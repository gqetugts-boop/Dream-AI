#!/bin/bash
# 双击这个文件即可。会打开终端窗口，装完按回车关闭。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1
bash tools/install.sh
printf "按回车关闭这个窗口…"
read -r _
