/**
 * 打包 dsh 引擎依赖闭包 → staging/node_modules（供内嵌进 APK）。
 *
 * 从桌面版已安装的 node_modules 提取 @deepseek-ai/dsh 的生产依赖闭包，
 * 按移动端(Android)场景精简：移除 node-pty 各平台预编译产物、非 Android
 * 的 ripgrep 二进制、类型声明与源码映射，仅保留运行必需文件。
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC_NM = "d:/code/dsh-gui/node_modules";
const STAGE = "d:/code/dsh-gui/dsh-mobile/app/bundle-staging/node_modules";

// 手机版不需要的功能（电脑控制 / 浏览器控制 / 桌面设置 / 更新器）对应插件包
const EXCLUDE_PKGS = [
  "@deepseek-ai/dsh-tool-computer-use",
  "@deepseek-ai/dsh-client-ui-computer-use",
  "@deepseek-ai/dsh-tool-browser",
  "@deepseek-ai/dsh-client-ui-browser",
  "@deepseek-ai/dsh-client-ui-desktop",
  "@deepseek-ai/dsh-client-ui-updater",
];

// fork bundle 的 cordis.patch.yml 已注册、但不在 npm 依赖闭包内的桌面自研插件，
// 需显式复制进 bundle，否则插件树加载失败（loader entries failed to apply）。
const EXTRA_PKGS = [
  "@deepseek-ai/dsh-command-btw",
  "@deepseek-ai/dsh-tool-webfetch",
  "@deepseek-ai/dsh-tool-snippets",
  "@deepseek-ai/dsh-tool-remind",
  "@deepseek-ai/dsh-tool-filesearch",
  "@deepseek-ai/dsh-tool-clipboard",
  "@deepseek-ai/dsh-tool-deliver",
  "@deepseek-ai/dsh-tool-phone",
  "@deepseek-ai/dsh-client-ui-enhance",
  "@deepseek-ai/dsh-client-ui-snippets",
  "@deepseek-ai/dsh-client-ui-stats",
  "@deepseek-ai/dsh-client-ui-onboarding",
  "@deepseek-ai/dsh-client-ui-deliver",
  "@deepseek-ai/dsh-client-ui-phone-control",
  "@deepseek-ai/dsh-client-ui-mobile",
  "@deepseek-ai/dsh-mobile-bridge",
];

// 1. 收集闭包
const seen = new Set();
function collect(pkg) {
  if (seen.has(pkg)) return;
  seen.add(pkg);
  let pj;
  try { pj = JSON.parse(readFileSync(join(SRC_NM, pkg, "package.json"), "utf8")); } catch { return; }
  for (const k of Object.keys({ ...pj.dependencies, ...pj.peerDependencies })) collect(k);
}
collect("@deepseek-ai/dsh");
console.log("closure packages:", seen.size);

// 2. 复制（应用精简规则）
const SKIP_SUFFIX = [
  "node-pty/prebuilds",           // 编译时按平台生成
  "node_modules/node-pty",        // 用 Android prebuilt fork 替代（@mmmbuto/node-pty-android-arm64）
  "node_modules/@vscode/ripgrep/bin", // 非 Android 二进制，用 Termux ripgrep
  "node_modules/@types",          // 类型声明，运行时不需要
  "node_modules/react-native",    // 若混入 RN 依赖则跳过
];
const SKIP_EXT = [".map", ".md"];

function real(pkg) {
  const s = pkg.split("/");
  return s[0].startsWith("@") ? s[0] + "/" + s[1] : s[0];
}

rmSync(join(STAGE, ".."), { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

let copied = 0;
let skipped = 0;
for (const pkg of seen) {
  const r = real(pkg);
  // 手机版排除：电脑控制 / 浏览器控制插件包
  if (EXCLUDE_PKGS.includes(r)) { console.log("  (exclude) " + r); skipped++; continue; }
  const src = join(SRC_NM, r);
  if (!existsSync(src)) { console.log("  (missing) " + r); skipped++; continue; }
  const dest = join(STAGE, r);
  try {
    cpSync(src, dest, { recursive: true, force: true, filter: (s) => {
      const rel = s.replace(/\\/g, "/");
      for (const suf of SKIP_SUFFIX) if (rel.includes(suf)) return false;
      for (const ext of SKIP_EXT) if (rel.endsWith(ext)) return false;
      return true;
    } });
    copied++;
  } catch (e) {
    console.log("  (fail) " + r + " " + e.message);
  }
}
console.log("copied:", copied, "skipped:", skipped);

// 2.5 复制 EXTRA_PKGS（fork patch 已注册但不在 npm 闭包内的桌面自研插件）
for (const pkg of EXTRA_PKGS) {
  const r = real(pkg);
  const src = join(SRC_NM, r);
  const dest = join(STAGE, r);
  if (existsSync(src) && r !== "@deepseek-ai/dsh-client-ui-mobile") {
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, force: true });
    console.log("  (extra) " + r);
  }
}
// 手机端 UI 插件来自 assets/dsh/plugins
const mobileSrc = "d:/code/dsh-gui/dsh-mobile/app/android/app/src/main/assets/dsh/plugins/@deepseek-ai/dsh-client-ui-mobile";
const mobileDest = join(STAGE, "@deepseek-ai/dsh-client-ui-mobile");
if (existsSync(mobileSrc)) {
  rmSync(mobileDest, { recursive: true, force: true });
  cpSync(mobileSrc, mobileDest, { recursive: true, force: true });
  console.log("  (extra) @deepseek-ai/dsh-client-ui-mobile (from assets)");
}

// 2.6 为无 Android prebuild 的原生模块（koffi / sharp）注入安全 stub。
//    这两个模块仅桌面/win32 路径真正使用；stub 让 Android 上模块导入成功
//    （koffi 需满足加载期 struct size 断言），实际调用时才抛错。
function writeStub(pkg, files) {
  const dest = join(STAGE, pkg);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dest, name), content);
  }
  console.log("  (stub) " + pkg);
}

const KOFFI_STUB = `// Android stub: real koffi has no android prebuild.
// Satisfies module-load (struct size assertions); throws if win32-only paths run.
const SIZES = { STARTUPINFOW: 104, PROCESS_INFORMATION: 24 };
const unavailable = (fn) => () => { throw new Error("koffi native module unavailable on " + process.platform + "-" + process.arch + " (" + fn + ")"); };
const api = {
  pointer: (t) => ({ __koffiPointer: typeof t === "string" ? t : "ptr" }),
  struct: (name) => ({ __koffiStruct: name, size: SIZES[name] ?? 0 }),
  alloc: unavailable("alloc"),
  encode: unavailable("encode"),
  decode: unavailable("decode"),
  address: unavailable("address"),
  load: unavailable("load"),
};
export default api;
export const pointer = api.pointer, struct = api.struct, alloc = api.alloc,
  encode = api.encode, decode = api.decode, address = api.address, load = api.load;
`;
const KOFFI_STUB_CJS = `const SIZES = { STARTUPINFOW: 104, PROCESS_INFORMATION: 24 };
const unavailable = (fn) => () => { throw new Error("koffi native module unavailable on " + process.platform + "-" + process.arch + " (" + fn + ")"); };
const api = {
  pointer: (t) => ({ __koffiPointer: typeof t === "string" ? t : "ptr" }),
  struct: (name) => ({ __koffiStruct: name, size: SIZES[name] ?? 0 }),
  alloc: unavailable("alloc"), encode: unavailable("encode"), decode: unavailable("decode"),
  address: unavailable("address"), load: unavailable("load"),
};
module.exports = api;
module.exports.default = api;
`;

const SHARP_STUB = `// Android stub: sharp has no android prebuild. Import succeeds; calls throw.
function sharp() { throw new Error("sharp native module unavailable on " + process.platform + "-" + process.arch); }
export default sharp;
`;
const SHARP_STUB_CJS = `function sharp() { throw new Error("sharp native module unavailable on " + process.platform + "-" + process.arch); }
module.exports = sharp;
module.exports.default = sharp;
`;

writeStub("koffi", {
  "package.json": JSON.stringify({
    name: "koffi", version: "3.1.5", type: "module",
    main: "./index.cjs", module: "./index.js",
    exports: { ".": { import: "./index.js", require: "./index.cjs" } },
  }, null, 2),
  "index.js": KOFFI_STUB,
  "index.cjs": KOFFI_STUB_CJS,
});
writeStub("sharp", {
  "package.json": JSON.stringify({
    name: "sharp", version: "0.35.3", type: "module",
    main: "./index.cjs", module: "./index.js",
    exports: { ".": { import: "./index.js", require: "./index.cjs" } },
  }, null, 2),
  "index.js": SHARP_STUB,
  "index.cjs": SHARP_STUB_CJS,
});

// 3. 清理 bundle 内 dsh-base / dsh-web-app 的 cordis.patch.yml：
//    移除手机版不需要插件的注册条目（对应包已被排除）。
const STRIP_ENTRY_IDS = [
  "tool-computer-use",
  "ui-computer-use",
  "tool-browser",
  "ui-browser",
  "ui-desktop",
  "ui-updater",
];

/** 从 patch yml 内容中按 id 移除顶层注册条目（含注释块，保留文件其他内容）。 */
function stripPatchEntries(content, ids) {
  const lines = content.split("\n");
  const out = [];
  let skip = 0; // 剩余需要跳过的行数（条目本身 + 其 config 缩进块）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (skip > 0) { skip--; continue; }
    const m = line.match(/^\s*- id:\s*(\S+)\s*$/);
    if (m && ids.includes(m[1])) {
      // 向后吃掉属于该条目的行：比该行缩进更深的行（name:/config: 等）与纯注释
      const indent = line.match(/^\s*/)[0].length;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === "") { j++; continue; }
        const li = l.match(/^\s*/)[0].length;
        if (li > indent) { j++; continue; }
        break;
      }
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

