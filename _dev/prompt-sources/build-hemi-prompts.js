// ============================================================
//  build-hemi-prompts.js — 由明文母本生成 base64 混淆版
//
//  用法：node _dev/prompt-sources/build-hemi-prompts.js
//
//  输入：_dev/prompt-sources/tile-hemisynth.prompts.plain.js
//  输出：src/features/reference-ui/tile-hemisynth.prompts.js
//
//  这个脚本是 2026-09 补回来的 —— 原文件头注释里写着「改完运行本脚本」，
//  但脚本和母本当时都不在仓库里，那条路是断的。现在补上了。
//
//  关于混淆：base64 只提高「打开文件直接抄走提示词」的门槛，**不是加密**。
//  运行时内存里仍是明文，而且提示词最终要明文发给 AI 服务商。
//  真正的保护上限就在这儿，别指望它更多。
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const PLAIN = path.join(HERE, 'tile-hemisynth.prompts.plain.js');
const TARGET = path.join(HERE, '..', '..', 'src', 'features', 'reference-ui', 'tile-hemisynth.prompts.js');

const CHUNK = 100;          // 每行 base64 的字符数，纯为了文件好读
const B64_LINE_WIDTH = 78;  // 不参与编码，仅注释用

// ---------- 1. 读母本 ----------

let plain;
try {
    plain = require(PLAIN);
} catch (error) {
    console.error('✗ 读不到明文母本：' + PLAIN);
    console.error('  ' + error.message);
    process.exit(1);
}

const order = Array.isArray(plain.order) ? plain.order : Object.keys(plain.text || {});
if (!order.length) {
    console.error('✗ 母本里没有 order / text');
    process.exit(1);
}

// ---------- 2. 校验 ----------

// 正文会被塞进 JS 数组里的字符串字面量，用 JSON.stringify 转义，
// 所以反引号和 ${ 其实不会出问题 —— 但母本自己是用模板字符串包的，
// 那里面出现反引号或 ${ 会在**读取母本时**就炸掉，必须拦住。
let bad = 0;
order.forEach(function (key) {
    const text = (plain.text || {})[key];
    if (typeof text !== 'string' || !text.length) {
        console.error('✗ ' + key + '：正文缺失或为空');
        bad++;
        return;
    }
    if (text.includes('`')) { console.error('✗ ' + key + '：正文里有反引号，会破坏母本的模板字符串'); bad++; }
    if (text.includes('${')) { console.error('✗ ' + key + '：正文里有 ${，会破坏母本的模板字符串'); bad++; }
});
if (bad) process.exit(1);

// ---------- 3. 编码 ----------

function encode(text) {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const chunks = [];
    for (let i = 0; i < b64.length; i += CHUNK) chunks.push(b64.slice(i, i + CHUNK));
    return chunks;
}

const encoded = {};
order.forEach(function (key) { encoded[key] = encode(plain.text[key]); });

// ---------- 4. 拼文件 ----------

const lines = [];
lines.push('// ============================================================');
lines.push('//  tile-hemisynth.prompts.js — 半合成磁贴提示词数据 (混淆版, 自动生成)');
lines.push('//');
lines.push('//  ⚠ 请勿手改本文件。提示词母本在 _dev/prompt-sources/tile-hemisynth.prompts.plain.js,');
lines.push('//    改完运行 _dev/prompt-sources/build-hemi-prompts.js 重新生成。');
lines.push('//');
lines.push('//  提示词正文经 base64 编码存盘, 运行时解码还原为 window._hemisynthPrompts。');
lines.push('//  目的: 提高"打开文件直接抄走提示词"的门槛 (非强加密, 运行时内存仍可解出;');
lines.push('//        真正的保护上限受限于"提示词最终明文发往 AI 服务商"这一事实)。');
lines.push('//  对前端 tile-hemisynth.js 完全透明: 仍旧读 window._hemisynthPrompts[key].text。');
lines.push('//');
lines.push('//  本次生成: ' + order.length + ' 个 key, 正文合计 '
    + order.reduce(function (n, k) { return n + plain.text[k].length; }, 0) + ' 字');
