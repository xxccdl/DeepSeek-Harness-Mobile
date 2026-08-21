/**
 * 把内嵌 Termux deb（nodejs/npm 及依赖）的 data 合并打包为
 * assets/dsh/node-runtime.dat（prefix 相对路径的 tar.gz）。
 *
 * 设备上 dpkg 硬编码 /data/data/com.termux 路径，无法在第三方 App 内使用；
 * 改为构建期预解包、运行期直接解压到 $PREFIX，完全离线。
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, lstatSync, readlinkSync, copyFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

const DEBS = "d:/code/dsh-gui/dsh-mobile/runtime-src/debs"; // debs 放此处（不进 APK）
const OUT = "d:/code/dsh-gui/dsh-mobile/app/android/app/src/main/assets/dsh/node-runtime.dat";
const PREFIX_IN_DEB = "data/data/com.termux/files/usr";

const work = join(tmpdir(), "node-runtime-pack");
rmSync(work, { recursive: true, force: true });
const merged = join(work, "merged");
mkdirSync(merged, { recursive: true });

for (const deb of readdirSync(DEBS).filter((f) => f.endsWith(".deb"))) {
  const dir = join(work, deb);
  mkdirSync(dir, { recursive: true });
  // ar 归档：解出 data.tar.xz
  execSync(`tar -xf "${join(DEBS, deb)}" -C "${dir}"`, { stdio: "pipe" });
  const dataTar = join(dir, "data.tar.xz");
  if (!existsSync(dataTar)) {
    console.log("!! no data.tar.xz in", deb);
    continue;
  }
  execSync(`tar -xJf "${dataTar}" -C "${merged}"`, { stdio: "pipe" });
  console.log("merged:", deb);
}

const usr = join(merged, PREFIX_IN_DEB);
if (!existsSync(usr)) {
  console.error("!! merged prefix not found:", usr);
  process.exit(1);
}

rmSync(OUT, { force: true });
execSync(`tar -czf "${OUT}" -C "${usr}" .`, { stdio: "pipe" });
console.log("node-runtime.dat:", (statSync(OUT).size / 1048576).toFixed(1), "MB");