for (const f of ["dsh-base/cordis.patch.yml", "dsh-web-app/cordis.patch.yml"]) {
  const p = join(STAGE, "@deepseek-ai", f);
  if (!existsSync(p)) { console.log("  (no patch) " + f); continue; }
  const before = readFileSync(p, "utf8");
  const after = stripPatchEntries(before, STRIP_ENTRY_IDS);
  if (after !== before) {
    writeFileSync(p, after);
    console.log("  stripped entries from " + f);
  }
}

// 3.5 把手机 UI 插件注册进 dsh-web-app 的 patch（而非单独 DSH_HOME/cordis.patch.yml）。
//    原因：bundle patch 位于 node_modules 内，cordis loader 从那里能解析到
//    @deepseek-ai/dsh-client-ui-mobile；而 DSH_HOME/cordis.patch.yml 位于
//    dsh-home 下，向上无 node_modules，会 ERR_MODULE_NOT_FOUND。
const webAppPatch = join(STAGE, "@deepseek-ai/dsh-web-app/cordis.patch.yml");
if (existsSync(webAppPatch)) {
  const c = readFileSync(webAppPatch, "utf8");
  if (!c.includes("ui-mobile")) {
    const anchor = "    - id: ui-trajectory\n      name: '@deepseek-ai/dsh-client-ui-trajectory'";
    const injected = anchor + "\n\n    - id: ui-mobile\n      name: '@deepseek-ai/dsh-client-ui-mobile'";
    if (c.includes(anchor)) {
      writeFileSync(webAppPatch, c.replace(anchor, injected));
      console.log("  injected ui-mobile into dsh-web-app patch");
    } else {
      console.log("  !! ui-trajectory anchor not found; ui-mobile not injected");
    }
  }
}

