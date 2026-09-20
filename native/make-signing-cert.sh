#!/bin/bash
# ============================================================
#  make-signing-cert.sh — 给助手办一张「自签名代码签名证书」
#
#  解决什么问题
#  ------------
#  辅助功能（Accessibility）授权是绑定在**签名身份**上的：
#    · ad-hoc 签名（codesign -s -）的身份 = 二进制指纹 cdhash
#      → 每次重新编译都会变，授权就失效，得重新勾一次
#    · 用证书签名，身份 = 证书指纹
#      → 编译多少次都不变，授权一直有效
#
#  跑一次这个脚本，之后每次 build.sh 都会自动用这张证书签名，
#  重新构建、重新安装都不再需要重新授权。
#
#  用法
#  ----
#      bash native/make-signing-cert.sh      # 不需要输密码、不需要点任何框
#
#  撤销
#  ----
#      security delete-keychain ~/Library/Keychains/huanmeng-signing.keychain-db
#      再跑一次 build.sh 就退回 ad-hoc 签名（代价是又得重新授权）。
#
#  ────────────────────────────────────────────────────────────
#  为什么是「专用钥匙串」而不是登录钥匙串（这段是踩坑记录，别随便改）
#  ────────────────────────────────────────────────────────────
#  一开始放进登录钥匙串，结果 codesign 死活找不到身份
#  （by name 和 by SHA-1 都试过，一律 "The specified item could not be found"）。
#  登录钥匙串对导入的私钥有额外的访问控制，光靠 -T 授权是不够的，
#  还得跑 set-key-partition-list —— 而那条命令要输钥匙串密码。
#
#  换成自己建的钥匙串就没这问题：密码是我们设的，set-key-partition-list
#  可以带 -k 非交互执行。整条流程一次都不用你出手。
#
#  另外两个真实踩过的坑：
#   1. p12 必须指定 -certpbe/-keypbe PBE-SHA1-3DES -macalg sha1。
#      OpenSSL 3 的默认算法 macOS 的 security 读不了，
#      报 "MAC verification failed during PKCS12 import"。
#   2. p12 的**密码不能为空**。同样的算法下，空密码一样报 MAC verification failed。
#      随便给个临时密码就行，p12 用完就删。
#
#  安全性
#  ------
#  这张证书只用来给本程序签名，不能用来给别的程序签名，也不代表任何第三方身份。
#  钥匙串密码写死在脚本里是有意的：那把钥匙串里只有这一张一次性自签名证书，
#  任何能读到它的人本来就已经能读你的整个登录钥匙串了。
#  「自签名」= 系统不认识这个签名者，所以它**不会**让 Gatekeeper 放行
#  从网上下载的副本；它只解决「授权认得住同一个程序」这一件事。
# ============================================================

set -euo pipefail

CERT_NAME="HuanmengRing Self-Signed"
KEYCHAIN="$HOME/Library/Keychains/huanmeng-signing.keychain-db"
KEYCHAIN_PASS="huanmeng-local"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "✗ 这个脚本只在 macOS 上有意义"
    exit 1
fi

# ---------- 已经有了就直接用 ----------

if [ -f "$KEYCHAIN" ] && security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$CERT_NAME"; then
    echo "✓ 已经有这张证书了，不用重做："
    security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep "$CERT_NAME" | sed 's/^/  /'
    echo
    echo "  build.sh 会自动用它。"
    exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "✗ 找不到 openssl（macOS 自带，正常情况下不会缺）"
    exit 1
fi

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "▶ 生成密钥和证书…"
# 证书名必须是纯 ASCII：openssl 的 -subj 不认非 ASCII，
# 写中文进去会被双重编码成乱码（钥匙串里显示成鬼画符，按名字也查不到）。
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
    -subj "/CN=$CERT_NAME/O=HuanmengRing/C=CN" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

echo "▶ 打包成 .p12…"
TEMP_PASS="huanmeng-$$"
openssl pkcs12 -export -out "$WORK/id.p12" \
    -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -passout "pass:$TEMP_PASS" \
    -name "$CERT_NAME" \
    -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 >/dev/null 2>&1

echo "▶ 建专用钥匙串…"
security delete-keychain "$KEYCHAIN" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
# 6 小时无操作才自动锁；build.sh 每次构建前也会主动解锁一次
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"

echo "▶ 导入证书…"
security import "$WORK/id.p12" -k "$KEYCHAIN" -P "$TEMP_PASS" \
    -T /usr/bin/codesign -T /usr/bin/security -A >/dev/null

# 让 codesign 不用每次问「能不能用这把钥匙」。带 -k 所以不弹框。
security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "$KEYCHAIN_PASS" "$KEYCHAIN" >/dev/null 2>&1 || true

# 加进用户钥匙串搜索列表，codesign 不带 --keychain 也能找到
EXISTING="$(security list-keychains -d user | tr -d ' "' | tr '\n' ' ')"
case " $EXISTING " in
  *" $KEYCHAIN "*) ;;
  *) security list-keychains -d user -s $EXISTING "$KEYCHAIN" ;;
esac

echo
if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$CERT_NAME"; then
    echo "✓ 证书已就绪（不需要设信任，也不需要输密码）："
    security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep "$CERT_NAME" | sed 's/^/  /'
    echo
    echo "  接下来："
    echo "    bash native/build.sh              # 会自动用这张证书签名"
    echo "    bash native/autostart.sh install  # 重新装一次"
    echo
    echo "  装完**还要重新授权最后一次**：签名身份刚从「二进制指纹」换成了「证书」，"
    echo "  对系统来说这是一个新身份。这一次之后，再重新构建都不用再授权了。"
else
    echo "✗ 导入失败 —— 证书没能成为可用的签名身份。"
    exit 1
fi
