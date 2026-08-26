import { dirname, join, parse, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { AttachmentError, AttachmentId, AttachmentStore } from "@deepseek-ai/dsh-attachment";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import sharp from "sharp";
//#region lib/types/image.js
/** Raster inspection: full decode at admission, header-only probe on verified reads. */
const MEDIA_TYPES = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif"
};
/** True when a caught error means sharp's native library is absent (the
 *  Android bundle ships a stub that throws this message on first call). */
function sharpUnavailableError(error) {
	return error instanceof Error && /sharp native module unavailable/i.test(error.message);
}
function readU16LE(bytes, off) {
	return bytes[off] | (bytes[off + 1] << 8);
}
function readU16BE(bytes, off) {
	return (bytes[off] << 8) | bytes[off + 1];
}
function readU32BE(bytes, off) {
	return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}
/**
* Header-only raster probe: validate magic bytes and read intrinsic dimensions
* for PNG / JPEG / WebP / GIF without decoding pixels. Used as the fallback
* when sharp is unavailable (the Android bundle stubs it out), so the
* attachment pipeline still works there. Admission is weaker than sharp's full
* decode — it checks the container header rather than the whole raster — which
* is the best a pure-JS path can do without a native image library.
* @param data - complete encoded image bytes.
* @returns verified format and dimensions.
* @throws {@link AttachmentError} INVALID_IMAGE when the header is unsupported or malformed.
*/
function probeHeader(data) {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	// PNG: 8-byte signature + IHDR (width/height at 16/20, big-endian).
	if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
		&& bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
		&& bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
		return { mediaType: "image/png", width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
	}
	// JPEG: SOI (FF D8 FF), then walk segments to the first SOF marker.
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		let off = 2;
		while (off + 4 < bytes.length) {
			while (off < bytes.length && bytes[off] === 0xff) off += 1;
			if (off >= bytes.length) break;
			const marker = bytes[off];
			off += 1;
			if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
			if (off + 2 > bytes.length) break;
			const segLen = readU16BE(bytes, off);
			off += 2;
			// SOF0..SOF15 except DHT(C4) / JPG(C8) / DAC(CC).
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				if (off + 5 > bytes.length) break;
				return { mediaType: "image/jpeg", width: readU16BE(bytes, off + 3), height: readU16BE(bytes, off + 1) };
			}
			if (segLen < 2) break;
			off += segLen - 2;
		}
	}
	// GIF: GIF87a / GIF89a, logical screen width/height at 6/8 (little-endian).
	if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return { mediaType: "image/gif", width: readU16LE(bytes, 6), height: readU16LE(bytes, 8) };
	}
	// WebP: RIFF....WEBP + chunk; dimensions live in the first chunk's payload.
	if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
		&& bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
		const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
		if (fourcc === "VP8X") {
			// Canvas size: 3-byte little-endian at 24 (width) / 27 (height), each +1.
			const w = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
			const h = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
			return { mediaType: "image/webp", width: (w & 0xffffff) + 1, height: (h & 0xffffff) + 1 };
		}
		if (fourcc === "VP8 ") {
			// Lossy frame: 14-bit little-endian at 26 (width) / 28 (height).
			return { mediaType: "image/webp", width: readU16LE(bytes, 26) & 0x3fff, height: readU16LE(bytes, 28) & 0x3fff };
		}
		if (fourcc === "VP8L" && bytes.length >= 25) {
			// Lossless: signature 0x2f at 20, then 32-bit LE where bits 0-13 = width-1, bits 14-27 = height-1.
			const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
			const w = 1 + (b0 | ((b1 & 0x3f) << 8));
			const h = 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
			return { mediaType: "image/webp", width: w, height: h };
		}
	}
	throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE");
}
async function imageMetadata(image) {
	const metadata = await image.metadata();
	const mediaType = MEDIA_TYPES[metadata.format];
	if (mediaType === void 0) throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE");
	return {
		mediaType,
		width: metadata.width,
		height: metadata.height
	};
}
/**
* Parse a supported raster's header and return its intrinsic metadata without
* decoding pixels. Digest-verified reads use this: admission already proved
* that these exact bytes decode completely, so the read path only re-derives
* the reference fields instead of paying the full-raster decode again.
* @param data - complete encoded image bytes.
* @returns verified format and dimensions.
*/
async function probeImage(data) {
	try {
		return await imageMetadata(sharp(data, {
			failOn: "error",
			limitInputPixels: false
		}));
	} catch (error) {
		if (error instanceof AttachmentError) throw error;
		if (sharpUnavailableError(error)) return probeHeader(data);
		throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE", { cause: error });
	}
}
/**
* Fully decode a supported raster and return its intrinsic metadata.
* @param data - complete encoded image bytes.
* @param maxPixels - decoded-pixel admission limit.
* @returns verified format and dimensions.
*/
async function detectImage(data, maxPixels) {
	try {
		const image = sharp(data, {
			failOn: "error",
			limitInputPixels: false
		});
		const detected = await imageMetadata(image);
		if (maxPixels !== void 0 && detected.width * detected.height > maxPixels) throw new AttachmentError("Image exceeds the configured decoded-pixel limit.", "IMAGE_TOO_MANY_PIXELS");
		await image.raw().toBuffer();
		return detected;
	} catch (error) {
		if (error instanceof AttachmentError) throw error;
		if (sharpUnavailableError(error)) return probeHeader(data);
		throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE", { cause: error });
	}
}
//#endregion
//#region lib/types/store.js
/** Content-addressed, owner-private local attachment storage. */
const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
const durableHomes = /* @__PURE__ */ new Set();
function digest(data) {
	return createHash("sha256").update(data).digest("hex");
}
function displayName(value) {
	if (value === void 0) return void 0;
	const clean = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
	return clean === "" ? void 0 : clean;
}
function objectPath(root, sha256) {
	return join(root, "objects", sha256.slice(0, 2), sha256);
}
function ensureReference(ref) {
	const match = ID_PATTERN.exec(String(ref.attachmentId));
	if (match?.[1] === void 0) throw new AttachmentError("Attachment reference is invalid.", "INVALID_ATTACHMENT_REF");
	return match[1];
}
async function inspectMetadata(data, declaredMediaType, maxPixels) {
	if (data.byteLength === 0) throw new AttachmentError("Image is empty.", "INVALID_IMAGE");
	const detected = await detectImage(data, maxPixels);
	if (detected.mediaType !== declaredMediaType) throw new AttachmentError("Declared image type does not match its bytes.", "IMAGE_TYPE_MISMATCH");
	return {
		...detected,
		bytes: data.byteLength
	};
}
/**
* Run the full admission policy for one image without touching storage.
* @param input - encoded bytes and declared metadata.
* @param limits - resolved storage policy.
* @returns completion after the encoded raster has been fully decoded.
*/
async function validateImageFile(input, limits) {
	if (input.data.byteLength > limits.maxImageBytes) throw new AttachmentError("Image exceeds the configured byte limit.", "IMAGE_TOO_LARGE");
	await inspectMetadata(input.data, input.mediaType, limits.maxImagePixels);
}
/**
* Make a directory's entries durable (fsync on a read-only directory handle).
* A synced file alone does not survive a crash when its directory entry never
* reached storage, so the publication directory is synced before a durable
* reference is reported.
*/
async function syncDirectory(path) {
	/* v8 ignore next -- Windows cannot open directory handles; NTFS metadata journaling owns entry durability there. */
	if (process.platform === "win32") return;
	/* v8 ignore start -- Windows cannot exercise directory fsync; POSIX behavior tests enforce this peer. */
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	/* v8 ignore stop */
}
/**
* Create one private directory tree and persist every ancestor entry up to a
* caller-vouched durable boundary. The walk deliberately ignores what mkdir
* reports as newly created: a concurrent first save can create a level this
* process then merely observes, so "already existed" is not "already durable"
* — the entry may still be unsynced in the creator, and a crash would drop a
* directory the session checkpoint already references. Re-syncing a durable
* entry is harmless; skipping an unsynced one is not.
* @param path - absolute directory to create.
* @param boundary - absolute ancestor the caller vouches is already durable.
*/
async function ensureDurableDirectory(path, boundary) {
	const target = resolve(path);
	const stop = resolve(boundary);
	await mkdir(target, {
		recursive: true,
		mode: 448
	});
	await chmod(target, 448);
	let level = target;
	while (level !== stop) {
		const parent = dirname(level);
		await syncDirectory(parent);
		/* v8 ignore next -- filesystem-root guard: callers pass a boundary that is an ancestor of path, so the walk reaches it first. */
		if (parent === level) return;
		level = parent;
	}
}
/**
* Establish this process's proof that one DSH_HOME entry and every ancestor
* below the filesystem root are durable. Mere existence is insufficient: a
* concurrent process may have created the directory but not synced its parent.
*/
async function ensureDurableHome(path) {
	const home = resolve(path);
	if (!durableHomes.has(home)) {
		await ensureDurableDirectory(home, parse(home).root);
		durableHomes.add(home);
	}
	return home;
}
/**
* Save and verify immutable image bytes below a versioned attachment root.
* @param root - absolute `DSH_HOME/attachments/v1` root.
* @param input - encoded bytes and declared metadata.
* @param limits - resolved storage policy.
* @returns durable content-addressed reference.
*/
async function saveImageFile(root, input, limits) {
	if (input.data.byteLength > limits.maxImageBytes) throw new AttachmentError("Image exceeds the configured byte limit.", "IMAGE_TOO_LARGE");
	const metadata = await inspectMetadata(input.data, input.mediaType, limits.maxImagePixels);
	const sha256 = digest(input.data);
	const bucket = join(root, "objects", sha256.slice(0, 2));
	const staging = join(root, "tmp");
	const boundary = await ensureDurableHome(dirname(dirname(resolve(root))));
	await ensureDurableDirectory(bucket, boundary);
	await ensureDurableDirectory(staging, boundary);
	const temporary = join(staging, randomUUID());
	const target = objectPath(root, sha256);
	let handle;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
		await handle.writeFile(input.data);
		await handle.sync();
		await handle.close();
		handle = void 0;
		let publishedViaRename = false;
		try {
			await link(temporary, target);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : void 0;
			/* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */
			if (code === "EEXIST") {
				if (digest(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");
			} else if (code === "EACCES" || code === "EPERM" || code === "ENOSYS" || code === "EXDEV") {
				// Android SELinux 禁止应用创建硬链接：回退为同目录 rename 原子发布，
				// temporary 随即被重命名走，不再 unlink。
				await rename(temporary, target);
				publishedViaRename = true;
			} else {
				throw error;
			}
		}
		await syncDirectory(bucket);
		await syncDirectory(join(root, "objects"));
		if (!publishedViaRename) await unlink(temporary);
	} catch (error) {
		/* v8 ignore next -- A descriptor can remain open only when the underlying write/sync/close operation fails. */
		if (handle !== void 0) await handle.close().catch(
			/* v8 ignore next -- Close failure is superseded by the storage operation that entered cleanup. */
			() => {}
		);
		await unlink(temporary).catch(
			/* v8 ignore next -- The callback requires a second independent staging-unlink failure. */
			(cleanupError) => {
				/* v8 ignore next -- Cleanup is best-effort only for a staging file already removed by a failed operation. */
				if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) throw cleanupError;
			}
		);
		if (error instanceof AttachmentError) throw error;
		throw new AttachmentError("Unable to persist image attachment.", "ATTACHMENT_WRITE_FAILED", { cause: error });
	}
	const name = displayName(input.name);
	return {
		attachmentId: AttachmentId(`sha256:${sha256}`),
		...metadata,
		...name !== void 0 ? { name } : {}
	};
}
/**
* Read and verify one content-addressed image.
* @param root - absolute `DSH_HOME/attachments/v1` root.
* @param ref - reference recorded in the session log.
* @param signal - optional cancellation for filesystem and verification work.
* @returns verified bytes and reference.
* @throws the signal reason when aborted, or an AttachmentError when verification fails.
*/
async function readImageFile(root, ref, signal) {
	signal?.throwIfAborted();
	const sha256 = ensureReference(ref);
	let data;
	try {
		data = new Uint8Array(await readFile(objectPath(root, sha256), { signal }));
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new AttachmentError("Attachment object is missing.", "ATTACHMENT_NOT_FOUND");
		throw new AttachmentError("Unable to read image attachment.", "ATTACHMENT_READ_FAILED", { cause: error });
	}
	signal?.throwIfAborted();
	if (digest(data) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");
	const metadata = await probeImage(data);
	signal?.throwIfAborted();
	if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes || metadata.width !== ref.width || metadata.height !== ref.height) throw new AttachmentError("Stored attachment metadata does not match its reference.", "ATTACHMENT_CORRUPT");
	return {
		ref,
		data
	};
}
//#endregion
//#region lib/types/index.js
/** Local durable attachment backend rooted below `DSH_HOME`. @module @deepseek-ai/dsh-attachment-local */
/** Default maximum encoded bytes for one image. */
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Default maximum images in one prompt. */
const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20;
/** Default maximum aggregate image bytes in one prompt. */
const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024;
/** Default maximum intrinsic pixels for one image. */
const DEFAULT_MAX_IMAGE_PIXELS = 4e7;
/** Persistent content-addressed local attachment store. */
var LocalAttachmentStore = class extends AttachmentStore {
	static Config = z.object({
		dshHome: z.string(),
		maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
		maxImagesPerMessage: z.number().step(1).min(1).default(20),
		maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
		maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS)
	});
	/** Absolute versioned storage root. */
	root;
	imageLimits;
	constructor(ctx, config) {
		super(ctx);
		this.root = resolve(join(resolveDshHome(config.dshHome), "attachments", "v1"));
		this.imageLimits = Object.freeze({
			maxImageBytes: config.maxImageBytes ?? 5242880,
			maxImagesPerMessage: config.maxImagesPerMessage ?? 20,
			maxMessageImageBytes: config.maxMessageImageBytes ?? 104857600,
			maxImagePixels: config.maxImagePixels ?? 4e7,
			mediaTypes: Object.freeze([
				"image/png",
				"image/jpeg",
				"image/webp",
				"image/gif"
			])
		});
	}
	async validateImage(input) {
		await validateImageFile(input, this.imageLimits);
	}
	async saveImage(input) {
		return saveImageFile(this.root, input, this.imageLimits);
	}
	async readImage(ref, signal) {
		return readImageFile(this.root, ref, signal);
	}
};
//#endregion
export { DEFAULT_MAX_IMAGES_PER_MESSAGE, DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_PIXELS, DEFAULT_MAX_MESSAGE_IMAGE_BYTES, LocalAttachmentStore, LocalAttachmentStore as default, detectImage, readImageFile, saveImageFile, validateImageFile };