// 3.5b 产物交付 UI：在对话 turnTail 渲染「产物标签 + 一键保存」按钮（postMessage 桥接原生保存）
{
  const c = readFileSync(webAppPatch, "utf8");
  if (!c.includes("id: ui-deliver\n")) {
    const anchor = "    - id: ui-mobile\n      name: '@deepseek-ai/dsh-client-ui-mobile'";
    if (c.includes(anchor)) {
      writeFileSync(webAppPatch, c.replace(anchor, anchor + "\n\n    - id: ui-deliver\n      name: '@deepseek-ai/dsh-client-ui-deliver'"));
      console.log("  injected ui-deliver into dsh-web-app patch");
    } else {
      console.log("  !! ui-mobile anchor not found; ui-deliver not injected");
    }
  }
}

// 3.5c 手机控制设置分区：在设置页注册「手机控制」分区（状态开关 + 测试读屏）
{
  const c = readFileSync(webAppPatch, "utf8");
  if (!c.includes("id: ui-phone-control\n")) {
    const anchor = "    - id: ui-deliver\n      name: '@deepseek-ai/dsh-client-ui-deliver'";
    if (c.includes(anchor)) {
      writeFileSync(webAppPatch, c.replace(anchor, anchor + "\n\n    - id: ui-phone-control\n      name: '@deepseek-ai/dsh-client-ui-phone-control'"));
      console.log("  injected ui-phone-control into dsh-web-app patch");
    } else {
      console.log("  !! ui-deliver anchor not found; ui-phone-control not injected");
    }
  }
}

