#!/bin/bash
# ============================================================
#  install.sh — 部署包的实际安装逻辑
#  由「一键安装.command」调用，也可以直接 bash 跑。
#
#  包内布局（脚本在 tools/ 下，包根在上一级）：
#    ../幻梦圆环/HuanmengRing.app    预构建助手，不需要 Xcode / Swift
#    ../插件/Dream-ps-ai              UXP 插件
#    tools/udt-load.mjs               走 UDT 通道加载插件
#    tools/install.sh                 本文件
# ============================================================

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# 同一个脚本要能在两种目录布局下工作：
#   发布包：ROOT/幻梦圆环/HuanmengRing.app + ROOT/插件/Dream-ps-ai
#   源码仓库：<repo>/HuanmengRing/native/build/HuanmengRing.app + <repo>/Dream-ps-ai
# 自动探测，省得维护两份安装逻辑（两份迟早会不一致）。
if [ -d "$ROOT/幻梦圆环/HuanmengRing.app" ]; then
    APP_SRC="$ROOT/幻梦圆环/HuanmengRing.app"
    PLUGIN_SRC="$ROOT/插件/Dream-ps-ai"
else
    # native/deploy → 上三级才是仓库根。
    # 注意是**三级**：HuanmengRing/native/deploy 的上一层是 HuanmengRing，
    # 再上一层是仓库根（Dream AI/，里面同时放着 HuanmengRing/ 和 Dream-ps-ai/）。
    # 这里以前写的是两级，目录重组成大仓库之后就找错地方了。
    REPO="$(cd "$HERE/../../.." && pwd)"
    APP_SRC="$REPO/HuanmengRing/native/build/HuanmengRing.app"
    PLUGIN_SRC="$REPO/Dream-ps-ai"
fi

UDT_LOADER="$HERE/udt-load.mjs"

APP_DEST="$HOME/Applications/HuanmengRing.app"
SUPPORT="$HOME/Library/Application Support/HuanmengRing"
PID_FILE="$SUPPORT/udt-loader.pid"
PLIST="$HOME/Library/LaunchAgents/com.huanmeng.ring.plist"
LABEL="com.huanmeng.ring"
STATUS_FILE="$HOME/.huanmeng-ring-status.json"

RUNNING_PATTERN="HuanmengRing.app/Contents/MacOS/HuanmengRing"

BLUE='\033[1;34m'; GREEN='\033[1;32m'; YELLOW='\033[1;33m'; RED='\033[1;31m'; DIM='\033[2m'; OFF='\033[0m'
step() { printf "\n${BLUE}▶ %s${OFF}\n" "$1"; }
ok()   { printf "${GREEN}✓ %s${OFF}\n" "$1"; }
warn() { printf "${YELLOW}! %s${OFF}\n" "$1"; }
bad()  { printf "${RED}✗ %s${OFF}\n" "$1"; }
dim()  { printf "${DIM}  %s${OFF}\n" "$1"; }

# 助手自己写的状态：trusted / tapActive / bridgeConnected …
status_field() {
    [ -f "$STATUS_FILE" ] || return 1
    python3 -c "
import json,sys
try:
    d=json.load(open('$STATUS_FILE'))
    print(d.get('$1'))
except Exception:
    sys.exit(1)
" 2>/dev/null
}

helper_pid() { pgrep -f "$RUNNING_PATTERN" | head -1; }

printf "\n${BLUE}幻梦AI · 一键部署${OFF}\n"
printf "${DIM}────────────────────────────────────────────────${OFF}\n"

# ---------- 0. 环境检查 ----------

step "0/6  环境检查"

if [ "$(uname -s)" != "Darwin" ]; then
    bad "这个包只能在 macOS 上用"; exit 1
fi
dim "macOS $(sw_vers -productVersion)"

if [ -d "/Applications/Adobe Photoshop 2025" ] || \
   [ -d "/Applications/Adobe Photoshop 2026" ] || \
   pgrep -f "Adobe Photoshop.*MacOS" >/dev/null 2>&1; then
    ok "找到 Photoshop"
