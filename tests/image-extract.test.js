/*
 * 图像响应提取回归测试
 *
 * 直接从 src/app/index.js 里切出真实的 collectImageCandidates / isLikelyImageResult /
 * extractImageFromResponse 三个函数来跑，避免测试副本和线上代码走偏。
 * 运行：node tests/image-extract.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'src', 'app', 'index.js');
const lines = fs.readFileSync(SOURCE, 'utf8').split('\n');

// 自动定位切片范围：从 isLikelyBase64ImageData 起，到 extractImageFromResponse 的收尾花括号为止。
// 不写死行号，index.js 增删代码后测试不会静默跑偏。
function findLine(needle) {
    const index = lines.findIndex(function (line) { return line.indexOf(needle) !== -1; });
    if (index === -1) {
        console.error('在 ' + SOURCE + ' 中找不到：' + needle);
        process.exit(2);
    }
    return index;
}

const SLICE_START = findLine('function isLikelyBase64ImageData');
const extractStart = findLine('function extractImageFromResponse');
let SLICE_END = extractStart;
for (let i = extractStart + 1; i < lines.length; i++) {
    if (lines[i] === '    }') { SLICE_END = i + 1; break; }
}
const slice = lines.slice(SLICE_START, SLICE_END).join('\n');

['function extractImageFromResponse', 'function isLikelyBase64ImageData',
 'function collectImageCandidates', 'function isLikelyImageResult',
 'function sanitizeImageCandidate'].forEach(function (name) {
    if (slice.indexOf(name) === -1) {
        console.error('切片缺少 ' + name + '，定位逻辑需要修正');
        process.exit(2);
    }
});

const sandbox = { URL, console, debugLog: function () {} };
vm.createContext(sandbox);
vm.runInContext(slice + '\nthis.extractImageFromResponse = extractImageFromResponse;', sandbox);
const extract = sandbox.extractImageFromResponse;

const CASES = [
    {
        name: 'Adobe Firefly 官方 outputs[].image.url（预签名，无扩展名）',
        response: { outputs: [{ image: { url: 'https://pre-signed-firefly-prod.s3-accelerate.amazonaws.com/abc123?X-Amz-Signature=deadbeef' } }] },
        expect: 'https://pre-signed-firefly-prod.s3-accelerate.amazonaws.com/abc123?X-Amz-Signature=deadbeef'
    },
    {
        name: 'outputs[].image.url（普通 CDN 带扩展名）',
        response: { outputs: [{ image: { url: 'https://cdn.example.com/render/final.webp' } }] },
        expect: 'https://cdn.example.com/render/final.webp'
    },
    {
        name: '火山方舟 data[].url（ark-content.volces.com 无扩展名）',
        response: { data: [{ url: 'https://ark-content.volces.com/img/xyz' }] },
        expect: 'https://ark-content.volces.com/img/xyz'
    },
    {
        name: 'xAI 返回顶层 url',
        response: { data: [{ url: 'https://imgen.x.ai/generated/9f8e.png' }] },
        expect: 'https://imgen.x.ai/generated/9f8e.png'
    },
    {
        name: 'OpenAI DALL-E b64_json',
        response: { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }] },
        expectPrefix: 'data:image/'
    },
    {
        name: 'grok2api images[]',
        response: { images: ['https://grokipedia.example.com/a.png', 'https://grokipedia.example.com/b.png'] },
        expect: 'https://grokipedia.example.com/a.png'
    },
    {
        name: '非图片 URL 必须被拒',
        response: { status: 'ok', docs: 'https://api.example.com/v1/help', homepage: 'https://example.com/about' },
        expect: null
    },
    {
        name: '嵌套 message.content 里的 markdown 图片',
        response: { choices: [{ message: { content: 'done ![img](https://img.example.org/out.png)' } }] },
        expect: 'https://img.example.org/out.png'
    },
    {
        name: 'Google Gemini candidates[].content.parts[].inlineData（官方图像响应格式）',
        response: {
            candidates: [{
                content: {
                    role: 'model',
                    parts: [
                        { text: 'Here is your image.' },
                        { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }
                    ]
                }
            }]
        },
        expectPrefix: 'data:image/'
    },
    {
        name: 'Google Gemini 下划线写法 inline_data',
        response: {
            candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }] } }]
        },
        expectPrefix: 'data:image/'
    }
];

let pass = 0;
CASES.forEach(function (testCase) {
    const got = extract(testCase.response);
    let ok;
    if (testCase.expectPrefix) {
        ok = typeof got === 'string' && got.indexOf(testCase.expectPrefix) === 0;
    } else {
        ok = got === testCase.expect;
    }
    if (ok) pass++;
    console.log((ok ? '✅' : '❌') + ' ' + testCase.name);
    if (!ok) {
        console.log('    期望: ' + (testCase.expectPrefix ? testCase.expectPrefix + '…' : testCase.expect));
        console.log('    实际: ' + got);
    }
});

console.log('\n' + pass + '/' + CASES.length + ' 通过');
process.exit(pass === CASES.length ? 0 : 1);
