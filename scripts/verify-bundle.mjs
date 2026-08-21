/**
 * 校验 bundle 内 dsh-base / dsh-web-app 的 cordis.patch.yml 注册的每个插件包
 * 是否都存在于 bundle 的 node_modules 闭包中。缺包会导致插件树加载失败。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const STAGE = "d:/code/dsh-gui/dsh-mobile/app/bundle-staging/node_modules";

function registeredNames(patchPath) {
  const content = readFileSync(patchPath, "utf8");
  const names = new Set();
  for (const m of content.matchAll(/^\s*name: '(@deepseek-ai\/[^']+)'/gm)) {
    // 去掉子入口形如 name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
    names.add(m[1].split("/").slice(0, 2).join("/"));
  }
  return names;
}

for (const patch of ["dsh-base/cordis.patch.yml", "dsh-web-app/cordis.patch.yml"]) {
  const p = join(STAGE, "@deepseek-ai", patch);
  const names = registeredNames(p);
  const missing = [];
  for (const n of names) {
    if (!existsSync(join(STAGE, n.replace("@deepseek-ai/", "@deepseek-ai\\")))) {
      missing.push(n);
    }
  }
  console.log(`== ${patch} (${names.size} 个插件) ==`);
  if (missing.length === 0) {
    console.log("   全部存在 ✓");
  } else {
    console.log("   缺失:");
    for (const m of missing) console.log("   ✗ " + m);
  }
}
