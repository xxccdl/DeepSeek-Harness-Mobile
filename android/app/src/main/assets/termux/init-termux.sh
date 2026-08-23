#!/data/data/com.termux/files/usr/bin/bash
# DeepSeek Harness 手机版 — 内嵌 Termux 环境初始化脚本。
# 由 App 原生模块通过 bash -c 执行（不依赖 shebang）。
#
# dsh 引擎与桌面版插件已内嵌进 APK（由原生模块解压到 $DSH_BUNDLE）：
#   1) bootstrap        → bash/apt 基础环境（原生模块已解压到 $PREFIX）
#   2) dsh-modules.tar.gz → dsh 引擎及其全部 JS 依赖
#   3) plugins/          → 桌面版独有插件 + 手机 UI 优化插件
#   4) dsh-mobile.patch.yml → 插件注册（复制为 DSH_HOME/cordis.patch.yml）
#
# 首次初始化完全离线：
#   node 运行时 + npm 由内嵌 deb 安装（dpkg -i），node-pty 用 Android prebuilt，
#   dsh 引擎与桌面版插件由 bundle 直接解压，全程无需联网。

set -e

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PREFIX
export HOME="${HOME:-$PREFIX/../home}"
export TMPDIR="${TMPDIR:-$PREFIX/../tmp}"
export LD_LIBRARY_PATH="$PREFIX/lib"
# 路径重映射库：apt/dpkg/proot-distro 读取编译期硬编码的 /data/data/com.termux/files，
# 经 LD_PRELOAD 拦截 libc 文件 API 重写到真实前缀（DSH_REMAP_PREFIX 指向 files 目录）
if [ -f "$PREFIX/lib/libdsh-pathremap.so" ]; then
  export LD_PRELOAD="$PREFIX/lib/libdsh-pathremap.so:$PREFIX/lib/libtermux-exec.so"
  export DSH_REMAP_PREFIX="${DSH_REMAP_PREFIX:-$(dirname "$PREFIX")}"
else
  export LD_PRELOAD="$PREFIX/lib/libtermux-exec.so"
fi
# node 编译期默认 /data/data/com.termux 路径，用 OPENSSL_CONF 指向实际前缀
export OPENSSL_CONF="$PREFIX/etc/tls/openssl.cnf"
export PATH="$PREFIX/bin:$PREFIX/bin/applets:/system/bin:/system/xbin"

# proot-distro 定位真实前缀（它默认硬编码 /data/data/com.termux），
# 并覆盖 proot 二进制内的 loader/tmp 硬编码路径（重定位后指向其他应用目录会 EACCES）。
export TERMUX__PREFIX="$PREFIX"
export TERMUX__HOME="${HOME}"
export TERMUX_APP__PACKAGE_NAME="${TERMUX_APP__PACKAGE_NAME:-com.dshmobile}"
export PROOT_LOADER="$PREFIX/libexec/proot/loader"
export PROOT_LOADER_32="$PREFIX/libexec/proot/loader32"
export PROOT_TMP_DIR="${TMPDIR}"

# 内嵌 bundle 与 dsh 数据目录（由原生模块在 <files>/dsh 与 <files>/dsh-home 解压/创建）
DSH_BUNDLE="${DSH_BUNDLE:-$PREFIX/../dsh}"
DSH_HOME="${DSH_HOME:-$PREFIX/../dsh-home}"
export DSH_HOME
export DSH_TELEMETRY_DISABLED=1