else
    warn "没找到 Photoshop —— 助手能装，但插件要等 PS 装好后再加载"
fi

if [ -d "/Applications/Adobe UXP Developer Tools/Adobe UXP Developer Tools.app" ]; then
    ok "找到 UXP Developer Tools"
    HAS_UDT=1
else
    warn "没找到 UXP Developer Tools —— 插件无法自动加载，需要先装它"
    HAS_UDT=0
fi

if command -v node >/dev/null 2>&1; then
    ok "node $(node -v)（用来把插件加载进 Photoshop）"
    HAS_NODE=1
else
    warn "没有 node —— 插件需要你手动在 UDT 里点 Load"
    HAS_NODE=0
fi

if [ ! -d "$APP_SRC" ]; then
    bad "找不到助手：$APP_SRC"
    if [ -n "${REPO:-}" ]; then
        printf "  ${DIM}源码仓库里还没有构建产物，先跑一次：${OFF}\n"
        printf "  ${DIM}    bash HuanmengRing/native/build.sh${OFF}\n"
    fi
    exit 1
fi
if [ ! -f "$PLUGIN_SRC/manifest.json" ]; then
    bad "找不到插件：$PLUGIN_SRC"; exit 1
fi

# ---------- 1. 安装助手 ----------

step "1/6  安装助手"

# 关键：辅助功能授权是绑定到二进制指纹（cdhash）的。换了内容就要重新授权，
# 内容没变则换不换路径都无所谓（指纹一样，TCC 认的就是同一个）。
#
# 所以判断依据是**指纹**，不是「有没有在跑」：
#   · 正在跑的助手指纹 == 要装的那份 → 什么都不用做，连进程都不用重启
#   · 指纹不同 → 装新的（用户需要重新授权一次，这里会提前说清楚）
#
# 早先的版本只看「有没有已授权且在跑的」，结果是：如果用户当初是直接从
# 构建目录启动的（autostart.sh 的老毛病），自启就会被一直钉在那个目录上 ——
# 而构建目录每次 build.sh 都会被整个替换掉，授权也就每次失效。
cdhash_of() {
    codesign -dvvv "$1" 2>&1 | awk -F= '/^CDHash=/{print $2; exit}'
}

SRC_HASH="$(cdhash_of "$APP_SRC")"
DEST_HASH="$(cdhash_of "$APP_DEST" 2>/dev/null || echo '')"

if [ -n "$SRC_HASH" ] && [ "$SRC_HASH" = "$DEST_HASH" ]; then
    ok "安装目录里已经是这一份（指纹相同），不用重新复制"
    dim "路径：$APP_DEST"
    # 之前从别的地方（比如构建目录）启动的实例要停掉 ——
    # 自启马上会换成安装目录这一份，留着会两个实例抢 8799 端口。
    # 指纹相同，所以停掉不会影响已有的辅助功能授权。
    if [ -n "$(helper_pid)" ]; then
        RUNNING_PATH="$(ps -p "$(helper_pid)" -o comm= 2>/dev/null || echo '')"
        if [ "$RUNNING_PATH" != "$APP_DEST/Contents/MacOS/HuanmengRing" ]; then
            dim "把从别处启动的那个实例换成安装目录这份"
            pkill -f "$RUNNING_PATTERN" 2>/dev/null || true
            sleep 1
        fi
    fi
else
    if [ -n "$(helper_pid)" ]; then
        TRUSTED="$(status_field trusted || echo '')"
        [ "$TRUSTED" = "True" ] && \
            dim "这次装的是新版本，正在跑的旧实例要换掉 —— 换完需要重新授权一次"
    fi
    pkill -f "$RUNNING_PATTERN" 2>/dev/null || true
    sleep 1
    mkdir -p "$HOME/Applications"
    rm -rf "$APP_DEST"
    # 用 ditto 而不是 cp -R：ditto 会完整保留权限和扩展属性，
    # 用 cp 复制后签名有可能失效（用 codesign 校验过再放行）
    ditto "$APP_SRC" "$APP_DEST"

    if codesign --verify --deep --strict "$APP_DEST" 2>/dev/null; then
        ok "已安装到 $APP_DEST"
    else
        bad "复制后签名校验失败，这会导致授权不上"
        dim "请把整个部署包用 ditto 重新解压后再试（Finder 解压有时会破坏签名）"
        exit 1
    fi