lines.push('// ============================================================');
lines.push('');
lines.push('(function() {');
lines.push("'use strict';");
lines.push('');
lines.push('// UTF-8 安全的 base64 解码 (UXP webview 有 atob, 但 atob 只回 Latin1, 中文需再转 UTF-8)');
lines.push('function _dec(b64) {');
lines.push('  try {');
lines.push('    var bin = atob(b64);');
lines.push('    var bytes = new Uint8Array(bin.length);');
lines.push('    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);');
lines.push('    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);');
lines.push('    var out = "", j = 0;');
lines.push('    while (j < bytes.length) {');
lines.push('      var c = bytes[j++];');
lines.push('      if (c < 0x80) out += String.fromCharCode(c);');
lines.push('      else if (c < 0xE0) out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[j++] & 0x3F));');
lines.push('      else if (c < 0xF0) out += String.fromCharCode(((c & 0x0F) << 12) | ((bytes[j++] & 0x3F) << 6) | (bytes[j++] & 0x3F));');
lines.push('      else { var cp = ((c & 0x07) << 18) | ((bytes[j++] & 0x3F) << 12) | ((bytes[j++] & 0x3F) << 6) | (bytes[j++] & 0x3F); cp -= 0x10000; out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); }');
lines.push('    }');
lines.push('    return out;');
lines.push('  } catch (e) { return ""; }');
lines.push('}');
lines.push('');
lines.push('var _D = {};   // key → base64 片段拼接');
order.forEach(function (key) {
    lines.push('_D[' + JSON.stringify(key) + '] = [');
    const chunks = encoded[key];
    chunks.forEach(function (chunk, i) {
        lines.push('  ' + JSON.stringify(chunk) + (i === chunks.length - 1 ? '' : ','));
    });
    lines.push('].join("");');
});
lines.push('');
lines.push('var _META = {');
order.forEach(function (key, i) {
    const meta = (plain.meta || {})[key] || {};
    lines.push('  ' + JSON.stringify(key) + ': { label: ' + JSON.stringify(meta.label || key)
        + ', groupName: ' + JSON.stringify(meta.groupName || '') + ' }' + (i === order.length - 1 ? '' : ','));
});
lines.push('};');
lines.push('');
lines.push('window._hemisynthPrompts = {};');
lines.push('Object.keys(_META).forEach(function(k) {');
lines.push('  window._hemisynthPrompts[k] = {');
lines.push('    label: _META[k].label,');
lines.push('    groupName: _META[k].groupName,');
lines.push('    get text() { return _dec(_D[k]); }');
lines.push('  };');
lines.push('});');
lines.push('');
lines.push('})();');
lines.push('');

const output = lines.join('\n');

// ---------- 5. 自检：解回来逐字比对 ----------
//
// 这一步不能省。编码写错（分片边界、转义、UTF-8）会生成一个
// 「看起来正常但正文悄悄变了」的文件，而提示词错一个字是查不出来的。

const sandbox = { window: {} };
const atobShim = function (b64) { return Buffer.from(b64, 'base64').toString('binary'); };
new Function('window', 'atob', output)(sandbox.window, atobShim);

let mismatch = 0;
order.forEach(function (key) {
    const produced = sandbox.window._hemisynthPrompts[key];
    if (!produced) { console.error('✗ 自检：' + key + ' 没生成出来'); mismatch++; return; }
    if (produced.text !== plain.text[key]) {
        console.error('✗ 自检：' + key + ' 正文往返不一致');
        const a = plain.text[key], b = produced.text;
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (a[i] !== b[i]) { console.error('   首个差异在第 ' + i + ' 字：母本=' + JSON.stringify(a.slice(i, i + 20)) + ' 生成=' + JSON.stringify(b.slice(i, i + 20))); break; }
        }
        mismatch++;
    }
    const wantMeta = (plain.meta || {})[key] || {};
    if (produced.label !== (wantMeta.label || key) || produced.groupName !== (wantMeta.groupName || '')) {
        console.error('✗ 自检：' + key + ' 的 label/groupName 不一致');
        mismatch++;
    }
});
if (mismatch) {
    console.error('\n✗ 自检失败，**没有写盘** —— 生成的文件会破坏提示词。');
    process.exit(1);
}

// ---------- 6. 写盘 ----------

fs.writeFileSync(TARGET, output, 'utf8');

console.log('✓ 已生成 ' + TARGET);
order.forEach(function (key) {
    console.log('    ' + key.padEnd(10) + plain.text[key].length + ' 字  →  '
        + encoded[key].length + ' 个 base64 分片  label=' + ((plain.meta || {})[key] || {}).label);
});
console.log('  自检通过：5 个 key 正文往返逐字一致');