# ── 飞速启动快速路径 ──────────────────────────────────────────────
# 环境已完成（node/dsh 引擎在位）且内嵌 bundle 未变化（未升级 APK）时，
# 直接跳过全部解压/安装/链接步骤，秒进 dsh 界面。
# 注意：必须校验 proot-distro 可执行文件与 Debian 容器都就位——旧版环境
# 可能在 proot-distro.dat 捆绑前初始化，仅校验 bin/proot 会把「缺 proot-distro」
# 误判为已就绪而跳过补装，导致 bash 工具 spawn proot-distro ENOENT。
BUNDLE_DAT="$DSH_BUNDLE/dsh-bundle.dat"
BUNDLE_SIZE="0"
[ -f "$BUNDLE_DAT" ] && BUNDLE_SIZE="$(wc -c < "$BUNDLE_DAT" | tr -d ' ')"
ENV_DONE="$DSH_HOME/.env-done"
if [ -f "$ENV_DONE" ] && [ -x "$PREFIX/bin/node" ] && [ -x "$PREFIX/bin/dsh" ] \
  && [ -f "$PREFIX/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" ] \
  && [ -x "$PREFIX/bin/proot" ] && [ -x "$PREFIX/bin/python3.14" ] \
  && [ -x "$PREFIX/bin/proot-distro" ] \
  && [ -f "$PREFIX/lib/python3.14/site-packages/proot_distro/cli.py" ] \
  && [ -d "$PREFIX/var/lib/proot-distro/containers/debian/rootfs" ] \
  && [ "$BUNDLE_SIZE" = "$(cat "$ENV_DONE" 2>/dev/null | tr -d ' ')" ]; then
  echo "==> 环境已就绪，跳过初始化（飞速启动）"
  exit 0
fi

echo "==> 安装 Node.js 运行时（内嵌 node-runtime.dat，无需联网）"
if [ ! -x "$PREFIX/bin/node" ] && [ -f "$DSH_BUNDLE/node-runtime.dat" ]; then
  # 构建期已把 deb 数据合并为 prefix 相对的 tar.gz，直接解压到 $PREFIX
  tar -xzf "$DSH_BUNDLE/node-runtime.dat" -C "$PREFIX"
  chmod +x "$PREFIX/bin/node" "$PREFIX/bin/npm" "$PREFIX/bin/npx" \
    "$PREFIX/lib/node_modules/npm/bin/npm-cli.js" "$PREFIX/lib/node_modules/npm/bin/npx-cli.js" 2>/dev/null || true
  echo "   node 运行时已就绪"
elif [ -x "$PREFIX/bin/node" ]; then
  echo "   node 已存在，跳过解压"
else
  echo "==> 未找到内嵌运行时，回退为 apt 安装"
  apt update -y
  apt install -y nodejs npm
fi

echo "==> 检查 Node 版本"
NODE_VERSION="$(node -v 2>/dev/null || echo unknown)"
echo "Node: $NODE_VERSION"

# dsh 需要 Node ^22.19 || >=24
case "$NODE_VERSION" in
  v24.*|v25.*|v26.*|v27.*|v28.*|v29.*|v30.*)
    echo "Node 版本满足要求"
    ;;
  v22.*)
    echo "Node 22 已安装（需要 22.19+）"
    ;;
  *)
    echo "==> 尝试安装 nodejs-lts"
    apt install -y nodejs-lts
    ;;
esac

# npm 的 shebang 硬编码 /data/data/com.termux 路径，用 node 直接调用
NPM="node $PREFIX/lib/node_modules/npm/bin/npm-cli.js"

echo "==> 解压内嵌 dsh 引擎（无需下载）"
INSTALLED_SIZE=""
[ -f "$PREFIX/lib/.bundle-size" ] && INSTALLED_SIZE="$(cat "$PREFIX/lib/.bundle-size" 2>/dev/null | tr -d ' ')"
if [ -f "$BUNDLE_DAT" ]; then
  # 全新安装（引擎缺失）或 bundle 大小与已安装记录不一致（APK 升级）→ 重新解压；
  # 无大小记录视同不一致，保证升级后必然使用新引擎。
  if [ ! -d "$PREFIX/lib/node_modules/@deepseek-ai/dsh" ] || [ "$BUNDLE_SIZE" != "$INSTALLED_SIZE" ]; then
    mkdir -p "$PREFIX/lib/node_modules"
    tar -xzf "$BUNDLE_DAT" -C "$PREFIX/lib/"
    echo "   dsh 引擎就绪"
  else
    echo "   dsh 引擎已就绪，跳过解压"
  fi
  echo "$BUNDLE_SIZE" > "$PREFIX/lib/.bundle-size"
else
  echo "!! 未找到内嵌引擎，回退为 npm 安装"
  $NPM config set registry https://registry.npmmirror.com
  $NPM install -g @deepseek-ai/dsh
