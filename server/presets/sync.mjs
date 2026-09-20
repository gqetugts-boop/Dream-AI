// ============================================================
//  sync.mjs — 校验 presets.json，生成 api/presets/manifest
//
//  用法：node server/presets/sync.mjs
//
//  为什么需要这一步校验（而不是直接把 JSON 丢上去）：
//  插件的预设合并顺序里，**服务端预设排在最后**，而去重规则是
//  「同名无条件丢弃后来的」。所以只要某条云端预设的名字撞上内置的
//  68 条（或用户自己存的），这条就会**被静默吃掉** —— 不报错、不提示，
//  用户只会觉得「我明明配了这条怎么没有」。这个脚本把这种情况拦在前面。
//
//  零依赖，只用 node: 内置模块。照着 _dev/prompt-sources/build-hemi-prompts.js
//  的写法来：改源文件 → 跑脚本 → 产物写回。
// ============================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'presets.json');
const OUT = join(HERE, 'public', 'api', 'presets', 'manifest');
const BUILTIN = join(HERE, '..', '..', 'assets', 'presets', 'yushe.json');

const errors = [];
const warnings = [];

function fail(message) { errors.push(message); }
function warn(message) { warnings.push(message); }

// ---- 读源文件 ----

let raw;
try {
    raw = JSON.parse(readFileSync(SRC, 'utf8'));
} catch (error) {
    console.error('✗ 读不了 presets.json：' + error.message);
    process.exit(1);
}

if (!Array.isArray(raw)) {
    console.error('✗ presets.json 顶层必须是数组（客户端也接受 {presets:[...]}，但这里统一用数组）');
    process.exit(1);
}

// ---- 内置预设的名字（用来检测会被静默丢弃的撞名）----

let builtinNames = new Set();
try {
    const builtin = JSON.parse(readFileSync(BUILTIN, 'utf8'));
    if (Array.isArray(builtin)) {
        builtinNames = new Set(builtin.map((item) => String((item && item.name) || '').trim()));
    }
} catch (error) {
    warn('读不到内置预设（' + BUILTIN + '），跳过撞名检查：' + error.message);
}

// ---- 逐条校验 ----

const items = [];
const seen = new Map();

raw.forEach((entry, index) => {
    const at = '第 ' + (index + 1) + ' 条';

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        fail(at + '：必须是对象');
        return;
    }

    const name = String(entry.name || '').trim();
    const prompt = entry.prompt;

    if (!name) { fail(at + '：缺 name'); return; }

    // 正文必须是干净的非空字符串。客户端的 extractPresetPromptText 对对象会按
    // preferredKeys 逐字段拼接、还给正/反向词加前缀 —— 出来的东西不是你想发出去的。
    if (typeof prompt !== 'string' || !prompt.trim()) {
        let because = '';
        if (Array.isArray(prompt)) {
            because = '现在是数组，客户端会把每段用换行拼起来。';
        } else if (prompt && typeof prompt === 'object') {
            because = '现在是对象，客户端会按字段逐条拼接、还给正/反向词加前缀。';
        } else if (prompt !== undefined && typeof prompt !== 'string') {
            because = '现在是 ' + typeof prompt + '，客户端提取不出内容，这条会被静默丢弃。';
        }
        fail(at + '（' + name + '）：prompt 必须是非空字符串。' + because);
        return;
    }
    // front-matter 不会被剥掉，会整段变成提示词。
    if (/^\s*---\s*$/m.test(prompt)) {
        warn(at + '（' + name + '）：prompt 里出现 --- 行，客户端不会剥 front-matter，它会原样进提示词');
    }

    const category = String(entry.category || '服务器').trim() || '服务器';

    // 同名会被客户端无条件丢弃 —— 这里拦下来
    const key = name.toLowerCase();
    if (seen.has(key)) {
        fail(at + '（' + name + '）：和本文件第 ' + seen.get(key) + ' 条重名，客户端只保留先出现的那个');
    } else {
        seen.set(key, index + 1);
    }
    if (builtinNames.has(name)) {
        fail(at + '（' + name + '）：和**内置预设**重名。合并时服务端预设排在最后，'
            + '这条会被静默丢弃（不报错）。换个名字。');
    }

    // 参考图：URL 可以，base64 会把 localStorage 撑爆
    let refImages = entry.refImages || entry.referenceImages || [];
    if (!Array.isArray(refImages)) refImages = [];
    refImages.forEach((ref) => {
        const value = typeof ref === 'string' ? ref : (ref && (ref.url || ref.base64 || ref.dataUrl)) || '';
        if (/^data:/i.test(String(value))) {
            warn(at + '（' + name + '）：refImages 里有 base64。插件是把整个配置 JSON.stringify '
                + '回写 localStorage 的，大图会撑爆配额。改用公网 https 图片地址。');
        }
    });

    const item = { name, category, prompt };
    if (refImages.length) item.refImages = refImages;
    items.push(item);
});

// ---- 报告 ----

warnings.forEach((message) => console.log('  ⚠ ' + message));
errors.forEach((message) => console.log('  ✗ ' + message));

if (errors.length) {
    console.error('\n✗ ' + errors.length + ' 个错误，没有生成 manifest。');
    process.exit(1);
}

// ---- 生成产物 ----

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(items, null, 2) + '\n', 'utf8');

console.log('✓ ' + items.length + ' 条预设 → ' + OUT.replace(HERE + '/', ''));
console.log('  部署：把 ' + join(HERE, 'public').replace(HERE + '/', '') + '/ **里面的内容**上传到网站根目录'
    + '（要的是 public/api/presets/manifest 这个层级），插件里填 https://你的域名 即可。');
if (warnings.length) console.log('  （' + warnings.length + ' 个警告，未阻断）');
