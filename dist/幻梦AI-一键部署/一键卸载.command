#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1
bash tools/uninstall.sh
printf "按回车关闭这个窗口…"
read -r _