fi

echo "==> 安装手机 UI 插件（桌面版插件已在 bundle 内注册）"
mkdir -p "$PREFIX/lib/node_modules/@deepseek-ai"
# 清理旧版残留的不完整插件目录（仅 package.json、无 lib/ 也无 dist/ 才会遮蔽 bundle 内真实包）
for d in "$PREFIX/lib/node_modules/@deepseek-ai"/dsh-*; do
  if [ -d "$d" ] && [ ! -d "$d/lib" ] && [ ! -d "$d/dist" ]; then rm -rf "$d"; fi
done
if [ -d "$DSH_BUNDLE/plugins/@deepseek-ai/dsh-client-ui-mobile" ]; then
  cp -r "$DSH_BUNDLE/plugins/@deepseek-ai/dsh-client-ui-mobile" "$PREFIX/lib/node_modules/@deepseek-ai/" || true
  echo "   手机 UI 插件已就绪"
fi

echo "==> 内嵌 Android 版 node-pty（已打入 bundle，无需联网）"
if [ -d "$PREFIX/lib/node_modules/node-pty/prebuilds/android-arm64" ]; then
  echo "   node-pty prebuilt 已就绪"
else
  echo "!! bundle 内未找到 node-pty，回退为 npm 安装"
  cd "$PREFIX/lib/node_modules"
  npm install --no-save --ignore-scripts node-pty@npm:@mmmbuto/node-pty-android-arm64@1.1.2 || true
fi

echo "==> 安装 proot-distro 运行时（内嵌 proot-distro.dat，无需联网）"
# 必须连 proot-distro 命令一起校验：旧版环境可能在 proot-distro.dat 捆绑前初始化，
# 仅有 proot/python3.14 却缺 proot-distro 命令与 Debian 容器，会导致 bash 工具
# spawn proot-distro ENOENT。缺任一即重新解压 proot-distro.dat 补齐。
# 关键库校验：旧版环境可能残留指向开发机绝对路径（//?/D:/...）的失效符号链接，
# 导致 node 缺 libsqlite3.so、apt 缺 libbz2.so.1.0 而无法链接。缺任一即重新解压
# proot-distro.dat（已实体化为真实文件）覆盖这些失效链接。
if [ -x "$PREFIX/bin/proot" ] && [ -x "$PREFIX/bin/python3.14" ] \
  && [ -x "$PREFIX/bin/proot-distro" ] \
  && [ -f "$PREFIX/lib/python3.14/site-packages/proot_distro/cli.py" ] \
  && [ -f "$PREFIX/lib/libsqlite3.so" ] && [ -f "$PREFIX/lib/libbz2.so.1.0" ]; then
  echo "   proot-distro 运行时已就绪，跳过"
elif [ -f "$DSH_BUNDLE/proot-distro.dat" ]; then
  # proot-distro.dat 的 tar 顶层是 usr/（usr/bin/proot、usr/lib/...），
  # 必须解到 $PREFIX 的父目录（files），再落入 $PREFIX/bin 与 $PREFIX/lib。
  tar -xzf "$DSH_BUNDLE/proot-distro.dat" -C "${PREFIX%/usr}"
  chmod +x "$PREFIX/bin/proot" "$PREFIX/bin/proot-distro" "$PREFIX/bin/pd" \
    "$PREFIX/bin/python3.14" "$PREFIX/libexec/proot/loader" "$PREFIX/libexec/proot/loader32" 2>/dev/null || true
  echo "   proot-distro 运行时已就绪"
else
  echo "!! 未找到 proot-distro.dat，跳过 Debian 环境"
fi

# 修复 proot-distro / pd 的 shebang：内嵌时把解释器硬编码为 /data/data/com.termux 前缀，
# 在第三方 App 内无法执行（bad interpreter: Permission denied）。改写为实际前缀的 python3.14。
# 该步骤在「跳过解压」时也执行，保证既有环境同样自愈。
for __pd in "$PREFIX/bin/proot-distro" "$PREFIX/bin/pd"; do
  if [ -f "$__pd" ] && [ -x "$PREFIX/bin/python3.14" ]; then
    "$PREFIX/bin/python3.14" - "$__pd" "$PREFIX/bin/python3.14" <<'PYFIX' 2>/dev/null || true
