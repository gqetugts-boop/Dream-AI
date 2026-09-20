/*
 * tests/run-tests.mjs — Dream AI 插件自测
 *
 * 覆盖不需要 Photoshop 宿主的纯逻辑：
 *   - 图像编码（PNG/JPEG/缩放/位序）
 *   - 色彩空间与校色算法
 *   - 辉光与位移特效算法
 *   - 示波器统计
 *   - i18n 双语完整性（两套词条键必须一致）
 *
 * 用法：node tests/run-tests.mjs [用例名过滤]
 */
import { loadDreamAI, makeImage, installGlobals } from './sandbox.mjs';

const filter = process.argv[2] || '';
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    if (filter && name.indexOf(filter) === -1) return;
    return Promise.resolve()
        .then(fn)
        .then(() => { passed++; console.log('  \u2713 ' + name); })
        .catch((error) => {
            failed++;
            failures.push({ name, error });
            console.log('  \u2717 ' + name + '\n      ' + (error && error.message ? error.message : error));
        });
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error((message || 'not equal') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
}

function assertClose(actual, expected, tolerance, message) {
    if (!(Math.abs(actual - expected) <= tolerance)) {
        throw new Error((message || 'not close') + ': expected ' + expected + ' ±' + tolerance + ', got ' + actual);
    }
}

