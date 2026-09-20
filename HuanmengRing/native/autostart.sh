#!/bin/bash
# ============================================================
#  autostart.sh — 管理「幻梦圆环」的登录自启动
#
#  用法：
#    bash native/autostart.sh install     开机自动启动
#    bash native/autostart.sh uninstall   取消自启动
#    bash native/autostart.sh status      查看当前状态
#
#  原理：往 ~/Library/LaunchAgents 放一个 LaunchAgent plist。
#  这是用户级配置，不需要管理员权限，随时可以删。
#
#  ⚠ install **不再自己写 plist**，而是交给 deploy/install.sh。
#
#  为什么要改：以前这里把自启指向 native/build/HuanmengRing.app ——
#  那是构建产物目录，每次 build.sh 都会 rm -rf 重建。于是每重建一次，
#  自启指向的二进制就换了一个（cdhash 变了），
#  而辅助功能授权**正是绑在 cdhash 上的** —— 结果就是「怎么又要授权」。
#  「装到哪」和「自启指向哪」只能有一处定义，否则两边迟早对不上。
# ============================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DEST="$HOME/Applications/HuanmengRing.app"
BINARY="$APP_DEST/Contents/MacOS/HuanmengRing"
LABEL="com.huanmeng.ring"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

ACTION="${1:-status}"

case "$ACTION" in
  install)
    # 交给统一安装脚本：编译 → 装到 ~/Applications → 写自启 → 引导授权 → 载入插件 → 自检
    if [ ! -d "$HERE/build/HuanmengRing.app" ]; then
      echo "▶ 还没有构建产物，先编译…"
      bash "$HERE/build.sh"
    fi
    exec bash "$HERE/deploy/install.sh"
    ;;

  uninstall)
    if [ -f "$PLIST" ]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "✓ 已取消开机自启动"
    else
      echo "· 本来就没有配置自启动"
    fi
    ;;

  status)
    if [ -f "$PLIST" ]; then
      echo "已配置自启动：$PLIST"
      TARGET="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST" 2>/dev/null || echo '?')"
      echo "  指向：$TARGET"
      # 指向构建目录 = 每次 build.sh 都换二进制 = 每次都要重新授权。
      # 这是「怎么老要我授权」最常见的原因，直接点出来。
      if [ "$TARGET" != "$BINARY" ]; then
        echo
        echo "  ⚠ 自启指向的不是安装目录。"
        echo "    如果指向的是 native/build/ 里的产物，那每次重新构建都会换一个二进制，"
        echo "    而辅助功能授权绑在二进制指纹上 —— 于是每次都要重新授权。"
        echo "    修一下：bash native/autostart.sh install"
      fi
      launchctl list 2>/dev/null | grep -i "$LABEL" || echo "  （当前未在 launchctl 列表中）"
    else
      echo "未配置自启动"
      echo "  开启：bash native/autostart.sh install"
    fi
    # 匹配完整路径，不能用 pgrep -f HuanmengRing ——
    # 安装脚本的 node 进程命令行里也含 "HuanmengRing"，会被误判成「助手在运行」
    PATTERN="HuanmengRing.app/Contents/MacOS/HuanmengRing"
    if pgrep -f "$PATTERN" >/dev/null; then
      echo "助手进程：运行中"
      ps -p "$(pgrep -f "$PATTERN" | head -1)" -o command= 2>/dev/null | sed 's/^/  来自：/'
    else
      echo "助手进程：未运行"
    fi
    ;;

  *)
    echo "用法：bash native/autostart.sh {install|uninstall|status}"
    exit 1
    ;;
esac