// 3.6 把手机桥接插件注册进 dsh-base 的 patch：它订阅 dsh/notify 并把通知
//    写入 <files>/notify 队列，由原生层 FileObserver 弹系统通知。
//    紧邻 task-notify（dsh-tool-notify，真正 emit dsh/notify 的插件）。
const basePatch = join(STAGE, "@deepseek-ai/dsh-base/cordis.patch.yml");
if (existsSync(basePatch)) {
  const c = readFileSync(basePatch, "utf8");
  if (!c.includes("mobile-bridge")) {
    const anchor = "    - id: task-notify\n      name: '@deepseek-ai/dsh-tool-notify'";
    const injected = anchor + "\n\n    - id: mobile-bridge\n      name: '@deepseek-ai/dsh-mobile-bridge'";
    if (c.includes(anchor)) {
      writeFileSync(basePatch, c.replace(anchor, injected));
      console.log("  injected mobile-bridge into dsh-base patch");
    } else {
      console.log("  !! task-notify anchor not found; mobile-bridge not injected");
    }
  }
}

// 3.6b AI 产物交付工具：注册进 dsh-base patch，让 AI 能用 send_file 交付产物
//    （bridge 转发 deliver 事件，原生层再弹「点击保存到 Download」通知）。
{
  const c = readFileSync(basePatch, "utf8");
  if (!c.includes("tool-deliver")) {
    const deliverAnchor = "    - id: tool-clipboard\n      name: '@deepseek-ai/dsh-tool-clipboard'";
    if (c.includes(deliverAnchor)) {
      writeFileSync(basePatch, c.replace(deliverAnchor, deliverAnchor + "\n\n    - id: tool-deliver\n      name: '@deepseek-ai/dsh-tool-deliver'"));
      console.log("  injected tool-deliver into dsh-base patch");
    } else {
      console.log("  !! tool-clipboard anchor not found; tool-deliver not injected");
    }
  }
}

// 3.6c AI 手机控制工具：注册进 dsh-base patch，让 AI 能用 phone_screen/tap/swipe 等
//    工具操控手机（经本地 HTTP 服务调原生无障碍服务）。
{
  const c = readFileSync(basePatch, "utf8");
  if (!c.includes("tool-phone")) {
    const phoneAnchor = "    - id: tool-deliver\n      name: '@deepseek-ai/dsh-tool-deliver'";
    if (c.includes(phoneAnchor)) {
      writeFileSync(basePatch, c.replace(phoneAnchor, phoneAnchor + "\n\n    - id: tool-phone\n      name: '@deepseek-ai/dsh-tool-phone'"));
      console.log("  injected tool-phone into dsh-base patch");
    } else {
      console.log("  !! tool-deliver anchor not found; tool-phone not injected");
    }
  }
}

