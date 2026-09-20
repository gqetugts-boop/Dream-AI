#!/bin/bash
# ============================================================
#  体检.command — 双击就能查问题
#
#  不用开终端、不用记命令、不用看日志。
#  和菜单栏 →「自检…」是同一套检查，只是输出在窗口里方便复制。
# ============================================================

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1

APP="native/build/HuanmengRing.app"

printf "\n\033[1;34m幻梦圆环 · 自检\033[0m\n"
printf "\033[2m────────────────────────────────────────────────\033[0m\n\n"

if [ ! -x "$APP/Contents/MacOS/HuanmengRing" ]; then
    printf "\033[1;31m✗ 还没构建过\033[0m\n"
    printf "  先双击「安装.command」，或者执行：bash native/build.sh\n\n"
    printf "按回车关闭…"; read -r _
    exit 1
fi

printf "\033[2m（提示：下面「辅助功能权限」一项，从终端跑读到的可能是终端自身的权限，\033[0m\n"
printf "\033[2m  以菜单栏 ◎ →「自检…」的结果为准）\033[0m\n\n"

"$APP/Contents/MacOS/HuanmengRing" --doctor
STATUS=$?

printf "\n\033[2m────────────────────────────────────────────────\033[0m\n"
if pgrep -f "HuanmengRing.app/Contents/MacOS/HuanmengRing" > /dev/null; then
    printf "助手进程：\033[1;32m运行中\033[0m\n"
else
    printf "助手进程：\033[1;33m未运行\033[0m  ——  双击「安装.command」启动\n"
fi
printf "配置文件：%s\n" "$HOME/.huanmeng-ring.json"
printf "构建产物：%s\n" "$APP"

printf "\n按回车关闭…"
read -r _
exit $STATUS
