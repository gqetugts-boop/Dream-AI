/*
 * tools/vfx-core.js — 位移特效算法内核
 *
 * 职责：
 *   1. 定义「热浪 / 气流 / 刀光 / 涟漪」四种位移特效的参数区间（RANGES）与完整预设（PRESETS）；
 *   2. 用分形值噪声（振幅逐层减半、频率逐层翻倍）叠加沿轴波动，构造平滑位移场，
 *      再对源图做边缘钳制的双线性重采样；
 *   3. 输出 8 位位移图：R/G = 128 + 像素位移 × 2（量程 ±63.5 像素），
 *      B = 掩膜强度（0-255），A = 255，可直接交给宿主的置换滤镜或自绘预览；
 *   4. 沿效果轴生成软光带，按 glowColorAmount 与效果基色混合后以屏幕混合叠加。
 *
 * 输入：{ data, width, height, channels }（交错通道，3 或 4，取值 0-255）+ 设置对象。
 * 输出：{ imageData: { data, width, height, channels }, displacement, settings }。
 *
 * 边界：
 *   - 纯算法模块：不碰 DOM / Canvas / Photoshop，可在 Node 下直接跑测试；
 *   - 不修改入参，永远返回新缓冲区；
 *   - 逐像素循环内零分配（噪声先算在粗网格上，循环里只做双线性升采样）；
 *   - 设置缺失、超界、类型错误一律钳制到合法值，不抛异常。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.VfxCore) return;

    var util = DreamAI.util;

    var TAU = Math.PI * 2;
    var DEG = Math.PI / 180;
    var INV255 = 1 / 255;

    /** 位移图编码倍率：R/G = 128 + 像素位移 × DISPLACEMENT_SCALE（1 单位 = 0.5 像素） */
    var DISPLACEMENT_SCALE = 2;

    /* ============================================================
     * 1. 参数区间 / 效果定义 / 预设
     * ============================================================ */

    /** 面板滑块直接读这张表取上下限 */
    var RANGES = {
        intensity: [0, 100],
        range: [10, 100],
        feather: [0, 100],
        angle: [-180, 180],
        detail: [0, 100],
        glow: [0, 100],
        glowColorAmount: [0, 100],
        brush: [8, 120],
        octaves: [1, 6],
        phase: [0, 360]
    };

    /** 中心点区间（不进 RANGES，面板用归一化坐标 0-1） */
    var CENTER_RANGE = [0, 1];

    /**
     * 效果算法定义表。
     *   flowMode    默认流向：linear = 沿角度方向，radial = 由中心向外，swirl = 绕中心旋转；
     *   maskProfile 掩膜形状：band = 沿角度方向的软光带，radial = 以中心为原点的软圆盘；
     *   along/perp  主轴 / 垂直方向的位移权重；
     *   gain        整体位移幅度系数；
     *   bandScale   光带厚度系数（越小越细，刀光就是细带）；
     *   ringScale   径向波频率倍数；
     *   noiseScale  噪声频率倍数；
     *   glowScale   辉光软光带宽度系数；
     *   phase       该效果的固定相位偏移（度）。
     */
    var EFFECT_DEFS = {
        heat: {
            id: 'heat', labelKey: 'vfx.effectHeat', color: '#ff9a4d',
            flowMode: 'linear', maskProfile: 'radial',
            along: 0.30, perp: 1.00, gain: 0.85, bandScale: 1.15,
            ringScale: 0.55, noiseScale: 0.95, glowScale: 1.80, phase: 0
        },
        airflow: {
            id: 'airflow', labelKey: 'vfx.effectAirflow', color: '#9fd8ff',
            flowMode: 'linear', maskProfile: 'band',
            along: 0.35, perp: 1.00, gain: 1.00, bandScale: 1.00,
            ringScale: 0.60, noiseScale: 1.15, glowScale: 1.35, phase: 0
        },
        blade: {
            id: 'blade', labelKey: 'vfx.effectBlade', color: '#e6f2ff',
            flowMode: 'linear', maskProfile: 'band',
            along: 0.95, perp: 0.45, gain: 1.25, bandScale: 0.70,
            ringScale: 0.90, noiseScale: 1.30, glowScale: 0.75, phase: 90
        },
        ripple: {
            id: 'ripple', labelKey: 'vfx.effectRipple', color: '#7fb4ff',
            flowMode: 'radial', maskProfile: 'radial',
            along: 1.00, perp: 0.55, gain: 0.95, bandScale: 1.00,
            ringScale: 1.80, noiseScale: 0.90, glowScale: 1.00, phase: 0
        }
    };

    /** 效果清单（面板下拉框用，labelKey 由 I18n 负责解析） */
    var EFFECTS = (function () {
        var order = ['heat', 'airflow', 'blade', 'ripple'];
        var list = [];
        for (var i = 0; i < order.length; i++) {
            var def = EFFECT_DEFS[order[i]];
            list.push({ id: def.id, labelKey: def.labelKey });
        }
        return list;
    })();

    /** 默认设置：热浪，沿用面板文档里定下的初始值 */
    var DEFAULT_SETTINGS = {
        effect: 'heat',
        flowMode: 'linear',
        intensity: 48,
        range: 62,
        feather: 54,
        angle: 90,
        detail: 58,
        glow: 12,
        glowColor: '#ffd27a',
        glowColorAmount: 28,
        glowColorEnabled: true,
        brush: 42,
        centerX: 0.5,
        centerY: 0.5,
        octaves: 4,
        phase: 0
    };

    /** 每种效果一套完整预设（键集合与 DEFAULT_SETTINGS 一致，切换效果不会留下半套参数） */
    var PRESETS = {
        heat: {
            effect: 'heat', flowMode: 'linear',
            intensity: 48, range: 62, feather: 54, angle: 90, detail: 58,
            glow: 12, glowColor: '#ffd27a', glowColorAmount: 28, glowColorEnabled: true,
            brush: 42, centerX: 0.5, centerY: 0.5, octaves: 4, phase: 0
        },
        airflow: {
            effect: 'airflow', flowMode: 'linear',
            intensity: 56, range: 70, feather: 62, angle: 105, detail: 66,
            glow: 18, glowColor: '#bfe4ff', glowColorAmount: 42, glowColorEnabled: true,
            brush: 44, centerX: 0.5, centerY: 0.5, octaves: 4, phase: 40
        },
        blade: {
            effect: 'blade', flowMode: 'linear',
            intensity: 72, range: 58, feather: 38, angle: 135, detail: 74,
            glow: 46, glowColor: '#e9f4ff', glowColorAmount: 36, glowColorEnabled: true,
            brush: 26, centerX: 0.5, centerY: 0.5, octaves: 5, phase: 120
        },
        ripple: {
            effect: 'ripple', flowMode: 'radial',
            intensity: 52, range: 76, feather: 70, angle: 90, detail: 52,
            glow: 22, glowColor: '#9ec8ff', glowColorAmount: 40, glowColorEnabled: true,
            brush: 48, centerX: 0.5, centerY: 0.5, octaves: 3, phase: 0
        }
    };

    /* ============================================================
     * 2. 小工具：钳制 / 颜色 / 平滑阶跃
     * ============================================================ */

    /** 取 [min,max] 区间内的数值，非法值回落到 fallback */
    function numIn(value, fallback, bounds) {
        var fb = util.toNumber(fallback, bounds[0]);
        if (fb < bounds[0]) fb = bounds[0];
        if (fb > bounds[1]) fb = bounds[1];
        var n;
        if (value === undefined || value === null || value === '') {
            n = fb;
        } else {
            n = Number(value);
            if (!isFinite(n)) n = fb;
        }
        if (n < bounds[0]) return bounds[0];
        if (n > bounds[1]) return bounds[1];
        return n;
    }

    function boolIn(value, fallback) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return isFinite(value) ? value !== 0 : !!fallback;
        if (typeof value === 'string') {
            var s = value.toLowerCase();
            if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
            if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
        }
        return !!fallback;
    }

    function flowModeIn(value, fallback) {
        var modes = { radial: true, linear: true, swirl: true };
        var candidate = typeof value === 'string' ? value.toLowerCase() : '';
        if (modes[candidate]) return candidate;
        var fb = typeof fallback === 'string' ? fallback.toLowerCase() : '';
        return modes[fb] ? fb : 'linear';
    }

    /** 归一化 16 进制色值，非法值回落到 fallback */
    function hexIn(value, fallback) {
        var text = typeof value === 'string' ? value.replace(/^\s+|\s+$/g, '') : '';
        if (/^#[0-9a-fA-F]{3}$/.test(text)) {
            text = '#' + text.charAt(1) + text.charAt(1) + text.charAt(2) +
                text.charAt(2) + text.charAt(3) + text.charAt(3);
        }
        if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
        return fallback;
    }

    function hexToRgb(hex) {
        var text = String(hex || '').replace('#', '');
        if (text.length === 3) {
            text = text.charAt(0) + text.charAt(0) + text.charAt(1) + text.charAt(1) +
                text.charAt(2) + text.charAt(2);
        }
        var value = parseInt(text, 16);
        if (!isFinite(value)) return { r: 255, g: 255, b: 255 };
        return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
    }

    /** 平滑阶跃：v ≤ e0 → 0，v ≥ e1 → 1（保证边界处严格取到 0） */
    function sstep(e0, e1, v) {
        var span = e1 - e0;
        if (span <= 1e-9) return v < e0 ? 0 : 1;
        var t = (v - e0) / span;
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        return t * t * (3 - 2 * t);
    }

    /** 双线性混合四个采样点 */
    function blend4(v00, v10, v01, v11, fx, fy) {
        var top = v00 + (v10 - v00) * fx;
        var bottom = v01 + (v11 - v01) * fx;
        return top + (bottom - top) * fy;
    }

    /**
     * 通道数归一化：缺失 / 非数字一律按 4 通道处理。
     * 直接调 util.clamp 会把 null 当成 0 再钳到 1，这里显式区分「没给」和「给了 0」。
     */
    function channelsOf(image) {
        var raw = image ? image.channels : null;
        if (raw === undefined || raw === null || raw === '') return 4;
        var n = Number(raw);
        if (!isFinite(n)) return 4;
        n = Math.round(n);
        if (n < 1) return 1;
        if (n > 4) return 4;
        return n;
    }

    /** 像素位移 → 8 位位移图编码值 */
    function encodeShift(pixels) {
        var v = Math.round(128 + pixels * DISPLACEMENT_SCALE);
        if (v < 0) return 0;
        if (v > 255) return 255;
        return v;
    }

    /* ============================================================
     * 3. 分形值噪声
     * ============================================================ */

    /** 32 位整数乘法（ES5 下不依赖 Math.imul） */
    function imul(a, b) {
        var ah = (a >>> 16) & 0xFFFF;
        var al = a & 0xFFFF;
        var bh = (b >>> 16) & 0xFFFF;
        var bl = b & 0xFFFF;
        return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
    }

    /** 整数格点哈希 → 0..1（确定性，不含随机数，保证同参数同结果） */
    function hash01(ix, iy, seed) {
        var h = imul(ix | 0, 0x27D4EB2D);
        h = (h + imul(iy | 0, 0x165667B1)) | 0;
        h = (h + imul(seed | 0, 0x9E3779B1)) | 0;
        h = (h ^ (h >>> 15)) | 0;
        h = imul(h, 0x85EBCA6B);
        h = (h ^ (h >>> 13)) | 0;
        h = imul(h, 0xC2B2AE35);
        h = (h ^ (h >>> 16)) | 0;
        return (h >>> 0) / 4294967296;
    }

    /** 单层值噪声：格点随机值 + 平滑双线性插值，返回 -1..1 */
    function valueNoise(x, y, seed) {
        var x0 = Math.floor(x);
        var y0 = Math.floor(y);
        var fx = x - x0;
        var fy = y - y0;
        var ux = fx * fx * (3 - 2 * fx);
        var uy = fy * fy * (3 - 2 * fy);
        var n00 = hash01(x0, y0, seed);
        var n10 = hash01(x0 + 1, y0, seed);
        var n01 = hash01(x0, y0 + 1, seed);
        var n11 = hash01(x0 + 1, y0 + 1, seed);
        var top = n00 + (n10 - n00) * ux;
        var bottom = n01 + (n11 - n01) * ux;
        return (top + (bottom - top) * uy) * 2 - 1;
    }

    /** 分形值噪声：振幅逐层减半、频率逐层翻倍，返回 -1..1 */
    function fbm(x, y, octaves, seed) {
        var sum = 0;
        var amp = 1;
        var freq = 1;
        var norm = 0;
        for (var o = 0; o < octaves; o++) {
            sum += amp * valueNoise(x * freq, y * freq, seed + o * 1013);
            norm += amp;
            amp *= 0.5;
            freq *= 2.02;
        }
        return norm > 0 ? sum / norm : 0;
    }

    /* ============================================================
     * 4. 参数归一化
     * ============================================================ */

    /**
     * 把任意输入补成完整、合法、可直接渲染的设置对象。
     * 缺省值取自对应效果的预设，非法值一律钳制而不是抛错。
     */
    function normalizeSettings(settings) {
        var raw = util.isPlainObject(settings) ? settings : {};
        var effectId = (typeof raw.effect === 'string' && PRESETS[raw.effect]) ? raw.effect : DEFAULT_SETTINGS.effect;
        var preset = PRESETS[effectId] || DEFAULT_SETTINGS;
        var def = EFFECT_DEFS[effectId] || EFFECT_DEFS.heat;

        var out = {};
        out.effect = effectId;
        out.flowMode = flowModeIn(raw.flowMode, preset.flowMode || def.flowMode);
        out.intensity = numIn(raw.intensity, preset.intensity, RANGES.intensity);
        out.range = numIn(raw.range, preset.range, RANGES.range);
        out.feather = numIn(raw.feather, preset.feather, RANGES.feather);
        out.angle = numIn(raw.angle, preset.angle, RANGES.angle);
        out.detail = numIn(raw.detail, preset.detail, RANGES.detail);
        out.glow = numIn(raw.glow, preset.glow, RANGES.glow);
        out.glowColor = hexIn(raw.glowColor, preset.glowColor || DEFAULT_SETTINGS.glowColor);
        out.glowColorAmount = numIn(raw.glowColorAmount, preset.glowColorAmount, RANGES.glowColorAmount);
        out.glowColorEnabled = boolIn(raw.glowColorEnabled, preset.glowColorEnabled);
        out.brush = numIn(raw.brush, preset.brush, RANGES.brush);
        out.centerX = numIn(raw.centerX, preset.centerX, CENTER_RANGE);
        out.centerY = numIn(raw.centerY, preset.centerY, CENTER_RANGE);
        out.octaves = Math.round(numIn(raw.octaves, preset.octaves, RANGES.octaves));
        out.phase = numIn(raw.phase, preset.phase, RANGES.phase);
        return out;
    }

    /* ============================================================
     * 5. 渲染
     * ============================================================ */

    /** 统一入口：归一化设置 → 位移场 → 重采样 → 辉光合成 */
    function render(sourceImage, settings) {
        var opts = normalizeSettings(settings);
        var def = EFFECT_DEFS[opts.effect] || EFFECT_DEFS.heat;

        var width = Math.max(1, Math.round(util.toNumber(sourceImage && sourceImage.width, 1)));
        var height = Math.max(1, Math.round(util.toNumber(sourceImage && sourceImage.height, 1)));
        var channels = channelsOf(sourceImage);
        var count = width * height;

        var source = (sourceImage && sourceImage.data && sourceImage.data.length >= count * channels)
            ? sourceImage.data
            : new Uint8ClampedArray(count * channels);

        var out = new Uint8ClampedArray(count * channels);
        var displacement = new Uint8ClampedArray(count * 4);

        /* ---------- 5.1 与像素位置无关的预计算 ---------- */

        var angleRad = opts.angle * DEG;
        var axisX = Math.cos(angleRad);
        var axisY = Math.sin(angleRad);
        var perpX = -axisY;
        var perpY = axisX;

        var centerPx = opts.centerX * (width - 1);
        var centerPy = opts.centerY * (height - 1);
        var halfX = Math.max(centerPx, width - 1 - centerPx);
        var halfY = Math.max(centerPy, height - 1 - centerPy);
        var maxHalf = Math.max(halfX, halfY);
        var maxRadius = Math.sqrt(halfX * halfX + halfY * halfY);
        if (!(maxRadius > 0)) maxRadius = 1;

        // 掩膜：光带 / 圆盘的到达半径（到此外沿掩膜严格为 0）、平台半径、沿轴衰减区间
        var baseExtent = Math.min(width, height) * 0.5;
        var brushFactor = util.clamp(opts.brush / 42, 0.35, 2.4, 1);
        var reach = baseExtent * (0.18 + 0.82 * opts.range / 100) * brushFactor * def.bandScale;
        var softness = 0.15 + 0.80 * opts.feather / 100;
        var inner = reach * (1 - softness);
        if (inner < 0) inner = 0;
        var taperStart = maxHalf * 0.42;
        var taperEnd = maxHalf * 1.35;
        var taperDepth = 0.55;
        // 画面边界渐隐：让四角掩膜恒为 0
        var edgeStart = maxRadius * (0.40 + 0.30 * opts.range / 100);
        if (edgeStart > maxRadius) edgeStart = maxRadius;

        // 位移幅度（像素）：强度 0 时严格为 0，保证「零位移 = 输出等于输入」
        var amp = opts.intensity * 0.12 * def.gain;

        var wavelength = Math.max(18, 120 - 0.9 * opts.detail);
        var waveFreq = TAU / wavelength;
        var cell = Math.max(6, 72 - 0.55 * opts.detail);
        var noiseFreq = (1 / cell) * def.noiseScale;
        var octaves = Math.round(util.clamp(opts.octaves, RANGES.octaves[0], RANGES.octaves[1], 4));
        var phaseRad = (opts.phase + def.phase) * DEG;

        // 辉光：软光带宽度、着色（效果基色 ← 辉光色混合）
        var glowAmount = opts.glow / 100;
        var glowReach = Math.max(1, opts.brush * def.glowScale * (0.6 + 0.8 * opts.range / 100));
        var glowMix = opts.glowColorAmount / 100;
        var baseRgb = hexToRgb(def.color);
        var glowRgb = hexToRgb(opts.glowColor);
        var colR = baseRgb.r;
        var colG = baseRgb.g;
        var colB = baseRgb.b;
        if (opts.glowColorEnabled) {
            colR = baseRgb.r + (glowRgb.r - baseRgb.r) * glowMix;
            colG = baseRgb.g + (glowRgb.g - baseRgb.g) * glowMix;
            colB = baseRgb.b + (glowRgb.b - baseRgb.b) * glowMix;
        }

        // 噪声在粗网格上求值，循环里只做双线性升采样（大图不再逐像素跑 8 次噪声）
        var noiseStep = Math.max(1, Math.min(4, Math.round(Math.min(width, height) / 160)));
        var gridW = Math.ceil(width / noiseStep) + 2;
        var gridH = Math.ceil(height / noiseStep) + 2;
        var fieldA = new Float32Array(gridW * gridH);
        var fieldB = new Float32Array(gridW * gridH);
        var stepFreq = noiseStep * noiseFreq;
        var gx;
        var gy;
        for (gy = 0; gy < gridH; gy++) {
            var rowBase = gy * gridW;
            var ny = gy * stepFreq;
            for (gx = 0; gx < gridW; gx++) {
                var nx = gx * stepFreq;
                fieldA[rowBase + gx] = fbm(nx, ny, octaves, 17);
                fieldB[rowBase + gx] = fbm(nx, ny, octaves, 911);
            }
        }

        var invStep = 1 / noiseStep;
        var isBand = def.maskProfile === 'band';
        var flowMode = opts.flowMode;
        var alongWeight = def.along;
        var perpWeight = def.perp;
        var ringScale = def.ringScale;

        /* ---------- 5.2 逐像素：掩膜 → 位移 → 重采样 → 辉光 ---------- */

        for (var y = 0; y < height; y++) {
            var relY = y - centerPy;
            var fieldY = y * invStep;
            var gyFloor = fieldY | 0;
            var fy = fieldY - gyFloor;

            for (var x = 0; x < width; x++) {
                var index = y * width + x;
                var offset = index * channels;
                var relX = x - centerPx;

                var dist = Math.sqrt(relX * relX + relY * relY);
                var along = relX * axisX + relY * axisY;
                var perp = relX * perpX + relY * perpY;
                var absPerp = perp < 0 ? -perp : perp;

                /* ---- 掩膜强度 ---- */
                var shape;
                if (isBand) {
                    shape = (reach <= 0 || absPerp >= reach) ? 0 : 1 - sstep(inner, reach, absPerp);
                    if (shape > 0) {
                        var absAlong = along < 0 ? -along : along;
                        if (absAlong > taperStart) {
                            shape *= 1 - taperDepth * sstep(taperStart, taperEnd, absAlong);
                        }
                    }
                } else {
                    shape = (reach <= 0 || dist >= reach) ? 0 : 1 - sstep(inner, reach, dist);
                }
                if (shape > 0) {
                    // 边界渐隐保证四角为 0；dist ≥ maxRadius 时结果严格为 0
                    shape *= dist >= maxRadius ? 0 : 1 - sstep(edgeStart, maxRadius, dist);
                }
                if (shape < 0) shape = 0;
                else if (shape > 1) shape = 1;

                /* ---- 噪声抬升采样 ---- */
                var fieldX = x * invStep;
                var gxFloor = fieldX | 0;
                var fx = fieldX - gxFloor;
                var cellIndex = gyFloor * gridW + gxFloor;

                var a00 = fieldA[cellIndex];
                var a10 = fieldA[cellIndex + 1];
                var a01 = fieldA[cellIndex + gridW];
                var a11 = fieldA[cellIndex + gridW + 1];
                var noiseA = blend4(a00, a10, a01, a11, fx, fy);

                var b00 = fieldB[cellIndex];
                var b10 = fieldB[cellIndex + 1];
                var b01 = fieldB[cellIndex + gridW];
                var b11 = fieldB[cellIndex + gridW + 1];
                var noiseB = blend4(b00, b10, b01, b11, fx, fy);

                /* ---- 位移向量 ---- */
                var dx = 0;
                var dy = 0;
                if (amp > 0 && shape > 0) {
                    var primary;
                    var secondary;
                    if (flowMode === 'linear') {
                        // 主轴：波动推动；垂直方向：噪声弯曲
                        var wave = Math.sin(along * waveFreq + phaseRad);
                        primary = wave * alongWeight + noiseB * 0.45;
                        secondary = noiseA * perpWeight;
                        dx = amp * shape * (primary * axisX + secondary * perpX);
                        dy = amp * shape * (primary * axisY + secondary * perpY);
                    } else {
                        var invDist = dist > 1e-4 ? 1 / dist : 0;
                        var ux = relX * invDist;
                        var uy = relY * invDist;
                        var ring = Math.sin(dist * waveFreq * ringScale + phaseRad);
                        if (flowMode === 'swirl') {
                            // 旋涡：以切线方向为主
                            primary = noiseA * 0.30 * alongWeight;
                            secondary = (0.90 * ring + 0.45 * noiseB) * perpWeight;
                        } else {
                            // 径向：同心环推动 + 噪声扰动
                            primary = ring * alongWeight + noiseA * 0.35;
                            secondary = noiseB * perpWeight;
                        }
                        dx = amp * shape * (primary * ux - secondary * uy);
                        dy = amp * shape * (primary * uy + secondary * ux);
                    }
                }

                /* ---- 辉光软光带（沿效果轴的线状项 × 掩膜） ---- */
                var glowStrength = 0;
                if (glowAmount > 0 && shape > 0 && absPerp < glowReach) {
                    glowStrength = shape * (1 - sstep(0, glowReach, absPerp));
                }

                /* ---- 重采样 ---- */
                var outR;
                var outG;
                var outB;
                if (dx === 0 && dy === 0) {
                    // 位移严格为 0：原位拷贝，保证逐字节等价
                    outR = source[offset];
                    outG = channels > 1 ? source[offset + 1] : outR;
                    outB = channels > 2 ? source[offset + 2] : outR;
                } else {
                    var sampleX = x + dx;
                    var sampleY = y + dy;
                    var x0 = Math.floor(sampleX);
                    var y0 = Math.floor(sampleY);
                    var fx2 = sampleX - x0;
                    var fy2 = sampleY - y0;
                    if (x0 < 0) { x0 = 0; fx2 = 0; }
                    else if (x0 > width - 1) { x0 = width - 1; fx2 = 0; }
                    if (y0 < 0) { y0 = 0; fy2 = 0; }
                    else if (y0 > height - 1) { y0 = height - 1; fy2 = 0; }
                    var x1 = x0 < width - 1 ? x0 + 1 : x0;
                    var y1 = y0 < height - 1 ? y0 + 1 : y0;
                    var o00 = (y0 * width + x0) * channels;
                    var o10 = (y0 * width + x1) * channels;
                    var o01 = (y1 * width + x0) * channels;
                    var o11 = (y1 * width + x1) * channels;
                    outR = blend4(source[o00], source[o10], source[o01], source[o11], fx2, fy2);
                    outG = channels > 1
                        ? blend4(source[o00 + 1], source[o10 + 1], source[o01 + 1], source[o11 + 1], fx2, fy2)
                        : outR;
                    outB = channels > 2
                        ? blend4(source[o00 + 2], source[o10 + 2], source[o01 + 2], source[o11 + 2], fx2, fy2)
                        : outR;
                }

                /* ---- 辉光：屏幕混合后按强度回混 ---- */
                if (glowAmount > 0 && glowStrength > 0) {
                    var gs = glowAmount * glowStrength;
                    outR += gs * colR * (1 - outR * INV255);
                    outG += gs * colG * (1 - outG * INV255);
                    outB += gs * colB * (1 - outB * INV255);
                }

                out[offset] = outR;
                if (channels > 1) out[offset + 1] = outG;
                if (channels > 2) out[offset + 2] = outB;
                if (channels > 3) out[offset + 3] = source[offset + 3];

                var dispOffset = index * 4;
                displacement[dispOffset] = encodeShift(dx);
                displacement[dispOffset + 1] = encodeShift(dy);
                displacement[dispOffset + 2] = Math.round(shape * 255);
                displacement[dispOffset + 3] = 255;
            }
        }

        return {
            imageData: { data: out, width: width, height: height, channels: channels },
            displacement: displacement,
            settings: opts
        };
    }

    /* ============================================================
     * 6. 注册
     * ============================================================ */

    DreamAI.VfxCore = {
        EFFECTS: EFFECTS,
        PRESETS: PRESETS,
        RANGES: RANGES,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        DISPLACEMENT_SCALE: DISPLACEMENT_SCALE,
        normalizeSettings: normalizeSettings,
        render: render
    };
})(typeof window !== 'undefined' ? window : this);
