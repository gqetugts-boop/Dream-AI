#!/bin/bash
# ============================================================
#  一键安装.command — 从源码仓库安装幻梦AI
#
#  双击即可。它会：编译助手 → 安装 → 设置自启 → 引导授权 →
#  把插件加载进 Photoshop → 跑自检。
#
#  ⚠ 这是「从源码构建」的路径，需要 Swift 工具链（Xcode Command Line Tools）。
#    如果你拿到的是打包好的发布包（有「幻梦圆环/」和「插件/」两个目录），
#    用那个里面的「一键安装.command」，不需要编译。
#
#  为什么源码版要重新编译：.app 是构建产物，不进版本库（76M 的 Swift
#  缓存 + 每次构建 cdhash 都会变，进了 git 只会让仓库膨胀且无法复用）。
# ============================================================

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1

BLUE='\033[1;34m'; GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'; DIM='\033[2m'; OFF='\033[0m'
step() { printf "\n${BLUE}▶ %s${OFF}\n" "$1"; }
ok()   { printf "${GREEN}✓ %s${OFF}\n" "$1"; }
warn() { printf "${YELLOW}! %s${OFF}\n" "$1"; }
bad()  { printf "${RED}✗ %s${OFF}\n" "$1"; }

printf "\n${BLUE}幻梦AI · 从源码安装${OFF}\n"
printf "${DIM}────────────────────────────────────────────────${OFF}\n"

# ---------- 1. 工具链 ----------

step "1/2  检查构建工具链"

if [ "$(uname -s)" != "Darwin" ]; then
    bad "幻梦圆环助手目前只有 macOS 版（Windows 版还没编译验证过）"
    printf "  插件本身是跨平台的，可以单独用 UDT 加载 Dream-ps-ai/。\n"
    printf "\n按回车关闭…"; read -r _
    exit 1
fi
printf "${DIM}  macOS %s${OFF}\n" "$(sw_vers -productVersion)"

if ! command -v swift >/dev/null 2>&1; then
    bad "没有找到 swift"
    printf "\n   需要 Xcode Command Line Tools，执行这条命令安装：\n"
    printf "   ${YELLOW}    xcode-select --install${OFF}\n"
    printf "\n   弹窗里点「安装」，装完再双击一次本文件。\n"
    printf "\n按回车关闭…"; read -r _
    exit 1
fi
ok "swift $(swift --version 2>/dev/null | head -1 | sed 's/.*version //;s/ .*//')"

# 首次构建要下载依赖，网络不好会很久
printf "${DIM}  首次构建需要几分钟（要下载 Swift 依赖），之后是几秒${OFF}\n"

# ---------- 2. 构建 + 安装 ----------

step "2/2  编译并安装"

if ! bash HuanmengRing/native/build.sh 2>&1 | tail -3; then
    bad "编译失败"
    printf "  把上面的报错完整复制出来可以定位问题。\n"
    printf "\n按回车关闭…"; read -r _
    exit 1
fi

if [ ! -d "HuanmengRing/native/build/HuanmengRing.app" ]; then
    bad "编译似乎没产出 .app，请检查上面的输出"
    printf "\n按回车关闭…"; read -r _
    exit 1
fi
ok "助手编译完成"

# 后面交给统一的安装脚本：安装 / 自启 / 授权引导 / 加载插件 / 自检
# 它也能在发布包的目录结构下工作，两种布局共用一套逻辑
bash HuanmengRing/native/deploy/install.sh

printf "\n${DIM}────────────────────────────────────────────────${OFF}\n"
printf "  插件：${YELLOW}Dream-ps-ai/${OFF}（跨平台，Windows 上也能用）\n"
printf "  文档：${YELLOW}HuanmengRing/使用说明.md${OFF}\n"
printf "  出问题：菜单栏 ${YELLOW}◎ → 自检…${OFF}\n"
printf "\n按回车关闭这个窗口…"
read -r _
