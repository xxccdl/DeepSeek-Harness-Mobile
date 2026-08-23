// 备份 Android release 签名文件到 C:\dsh-signing-key 与 F:\dsh-signing-key
// 用法：node backup-signing-key.js
const fs = require("fs");
const path = require("path");

const SOURCES = [
  path.join(__dirname, "app", "release.keystore"),
  path.join(__dirname, "keystore.properties"),
];
const TARGETS = ["C:\\dsh-signing-key", "F:\\dsh-signing-key"];

let ok = true;
for (const dir of TARGETS) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const src of SOURCES) {
      if (!fs.existsSync(src)) {
        console.error("缺失源文件: " + src);
        ok = false;
        continue;
      }
      const dest = path.join(dir, path.basename(src));
      fs.copyFileSync(src, dest);
      console.log("已备份 -> " + dest);
    }
  } catch (e) {
    console.error("备份失败 " + dir + " : " + e.message);
    ok = false;
  }
}
console.log(ok ? "备份完成" : "备份未完全完成，请检查上面的错误");
process.exit(ok ? 0 : 1);
