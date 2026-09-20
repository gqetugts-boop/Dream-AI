#!/bin/bash
# ============================================================
#  make-icon.sh — 生成 AppIcon.icns
#
#  用法：bash native/make-icon.sh
#  产物：native/HuanmengRing/Resources/AppIcon.icns
#
#  设计是**画**出来的（make-icon.swift），不是拿图生图生成的：
#  图标要用和圆环界面同一套几何与配色，只能从同一份数字来。
#
#  改了图标长什么样 → 重跑这个 → 再跑 build.sh。
# ============================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$HERE/make-icon.swift"
RESOURCES="$HERE/HuanmengRing/Resources"
OUT="$RESOURCES/AppIcon.icns"

if [ ! -f "$SOURCE" ]; then
    echo "✗ 找不到 $SOURCE"
    exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "▶ 画 1024×1024 母图…"
swift "$SOURCE" "$WORK/icon.png" 1024

ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"

# macOS 要的那几档。16/32 那几张是访达列表和菜单里用的，
# 从 1024 直接缩下去会糊，所以每一档都单独缩（sips 的插值够用）。
echo "▶ 切图…"
for spec in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" \
            "128 128x128" "256 128x128@2x" "256 256x256" "512 256x256@2x" \
            "512 512x512" "1024 512x512@2x"; do
    pixels="${spec%% *}"
    name="${spec#* }"
    sips -z "$pixels" "$pixels" "$WORK/icon.png" --out "$ICONSET/icon_$name.png" >/dev/null 2>&1
done

echo "▶ 打成 .icns…"
mkdir -p "$RESOURCES"
iconutil -c icns "$ICONSET" -o "$OUT"

echo "✓ $OUT（$(du -h "$OUT" | cut -f1)）"
