#!/bin/bash
# ============================================================
#  package-deploy.sh — 组装「一键部署」包
#
#  用法：bash native/package-deploy.sh
#  产物：dist/幻梦AI-一键部署/          可直接在访达里双击用
#        dist/幻梦AI-一键部署.zip        用来拷到别的 Mac
#
#  **不会重新编译助手**。这不是偷懒：
#  辅助功能授权绑定在二进制的 cdhash 上，重新 build 会让授权失效。
#  包里放的就是当前这个已经授权过的产物，拷到别的机器上是全新授权，
#  在这台机器上是复用现有授权。
# ============================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

APP_SRC="$HERE/build/HuanmengRing.app"
PLUGIN_SRC="$ROOT/../Dream-ps-ai"
OUT="$ROOT/dist/幻梦AI-一键部署"

echo "▶ 检查素材"

if [ ! -d "$APP_SRC" ]; then
    echo "✗ 找不到已构建的助手：$APP_SRC"
    echo "  先跑：bash native/build.sh"
    exit 1
fi

if [ ! -f "$PLUGIN_SRC/manifest.json" ]; then
    echo "✗ 找不到插件：$PLUGIN_SRC"
    exit 1
fi

# 签名校验：签名坏了的话用户拿到手授权不上，而且很难查
if ! codesign --verify --deep --strict "$APP_SRC" 2>/dev/null; then
    echo "✗ 助手的签名校验没过，先重新构建：bash native/build.sh"
    exit 1
fi
echo "  ✓ 助手签名正常"
echo "  ✓ 插件 $(python3 -c "import json;print(json.load(open('$PLUGIN_SRC/manifest.json'))['name'])" 2>/dev/null || echo '')"

echo "▶ 组装到 $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/幻梦圆环" "$OUT/插件" "$OUT/tools"

# 助手：用 ditto 而不是 cp -R —— ditto 完整保留权限与扩展属性，
# 用 cp 复制后签名有可能失效
ditto "$APP_SRC" "$OUT/幻梦圆环/HuanmengRing.app"

# 插件：排除测试和编辑器目录，其余照搬
# （排除清单很小是有意的 —— 少删一个文件就可能是运行时白屏，
#   而这些目录加起来也就一百多 KB）
rsync -a \
    --exclude 'tests/' \
    --exclude '.vscode/' \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    "$PLUGIN_SRC/" "$OUT/插件/Dream-ps-ai/"

cp "$HERE/deploy/install.sh"   "$OUT/tools/install.sh"
cp "$HERE/deploy/uninstall.sh" "$OUT/tools/uninstall.sh"
cp "$HERE/deploy/udt-load.mjs" "$OUT/tools/udt-load.mjs"
chmod +x "$OUT/tools/install.sh" "$OUT/tools/uninstall.sh"

# ---------- 双击入口 ----------

cat > "$OUT/一键安装.command" <<'CMD'
#!/bin/bash
# 双击这个文件即可。会打开终端窗口，装完按回车关闭。
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1
bash tools/install.sh
printf "按回车关闭这个窗口…"
read -r _
CMD

cat > "$OUT/一键卸载.command" <<'CMD'
#!/bin/bash
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1
bash tools/uninstall.sh
printf "按回车关闭这个窗口…"
read -r _
CMD

chmod +x "$OUT/一键安装.command" "$OUT/一键卸载.command"

# 使用说明
if [ -f "$HERE/deploy/使用说明.md" ]; then
    cp "$HERE/deploy/使用说明.md" "$OUT/使用说明.md"
fi

# ---------- 打 zip ----------
#
# 必须用 ditto 打包：zip(1) 会丢掉 .command 的可执行位和 .app 的符号链接，
# 用户解压后发现「双击没反应」。

ZIP="$ROOT/dist/幻梦AI-一键部署.zip"
rm -f "$ZIP"
echo "▶ 打包 zip"
ditto -c -k --sequesterRsrc --keepParent "$OUT" "$ZIP"

echo
echo "✓ 完成"
echo "  目录：$OUT"
echo "  压缩包：$ZIP  ($(du -h "$ZIP" | cut -f1))"
echo
echo "  本机直接双击：$OUT/一键安装.command"
echo "  发给别人：把 zip 发过去，对方解压后双击「一键安装.command」"
echo
echo "  注意：解压必须用 ditto 或 Finder 双击。"
echo "        用某些第三方解压工具（如部分 Windows 移植版）会丢掉执行权限。"
