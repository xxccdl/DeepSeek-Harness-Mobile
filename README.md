# DeepSeek Harness Mobile

在 Android 手机上运行 [DeepSeek Harness](https://github.com/xxccdl/deepseek-harness-desktop)（dsh）AI 助手的 React Native 应用。

内置完整 Linux 环境（Termux + proot-distro Debian 容器），无需 root。AI 可以读写文件、执行命令、安装软件包，甚至可以读取屏幕并操控手机。

## 功能

- **内置 dsh 引擎**：嵌入式 Node.js 运行时 + dsh-bundle，首次启动自动解压 Termux bootstrap 并启动 dsh Web 服务
- **完整 Linux 环境**：proot-distro 运行 Debian 容器，AI 可通过 bash 工具执行 `apt` / `pip` / `git` 等命令
- **手机控制**：无障碍服务 + 本地 HTTP 桥接，AI 可读取屏幕元素、点击、长按、滑动、输入、滚动、按键、打开应用等
- **AI 产物一键保存**：AI 完成产物后发送给用户，一键保存到 `Download/DeepSeekHarness`
- **任务通知**：AI 任务完成、产物保存时通过系统通知提醒
- **移动端适配**：深色主题、触屏优化、欢迎向导

## 架构

React Native (0.87) 壳层 + 原生 Android 模块：

| 模块 | 说明 |
| --- | --- |
| `TermuxEngine` | 嵌入式 Termux 引擎：解压 bootstrap、初始化环境、启动 dsh Web 服务 |
| `PhoneAccessibilityService` / `PhoneControlHttp` | 无障碍服务 + 本地 HTTP（`127.0.0.1:3090`），供 dsh-tool-phone 插件调用 |
| `DeliverSaver` / `DeliverReceiver` | 产物保存到 `Download/DeepSeekHarness` + 通知点击保存 |

启动流程：

1. App 启动 → 解压 Termux bootstrap → 安装 nodejs / ripgrep → 配置 npm 镜像
2. 安装 dsh 引擎（dsh-bundle.dat）→ 解压 Debian rootfs（proot-distro）
3. 启动 dsh Web 服务（`127.0.0.1:3080`）→ React Native WebView 加载聊天界面

## 目录结构

```
├── android/                  # Android 原生工程（Kotlin 模块在 android/app/src/main/java/com/dshmobile/）
├── src/                      # React Native 界面（SplashScreen / InitScreen / ChatScreen）
├── scripts/                  # 资产构建脚本（bundle-dsh / pack-node-runtime 等）
├── proot-distro/             # proot-distro 打包脚本
├── plugins/                  # dsh 插件源码（@deepseek-ai/*）
└── ...
```

## 插件

本仓库 `plugins/@deepseek-ai/` 收录移动端用到的 dsh 插件源码，包括：

- **手机控制**：`dsh-tool-phone` / `dsh-client-ui-phone-control`（无障碍读屏 + 点击/滑动/输入等）
- **悬浮球**：`dsh-client-ui-floatball`
- **产物交付**：`dsh-tool-deliver` / `dsh-client-ui-deliver`（一键保存到下载目录）
- **检查更新**：`dsh-client-ui-updatecheck`
- **移动端 UI 魔改**：`dsh-client-ui-mobile`（DeepSeek 风格、上传面板、窄屏适配）
- **移动桥接**：`dsh-mobile-bridge`（通知/保存等原生桥接）
- 以及 `dsh-tool-vision`、`dsh-tool-webfetch`、`dsh-tool-snippets`、`dsh-command-btw` 等

插件通过 `scripts/bundle-dsh.mjs` 打进 `dsh-bundle.dat`（在 `EXTRA_PKGS` 中声明的包）。

## 构建（Android）

### 环境要求

- Node.js ≥ 22.11
- JDK 17（见 `android/gradle.properties` 中的 `org.gradle.java.installations.paths`）
- Android SDK / Android Studio

### 运行时资产

为保持仓库精简，以下大体积运行时数据**不入库**，需先构建或从 Release 获取：

| 资产 | 生成方式 |
| --- | --- |
| `android/app/src/main/assets/dsh/dsh-bundle.dat` | `node scripts/bundle-dsh.mjs`（dsh 引擎依赖闭包） |
| `android/app/src/main/assets/dsh/node-runtime.dat` | `node scripts/pack-node-runtime.mjs`（嵌入式 Node 运行时） |
| `android/app/src/main/assets/dsh/debian-rootfs.tar.gz` | `proot-distro/pack-proot.mjs`（Debian rootfs） |
| `android/app/src/main/assets/termux/bootstrap-aarch64.zip` | Termux bootstrap 包 |
| `mmmbuto-node-pty-android-arm64-1.1.2.tgz` | node-pty Android 预编译包 |

> 注意：资产构建脚本是开发期工具，部分路径指向本地桌面版 dsh 仓库
> （如 `scripts/bundle-dsh.mjs` 中的 `SRC_NM = d:/code/dsh-gui/node_modules`），
> 开源后需按自己的环境调整这些路径。

### 构建 APK

```sh
npm install
cd android
./gradlew assembleRelease
```

生成 APK：`android/app/build/outputs/apk/release/app-release.apk`

> ⚠️ **签名**：仓库默认 release 构建复用 debug keystore（仅用于开发调试）。
> 正式分发请在 `android/keystore.properties` 配置自己的 keystore（模板：
> `storeFile`、`storePassword`、`keyAlias`、`keyPassword`，文件不入库）。
> 存在该文件时自动使用正式签名，缺失时回退 debug 签名保证可直接构建。

## 使用

1. 首次启动自动初始化环境并请求无障碍权限（手机控制）
2. 在系统设置 → 无障碍中开启 DeepSeek Harness
3. 打开 App，在设置页的「手机控制」分区可验证屏幕读取

## 致谢

- [DeepSeek Harness](https://github.com/xxccdl/deepseek-harness-desktop) — dsh 引擎（MIT）
- [Termux](https://github.com/termux) — Android 终端环境
- [proot-distro](https://github.com/termux/proot-distro) — Linux 发行版容器

## 许可证

[MIT](LICENSE)
