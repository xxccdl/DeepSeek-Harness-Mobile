#!/data/data/com.termux/files/usr/bin/bash
# DeepSeek Harness 手机版 — Termux 一键安装脚本
# 用法：在 Termux 中执行  bash termux-setup.sh （或粘贴整段命令）
# 安装完成后运行：dsh web --host 127.0.0.1 --port 3080

set -e

echo "==> 更新 Termux 软件源"
pkg update -y
pkg upgrade -y

echo "==> 安装运行依赖 (Node.js / 编译工具 / ripgrep / git)"
pkg install -y nodejs-lts clang make pkg-config ripgrep git

echo "==> 安装 dsh CLI（含原生模块编译，需要几分钟）"
npm install -g @deepseek-ai/dsh

echo ""
echo "==> 安装完成"
echo ""
echo "启动 dsh 服务（保持 Termux 在前台运行）:"
echo "    dsh web --host 127.0.0.1 --port 3080"
echo ""
echo "首次运行 dsh 会引导配置 DeepSeek API Key。"