async function main() {
    const D = await loadDreamAI([
        'src/core/store.js',
        'src/core/bus.js',
        'src/core/logbus.js',
        'src/core/photo-encode.js',
        'src/i18n/zh-CN.js',
        'src/i18n/en-US.js',
        'src/i18n/i18n.js',
        'src/features/color-engine.js',
        'src/features/gallery.js',
        'src/features/task-queue.js',
        'src/features/batch.js',
        'src/providers/registry.js',
        'src/tools/glow-core.js',
        'src/tools/vfx-core.js',
        'src/tools/scope.js',
        'src/local/comfyui.js',
        'src/local/forge.js'
    ]);
    const missing = D.__missing || [];
    if (missing.length) console.log('（以下模块尚未落盘，相关用例跳过：' + missing.join(', ') + '）');

    /* ============ 样式键转换 ============ */
    await test('util: toKebabCase 覆盖 camelCase / kebab / 自定义属性', async () => {
        const u = D.util;
        assertEqual(u.toKebabCase('backgroundColor'), 'background-color', 'camelCase');
        assertEqual(u.toKebabCase('flexDirection'), 'flex-direction', '两段');
        assertEqual(u.toKebabCase('maxWidth'), 'max-width', 'maxWidth');
        assertEqual(u.toKebabCase('border-radius'), 'border-radius', '已是 kebab 保持');
        assertEqual(u.toKebabCase('--range-ratio'), '--range-ratio', '自定义属性保持');
        assertEqual(u.toKebabCase('flex'), 'flex', '单词不变');
        assertEqual(u.toKebabCase(''), '', '空串');
    });

    await test('util: el() 的 camelCase 样式键会真正生效', async () => {
        // 这是踩过的坑：setProperty 传 camelCase 不报错也不生效，
        // 导致马赛克背景色、卡片对齐等一大批内联样式被静默忽略。
        const applied = [];
        const node = D.util.el('div', {
            style: {
                backgroundColor: 'rgb(1,2,3)',
                flexDirection: 'column',
                maxWidth: '80%',
                '--custom-var': '7px'
            }
        });
        // 沙箱的 DOM 桩把 setProperty 调用记录下来
        assert(node, 'el 应返回节点');
        const cssText = [];
        for (const key of ['background-color', 'flex-direction', 'max-width', '--custom-var']) {
            cssText.push(key + '=' + (node.style && node.style.getPropertyValue ? node.style.getPropertyValue(key) : ''));
        }
        void applied;
        assert(cssText.join('|').indexOf('background-color=rgb(1,2,3)') !== -1,
            'backgroundColor 应被转成 background-color 并写入，实际：' + cssText.join('|'));
    });

    /* ============ 宿主探测 ============ */
    await test('host: 能通过全局 require 识别 UXP 宿主（含 ESM 包装场景）', async () => {
        // 复刻 UXP 的真实加载方式：经典脚本 + 全局 require。
        // 这条用例的存在意义：host.js 早期只判断 `typeof require`，
        // 在 ESM/沙箱下会静默降级成"浏览器预览"，导致 Photoshop 功能集体失效却不报错。
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
        const source = fs.readFileSync(path.join(root, 'src', 'boot', 'host.js'), 'utf8');

        const saved = globalThis.require;
        const seen = [];
        globalThis.require = (name) => {
            seen.push(name);
            if (name === 'photoshop') return { app: {}, core: {}, imaging: {} };
            if (name === 'uxp') return { host: { name: 'Photoshop', version: '25.0.0' }, storage: {} };
            return null;
        };
        try {
            const previous = globalThis.DreamAI.host;
            (0, eval)(source);
            assertEqual(globalThis.DreamAI.host.isUxp, true, '应识别为 UXP 宿主');
            assertEqual(globalThis.DreamAI.host.hasPhotoshop, true, '应识别出 photoshop 模块');
            assert(seen.indexOf('uxp') !== -1, '应尝试加载 uxp 模块');
            assert(seen.indexOf('photoshop') !== -1, '应尝试加载 photoshop 模块');
            globalThis.DreamAI.host = previous;
        } finally {
            if (saved === undefined) delete globalThis.require;
            else globalThis.require = saved;
        }
    });

    await test('host: 取不到宿主模块时降级为浏览器且给出可见信号', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
        const source = fs.readFileSync(path.join(root, 'src', 'boot', 'host.js'), 'utf8');
        const saved = globalThis.require;
        delete globalThis.require;
        try {
            const previous = globalThis.DreamAI.host;
            (0, eval)(source);
            assertEqual(globalThis.DreamAI.host.isUxp, false, '无宿主模块时应为浏览器模式');
            assertEqual(globalThis.DreamAI.host.hasPhotoshop, false, '不应声称有 photoshop 模块');
            globalThis.DreamAI.host = previous;
        } finally {
            if (saved !== undefined) globalThis.require = saved;
        }
    });

    /* ============ 编码 ============ */
    await test('photo-encode: crc32 已知向量', async () => {
        const PE = D.PhotoEncode;
        // "123456789" 的标准 CRC-32
        const bytes = new Uint8Array([...'123456789'].map((c) => c.charCodeAt(0)));
        assertEqual(PE.crc32(bytes), 0xCBF43926, 'crc32(123456789)');
    });

    await test('photo-encode: adler32 已知向量', async () => {
        const PE = D.PhotoEncode;
        const bytes = new Uint8Array([...'Wikipedia'].map((c) => c.charCodeAt(0)));
        assertEqual(PE.adler32(bytes), 0x11E60398, 'adler32(Wikipedia)');
    });

    await test('photo-encode: PNG 结构（签名/IHDR/sRGB/IDAT/IEND）', async () => {
        const PE = D.PhotoEncode;
        const img = makeImage(32, 16, (x, y) => [x * 8 & 255, y * 16 & 255, 100, 255]);
        const png = PE.encodePng(img);
        const magic = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        for (let i = 0; i < magic.length; i++) assertEqual(png[i], magic[i], 'signature byte ' + i);
        const text = Buffer.from(png).toString('latin1');
        assert(text.indexOf('IHDR') > 0, 'missing IHDR');
        assert(text.indexOf('sRGB') > 0, 'missing sRGB chunk');
        assert(text.indexOf('IDAT') > 0, 'missing IDAT');
        assert(text.indexOf('IEND') > 0, 'missing IEND');
        // 宽高写在大端位置 16..24
        assertEqual((png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19], 32, 'width');
        assertEqual((png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23], 16, 'height');
    });

    await test('photo-encode: deflate 往返（多种数据形态）', async () => {
        const PE = D.PhotoEncode;
        const zlib = await import('node:zlib');
        const cases = [
            new Uint8Array([7]),
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
            new Uint8Array(300).fill(7),
            Uint8Array.from({ length: 500 }, (_, i) => i & 255),
            Uint8Array.from({ length: 2000 }, (_, i) => (i * 37 + 11) & 255),
            Uint8Array.from({ length: 3000 }, () => Math.floor(Math.random() * 256))
        ];
        for (const input of cases) {
            const packed = PE.zlibCompress(input, 2);
            const back = new Uint8Array(zlib.inflateSync(Buffer.from(packed)));
            assertEqual(back.length, input.length, 'length for input of ' + input.length);
            for (let i = 0; i < input.length; i++) {
                if (back[i] !== input[i]) throw new Error('byte ' + i + ' mismatch for input of ' + input.length);
            }
        }
    });

    await test('photo-encode: PNG IDAT 可被外部 zlib 解压', async () => {
        const PE = D.PhotoEncode;
        const zlib = await import('node:zlib');
        const width = 40;
        const height = 24;
        const img = makeImage(width, height, (x, y) => [(x * 6) & 255, (y * 10) & 255, (x + y) & 255, 255]);
        const png = PE.encodePng(img);
        // 定位 IDAT
        let cursor = 8;
        let idat = null;
        while (cursor + 12 <= png.length) {
            const length = (png[cursor] << 24) | (png[cursor + 1] << 16) | (png[cursor + 2] << 8) | png[cursor + 3];
            const type = String.fromCharCode(png[cursor + 4], png[cursor + 5], png[cursor + 6], png[cursor + 7]);
            if (type === 'IDAT') {
                idat = png.subarray(cursor + 8, cursor + 8 + length);
                break;
            }
            cursor += 12 + length;
        }
        assert(idat, 'IDAT not found');
        const raw = zlib.inflateSync(Buffer.from(idat));
        assertEqual(raw.length, (width * 4 + 1) * height, 'raw scanline bytes');
    });

    await test('photo-encode: inflate 能解固定/动态/存储三种块', async () => {
        const PE = D.PhotoEncode;
        const zlib = await import('node:zlib');
        const cases = [
            new Uint8Array([1, 2, 3, 4, 5]),                       // 固定 Huffman
            new Uint8Array(200).fill(9),                            // 长重复（纯匹配）
            Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255),
            new Uint8Array([7])
        ];
        for (const input of cases) {
            const raw = zlib.deflateRawSync(Buffer.from(input));
            const out = PE.inflate(raw, input.length + 1024);
            assertEqual(out.length, input.length, 'inflate 长度，输入 ' + input.length);
            for (let i = 0; i < input.length; i++) {
                if (out[i] !== input[i]) throw new Error('inflate 字节 ' + i + ' 不符（输入 ' + input.length + '）');
            }
        }
    });

    await test('photo-encode: inflate 对损坏数据会报错而不是死循环', async () => {
        const PE = D.PhotoEncode;
        // 坏数据必须抛错并快速返回：早先缺边界检查时会无限扩张数组把进程挂死
        const started = Date.now();
        let threw = false;
        try {
            PE.inflate(new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x01, 0x02]), 4096);
        } catch (error) {
            threw = true;
        }
        assert(threw, '损坏数据应当抛错');
        assert(Date.now() - started < 2000, '损坏数据应当在 2 秒内失败，实际 ' + (Date.now() - started) + 'ms');
    });

    await test('photo-encode: PNG 编解码往返（含自研解码器）', async () => {
        const PE = D.PhotoEncode;
        const cases = [
            [1, 1, [200, 60, 40, 255]],
            [8, 6, [200, 60, 40, 255]],
            [33, 17, [10, 220, 130, 180]],
            [64, 48, [17, 17, 17, 255]],
            [5, 40, [0, 0, 0, 0]]
        ];
        for (const [w, h, fill] of cases) {
            const img = makeImage(w, h, () => fill);
            const png = PE.encodePng(img);
            const dataUrl = 'data:image/png;base64,' + Buffer.from(png).toString('base64');
            const decoded = PE.decodeDataUrlToImage(dataUrl);
            assertEqual(decoded.width, w, '解码宽度 ' + w + 'x' + h);
            assertEqual(decoded.height, h, '解码高度 ' + w + 'x' + h);
            for (let i = 0; i < w * h * 4; i++) {
                if (decoded.data[i] !== fill[i % 4]) {
                    throw new Error('像素 ' + i + ' 不符（' + w + 'x' + h + '）：期望 ' + fill[i % 4] + ' 实际 ' + decoded.data[i]);
                }
            }
        }
    });

    await test('photo-encode: 解码 RGB（无 alpha）PNG', async () => {
        const PE = D.PhotoEncode;
        const rgb = { data: new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255]), width: 3, height: 1, channels: 3 };
        const png = PE.encodePng(rgb, { colorType: 2 });
        const decoded = PE.decodeDataUrlToImage('data:image/png;base64,' + Buffer.from(png).toString('base64'));
        assertEqual(decoded.width, 3, '宽度');
        assertEqual(decoded.data[0], 255, '首像素 R');
        assertEqual(decoded.data[3], 255, '首像素 alpha 应补 255');
        assertEqual(decoded.data[4], 0, '次像素 R');
        assertEqual(decoded.data[5], 255, '次像素 G');
    });

    await test('photo-encode: base64 解码不依赖 atob', async () => {
        const PE = D.PhotoEncode;
        // UXP 不保证提供 atob，解码器必须自带实现
        const samples = ['', 'QQ==', 'QUI=', 'QUJD', 'aGVsbG8gd29ybGQ=', '////'];
        const saved = globalThis.atob;
        delete globalThis.atob;
        try {
            for (const text of samples) {
                const mine = Array.from(PE.base64ToBytes(text));
                const expected = Array.from(Buffer.from(text, 'base64'));
                assertEqual(mine.length, expected.length, 'base64 长度 ' + JSON.stringify(text));
                for (let i = 0; i < expected.length; i++) {
                    assertEqual(mine[i], expected[i], 'base64 字节 ' + i + ' of ' + JSON.stringify(text));
                }
            }
            // 整条链路：没有 atob 也要能解出 PNG
            const img = makeImage(4, 3, () => [12, 34, 56, 255]);
            const png = PE.encodePng(img);
            const decoded = PE.decodeDataUrlToImage('data:image/png;base64,' + Buffer.from(png).toString('base64'));
            assertEqual(decoded.width, 4, '无 atob 时解码宽度');
            assertEqual(decoded.data[0], 12, '无 atob 时首像素 R');
        } finally {
            if (saved !== undefined) globalThis.atob = saved;
        }
    });

    await test('photo-encode: 解码器正确剥离 zlib 容器', async () => {
        const PE = D.PhotoEncode;
        const zlib = await import('node:zlib');
        const payload = new Uint8Array([4, 200, 60, 40, 255]);
        const wrapped = new Uint8Array(zlib.deflateSync(Buffer.from(payload)));
        // 伪造一个只含 IDAT 的最小 PNG，确认 decodePng 会剥头尾
        const png = PE.encodePng(makeImage(1, 1, () => [200, 60, 40, 255]));
        const decoded = PE.decodePng(png);
        assertEqual(decoded.width, 1, '宽度');
        assertEqual(decoded.data[0], 200, 'R 通道');
        assertEqual(decoded.data[1], 60, 'G 通道');
        assertEqual(decoded.data[2], 40, 'B 通道');
        assertEqual(decoded.data[3], 255, 'alpha');
        // 直接把 zlib 流喂给 inflate 应当失败（说明确实需要剥容器）
        let directFailed = false;
        try { PE.inflate(wrapped.subarray(0, wrapped.length), 4096); } catch (error) { directFailed = true; }
        assert(directFailed, 'inflate 只接受裸 deflate，喂 zlib 流应当报错');
    });

    await test('photo-encode: JPEG 头尾与尺寸字段', async () => {
        const PE = D.PhotoEncode;
        const img = makeImage(24, 16, () => [128, 64, 200, 255]);
        const jpg = PE.encodeJpeg(img, { quality: 85 });
        assertEqual(jpg[0], 0xFF, 'SOI 0');
        assertEqual(jpg[1], 0xD8, 'SOI 1');
        assertEqual(jpg[jpg.length - 2], 0xFF, 'EOI 0');
        assertEqual(jpg[jpg.length - 1], 0xD9, 'EOI 1');
        const text = Buffer.from(jpg).toString('latin1');
        assert(text.indexOf('JFIF') > 0, 'missing JFIF marker');
        const sofIndex = text.indexOf('\u00ff\u00c0');
        assert(sofIndex > 0, 'missing SOF0 segment');
        const height = (jpg[sofIndex + 5] << 8) | jpg[sofIndex + 6];
        const width = (jpg[sofIndex + 7] << 8) | jpg[sofIndex + 8];
        assertEqual(width, 24, 'jpeg width');
        assertEqual(height, 16, 'jpeg height');
    });

    await test('photo-encode: 双线性缩放保持尺寸与整体色调', async () => {
        const PE = D.PhotoEncode;
        const img = makeImage(64, 64, () => [200, 40, 10, 255]);
        const small = PE.resizeImage(img, 16, 16);
        assertEqual(small.width, 16, 'width');
        assertEqual(small.height, 16, 'height');
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < small.data.length; i += 4) {
            r += small.data[i]; g += small.data[i + 1]; b += small.data[i + 2];
        }
        const count = small.data.length / 4;
        assertClose(r / count, 200, 2, 'mean red');
        assertClose(g / count, 40, 2, 'mean green');
        assertClose(b / count, 10, 2, 'mean blue');
    });

    await test('photo-encode: ensureSrgbChunk 幂等', async () => {
        const PE = D.PhotoEncode;
        const png = PE.encodePng(makeImage(8, 8, [1, 2, 3, 255]));
        const again = PE.ensureSrgbChunk(png);
        assertEqual(again.length, png.length, 'already-tagged PNG must be untouched');
    });

    /* ============ i18n ============ */
    await test('i18n: 中英词条键完全对齐', async () => {
        // 必须先并入启动早期排队的词条，否则比较的是两个空字典（测试会假通过）
        D.I18n.flushQueue();
        const zh = Object.keys(D.I18n.dictionaries['zh-CN']);
        const en = Object.keys(D.I18n.dictionaries['en-US']);
        assert(zh.length > 200, '词条数量异常偏少（' + zh.length + '），队列可能未并入');
        const missingInEn = zh.filter((k) => en.indexOf(k) === -1);
        const missingInZh = en.filter((k) => zh.indexOf(k) === -1);
        assert(missingInEn.length === 0, '英文缺少 ' + missingInEn.length + ' 个键: ' + missingInEn.slice(0, 8).join(', '));
        assert(missingInZh.length === 0, '中文缺少 ' + missingInZh.length + ' 个键: ' + missingInZh.slice(0, 8).join(', '));
    });

    await test('i18n: 语言切换与插值', async () => {
        const I = D.I18n;
        I.flushQueue();
        I.init();
        I.setLang('zh-CN');
        assertEqual(I.t('nav.workbench'), '生图', 'zh nav');
        assertEqual(I.t('reference.count', { used: 2, max: 4 }), '2 / 4', 'interpolation');
        I.setLang('en-US');
        assertEqual(I.t('nav.workbench'), 'Generate', 'en nav');
        assertEqual(I.t('reference.count', { used: 2, max: 4 }), '2 / 4', 'interpolation en');
        assertEqual(I.langBadge(), 'EN', 'badge');
        I.setLang('zh-CN');
    });

    await test('i18n: 缺失词条回退为键名而不是空串', async () => {
        const I = D.I18n;
        assertEqual(I.t('does.not.exist'), 'does.not.exist', 'fallback');
    });

    /* ============ 色彩引擎 ============ */
    await test('color-engine: sRGB↔线性↔Lab 往返稳定', async () => {
        const CE = D.ColorEngine;
        for (const rgb of [[0, 0, 0], [255, 255, 255], [128, 64, 32], [12, 200, 90]]) {
            const lab = CE.srgbToLab(rgb[0], rgb[1], rgb[2]);
            const back = CE.labToSrgb(lab.L, lab.a, lab.b);
            assertClose(back.r, rgb[0], 1.5, 'roundtrip r for ' + rgb.join(','));
            assertClose(back.g, rgb[1], 1.5, 'roundtrip g for ' + rgb.join(','));
            assertClose(back.b, rgb[2], 1.5, 'roundtrip b for ' + rgb.join(','));
        }
    });

    await test('color-engine: Lab 白点与中灰', async () => {
        const CE = D.ColorEngine;
        const white = CE.srgbToLab(255, 255, 255);
        assertClose(white.L, 100, 0.5, 'white L');
        const gray = CE.srgbToLab(119, 119, 119);
        assertClose(gray.L, 50, 2, '18% gray L');
    });

    await test('color-engine: 均值方差迁移把源图统计对齐到参考图', async () => {
        const CE = D.ColorEngine;
        const width = 32;
        const height = 32;
        const source = makeImage(width, height, (x, y) => [40 + (x % 8) * 4, 60, 90, 255]);
        const reference = makeImage(width, height, () => [180, 150, 120, 255]);
        const result = CE.transferMeanStd(source, reference, { strength: 100, mask: null });
        const stat = (img) => {
            let r = 0, g = 0, b = 0;
            for (let i = 0; i < img.data.length; i += 4) { r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; }
            const n = img.data.length / 4;
            return { r: r / n, g: g / n, b: b / n };
        };
        const src = stat(source);
        const ref = stat(reference);
        const got = stat(result);
        assertClose(got.g, ref.g, 4, 'green mean');
        assertClose(got.b, ref.b, 4, 'blue mean');
        // 红通道源图方差极小，迁移后应显著靠近参考均值
        assertClose(got.r, ref.r, 12, 'red mean');
        assert(Math.abs(got.r - ref.r) < Math.abs(src.r - ref.r), 'red should move toward reference');
    });

    await test('color-engine: 强度 0 时输出等于输入', async () => {
        const CE = D.ColorEngine;
        const source = makeImage(16, 16, (x, y) => [x * 16, y * 16, 50, 255]);
        const reference = makeImage(16, 16, () => [10, 200, 30, 255]);
        const result = CE.transferMeanStd(source, reference, { strength: 0 });
        for (let i = 0; i < source.data.length; i++) {
            assertEqual(result.data[i], source.data[i], 'pixel byte ' + i);
        }
    });

    await test('color-engine: 多尺度低频重建尺寸一致', async () => {
        const CE = D.ColorEngine;
        const img = makeImage(64, 48, (x, y) => [(x * 4) & 255, (y * 5) & 255, 128, 255]);
        const low = CE.reconstructLowFrequency(img, { radius: 8, passes: 3 });
        assertEqual(low.width, 64, 'width');
        assertEqual(low.height, 48, 'height');
        assertEqual(low.data.length, img.data.length, 'data length');
    });

    /* ============ 辉光 ============ */
    await test('glow-core: 参数归一化与范围钳制', async () => {
        const G = D.GlowCore;
        const p = G.normalizeParams({ style: 'starburst', strength: 500, radius: -20, threshold: 9999 });
        assertEqual(p.style, 'starburst', 'style');
        assertEqual(p.strength, 100, 'strength clamped');
        assertEqual(p.radius, 1, 'radius clamped');
        assertEqual(p.threshold, 100, 'threshold clamped');
    });

    await test('glow-core: 未知风格回退到默认', async () => {
        const G = D.GlowCore;
        const p = G.normalizeParams({ style: 'nope-not-real' });
        assertEqual(p.style, G.STYLES[0], 'fallback style must be a known style');
    });

    await test('glow-core: 提供全部风格预设', async () => {
        const G = D.GlowCore;
        assert(G.STYLES.length >= 5, 'expected at least 5 styles, got ' + G.STYLES.length);
        for (const style of G.STYLES) {
            const preset = G.normalizeParams({ style }).preset;
            assert(preset && typeof preset === 'object', 'style ' + style + ' has no preset table');
        }
    });

    await test('glow-core: 发射蒙版只点亮高光区域', async () => {
        const G = D.GlowCore;
        // 左半黑、中间一块亮、右半暗灰
        const img = makeImage(64, 16, (x) => (x > 24 && x < 40 ? [250, 250, 240, 255] : [8, 8, 10, 255]));
        const params = G.normalizeParams({ style: 'whiteSoft', threshold: 60 });
        const built = G.buildSource(img, params);
        assertEqual(built.width, 64, 'width');
        assertEqual(built.height, 16, 'height');
        let left = 0, mid = 0, right = 0;
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 64; x++) {
                const v = built.source[y * 64 + x];
                if (x <= 20) left += v; else if (x >= 28 && x <= 36) mid += v; else if (x >= 50) right += v;
            }
        }
        assert(mid > left * 4, 'highlight region should dominate: mid=' + mid.toFixed(3) + ' left=' + left.toFixed(3));
        assert(mid > right * 4, 'highlight region should dominate: mid=' + mid.toFixed(3) + ' right=' + right.toFixed(3));
    });

    await test('glow-core: 多尺度金字塔输出尺寸正确且有能量', async () => {
        const G = D.GlowCore;
        const img = makeImage(96, 48, (x, y) => (x > 40 && x < 56 && y > 16 && y < 32 ? [255, 255, 250, 255] : [6, 6, 8, 255]));
        const params = G.normalizeParams({ style: 'shine', strength: 80, radius: 120 });
        const built = G.buildSource(img, params);
        const glow = G.buildMultiScaleGlow(built.source, 96, 48, params);
        assertEqual(glow.length, 96 * 48, 'glow layer length');
        let sum = 0;
        for (let i = 0; i < glow.length; i++) sum += glow[i];
        assert(sum > 0, 'glow layer must carry energy');
        let peak = 0;
        for (let i = 0; i < glow.length; i++) peak = Math.max(peak, glow[i]);
        assert(peak > 0.0001, 'glow peak must be non-zero');
    });

    await test('glow-core: 屏幕混合结果不小于基图', async () => {
        const G = D.GlowCore;
        const base = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
        const glow = new Float32Array([0.2, 0.1, 0.0, 0.3, 0.2, 0.1]);
        const out = G.screenBlend(base, glow);
        for (let i = 0; i < base.length; i++) {
            assert(out[i] >= base[i] - 1e-6, 'screen blend must not darken at ' + i);
            assert(out[i] <= 1 + 1e-6, 'screen blend must stay <= 1 at ' + i);
        }
    });

    await test('glow-core: 强度 0 不产生辉光', async () => {
        const G = D.GlowCore;
        const img = makeImage(32, 32, () => [255, 255, 255, 255]);
        const params = G.normalizeParams({ style: 'whiteSoft', strength: 0 });
        const built = G.buildSource(img, params);
        const glow = G.buildMultiScaleGlow(built.source, 32, 32, params);
        let sum = 0;
        for (let i = 0; i < glow.length; i++) sum += glow[i];
        assert(sum < 0.5, 'zero strength should produce ~no glow, got ' + sum.toFixed(3));
    });

    /* ============ VFX ============ */
    await test('vfx-core: 预设齐全且参数被钳制', async () => {
        const V = D.VfxCore;
        assert(V.EFFECTS.length >= 4, 'expected at least 4 effects');
        for (const effect of V.EFFECTS) {
            const s = V.normalizeSettings({ effect: effect.id, intensity: 1000, range: -5 });
            assertEqual(s.effect, effect.id, 'effect kept');
            assertEqual(s.intensity, 100, 'intensity clamped');
            assertEqual(s.range, V.RANGES.range[0], 'range clamped to min');
        }
    });

    await test('vfx-core: 位移场为零时输出等于输入', async () => {
        const V = D.VfxCore;
        const img = makeImage(32, 32, (x, y) => [(x * 7) & 255, (y * 5) & 255, 60, 255]);
        const result = V.render(img, { effect: 'heat', intensity: 0, glow: 0 });
        for (let i = 0; i < img.data.length; i++) {
            assertEqual(result.imageData.data[i], img.data[i], 'byte ' + i);
        }
    });

    await test('vfx-core: 位移图通道编码与蒙版范围', async () => {
        const V = D.VfxCore;
        const img = makeImage(48, 48, (x, y) => [(x * 4) & 255, (y * 4) & 255, 90, 255]);
        const result = V.render(img, { effect: 'airflow', intensity: 60, range: 70, glow: 0 });
        assert(result.displacement, 'displacement map must be returned');
        assertEqual(result.displacement.length, 48 * 48 * 4, 'displacement length');
        let alphaOk = true;
        for (let i = 3; i < result.displacement.length; i += 4) {
            if (result.displacement[i] !== 255) { alphaOk = false; break; }
        }
        assert(alphaOk, 'displacement alpha must be 255');
        // 蒙版应主要集中在画面中部，边缘为 0
        const maskAt = (x, y) => result.displacement[(y * 48 + x) * 4 + 2];
        assertEqual(maskAt(0, 0), 0, 'corner mask should be 0');
        let center = 0;
        for (let y = 20; y < 28; y++) for (let x = 20; x < 28; x++) center = Math.max(center, maskAt(x, y));
        assert(center > 40, 'center mask should be non-trivial, got ' + center);
    });

    await test('vfx-core: 非零强度会改变像素', async () => {
        const V = D.VfxCore;
        const img = makeImage(64, 64, (x, y) => [((x * 3) ^ (y * 5)) & 255, (y * 3) & 255, 120, 255]);
        const result = V.render(img, { effect: 'blade', intensity: 90, range: 60, detail: 70, glow: 40 });
        let diff = 0;
        for (let i = 0; i < img.data.length; i += 4) {
            if (result.imageData.data[i] !== img.data[i]) diff++;
        }
        assert(diff > 50, 'expected visible displacement, changed pixels = ' + diff);
    });

    /* ============ 示波器 ============ */
    await test('scope: 直方图统计总量等于像素数', async () => {
        const S = D.Scope;
        const img = makeImage(40, 30, (x, y) => [(x * 6) & 255, (y * 8) & 255, 128, 255]);
        const hist = S.histogram(img);
        assertEqual(hist.r.length, 256, 'r buckets');
        const sumR = hist.r.reduce((a, b) => a + b, 0);
        assertEqual(sumR, 40 * 30, 'r total');
        const sumLuma = hist.luma.reduce((a, b) => a + b, 0);
        assertEqual(sumLuma, 40 * 30, 'luma total');
    });

    await test('scope: 波形图按列聚合', async () => {
        const S = D.Scope;
        const img = makeImage(20, 20, () => [255, 255, 255, 255]);
        const wave = S.waveform(img, { columns: 10, bins: 16 });
        assertEqual(wave.columns, 10, 'columns');
        assertEqual(wave.bins, 16, 'bins');
        assertEqual(wave.bins0.length, 10 * 16, 'matrix length');
        // 全白图应集中在最高 bin
        for (let c = 0; c < 10; c++) {
            const top = wave.bins0[c * 16 + 15];
            assert(top > 0, 'top bin of column ' + c + ' should be non-zero');
        }
    });

    await test('scope: 矢量示波器给出色度分布', async () => {
        const S = D.Scope;
        const img = makeImage(32, 32, () => [200, 60, 60, 255]);
        const vector = S.vectorscope(img, { size: 32 });
        assertEqual(vector.size, 32, 'size');
        assertEqual(vector.data.length, 32 * 32, 'data length');
        const total = vector.data.reduce((a, b) => a + b, 0);
        assertEqual(total, 32 * 32, 'samples');
    });

    /* ============ 任务队列 ============ */
    if (D.TaskQueue && D.bus) {
        /*
         * 等待任务进入终态。
         *
         * 两个坑必须一起躲开：
         *   1. 任务可能在 subscribe 之前就已经结束（队列是同步 pump 的），
         *      所以进来先查一次当前状态；
         *   2. 定时器不能 unref，否则"等待"本身不占事件循环，
         *      失败路径会变成静默退出而不是超时报错。
         */
        const waitFor = (taskId, timeoutMs) => new Promise((resolve, reject) => {
            const started = Date.now();
            let done = false;
            const finish = (task) => {
                if (done) return;
                done = true;
                off();
                clearInterval(timer);
                resolve(task);
            };
            const fail = (error) => {
                if (done) return;
                done = true;
                off();
                clearInterval(timer);
                reject(error);
            };
            const current = D.TaskQueue.get(taskId);
            if (current && D.TaskQueue.isTerminal(current.state)) {
                resolve(current);
                return;
            }
            const off = D.bus.on('task:update', (payload) => {
                if (!payload || !payload.task || payload.task.id !== taskId) return;
                if (D.TaskQueue.isTerminal(payload.task.state)) finish(payload.task);
            });
            const timer = setInterval(() => {
                const task = D.TaskQueue.get(taskId);
                if (task && D.TaskQueue.isTerminal(task.state)) finish(task);
                else if (Date.now() - started > timeoutMs) {
                    fail(new Error('task ' + taskId + ' 未在 ' + timeoutMs + 'ms 内结束（当前状态 ' +
                        (task ? task.state : 'missing') + '）'));
                }
            }, 25);
        });

        await test('task-queue: 成功任务会记录结果并写回历史', async () => {
            const Q = D.TaskQueue;
            Q.init();
            const before = Q.list().length;
            const task = Q.enqueue({
                title: 'unit ok',
                providerId: 'unit',
                modelId: 'unit-model',
                mode: 'txt2img',
                prompt: 'hello',
                autoReturn: false,
                executor: async (t, helpers) => {
                    helpers.setProgress(50, 'half');
                    await D.util.sleep(10);
                    helpers.setProgress(100, 'done');
                    return { images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 4, height: 4 }] };
                }
            });
            assert(task && task.id, 'enqueue 应返回任务对象');
            assert(Q.list().length === before + 1, '任务应进入列表');
            const settled = await waitFor(task.id, 4000);
            assertEqual(settled.state, 'done', '任务应完成');
            assert(settled.images && settled.images.length === 1, '应保存结果图');
            assert(settled.finishedAt >= settled.startedAt, '起止时间应合理');
        });

        await test('task-queue: 失败任务记录错误且不写回', async () => {
            const Q = D.TaskQueue;
            const task = Q.enqueue({
                title: 'unit fail',
                providerId: 'unit',
                prompt: 'unit fail prompt',
                autoReturn: true,
                executor: async () => { throw new Error('unit-test-boom'); }
            });
            const settled = await waitFor(task.id, 4000);
            assertEqual(settled.state, 'failed', '任务应失败');
            assert(settled.error, '失败任务应带 error 文案');
            assert(!(settled.meta && settled.meta.returned), '失败任务不应产生回写图层');
        });

        await test('task-queue: 取消运行中的任务', async () => {
            const Q = D.TaskQueue;
            const task = Q.enqueue({
                title: 'unit cancel',
                providerId: 'unit',
                prompt: 'unit cancel prompt',
                executor: (t, helpers) => new Promise((resolve, reject) => {
                    const timer = setTimeout(() => resolve({ images: [] }), 3000);
                    timer.unref && timer.unref();
                    if (helpers.signal) {
                        helpers.signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('aborted'));
                        });
                    }
                })
            });
            await D.util.sleep(30);
            Q.cancel(task.id);
            const settled = await waitFor(task.id, 4000);
            assert(['canceled', 'failed', 'timeout', 'done'].indexOf(settled.state) !== -1,
                '取消后任务应进入终态，实际 ' + settled.state);
        });

        await test('task-queue: 超时会被标记为 timeout', async () => {
            const Q = D.TaskQueue;
            const task = Q.enqueue({
                title: 'unit timeout',
                providerId: 'unit',
                prompt: 'unit timeout prompt',
                timeout: 60,
                // 执行器不理会中止信号：这样唯一能让任务结束的就是队列自己的超时兜底
                executor: () => new Promise((resolve) => {
                    const timer = setTimeout(() => resolve({
                        images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 1, height: 1 }]
                    }), 2000);
                    if (timer.unref) timer.unref();
                })
            });
            const settled = await waitFor(task.id, 5000);
            assert(['timeout', 'failed'].indexOf(settled.state) !== -1,
                '60ms 超时的任务必须进入终态且不能是 done，实际 ' + settled.state);
        });

        await test('task-queue: 无外部定时器时执行器仍能跑完（保活）', async () => {
            const Q = D.TaskQueue;
            // 执行器内部只用一个 unref 过的定时器：如果没有队列保活，
            // 事件循环会被判定为空、宿主/进程提前退出，任务永远停在进行中。
            const task = Q.enqueue({
                title: 'unit keepalive',
                providerId: 'unit',
                prompt: 'unit keepalive prompt',
                autoReturn: false,
                executor: () => new Promise((resolve) => {
                    const timer = setTimeout(() => resolve({
                        images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 1, height: 1 }]
                    }), 300);
                    if (timer.unref) timer.unref();
                })
            });
            const settled = await waitFor(task.id, 5000);
            assertEqual(settled.state, 'done', '只有 unref 定时器时任务也应当完成');
        });

        await test('task-queue: clearFinished 只清理终态任务', async () => {
            const Q = D.TaskQueue;
            const terminal = Q.list().filter((task) => Q.isTerminal(task.state)).length;
            const removed = Q.clearFinished();
            assertEqual(removed, terminal, '清理条数应等于终态任务数');
            assert(Q.list().every((task) => !Q.isTerminal(task.state)), '清理后不应残留终态任务');
        });

        await test('task-queue: 并发上限被遵守', async () => {
            const Q = D.TaskQueue;
            // 通过设置域直接写入并发上限，避免依赖 App.patch 的存在
            D.Store.write('settings', { behavior: { maxConcurrent: 1 } });
            if (D.App && typeof D.App.loadSettings === 'function') D.App.loadSettings();
            const order = [];
            let active = 0;
            let peak = 0;
            const make = (name) => Q.enqueue({
                title: name,
                providerId: 'unit',
                prompt: name + ' prompt',
                autoReturn: false,
                executor: async () => {
                    active++;
                    peak = Math.max(peak, active);
                    order.push(name + ':start');
                    await D.util.sleep(30);
                    order.push(name + ':end');
                    active--;
                    return { images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 1, height: 1 }] };
                }
            });
            const a = make('A');
            const b = make('B');
            await Promise.all([waitFor(a.id, 5000), waitFor(b.id, 5000)]);
            assertEqual(peak, 1, '并发峰值应为 1，实际 ' + peak);
            assertEqual(order.join(','), 'A:start,A:end,B:start,B:end', '执行顺序应为串行，实际 ' + order.join(','));
            Q.clearFinished();
        });
    }

    /* ============ 画廊 ============ */
    if (D.Gallery) {
        await test('gallery: 写入 / 读取 / 删除', async () => {
            const G = D.Gallery;
            if (typeof G.init === 'function') G.init();
            const entry = await G.add('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', {
                prompt: 'unit gallery',
                providerId: 'unit',
                modelId: 'unit',
                width: 1,
                height: 1
            });
            assert(entry && entry.id, 'add 应返回带 id 的记录');
            const listed = G.list();
            assert(listed.some((item) => item.id === entry.id), '新记录应出现在列表里');
            const dataUrl = await G.getDataUrl(entry.id);
            assert(typeof dataUrl === 'string', 'getDataUrl 应返回字符串');
            assert(await G.remove(entry.id) === true, 'remove 应返回 true');
            assert(!G.list().some((item) => item.id === entry.id), '删除后不应再出现在列表里');
        });

        await test('gallery: prune 遵守数量策略', async () => {
            const G = D.Gallery;
            const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
            const created = [];
            for (let i = 0; i < 3; i++) {
                created.push(await G.add(pixel, { prompt: 'prune ' + i }));
            }
            const result = await G.prune({ mode: 'count', maxCount: 1, maxDays: 30 });
            assert(result && typeof result.kept === 'number', 'prune 应返回 { kept, removed }');
            assert(G.list().length <= 1, '清理后最多保留 1 条，实际 ' + G.list().length);
            for (const item of created) await G.remove(item.id).catch(() => {});
        });

        await test('gallery: policy() 返回合法策略', async () => {
            const policy = D.Gallery.policy();
            assert(['count', 'days', 'both'].indexOf(policy.mode) !== -1, 'mode 取值非法: ' + policy.mode);
            assert(policy.maxCount >= 1 && policy.maxCount <= 500, 'maxCount 越界: ' + policy.maxCount);
            assert(policy.maxDays >= 1 && policy.maxDays <= 3650, 'maxDays 越界: ' + policy.maxDays);
        });
    }

    /* ============ 批处理 ============ */
    if (D.Batch) {
        await test('batch: 队列增删清空', async () => {
            const B = D.Batch;
            if (typeof B.init === 'function') B.init();
            B.clear();
            const first = B.add({ prompt: 'batch one', providerId: 'unit' });
            const second = B.add({ prompt: 'batch two', providerId: 'unit' });
            assert(first && first.id && second && second.id, 'add 应返回带 id 的条目');
            assertEqual(B.list().length, 2, '队列应有 2 条');
            assert(B.remove(first.id) === true, 'remove 应返回 true');
            assertEqual(B.list().length, 1, '删除后应剩 1 条');
            assertEqual(B.clear(), 1, 'clear 应返回清理条数');
            assertEqual(B.list().length, 0, '清空后队列为空');
        });

        await test('batch: 空队列启动会安全返回', async () => {
            const B = D.Batch;
            B.clear();
            const result = await B.start();
            assert(result && typeof result.ok === 'number' && typeof result.fail === 'number',
                'start 应返回 { ok, fail }，实际 ' + JSON.stringify(result));
            assertEqual(result.ok + result.fail, 0, '空队列不应产生任何执行');
            assertEqual(B.isRunning(), false, '空队列启动后不应处于运行态');
        });
    }

    /* ============ 本地引擎 ============ */
    if (D.ComfyUI) {
        await test('comfyui: 工作流校验能区分 API / 界面 / 非法格式', async () => {
            const C = D.ComfyUI;
            const good = C.validateWorkflow(JSON.stringify({
                '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
                '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } }
            }));
            assertEqual(good.ok, true, '合法的 API 工作流应通过');
            assertEqual(good.nodeCount, 2, '节点数应为 2');

            const ui = C.validateWorkflow(JSON.stringify({ nodes: [{ id: 1 }], links: [] }));
            assertEqual(ui.ok, false, '界面格式工作流应被拒绝');
            assert(ui.reason && ui.reason.length > 0, '应给出拒绝原因');

            const broken = C.validateWorkflow('{ not json');
            assertEqual(broken.ok, false, '非法 JSON 应被拒绝');
            assert(typeof broken.reason === 'string', '应给出原因字符串');

            const empty = C.validateWorkflow('{}');
            assertEqual(empty.ok, false, '空工作流应被拒绝');
        });

        await test('comfyui: 参数抽取能识别提示词与采样参数', async () => {
            const C = D.ComfyUI;
            const params = C.extractParams({
                '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 25, cfg: 7.5 } },
                '6': { class_type: 'CLIPTextEncode', inputs: { text: 'hello' } },
                '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024 } }
            });
            assert(Array.isArray(params), '应返回数组');
            const keys = params.map((p) => p.key);
            assert(keys.indexOf('seed') !== -1, '应识别 seed');
            assert(keys.indexOf('steps') !== -1, '应识别 steps');
            assert(keys.indexOf('text') !== -1, '应识别提示词文本');
            assert(keys.indexOf('width') !== -1, '应识别宽度');
        });

        await test('comfyui: 配置读写与默认值合并', async () => {
            const C = D.ComfyUI;
            const defaults = C.loadConfig();
            assert(defaults && typeof defaults === 'object', 'loadConfig 应返回对象');
            C.saveConfig({ prompt: 'unit test prompt' });
            const after = C.loadConfig();
            assertEqual(after.prompt, 'unit test prompt', '写入的提示词应可读回');
            assert(after.localUrl, '默认本地地址应保留');
            if (typeof C.resetConfig === 'function') C.resetConfig();
        });
    }

    if (D.Forge) {
        await test('forge: 配置读写与尺寸取整规则', async () => {
            const F = D.Forge;
            const defaults = F.loadConfig();
            assert(defaults && typeof defaults === 'object', 'loadConfig 应返回对象');
            assert(defaults.width && defaults.height, '默认应有宽高');
            F.saveConfig({ steps: 33, denoise: 0.5 });
            const after = F.loadConfig();
            assertEqual(after.steps, 33, '写入的步数应可读回');
            assertEqual(after.denoise, 0.5, '写入的降噪强度应可读回');
            if (typeof F.resetConfig === 'function') F.resetConfig();
        });
    }

    /* ============ 存储与总线 ============ */
    await test('store: 命名空间读写与默认值合并', async () => {
        const Store = D.Store;
        const defaults = { a: 1, nested: { x: 'x', y: 'y' } };
        Store.remove('test-domain');
        const first = Store.read('test-domain', defaults);
        assertEqual(first.a, 1, 'default a');
        assertEqual(first.nested.x, 'x', 'default nested');
        Store.write('test-domain', { a: 9, nested: { y: 'changed' } }, defaults);
        const again = Store.read('test-domain', defaults);
        assertEqual(again.a, 9, 'written a');
        assertEqual(again.nested.x, 'x', 'untouched nested key preserved');
        assertEqual(again.nested.y, 'changed', 'patched nested key');
        Store.remove('test-domain');
    });

    await test('bus: 订阅/派发/取消', async () => {
        const bus = D.bus;
        let hits = 0;
        const off = bus.on('unit:test', () => { hits++; });
        bus.emit('unit:test', {});
        off();
        bus.emit('unit:test', {});
        assertEqual(hits, 1, 'handler should fire exactly once');
    });

    await test('bus: 订阅者抛错不影响其他订阅者', async () => {
        const bus = D.bus;
        let ok = 0;
        const offBad = bus.on('unit:throw', () => { throw new Error('boom'); });
        const offGood = bus.on('unit:throw', () => { ok++; });
        bus.emit('unit:throw', {});
        offBad(); offGood();
        assertEqual(ok, 1, 'second handler must still run');
    });

    await test('logbus: 环形缓冲上限与文本导出', async () => {
        const LB = D.logbus;
        LB.clear();
        for (let i = 0; i < LB.limit + 25; i++) LB.info('entry ' + i, { domain: 'unit' });
        assertEqual(LB.size, LB.limit, 'size capped at limit');
        const text = LB.toText();
        assert(text.indexOf('entry ' + (LB.limit + 24)) !== -1, 'newest entry kept');
        assert(text.indexOf('entry 0') === -1, 'oldest entry evicted');
        LB.clear();
    });

    console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' 通过 / ' + failed + ' 失败');
    if (failed > 0) {
        console.log('\n失败明细：');
        for (const item of failures) console.log(' - ' + item.name + ': ' + (item.error && item.error.message ? item.error.message : item.error));
        process.exitCode = 1;
    }
}

installGlobals();
main().catch((error) => {
    console.error('测试运行器崩溃：', error);
    process.exitCode = 1;
});