import sys
p, py = sys.argv[1], sys.argv[2]
try:
    with open(p, 'r', encoding='utf-8', errors='surrogateescape') as f:
        lines = f.readlines()
except OSError:
    sys.exit(0)
if lines and lines[0].startswith('#!') and 'com.termux' in lines[0]:
    lines[0] = '#!' + py + '\n'
    with open(p, 'w', encoding='utf-8', errors='surrogateescape') as f:
        f.writelines(lines)
PYFIX
    chmod +x "$__pd"
  fi
done

echo "==> 安装 Debian 容器（内嵌 debian-rootfs，无需联网）"
DEBIAN_ROOTFS="$PREFIX/var/lib/proot-distro/containers/debian/rootfs"
# 兼容 .tar.gz 与 .tar 两种打包名（proot-distro install 依 tarfile 自动识别格式）
ROOTFS_ARC=""
for cand in "$DSH_BUNDLE/debian-rootfs.tar.gz" "$DSH_BUNDLE/debian-rootfs.tar"; do
  if [ -f "$cand" ]; then ROOTFS_ARC="$cand"; break; fi
done
if [ -d "$DEBIAN_ROOTFS" ]; then
  echo "   Debian 已存在，跳过"
elif [ -x "$PREFIX/bin/proot-distro" ] && [ -n "$ROOTFS_ARC" ]; then
  "$PREFIX/bin/proot-distro" install "$ROOTFS_ARC" --name debian 2>&1 | tail -8 || true
  echo "   Debian 已安装"
else
  echo "!! 缺少 proot-distro 或 rootfs，跳过 Debian 安装"
fi

echo "==> 补齐 Debian 容器 CA 证书（内置 Termux cert.pem，无需联网）"
# debootstrap 最小根文件系统不含 ca-certificates，AI 在 Debian 里 curl/apt/pip/git
# 都会报 "unable to get local issuer certificate"。把 Termux 的 Mozilla CA 捆绑包
# 拷贝到 Debian 标准位置，让 OpenSSL 系工具（curl/apt/git/wget）直接可用。
if [ -d "$DEBIAN_ROOTFS" ] && [ -f "$PREFIX/etc/tls/cert.pem" ]; then
  CA_DIR="$DEBIAN_ROOTFS/etc/ssl/certs"
  mkdir -p "$CA_DIR"
  if [ ! -s "$CA_DIR/ca-certificates.crt" ]; then
    cp "$PREFIX/etc/tls/cert.pem" "$CA_DIR/ca-certificates.crt"
    echo "   CA 证书已写入 Debian 容器"
  else
    echo "   CA 证书已存在，跳过"
  fi
else
  echo "!! 缺少 Debian 或 cert.pem，跳过 CA 证书补齐"
fi