// 3.7 手机版：AI 的 bash 工具改在 proot-distro Debian 容器内执行（完整 Linux 环境，
//    apt/pip/glibc），而非受限于 Termux 前缀。bash-local 默认 `bash -c <command>`；
//    在 staging 副本里改成 DSH_MOBILE_PROOT=1 时走 `proot-distro login debian -- bash -c ...`。
//    DSH_MOBILE_PROOT、PROOT_LOADER/_32、PROOT_TMP_DIR、TERMUX__PREFIX 等覆盖值由原生层
//    TermuxEngine.termuxEnv 注入，proot-distro 读取并转发给 proot。桌面版 node_modules 不受影响。
{
  const bashLocal = join(STAGE, "@deepseek-ai/dsh-bash-local/lib/index.js");
  if (existsSync(bashLocal)) {
    let c = readFileSync(bashLocal, "utf8");
    const method = `	shellArgv(command, workdir) {
		if (process.env.DSH_MOBILE_PROOT === "1") {
			const args = ["proot-distro", "login", "debian"];
			const loader = process.env.PROOT_LOADER;
			const loader32 = process.env.PROOT_LOADER_32;
			const tmpdir = process.env.PROOT_TMP_DIR;
			if (loader) args.push("-e", "PROOT_LOADER=" + loader);
			if (loader32) args.push("-e", "PROOT_LOADER_32=" + loader32);
			if (tmpdir) args.push("-e", "PROOT_TMP_DIR=" + tmpdir);
			const filesDir = process.env.DSH_MOBILE_FILES_DIR;
			if (filesDir) args.push("--bind", filesDir);
			if (workdir) args.push("--work-dir", workdir);
			args.push("--", "bash", "-c", command);
			return args;
		}
		return ["bash", "-c", command];
	}
`;
    const injected = c.replace(/async run\(spec\) \{/, method + "\tasync run(spec) {");
    if (injected === c) {
      console.log("  !! bash-local run() anchor not found; proot wrap not applied");
    } else {
      c = injected;
      const argvRe = /return this\.(runArgv|startArgv)\(spec, \[\s*"bash"\s*,\s*"-c"\s*,\s*spec\.command\s*\]\);/g;
      const patched = c.replace(argvRe, "return this.$1(spec, this.shellArgv(spec.command, spec.workdir));");
      writeFileSync(bashLocal, patched);
      console.log("  patched bash-local → proot-distro (DSH_MOBILE_PROOT)");
    }
  } else {
    console.log("  !! bash-local not staged, skip proot wrap");
  }
}

// 3.8 手机版：proot overlayfs 拒绝 link()/跨目录 rename()（EACCES），导致 write 工具
//    的原子写（.tmpdir 暂存 → 硬链接发布）在 Debian 容器内失败。DSH_MOBILE_PROOT=1 时
//    原子写失败自动回退为直接写目标文件（非原子但可靠），并清理暂存目录。
{
  const fsLocal = join(STAGE, "@deepseek-ai/dsh-fs-local/lib/index.js");
  if (existsSync(fsLocal)) {
    let c = readFileSync(fsLocal, "utf8");
    // 1. 回退路径需要 copyFile/unlink/writeFile，补进 fs/promises 导入
    const importLine = 'import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";';
    if (c.includes(importLine)) {
      c = c.replace(importLine, 'import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";');
    }
    // 2. 包装 writeFileAtomic：原子写 EACCES/EPERM/EXDEV 时回退直接写
    const anchor = "async function writeFileAtomic(absolutePath, content, mode, signal, internals = {}, createIfAbsent) {";
    if (c.includes(anchor) && !c.includes("dshMobileProotFallback")) {
      const wrapped = `async function dshMobileProotFallback(absolutePath, content, signal, internals = {}) {
	const removeStagingDir = internals.removeStagingDir ?? ((path) => rm(path, { recursive: true, force: true }));
	const stagingDir = join(dirname(absolutePath), internals.tempDirName?.(absolutePath) ?? \`.\${basename(absolutePath)}.\${process.pid}.\${randomUUID()}.tmpdir\`);
	try {
		await writeFile(absolutePath, content, { encoding: "utf8", ...signal ? { signal } : {} });
	} catch (error) {
		try { await removeStagingDir(stagingDir); } catch {}
		throw error;
	}
	try { await removeStagingDir(stagingDir); } catch {}
}
async function writeFileAtomic(absolutePath, content, mode, signal, internals = {}, createIfAbsent) {
	if (process.env.DSH_MOBILE_PROOT === "1") {
		try {
			return await writeFileAtomicOriginal(absolutePath, content, mode, signal, internals, createIfAbsent);
		} catch (error) {
			const code = error?.code ?? error?.cause?.code;
			if (code === "EACCES" || code === "EPERM" || code === "EXDEV") {
				await dshMobileProotFallback(absolutePath, content, signal, internals);
				return;
			}
			throw error;
		}
	}
	return writeFileAtomicOriginal(absolutePath, content, mode, signal, internals, createIfAbsent);
}
async function writeFileAtomicOriginal(absolutePath, content, mode, signal, internals = {}, createIfAbsent) {`;
      c = c.replace(anchor, wrapped);
      writeFileSync(fsLocal, c);
      console.log("  patched dsh-fs-local → atomic-write fallback (DSH_MOBILE_PROOT)");
    } else {
      console.log("  !! writeFileAtomic anchor not found or already patched");
    }
  } else {
    console.log("  !! dsh-fs-local not staged, skip atomic-write fallback");
  }
}

// 4. 内嵌 Android 版 node-pty（@mmmbuto/node-pty-android-arm64 prebuilt）
//    dsh-subprocess-local 通过 `import "node-pty"` 解析，故直接放到
//    node_modules/node-pty，运行时不需联网 npm install。
const PTY_TGZ = "d:/code/dsh-gui/dsh-mobile/app/mmmbuto-node-pty-android-arm64-1.1.2.tgz";
const ptyDest = join(STAGE, "node-pty");
rmSync(ptyDest, { recursive: true, force: true });
mkdirSync(ptyDest, { recursive: true });
if (existsSync(PTY_TGZ)) {
  execSync(`tar -xzf "${PTY_TGZ}" -C "${join(ptyDest, "..")}"`, { stdio: "pipe" });
  // tar 解出 package/ 目录，作为 node-pty 包本体
  rmSync(ptyDest, { recursive: true, force: true });
  cpSync(join(ptyDest, "..", "package"), ptyDest, { recursive: true });
  rmSync(join(ptyDest, "..", "package"), { recursive: true, force: true });
  console.log("node-pty (android-arm64 prebuilt) embedded");
} else {
  console.log("!! node-pty tgz not found:", PTY_TGZ);
}

// 3. 统计
function dirSize(d) {
  let total = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) total += dirSize(f);
    else if (e.isFile()) { try { total += statSync(f).size; } catch {} }
  }
  return total;
}
console.log("staged size:", (dirSize(STAGE) / 1048576).toFixed(1), "MB");

// 6. 打包为 dsh-bundle.dat（Android asset，设备端 tar -xzf 解压到 $PREFIX/lib）
const OUT_DAT = "d:/code/dsh-gui/dsh-mobile/app/android/app/src/main/assets/dsh/dsh-bundle.dat";
rmSync(OUT_DAT, { force: true });
execSync(`tar -czf "${OUT_DAT}" -C "${join(STAGE, "..")}" node_modules`, { stdio: "pipe" });
console.log("dsh-bundle.dat:", (statSync(OUT_DAT).size / 1048576).toFixed(1), "MB");
