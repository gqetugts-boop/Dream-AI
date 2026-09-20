/*
 * scripts/make-icons.mjs — 生成插件图标
 *
 * 为什么用脚本生成而不是直接放图片：
 *   图标是莫兰迪配色的几何造型，用代码画出来可以在改配色时一键重出，
 *   也能保证不同尺寸（23/46/192/512）严格等比、不糊边。
 *
 * 用法：node scripts/make-icons.mjs
 * 产物：assets/icons/*.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDreamAI } from '../tests/sandbox.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'assets', 'icons');
const DreamAI = await loadDreamAI(['src/core/photo-encode.js']);
const PE = DreamAI.PhotoEncode;

/** 颜色取自 src/ui/tokens.css 的浅色主题变量 */
const COLORS = {
    bgTop: [0x9C, 0x89, 0xB4],
    bgBottom: [0x75, 0x64, 0x90],
    surface: [0xFC, 0xFB, 0xF9],
    accent: [0xC9, 0x8B, 0x72],
    deep: [0x2B, 0x27, 0x33]
};

function mix(a, b, t) {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t
    ];
}

/** 圆角矩形的覆盖判定（超采样抗锯齿，采样数决定边缘平滑度） */
function coverage(x, y, rect, samples) {
    let hits = 0;
    const step = 1 / samples;
    for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
            const px = x + (sx + 0.5) * step;
            const py = y + (sy + 0.5) * step;
            if (insideRoundedRect(px, py, rect)) hits++;
        }
    }
    return hits / (samples * samples);
}

function insideRoundedRect(px, py, rect) {
    const { left, top, right, bottom, radius } = rect;
    if (px < left || px > right || py < top || py > bottom) return false;
    const cx = Math.min(Math.max(px, left + radius), right - radius);
    const cy = Math.min(Math.max(py, top + radius), bottom - radius);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= radius * radius;
}

/**
 * 画主图标：圆角紫调方块 + 右下角暖色圆点（代表"生成落点"）。
 * 造型刻意做成"一角更圆"的非对称圆角，和插件内的品牌标记保持一致。
 */
function renderIcon(size) {
    const data = new Uint8ClampedArray(size * size * 4);
    const pad = size * 0.02;
    const radius = size * 0.26;
    const markRect = {
        left: pad,
        top: pad,
        right: size - pad,
        bottom: size - pad,
        radius: radius
    };
    // 品牌标记：右下角的小圆
    const dotRadius = size * 0.115;
    const dotCenter = { x: size * 0.715, y: size * 0.715 };
    const samples = size <= 32 ? 3 : (size <= 64 ? 2 : 1);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * 4;
            const gradient = size <= 1 ? 0 : (x / size) * 0.35 + (y / size) * 0.65;

            // 背景：竖向渐变，四角留出透明
            const markCoverage = coverage(x, y, markRect, samples);
            let r = 0, g = 0, b = 0, a = 0;

            if (markCoverage > 0) {
                const bg = mix(COLORS.bgTop, COLORS.bgBottom, gradient);
                r = bg[0]; g = bg[1]; b = bg[2];
                a = 255 * markCoverage;
            }

            // 右下角圆点
            const dx = x + 0.5 - dotCenter.x;
            const dy = y + 0.5 - dotCenter.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const dotAlpha = Math.max(0, Math.min(1, (dotRadius - dist) + 0.5));
            if (dotAlpha > 0 && markCoverage > 0.5) {
                r = mix([r, g, b], COLORS.surface, dotAlpha * 0.92)[0];
                const mixed = mix([r, g, b], COLORS.surface, dotAlpha * 0.92);
                r = mixed[0]; g = mixed[1]; b = mixed[2];
            }

            data[offset] = r;
            data[offset + 1] = g;
            data[offset + 2] = b;
            data[offset + 3] = a;
        }
    }
    return { data, width: size, height: size, channels: 4 };
}

/** 面板预览图：浅色/暗色底上放图标，用于插件市场展示 */
function renderPreview(size, dark) {
    const data = new Uint8ClampedArray(size * size * 4);
    const bg = dark ? [0x22, 0x20, 0x2A] : [0xEF, 0xED, 0xE8];
    const inner = Math.round(size * 0.56);
    const icon = renderIcon(inner);
    const offset = Math.round((size - inner) / 2);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const o = (y * size + x) * 4;
            data[o] = bg[0]; data[o + 1] = bg[1]; data[o + 2] = bg[2]; data[o + 3] = 255;
            const ix = x - offset;
            const iy = y - offset;
            if (ix < 0 || iy < 0 || ix >= inner || iy >= inner) continue;
            const io = (iy * inner + ix) * 4;
            const alpha = icon.data[io + 3] / 255;
            if (alpha <= 0) continue;
            data[o] = bg[0] + (icon.data[io] - bg[0]) * alpha;
            data[o + 1] = bg[1] + (icon.data[io + 1] - bg[1]) * alpha;
            data[o + 2] = bg[2] + (icon.data[io + 2] - bg[2]) * alpha;
        }
    }
    return { data, width: size, height: size, channels: 4 };
}

function write(name, image) {
    const png = PE.encodePng(image);
    const target = path.join(OUT_DIR, name);
    fs.writeFileSync(target, png);
    console.log('  ' + name.padEnd(30) + String(image.width).padStart(4) + '×' + image.height + '  ' + png.length + ' B');
    return target;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log('生成图标到 assets/icons/');
write('plugin.png', renderIcon(23));          // manifest 默认尺寸
write('plugin@2x.png', renderIcon(46));       // 高分屏
write('pwa-192.png', renderIcon(192));
write('pwa-512.png', renderIcon(512));
write('preview-light.png', renderPreview(512, false));
write('preview-dark.png', renderPreview(512, true));
console.log('完成。');
