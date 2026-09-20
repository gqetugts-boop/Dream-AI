#!/bin/bash
# ============================================================
#  安装.command — 双击这个文件就行
#
#  它会：构建 → 设置开机自启 → 启动助手 → 跑一遍自检 → 告诉你下一步做什么。
#  不需要懂终端，也不需要记住任何命令。
#
#  （macOS 可能会问「是否允许打开」，点「打开」即可 ——
#    这是本地自己创建的脚本，没有从网上下载，不存在安全风险。）
# ============================================================

# 双击运行时 $0 未必是绝对路径，用 BASH_SOURCE 定位更稳
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1

BLUE='\033[1;34m'; GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'; DIM='\033[2m'; OFF='\033[0m'

line() { printf "${DIM}────────────────────────────────────────────────${OFF}\n"; }
step() { printf "\n${BLUE}▶ %s${OFF}\n" "$1"; }
ok()   { printf "${GREEN}✓ %s${OFF}\n" "$1"; }
warn() { printf "${YELLOW}! %s${OFF}\n" "$1"; }
bad()  { printf "${RED}✗ %s${OFF}\n" "$1"; }

printf "\n${BLUE}幻梦圆环 · 一键安装${OFF}\n"
line

# ---------- 1. 构建 ----------

step "1/4  构建助手（第一次大约 30 秒，之后几秒）"
if ! bash native/build.sh > /tmp/huanmeng-build.log 2>&1; then
    bad "构建失败。日志：/tmp/huanmeng-build.log"
    printf "${DIM}  最后 15 行：${OFF}\n"
    tail -15 /tmp/huanmeng-build.log | sed 's/^/    /'
    printf "\n按回车关闭…"; read -r _
    exit 1
fi
ok "构建完成"

APP="native/build/HuanmengRing.app"

RUNNING_PATTERN="HuanmengRing.app/Contents/MacOS/HuanmengRing"

# ---------- 2. 关掉正在跑的旧实例 ----------

step "2/4  重启助手"
if pgrep -f "$RUNNING_PATTERN" > /dev/null; then
    pkill -f "$RUNNING_PATTERN" 2>/dev/null
    sleep 1
    ok "已关掉旧实例"
else
    ok "没有旧实例在跑"
fi

# ---------- 3. 设置自启（顺便就启动了）----------
#
#  顺序很重要：先 open 再 launchctl load 的话，RunAtLoad 会再拉起一个实例，
#  两个助手抢 8799 端口 —— 正好是「圆环显示未连接」的那个经典故障。
#  所以这里只让 launchctl 负责启动。

step "3/4  设置开机自动启动并启动"
if bash native/autostart.sh install > /dev/null 2>&1; then
    ok "以后开机自动运行，不用再管它"
else
    warn "自启动没设置成功，改用直接启动"
fi

sleep 2
if ! pgrep -f "$RUNNING_PATTERN" > /dev/null; then
    # launchctl 没能拉起来（例如 plist 被系统拒绝），退回直接打开
    open "$APP"
    sleep 2
fi

if pgrep -f "$RUNNING_PATTERN" > /dev/null; then
    ok "助手已在运行（看菜单栏的 ◎）"
else
    bad "助手没能启动。手动试试：open '$APP'"
fi

# ---------- 4. 自检 ----------

step "4/4  自检"
printf "\n"
"$APP/Contents/MacOS/HuanmengRing" --doctor
DOCTOR_EXIT=$?

# ---------- 下一步 ----------

printf "\n"
line
if [ "$DOCTOR_EXIT" -ne 0 ]; then
    warn "上面有标 ❌ 的项，先照着说明处理"
fi

cat <<'NEXT'

接下来还差两步（都是一次性的）：

  1. 授权「辅助功能」—— 只有 ⌥右键唤出需要，⌥⌘R 不需要权限
     · 点菜单栏的 ◎ → 那一行「⚠️ 点这里授予…」，会直接跳到系统设置
     · 在列表里勾上 HuanmengRing
     · 勾完不用重启，助手几秒内自己就会发现

  2. 在 Photoshop 里加载插件
     · 打开 UXP Developer Tool → Add Plugin → 选 Dream-ps-ai → Load
     · 顺便把 com.huanmeng.ai.satellite 之类的旧卫星插件 Unload 掉，
       它会和主插件抢 8799 端口，是「圆环显示未连接」最常见的原因
     · 然后在 PS 里打开：插件 → 幻梦AI 修图插件

菜单栏图标 ◎ = 插件已连上，○ = 还没连上。
出任何问题：菜单栏 ◎ → 自检…，它会告诉你哪儿不对。

完整说明见：使用说明.md

NEXT

printf "按回车关闭这个窗口…"
read -r _
