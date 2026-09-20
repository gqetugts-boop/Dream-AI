#!/bin/bash
# ============================================================
#  package.sh — 把「幻梦圆环」打包成可分发的 DMG
#
#  用法：bash native/package.sh
#  产物：dist/幻梦圆环-<版本>.dmg
#
#  签名说明：这里用 ad-hoc 签名（codesign -s -）。
#  没有 Apple Developer ID 也能分发，但对方第一次打开时
#  需要在「系统设置 → 隐私与安全性」里点「仍要打开」。
#  有 Developer ID 的话把 SIGN_IDENTITY 环境变量传进来即可自动用上：
#    SIGN_IDENTITY="Developer ID Application: XXX (TEAMID)" bash native/package.sh
# ============================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP_NAME="幻梦圆环"
BUNDLE="HuanmengRing"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$HERE/HuanmengRing/Resources/Info.plist" 2>/dev/null || echo "0.1.0")"
DIST="$ROOT/dist"
STAGE="$DIST/stage"

echo "▶ 构建 $BUNDLE $VERSION"
bash "$HERE/build.sh" >/dev/null

APP="$HERE/build/$BUNDLE.app"
if [ ! -d "$APP" ]; then
    echo "✗ 找不到 $APP"
    exit 1
fi

# 有 Developer ID 就用正式签名，否则 ad-hoc
if [ -n "${SIGN_IDENTITY:-}" ]; then
    echo "▶ 使用正式签名：$SIGN_IDENTITY"
    codesign --force --deep --options runtime --sign "$SIGN_IDENTITY" "$APP"
else
    echo "▶ ad-hoc 签名（对方首次打开需在「隐私与安全性」里放行）"
    codesign --force --deep --sign - "$APP" 2>/dev/null
fi

echo "▶ 组装分发包"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# 把 .app 改成中文名，Finder 里好看
cp -R "$APP" "$STAGE/$APP_NAME.app"

cat > "$STAGE/安装说明.txt" <<'README_EOF'
幻梦圆环 —— Photoshop 画布上的圆环菜单助手
================================================

一、安装
  1. 把「幻梦圆环.app」拖到「应用程序」文件夹
  2. 双击打开。第一次会被 macOS 拦住（未签名应用），
     去「系统设置 → 隐私与安全性」，在底部点「仍要打开」
  3. 首次运行会请求「辅助功能」权限 —— 这是为了让 ⌥右键
     能在 Photoshop 画布上被截获。在同一个设置页里勾选本程序，
     然后退出重开一次。

二、使用
  · ⌥⌘R               在鼠标位置唤出圆环
  · 在 Photoshop 里按住 ⌥ 再点右键   同样唤出（只在 PS 前台时生效）
  · 移动鼠标高亮扇区，左键点击确认；数字键 1-9 直选
  · Esc 关闭整个圆环，← 或 Delete 返回上一级
  · 菜单栏的 ◎ 图标显示连接状态：
      实心 ◎ 已连接 Photoshop 插件
      空心 ○ 等待插件（面板里会显示「正在连接圆环…」）
  · 退出助手请在菜单栏图标里选「退出幻梦圆环」

三、前置条件
  需要安装「幻梦AI 修图插件」（UXP 插件）并加载面板，
  圆环里的数据与生成能力都来自它。

四、开机自启动（可选）
  在项目目录里执行：
      bash native/autostart.sh install
  取消：
      bash native/autostart.sh uninstall

五、快捷键冲突
  默认 ⌥⌘R 由本程序独占。如果和 Photoshop 的快捷键冲突，
  可以在 ~/.huanmeng-ring.json 里改：
      { "hotkey": "ctrl+alt+cmd+r" }
README_EOF

ln -s /Applications "$STAGE/Applications" 2>/dev/null || true

DMG="$DIST/${APP_NAME}-${VERSION}.dmg"
rm -f "$DMG"
echo "▶ 生成 DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

rm -rf "$STAGE"

echo
echo "✓ 完成：$DMG"
du -h "$DMG" | awk '{print "  体积：" $1}'
