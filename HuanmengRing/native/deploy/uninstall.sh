#!/bin/bash
# ============================================================
#  uninstall.sh — 卸载
#
#  会清掉：插件会话、后台加载进程、助手、开机自启、安装到
#          ~/Applications 的副本。
#  不会动：你的配置 ~/.huanmeng-ring.json（要删得单独确认）
#          Photoshop 里的插件（那个得在 UDT 里 Unload）
# ============================================================

set -uo pipefail

APP_DEST="$HOME/Applications/HuanmengRing.app"
SUPPORT="$HOME/Library/Application Support/HuanmengRing"
PID_FILE="$SUPPORT/udt-loader.pid"
PLIST="$HOME/Library/LaunchAgents/com.huanmeng.ring.plist"
STATUS_FILE="$HOME/.huanmeng-ring-status.json"
RUNNING_PATTERN="HuanmengRing.app/Contents/MacOS/HuanmengRing"

GREEN='\033[1;32m'; BLUE='\033[1;34m'; YELLOW='\033[1;33m'; DIM='\033[2m'; OFF='\033[0m'
step() { printf "\n${BLUE}▶ %s${OFF}\n" "$1"; }
ok()   { printf "${GREEN}✓ %s${OFF}\n" "$1"; }
dim()  { printf "${DIM}  %s${OFF}\n" "$1"; }

printf "\n${BLUE}幻梦AI · 卸载${OFF}\n"

step "1/5  卸载插件会话"
if [ -f "$PID_FILE" ]; then
    LOADER_PID="$(cat "$PID_FILE" 2>/dev/null)"
    if [ -n "$LOADER_PID" ] && kill -0 "$LOADER_PID" 2>/dev/null; then
        # SIGTERM 会触发脚本里的 unload 分支，把插件从 Photoshop 里摘掉
        kill -TERM "$LOADER_PID" 2>/dev/null
        sleep 2
        ok "已通知加载进程卸载插件"
    fi
    rm -f "$PID_FILE"
else
    dim "没有后台加载进程"
fi
pkill -f "udt-load.mjs" 2>/dev/null && ok "已清理残留的加载进程" || true

step "2/5  停止助手"
if pkill -f "$RUNNING_PATTERN" 2>/dev/null; then
    sleep 1
    ok "已停止"
else
    dim "本来就没在跑"
fi

step "3/5  取消开机自启"
if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    ok "已取消"
else
    dim "本来就没设置"
fi

step "4/5  删除安装的副本"
if [ -d "$APP_DEST" ]; then
    rm -rf "$APP_DEST"
    ok "已删除 $APP_DEST"
else
    dim "没有安装到 ~/Applications"
fi
rm -rf "$SUPPORT"
rm -f "$STATUS_FILE"

step "5/5  完成"
printf "\n"
printf "  还差两件要手动做的：\n"
printf "    1. ${YELLOW}系统设置 → 隐私与安全性 → 辅助功能${OFF}\n"
printf "       把 HuanmengRing 移除（用 − 号）\n"
printf "    2. ${YELLOW}UXP Developer Tools 里把插件 Unload / 移除${OFF}\n"
printf "\n"
printf "  ${DIM}配置文件 ~/.huanmeng-ring.json 保留着（里面是你的配色和设置）。${OFF}\n"
printf "  ${DIM}要删的话：rm ~/.huanmeng-ring.json${OFF}\n"
printf "\n"
