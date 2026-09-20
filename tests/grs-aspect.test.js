/*
 * GRS 渠道回归测试
 *
 * 覆盖三块容易改坏的东西：
 *   1. gpt-image / nano-banana 的模型归类（决定走生图分支还是 chat 分支）
 *   2. 渠道归类（决定模型下拉框按渠道过滤的结果）
 *   3. 下拉框显示文字（官网名 + 单次参考价，ID 不变）
 *
 * 直接从 src/app/index.js 切真实代码来跑，避免测试副本和线上走偏。
 * 运行：node tests/grs-aspect.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'src', 'app', 'index.js');
const srcText = fs.readFileSync(SOURCE, 'utf8');
const lines = srcText.split('\n');

function findLine(needle) {
    const index = lines.findIndex(function (line) { return line.indexOf(needle) !== -1; });
    if (index === -1) {
        console.error('在 ' + SOURCE + ' 中找不到：' + needle);
        process.exit(2);
    }
    return index;
}

// 按 4 空格缩进定界切出一个函数
function sliceFunction(name) {
    const start = findLine('function ' + name + '(');
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^    \}\s*$/.test(lines[i])) { end = i + 1; break; }
    }
    if (end === -1) {
        console.error('无法确定 ' + name + ' 的结尾');
        process.exit(2);
    }
    return lines.slice(start, end).join('\n');
}

// 按 4 空格缩进定界切出一个常量声明
function sliceConst(name) {
    const start = findLine('const ' + name + ' =');
    let end = -1;
    for (let i = start; i < lines.length; i++) {
        if (/^    \};\s*$/.test(lines[i]) || /^    \];\s*$/.test(lines[i])) { end = i + 1; break; }
    }
    if (end === -1) {
        console.error('无法确定 ' + name + ' 的结尾');
        process.exit(2);
    }
    return lines.slice(start, end).join('\n');
}

const CONSTS = [
    'GRS_NANO_BANANA_MODELS',
    'GRS_GPT_IMAGE_MODELS',
    'GRS_MODEL_DISPLAY'
];
const FUNCS = [
    'getModelName',
    'getModelKey',
    'isGrsNanoBananaModel',
    'isGrsGptImageModel',
    'parseModelSelection',
    'getImageProviderChannel',
    'getImageModelDisplayName'
];

const code = CONSTS.map(sliceConst).join('\n')
    + '\n' + FUNCS.map(sliceFunction).join('\n')
    + '\nthis.getImageProviderChannel = getImageProviderChannel;'
    + '\nthis.parseModelSelection = parseModelSelection;'
    + '\nthis.getImageModelDisplayName = getImageModelDisplayName;'
    + '\nthis.isGrsGptImageModel = isGrsGptImageModel;'
    + '\nthis.GRS_GPT_IMAGE_MODELS = GRS_GPT_IMAGE_MODELS;';

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

let pass = 0;
let total = 0;

function check(name, actual, expected) {
    total++;
    const ok = actual === expected;
    if (ok) pass++;
    console.log((ok ? '✅' : '❌') + ' ' + name);
    if (!ok) console.log('    期望: ' + expected + '\n    实际: ' + actual);
}

console.log('── 模型归类 ──');
check('gpt-image-2 归为 gpt-image', sandbox.isGrsGptImageModel('gpt-image-2'), true);
check('gpt-image-2.5 归为 gpt-image（不能掉进 chat 分支）', sandbox.isGrsGptImageModel('gpt-image-2.5'), true);
check('gpt-image-2.5-flare 归为 gpt-image', sandbox.isGrsGptImageModel('gpt-image-2.5-flare'), true);
check('gpt-image-2.5-sunburst 归为 gpt-image', sandbox.isGrsGptImageModel('gpt-image-2.5-sunburst'), true);
check('带渠道前缀也能识别', sandbox.isGrsGptImageModel('grs/gpt-image-2.5'), true);
check('nano-banana 不算 gpt-image', sandbox.isGrsGptImageModel('nano-banana-pro'), false);

console.log('\n── 渠道归类（模型下拉框按渠道过滤的依据）──');
// 回归：getModelKey 会剥掉 'firefly/' 前缀，如果先做 GRS 名字判定，
// firefly/gpt-image-2 会被判成 GRS，Firefly 模型就混进 GRS 的列表里。
check('firefly/gpt-image-2 属于 firefly', sandbox.getImageProviderChannel('firefly/gpt-image-2'), 'firefly');
check('firefly/gemini-3-nano-banana-pro 属于 firefly', sandbox.getImageProviderChannel('firefly/gemini-3-nano-banana-pro'), 'firefly');
check('xai/grok-imagine-image 属于 xai', sandbox.getImageProviderChannel('xai/grok-imagine-image'), 'xai');
check('grok2api/... 属于 grok2api', sandbox.getImageProviderChannel('grok2api/grok-imagine-image-2.0'), 'grok2api');
check('sub2api/... 属于 sub2api', sandbox.getImageProviderChannel('sub2api/grok-imagine-image-quality'), 'sub2api');
check('volcengine/... 属于 volcengine', sandbox.getImageProviderChannel('volcengine/doubao-seedream-4-0-250828'), 'volcengine');
check('PS 原生属于 photoshop', sandbox.getImageProviderChannel('PS_NATIVE_NANO_BANANA'), 'photoshop');

console.log('\n── GRS 无前缀模型仍归 GRS ──');
['nano-banana-fast', 'nano-banana-pro', 'gpt-image-2', 'gpt-image-2-vip',
 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'].forEach(function (m) {
    total++;
    const channel = sandbox.getImageProviderChannel(m);
    if (channel === 'grs') { pass++; return; }
    console.log('❌ ' + m + ' 应归 grs，实际 ' + channel);
});
console.log('   7 个无前缀 GRS 模型全部归入 grs');

console.log('\n── parseModelSelection 不能把 GRS 模型误判成 openai ──');
// 回归：这里原先是硬编码的 gpt-image-2 / gpt-imagine-2 名单，
// vip 和 2.5 系列会掉到 startsWith('gpt') 分支变成 openai。
['gpt-image-2', 'gpt-imagine-2', 'gpt-image-2-vip', 'gpt-image-2.5',
 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'].forEach(function (m) {
    total++;
    const provider = sandbox.parseModelSelection(m).provider;
    if (provider === 'grs') { pass++; return; }
    console.log('❌ parseModelSelection(' + m + ').provider 应为 grs，实际 ' + provider);
});
console.log('   6 个 gpt-image 型号全部判为 grs');

console.log('\n── GRS 下拉框显示（官网名 + 单次参考价）──');
// 注意：这里只验证显示文字，模型 ID 一律不动。
// 价格来源 https://grsai.com/zh/dashboard/models，汇率 ¥1 = 20,000 积分。
const PRICE_CASES = {
    'gpt-image-2': '¥0.03/次',
    'gpt-image-2.5': '¥0.03/次',
    'gpt-image-2.5-flare': '¥0.10/次',
    'gpt-image-2.5-sunburst': '¥0.12/次',
    'gpt-image-2-vip': '¥0.10/次',
    'nano-banana': '¥0.022/次',
    'nano-banana-2': '¥0.06/次',
    'nano-banana-pro': '¥0.09/次',
    'nano-banana-pro-4k-vip': '¥0.90/次'
};
Object.keys(PRICE_CASES).forEach(function (model) {
    total++;
    const label = sandbox.getImageModelDisplayName(model, model);
    if (label.indexOf(PRICE_CASES[model]) > -1 && label.indexOf(' · ') > -1) { pass++; return; }
    console.log('❌ ' + model + ' 显示应为「官网名 · ' + PRICE_CASES[model] + '」，实际：' + label);
});
console.log('   9 个可对应官网的模型均显示官网名 + 价格');

// 官网找不到对应条目的模型必须保留原名、不能编造价格
['nano-banana-fast', 'nano-banana-pro-vt'].forEach(function (model) {
    total++;
    const label = sandbox.getImageModelDisplayName(model, model);
    if (label.indexOf('¥') === -1) { pass++; return; }
    console.log('❌ ' + model + ' 官网没有对应条目，不该标价格，实际：' + label);
});
console.log('   2 个无法对应的模型未标价格（避免编造）');

console.log('\n── GRS 请求体：aspectRatio 必须原样透传 ──');
// 回归（真实踩过）：曾经把 aspectRatio 送去 normalizeSupportedAspectRatio，
// 'auto'.split(':') 只有一段 → getAspectRatioValue 返回 1 → 吸附成 '1:1'，
// 于是不管选区什么比例都发方图，回贴时被 putImageDataAtBounds 拉伸成选区比例，
// 表现为「错位」。所有调用点传的都是 'auto'，必须原样透传。
// 这段逻辑内联在 generateImage 里没法直接调，做源码级断言守住这一行。
total++;
if (/aspectRatio:\s*options\.aspectRatio\s*\|\|\s*imageConfig\.aspectRatio\s*\|\|\s*'auto'/.test(srcText)) {
    pass++;
} else {
    console.log('❌ GRS 请求体的 aspectRatio 不再是 `options.aspectRatio || imageConfig.aspectRatio || \'auto\'`');
    console.log('   不要把它送去 normalizeSupportedAspectRatio —— 那会把 auto 变成 1:1，导致回图错位');
}

console.log('\n── 已删除的死代码不应复活 ──');
['resolveGrsAspectRatio', 'GRS_GPT_IMAGE_PIXEL_PRESETS', 'isGrsGptImagePixelOnlyModel'].forEach(function (name) {
    total++;
    if (srcText.indexOf(name) === -1) { pass++; return; }
    console.log('❌ ' + name + ' 已删除，但仍出现在源码里（所有调用点都传 auto，这套换算不可达）');
});
console.log('   3 个不可达的符号确认已清除');

console.log('\n' + pass + '/' + total + ' 通过');
process.exit(pass === total ? 0 : 1);