fi

# ---------- 2. 开机自启 ----------

step "2/6  设置开机自启"

mkdir -p "$HOME/Library/LaunchAgents"
# 自启**永远指向安装目录**，不指向构建目录。
# 构建目录（native/build/）每次 build.sh 都会 rm -rf 重建，
# 把自启钉在那里 = 每次重建都换一次二进制 = 每次都要重新授权。
TARGET_BIN="$APP_DEST/Contents/MacOS/HuanmengRing"

PLIST_OK=0
if [ -f "$PLIST" ] && grep -q "$TARGET_BIN" "$PLIST" 2>/dev/null && [ -n "$(helper_pid)" ]; then
    # plist 已经指向同一个二进制、助手也正在跑 —— 重新 load 会把正在工作的
    # 助手杀掉重启，白白打断用户。没必要动。
    PLIST_OK=1
    ok "开机自启已经配好了，跳过"
fi

if [ "$PLIST_OK" = "0" ]; then
    # 自启路径要变了（多半是从构建目录迁到安装目录）：先把旧实例停掉。
    # 不停的话 launchctl load 会再拉起一个，两个实例抢 8799 端口 ——
    # 那正是「圆环显示未连接」的经典故障。
    if [ -n "$(helper_pid)" ]; then
        pkill -f "$RUNNING_PATTERN" 2>/dev/null || true
        sleep 1
    fi
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$TARGET_BIN</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
    <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST_EOF

    launchctl unload "$PLIST" 2>/dev/null || true
    # 只让 launchctl 负责启动。先 open 再 load 会拉起两个实例抢 8799 端口 ——
    # 那正是「圆环显示未连接」的经典故障。
    launchctl load "$PLIST" 2>/dev/null && ok "已设置开机自启" || warn "自启动设置失败"

    sleep 2
fi

if [ -z "$(helper_pid)" ]; then
    [ -d "$APP_DEST" ] && open "$APP_DEST" 2>/dev/null
    sleep 2
fi

if [ -n "$(helper_pid)" ]; then
    ok "助手已在运行（菜单栏会出现一个 ◎）"
else
    bad "助手没启动起来，试试手动打开：$APP_DEST"
fi

# ---------- 3. 辅助功能授权 ----------

step "3/6  辅助功能授权（只有 ⌥右键需要）"

TRUSTED="$(status_field trusted || echo '')"
if [ "$TRUSTED" = "True" ]; then
    ok "已经授权过了"
else
    printf "  现在应该弹出了一个系统授权框：\n"
    printf "    ${YELLOW}「HuanmengRing 想控制这台电脑」→ 点「打开系统设置」${OFF}\n"
    printf "  然后在列表里把 ${YELLOW}HuanmengRing${OFF} 的开关打开。\n\n"

    # 把框和设置页都拉到前台。助手是 .accessory（不进 Dock、不抢焦点），
    # 不这么做的话授权框会开在别的窗口后面，用户根本看不见。
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null
    osascript -e 'tell application "System Settings" to activate' 2>/dev/null

    printf "  ${DIM}（没看到框？点菜单栏 ◎ → 那一行「⚠️ 点这里授予…」）${OFF}\n"
    printf "  等待授权中"

    GRANTED=0
    for _ in $(seq 1 60); do   # 最多等 90 秒
        sleep 1.5
        printf "."
        if [ "$(status_field trusted || echo '')" = "True" ]; then
            GRANTED=1
            break
        fi
    done
    printf "\n"

    if [ "$GRANTED" = "1" ]; then
        ok "授权成功，⌥右键已可用（助手自己发现的，没重启）"
    else
        warn "还没等到授权 —— 不影响快捷键 ⌥⌘R，之后想开 ⌥右键随时点菜单栏那行"
    fi
fi

# ---------- 4. 加载插件 ----------