echo "==> 安装 Debian 容器内基础工具 nodejs/git/curl/wget（apt，需联网）"
# 最小 rootfs 只含 python3/dpkg，node/git/curl 缺失时 AI 在容器内无法用这些工具；
# 且宿主 Termux 的 node 是 bionic 链接，在 glibc 容器内会 CANNOT LINK（损坏）。
# 这里装 Debian 原生 glibc 版本，彻底规避宿主二进制泄漏带来的“node/python 损坏”。
if [ -d "$DEBIAN_ROOTFS" ] && [ -x "$PREFIX/bin/proot-distro" ]; then
  if [ ! -x "$DEBIAN_ROOTFS/usr/bin/node" ] || [ ! -x "$DEBIAN_ROOTFS/usr/bin/curl" ]; then
    echo "   缺少 node/curl，执行 apt 安装（首次可能较慢，请稍候）..."
    # 注意：不能把 apt 输出接到 | tail（proot 下子进程残留会让管道不闭合、login 不返回），
    # 改为重定向到容器内日志文件；外面用 timeout 兜底，避免任何情况下挂死初始化。
    # 后台心跳循环每 15s 输出一行进度：apt 安装耗时可能达数分钟且全程静默，
    # 无进度会让 App 的启动超时逻辑误报「启动超时」。
    ( __n=0; while [ "$__n" -lt 32 ]; do sleep 15; echo "   Debian 基础工具安装中…"; __n=$((__n+1)); done ) &
    __hb=$!
    # 容器源默认是 mirrors.aliyun.com 且其 https 证书在 proot 下验证失败（certificate
    # verify failed），导致 apt 下载 nodejs 等全部失败。这里把 sources.list 直接重写为
    # 清华源，并关闭 https 证书校验规避该问题；后续容器内所有 apt 操作默认走清华源。
    if ! timeout 480 "$PREFIX/bin/proot-distro" login debian \
      -e PROOT_LOADER="$PREFIX/libexec/proot/loader" \
      -e PROOT_LOADER_32="$PREFIX/libexec/proot/loader32" \
      -e PROOT_TMP_DIR="${TMPDIR}" \
      -- bash -c 'export DEBIAN_FRONTEND=noninteractive; CODENAME=$(grep -oP "(?<=VERSION_CODENAME=)\S+" /etc/os-release 2>/dev/null || echo stable); printf "deb https://mirrors.tuna.tsinghua.edu.cn/debian %s main contrib non-free non-free-firmware\ndeb https://mirrors.tuna.tsinghua.edu.cn/debian %s-updates main contrib non-free non-free-firmware\ndeb https://mirrors.tuna.tsinghua.edu.cn/debian-security %s-security main contrib non-free non-free-firmware\n" "$CODENAME" "$CODENAME" "$CODENAME" > /etc/apt/sources.list; rm -f /etc/apt/sources.list.d/* 2>/dev/null; apt-get -o Acquire::https::Verify-Peers=false -o Acquire::https::Verify-Host=false update -y >/dev/null 2>&1; apt-get -o Acquire::https::Verify-Peers=false -o Acquire::https::Verify-Host=false install -y --no-install-recommends nodejs curl wget ca-certificates >/var/log/dsh-mobile-apt.log 2>&1' >/dev/null 2>&1; then
      echo "   （apt 安装未能完全结束或超时，后续可由 AI 补装）"
    fi
    kill "$__hb" 2>/dev/null || true
    wait "$__hb" 2>/dev/null || true
    echo "   Debian 基础工具安装步骤结束"
  else
    echo "   Debian 基础工具已就绪，跳过"
  fi
else
  echo "!! 缺少 Debian 或 proot-distro，跳过基础工具安装"
fi

echo "==> 创建 dsh 命令（node wrapper → \$PREFIX/bin/dsh）"
mkdir -p "$PREFIX/bin"
DSH_BIN="$PREFIX/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ -f "$DSH_BIN" ]; then
  cat > "$PREFIX/bin/dsh" <<EOF
#!$PREFIX/bin/node
import('$DSH_BIN');
EOF
  chmod +x "$PREFIX/bin/dsh"
  echo "   dsh wrapper -> $PREFIX/bin/dsh"
else
  echo "!! 未找到 dsh bin.js，请检查 bundle"
fi

echo "==> 清理旧版 DSH_HOME/cordis.patch.yml（手机 UI 插件已注册进 bundle patch）"
mkdir -p "$DSH_HOME"
rm -f "$DSH_HOME/cordis.patch.yml"

echo "==> 链接 @deepseek-ai 插件到 profiles/node_modules（dsh profile 解析位置）"
PROF_NM="$DSH_HOME/profiles/node_modules/@deepseek-ai"
mkdir -p "$PROF_NM"
for src in "$PREFIX/lib/node_modules/@deepseek-ai"/*; do
  if [ -d "$src" ]; then
    name="$(basename "$src")"
    ln -sfn "$src" "$PROF_NM/$name" 2>/dev/null || cp -an "$src" "$PROF_NM/$name" 2>/dev/null || true
  fi
done
echo "   已刷新插件链接"

echo "==> 初始化完成"

# 写入完成标记（含 bundle 大小），下次启动据此走飞速路径
mkdir -p "$DSH_HOME"
echo "$BUNDLE_SIZE" > "$ENV_DONE"
