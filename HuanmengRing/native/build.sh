#!/bin/bash
# ============================================================
#  build.sh — 构建「幻梦圆环」助手并组装成 .app
#
#  用法：bash native/build.sh            # 构建
#        bash native/build.sh run        # 构建并启动
#
#  产物：native/build/HuanmengRing.app
#
#  关于签名：这里用 ad-hoc 签名（codesign -s -）。
#  辅助功能权限是绑定到签名身份的，每次重新构建后
#  系统可能要求重新授权 —— 这是本地开发的正常现象，
#  不是权限配置错了。
# ============================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$HERE/HuanmengRing"
BUILD_DIR="$HERE/build"
APP="$BUILD_DIR/HuanmengRing.app"

echo "▶ 编译 Swift 包…"
cd "$PACKAGE_DIR"
swift build -c release

BINARY="$PACKAGE_DIR/.build/release/HuanmengRing"
if [ ! -f "$BINARY" ]; then
    echo "✗ 没有找到编译产物：$BINARY"
    exit 1
fi

echo "▶ 组装 .app…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/HuanmengRing"
cp "$PACKAGE_DIR/Resources/Info.plist" "$APP/Contents/Info.plist"
# 图标：没有就在构建时现画一张（图标是画出来的，见 make-icon.swift）
ICONS="$PACKAGE_DIR/Resources/AppIcon.icns"
if [ ! -f "$ICONS" ]; then
    echo "▶ 还没有图标，现画一张…"
    bash "$HERE/make-icon.sh" >/dev/null
fi
cp "$ICONS" "$APP/Contents/Resources/AppIcon.icns"
# 预设：把插件的全部预设打包进来，这样新机器装上就自带，
# 不用先连插件导一次（PresetStore 会读它）
if [ -f "$PACKAGE_DIR/Resources/presets.json" ]; then
    cp "$PACKAGE_DIR/Resources/presets.json" "$APP/Contents/Resources/presets.json"
fi
printf 'APPL????' > "$APP/Contents/PkgInfo"

# 签名身份决定「辅助功能授权能不能复用」：
#   · 用证书签名 → 身份是证书指纹，重新构建也不会让授权失效
#   · ad-hoc（-s -）→ 身份是二进制指纹 cdhash，每次重建都变，授权就失效
# 有证书就用证书，没有就退回 ad-hoc（功能一样，只是重建后要重新授权）。
SIGNING_KEYCHAIN="$HOME/Library/Keychains/huanmeng-signing.keychain-db"
IDENTITY="${SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ] && security find-identity -p codesigning "$SIGNING_KEYCHAIN" 2>/dev/null | grep -q "HuanmengRing Self-Signed"; then
    IDENTITY="HuanmengRing Self-Signed"
    # 重启后钥匙串会锁上，codesign 就用不了里面的证书了。
    # 解锁密码是脚本里写死的（那把钥匙串只装这一张一次性自签名证书）。
    security unlock-keychain -p "huanmeng-local" "$SIGNING_KEYCHAIN" 2>/dev/null || true
fi

if [ -n "$IDENTITY" ]; then
    echo "▶ 用证书签名：$IDENTITY"
    echo "  （重建不会让辅助功能授权失效）"
    codesign --force --deep --sign "$IDENTITY" "$APP" 2>&1 | sed 's/^/  /'
else
    echo "▶ ad-hoc 签名…"
    echo "  （每次重建都会换一个二进制指纹，需要重新授权一次）"
    echo "  想只授权一次：bash native/make-signing-cert.sh"
    codesign --force --deep --sign - "$APP" 2>&1 | sed 's/^/  /'
fi

echo "✓ 完成：$APP"
echo
echo "  省事做法：回上一级目录双击「安装.command」，构建/启动/自启/自检一次做完。"
echo
echo "  启动： open '$APP'"
echo "  权限： 首次运行会弹「辅助功能」授权框（只有 ⌥右键需要，⌥⌘R 不需要）。"
echo "         点菜单栏 ◎ →「⚠️ 点这里授予…」可直接跳到系统设置那一页，"
echo "         勾上之后不用重启助手，它自己会发现。"
echo "  自检： '$APP/Contents/MacOS/HuanmengRing' --doctor"
echo "  快捷键：⌥⌘R（可在 ~/.huanmeng-ring.json 里用 {\"hotkey\":\"ctrl+alt+cmd+r\"} 覆盖）"

if [ "${1:-}" = "run" ]; then
    echo
    echo "▶ 启动…"
    open "$APP"
fi