step "4/6  把插件加载进 Photoshop"

PLUGIN_OK=0

# 插件已经连上了就别再加载一次 —— 会开出第二个实例，
# 两个实例抢同一个桥接端口，表现为圆环状态乱跳。这是「检查现状再动手」。
if [ "$(status_field bridgeConnected || echo '')" = "True" ]; then
    ok "插件已经加载并连上了，跳过"
    PLUGIN_OK=2
fi

if [ "$PLUGIN_OK" = "0" ] && [ "$HAS_NODE" = "1" ] && [ "$HAS_UDT" = "1" ]; then
    if ! pgrep -f "Adobe UXP Developer Tools.app/Contents/MacOS" >/dev/null 2>&1; then
        dim "UDT 没在跑，先启动它…"
        open -a "Adobe UXP Developer Tools" 2>/dev/null
        sleep 6
    fi
    if ! pgrep -f "Adobe Photoshop.*MacOS" >/dev/null 2>&1; then
        dim "Photoshop 没在跑，先启动它…"
        open -a "Adobe Photoshop 2025" 2>/dev/null || open -a "Adobe Photoshop 2026" 2>/dev/null
        sleep 15
    fi

    # 先探一下通道通不通，避免直接 load 时报一个看不懂的错
    if node "$UDT_LOADER" --probe >/dev/null 2>&1; then
        mkdir -p "$SUPPORT"
        # 常驻运行：UDT 的 CLI 会话绑定在 WebSocket 连接上，
        # 连接一断会话就没了，所以必须让这个进程活着。
        nohup node "$UDT_LOADER" "$PLUGIN_SRC" --pid-file "$PID_FILE" \
            > "$SUPPORT/udt-loader.log" 2>&1 &
        sleep 4

        if [ -f "$PID_FILE" ]; then
            ok "插件已加载（后台进程 PID $(cat "$PID_FILE")）"
            PLUGIN_OK=1
        else
            warn "加载没成功，日志：$SUPPORT/udt-loader.log"
            tail -5 "$SUPPORT/udt-loader.log" 2>/dev/null | sed 's/^/    /'
        fi
    else
        warn "UDT 通道连不上 —— 请确认 UDT 和 Photoshop 都开着"
    fi
elif [ "$PLUGIN_OK" = "0" ]; then
    warn "缺少 node 或 UDT，跳过自动加载"
fi

if [ "$PLUGIN_OK" = "0" ]; then
    printf "\n  ${YELLOW}手动加载（一次即可，之后 UDT 里一直有）${OFF}\n"
    printf "    1. 打开 UXP Developer Tools\n"
    printf "    2. Add Plugin → 选这个文件夹：\n"
    printf "       ${DIM}$PLUGIN_SRC${OFF}\n"
    printf "    3. 点 Load\n"
    printf "    4. 在 Photoshop 里打开：插件 → 幻梦AI 修图插件\n"
fi

# ---------- 5. 自检 ----------

step "5/6  自检"

DOCTOR="$APP_DEST/Contents/MacOS/HuanmengRing"

if [ -x "$DOCTOR" ]; then
    sleep 2
    "$DOCTOR" --doctor
else
    warn "找不到助手可执行文件，跳过自检"
fi

# ---------- 6. 完事 ----------

step "6/6  完成"
printf "\n"
printf "  唤出圆环：${YELLOW}⌥⌘R${OFF}  或  在 Photoshop 画布上按 ${YELLOW}⌥ 再点右键${OFF}\n"
printf "  ${DIM}注意：⌥右键只在 Photoshop 位于前台时生效 —— 这是刻意的，${OFF}\n"
printf "  ${DIM}否则你在任何软件里按 ⌥右键都会弹出圆环。${OFF}\n"
printf "\n"
printf "  出问题：菜单栏 ${YELLOW}◎ → 自检…${OFF}，它会直接告诉你哪儿不对。\n"
printf "  配置：  菜单栏 ◎ → 偏好设置…（外观/交互/内容全部可调）\n"
printf "  卸载：  双击部署包里的「一键卸载.command」\n"
printf "\n"
