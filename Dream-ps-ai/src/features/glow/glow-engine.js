/*
 * glow-engine.js
 * 忠实地照搬参考插件（像素起子 V2.8.1）的辉光 CPU 引擎：
 *   - normalizeGlowParams : UI 参数 → 算法参数（含风格预设表）
 *   - buildSourceMask     : 源蒙版 / 高光发射层
 *   - buildMultiScaleGlow : 多尺度高斯金字塔模糊 + 光学层（星芒/拉丝）
 *   - renderGlowLayer     : 输出纯辉光层（写回 Photoshop 用）
 *   - composeProtected    : base + 辉光层 → 屏幕混合预览
 * 全部基于 Canvas 2D / ImageData（UXP 无 WebGL 时的 CPU 等价实现）。
 */
window.GlowEngine = (function () {
    'use strict';

    // ---------- 数值工具 ----------
    function clamp(v, lo, hi, dflt) {
        v = Number(v);
        if (isFinite(v)) return v < lo ? lo : (v > hi ? hi : v);
        return dflt === undefined ? lo : dflt;
    }
    function saturate(v) { return v <= 0 ? 0 : (v >= 1 ? 1 : v); }
    function smooth01(e0, e1, x) {
        var t = saturate((x - e0) / Math.max(1e-4, e1 - e0));
        return t * t * (3 - 2 * t);
    }
    function smoothstep(e0, e1, x) {
        var t = saturate((x - e0) / Math.max(1e-6, e1 - e0));
        return t * t * (3 - 2 * t);
    }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function lerpArrays(a, b, t) {
        var out = [];
        for (var i = 0; i < a.length; i++) out.push(lerp(a[i], b[i], t));
        return out;
    }
    function srgbToLinear(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    function linearToSrgb(v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }
    function hash12(x, y) { var v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); }
    function hexToRgb01(hex) {
        var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
        if (!m) return { r: 1, g: 0.82, b: 0.48 };
        return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
    }

    // ---------- 平面图像（{width,height,r,g,b}，Float32Array） ----------
    function makeImage(w, h) {
        var n = w * h;
        return { width: w, height: h, r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n) };
    }
    function imageDataToSRGBPlanes(imgData) {
        var w = imgData.width, h = imgData.height, n = w * h;
        var img = makeImage(w, h), d = imgData.data;
        for (var i = 0; i < n; i++) { img.r[i] = d[i * 4] / 255; img.g[i] = d[i * 4 + 1] / 255; img.b[i] = d[i * 4 + 2] / 255; }
        return img;
    }
    function sampleClampIdx(img, x, y) {
        var ix = Math.max(0, Math.min(img.width - 1, Math.floor(x)));
        var iy = Math.max(0, Math.min(img.height - 1, Math.floor(y)));
        return iy * img.width + ix;
    }
    function sampleAt(img, x, y) {
        var i = sampleClampIdx(img, x, y);
        return { r: img.r[i], g: img.g[i], b: img.b[i] };
    }
    function sampleBilinear(img, x, y) {
        var x0 = Math.floor(x), y0 = Math.floor(y);
        var tx = x - x0, ty = y - y0;
        var f = function (i) { return { r: img.r[i], g: img.g[i], b: img.b[i] }; };
        var c00 = f(sampleClampIdx(img, x0, y0));
        var c10 = f(sampleClampIdx(img, x0 + 1, y0));
        var c01 = f(sampleClampIdx(img, x0, y0 + 1));
        var c11 = f(sampleClampIdx(img, x0 + 1, y0 + 1));
        var r = lerp(lerp(c00.r, c10.r, tx), lerp(c01.r, c11.r, tx), ty);
        var g = lerp(lerp(c00.g, c10.g, tx), lerp(c01.g, c11.g, tx), ty);
        var b = lerp(lerp(c00.b, c10.b, tx), lerp(c01.b, c11.b, tx), ty);
        return { r: r, g: g, b: b };
    }
    function maxChannel(img, x, y) {
        var i = sampleClampIdx(img, x, y);
        return Math.max(img.r[i], img.g[i], img.b[i]);
    }

    // ---------- 一维 box blur（局部均值） ----------
    function boxBlur1D(src, w, h, radius, vertical) {
        var n = w * h, out = new Float32Array(n);
        var r = Math.max(1, Math.floor(radius));
        if (!vertical) {
            for (var y = 0; y < h; y++) {
                var row = y * w, sum = 0, count = 0;
                for (var seedX = 0; seedX <= Math.min(r, w - 1); seedX++) { sum += src[row + seedX]; count++; }
                for (var x = 0; x < w; x++) {
                    out[row + x] = sum / Math.max(1, count);
                    var removeX = x - r;
                    var addX = x + r + 1;
                    if (removeX >= 0) { sum -= src[row + removeX]; count--; }
                    if (addX < w) { sum += src[row + addX]; count++; }
                }
            }
        } else {
            for (var xx = 0; xx < w; xx++) {
                var s2 = 0, c2 = 0;
                for (var seedY = 0; seedY <= Math.min(r, h - 1); seedY++) { s2 += src[seedY * w + xx]; c2++; }
                for (var yy = 0; yy < h; yy++) {
                    out[yy * w + xx] = s2 / Math.max(1, c2);
                    var removeY = yy - r;
                    var addY = yy + r + 1;
                    if (removeY >= 0) { s2 -= src[removeY * w + xx]; c2--; }
                    if (addY < h) { s2 += src[addY * w + xx]; c2++; }
                }
            }
        }
        return out;
    }
    function boxBlur(src, w, h, radius) {
        return boxBlur1D(boxBlur1D(src, w, h, radius, false), w, h, radius, true);
    }

    // ---------- 风格预设表（像素起子 V2.8.1 原值） ----------
    var PRESETS = {
        none:      { thresholdBias: 0,    whiteProtect: 1,   skinProtect: 0, darkProtect: 1,   knee: 0.18, chromaBoost: 0,   smallWeight: 0,   mediumWeight: 0,   largeWeight: 0,   warmth: 0,    scatter: 0 },
        darkSoft:  { thresholdBias: 0.04, whiteProtect: 0.94, skinProtect: 0, darkProtect: 0.62, knee: 0.17, chromaBoost: 0.14, smallWeight: 0.52, mediumWeight: 0.84, largeWeight: 0.34, warmth: 0.008, scatter: 0.72 },
        whiteSoft: { thresholdBias: -0.02, whiteProtect: 0.9, skinProtect: 0, darkProtect: 0.5, knee: 0.26, chromaBoost: 0.2, smallWeight: 0.3, mediumWeight: 0.9, largeWeight: 0.62, warmth: 0.03, scatter: 1.08 },
        shine:     { thresholdBias: -0.03, whiteProtect: 0.8, skinProtect: 0, darkProtect: 0.44, knee: 0.22, chromaBoost: 0.34, smallWeight: 0.34, mediumWeight: 0.86, largeWeight: 0.68, warmth: 0.05, scatter: 1.18 },
        starburst: { thresholdBias: 0.04, whiteProtect: 0.96, skinProtect: 0, darkProtect: 0.72, knee: 0.06, chromaBoost: 0.18, smallWeight: 0.16, mediumWeight: 0.055, largeWeight: 0.012, warmth: 0.018, scatter: 0.18 },
        anamorphic:{ thresholdBias: 0.035, whiteProtect: 0.94, skinProtect: 0, darkProtect: 0.7, knee: 0.07, chromaBoost: 0.16, smallWeight: 0.12, mediumWeight: 0.05, largeWeight: 0.014, warmth: 0.012, scatter: 0.16 }
    };
    function normalizeStyle(s) {
        var v = String(s || '').trim().toLowerCase();
        if (v === 'none') return 'none';
        if (v === 'whitesoft' || v === 'soft') return 'whiteSoft';
        if (v === 'shine' || v === 'dreamy') return 'shine';
        if (v === 'starburst' || v === 'star' || v === 'sparkle') return 'starburst';
        if (v === 'anamorphic' || v === 'wide' || v === 'streak' || v === 'widescreen') return 'anamorphic';
        return 'darkSoft';
    }

    // ---------- 参数归一化 ----------
    function normalizeGlowParams(ui) {
        ui = ui || {};
        var style = normalizeStyle(ui.style);
        var preset = PRESETS[style];
        var ue = style === 'starburst' || style === 'anamorphic';
        var triggerMode = style === 'starburst' ? 1 : (style === 'anamorphic' ? 2 : 0);

        var N = style === 'none' ? 0 : clamp(ui.strength, 0, 100, 47);
        var radius = clamp(ui.radius, 1, 500, 81);
        var thresholdRaw = clamp(ui.threshold, 0, 100, 81);
        var saturation = clamp(ui.saturation, -100, 100, 0);
        var brightnessBias = clamp(ui.brightnessBias, -100, 100, 0);
        var colorShift = clamp(ui.colorShift, -100, 100, 0);
        var starLength = clamp(ui.starLength, 10, 220, 58);
        var starCount = Math.round(clamp(ui.starCount, 4, 12, 6));
        var starRotation = clamp(ui.starRotation, -90, 90, 0);
        var starVisible = clamp(ui.starVisible, 0, 100, 68);
        var streakLength = clamp(ui.streakLength, 16, 300, 86);
        var streakVisible = clamp(ui.streakVisible, 0, 100, 62);
        var chromaticRaw = ui.chromaticEnabled === false ? 0 : clamp(ui.chromatic, 0, 100, 0);
        var colorAmount = (style === 'none' || ui.colorEnabled === false) ? 0 : clamp(ui.colorAmount, 0, 100, 0);

        var u = N / 100, f = radius / 500, B = Math.min(1, radius / 250), x = Math.max(0, (radius - 250) / 250);
        var G = thresholdRaw / 100, re = brightnessBias / 100;
        var ge = G, he = 1 - ge;
        var Ge = style === 'starburst' ? starVisible / 100 : (style === 'anamorphic' ? streakVisible / 100 : 1);
        var xe = Math.pow(Ge, style === 'anamorphic' ? 0.78 : 0.84), Fe = 1 - xe;
        var nt = Math.pow(Ge, style === 'anamorphic' ? 1.08 : 1.12);
        var Xe = 1 - G, Ze = Math.pow(Xe, 1.35), at = 1 - Math.pow(G, 1.78), Se = G, Te = Math.pow(G, 1.22);
        var Z = Math.pow(f, 0.92), ie = Math.pow(f, 1.15), be = Math.pow(f, 2), pw = Math.pow(u, 1.22);

        // —— source 段 ——
        var source;
        if (ue) {
            var thresholdHigh = clamp((style === 'starburst' ? 0.34 + ge * 0.56 : 0.3 + ge * 0.54) + preset.thresholdBias, 0.24, 0.96, 0.58);
            var thresholdKnee = clamp((style === 'starburst' ? 0.035 + he * 0.085 + Math.max(0, re) * 0.012 : 0.04 + he * 0.095 + Math.max(0, re) * 0.014), 0.025, 0.14, 0.06);
            source = {
                triggerMode: triggerMode,
                thresholdLow: clamp(thresholdHigh - thresholdKnee * (style === 'starburst' ? 1.15 : 1.35), 0.18, 0.94, 0.42),
                thresholdHigh: thresholdHigh,
                thresholdKnee: thresholdKnee,
                localRadius: Math.max(2, Math.round(style === 'starburst' ? 3 + he * 4 : 4 + he * 5)),
                sourceFeatherRadius: Math.max(1, Math.min(3, Math.round(style === 'starburst' ? 1 + he * 1.4 : 1 + he * 1.7))),
                contrastLow: clamp(0.016 - re * 0.006, 0.01, 0.03, 0.018),
                contrastHigh: clamp((style === 'starburst' ? 0.05 : 0.044) + ge * 0.09 - re * 0.012, 0.032, 0.15, 0.062),
                specularLow: clamp((style === 'starburst' ? 0.045 : 0.038) + ge * 0.04, 0.03, 0.105, 0.052),
                specularHigh: clamp((style === 'starburst' ? 0.18 : 0.16) + ge * 0.2, 0.13, 0.44, 0.24),
                lowEnergyCutoff: clamp((style === 'starburst' ? 0.034 : 0.03) + ge * 0.058 + Fe * (style === 'starburst' ? 0.012 : 0.009), 0.024, 0.12, 0.04),
                chromaBoost: clamp(preset.chromaBoost + saturation / 100 * 0.12 + Math.max(0, re) * 0.018, 0, 0.48, preset.chromaBoost),
                whiteProtect: preset.whiteProtect, skinProtect: preset.skinProtect, darkProtect: preset.darkProtect
            };
        } else {
            source = {
                triggerMode: 0,
                thresholdLow: clamp(0.16 + at * 0.8 + preset.thresholdBias * 0.35 - re * 0.02 - (0.034 + Se * 0.12 + Z * 0.018) * (0.35 + G * 0.3), 0.08, 0.965, 0.42),
                thresholdHigh: clamp(0.16 + at * 0.81 + preset.thresholdBias * 0.35 - re * 0.024, 0.12, 0.985, 0.58),
                thresholdKnee: clamp(0.022 + Te * 0.12 + B * 0.01 + Z * 0.014 + Math.max(0, re) * 0.018, 0.025, 0.17, 0.08),
                localRadius: Math.max(3, Math.round(4 + B * 10)),
                sourceFeatherRadius: Math.max(1, Math.min(2, Math.round(1 + B * 0.7))),
                contrastLow: clamp(0.024 - re * 0.009, 0.013, 0.038, 0.024),
                contrastHigh: clamp(0.052 + Ze * 0.078 - re * 0.018, 0.032, 0.15, 0.068),
                specularLow: clamp(0.06 + Ze * 0.05, 0.06, 0.12, 0.06),
                specularHigh: clamp(0.28 + Ze * 0.16, 0.28, 0.48, 0.28),
                lowEnergyCutoff: clamp(0.038 + Ze * 0.032, 0.038, 0.078, 0.038),
                chromaBoost: clamp(preset.chromaBoost + saturation / 100 * 0.24 + Math.max(0, re) * 0.03, 0, 0.68, preset.chromaBoost),
                whiteProtect: preset.whiteProtect, skinProtect: preset.skinProtect, darkProtect: preset.darkProtect
            };
        }

        // —— blur 段 ——
        var se = [0.68, 0.34, 0.14, 0.052, 0.018, 0.005, 0.002];
        var ke = [0.36, 0.32, 0.24, 0.16, 0.082, 0.035, 0.014];
        var g = [0.2, 0.23, 0.24, 0.22, 0.16, 0.09, 0.045];
        var K = clamp(Math.sqrt(f), 0, 1);
        var baseW;
        if (K < 0.52) baseW = lerpArrays(se, ke, K / 0.52);
        else baseW = lerpArrays(ke, g, (K - 0.52) / 0.48);
        var H = ue ? (style === 'starburst' ? [0.2, 0.07, 0.022, 0.006, 0.001, 0, 0] : [0.17, 0.065, 0.026, 0.008, 0.0015, 0, 0]) : baseW;
        var ae = style === 'none' ? 0 : clamp(0.98 + preset.smallWeight * 0.16 + preset.mediumWeight * 0.14 + preset.largeWeight * 0.12, 0, 1.42, 1.16);
        var Me = ue ? 0.22 : 1 + K * 0.12;
        var mipWeights = normalizeWeights(H, ae * Me);
        var We = ue ? (style === 'starburst' ? 2.4 + (1 - G) * 1.1 : 2.8 + (1 - G) * 1.2) : 2.7 + B * 3.1 + x * 1.35;
        var mipCount = ue ? clamp(Math.round(We), 2, 4) : clamp(Math.round(We), 2, 7);
        var lastMipMix = mipCount > (ue ? 2 : 3) ? clamp(We - (mipCount - 0.5), 0, 1, 0) : 1;
        var pyramidWeight = ue ? clamp(style === 'starburst' ? 0.24 + u * 0.1 : 0.22 + u * 0.095, 0.14, 0.42, 0.24)
                              : clamp(0.82 + K * 0.14 + preset.scatter * 0.045, 0.76, 1.08, 0.86);

        // —— composite 段 ——
        var chromatic = style === 'none' ? 0 : Math.pow(chromaticRaw / 100, 0.88);
        var composite = {
            intensity: ue
                ? clamp(pw * (style === 'starburst' ? 9.2 : 10.4) * (0.7 + (1 - G) * 0.16), 0, 28, 1)
                : clamp(pw * 12.2 * (1.08 + u * 0.52) * (1 + K * 0.12), 0, 38, 1),
            warmth: preset.warmth,
            saturation: ue ? clamp(1.08 + saturation / 100 * 0.34 + source.chromaBoost * 0.18, 0.72, 1.62, 1)
                          : clamp(1.22 + saturation / 100 * 0.56 + source.chromaBoost * 0.3, 0.72, 1.9, 1),
            shoulder: ue ? clamp(0.13 + u * 0.018, 0.1, 0.2, 0.14)
                        : clamp(0.16 + u * 0.028 + ie * 0.012 + Math.max(0, re) * 0.004, 0.12, 0.28, 0.18),
            colorShift: colorShift / 100,
            colorTint: hexToRgb01(ui.colorHex || '#ffd27a'),
            colorAmount: colorAmount / 100,
            chromatic: chromatic,
            energyFloor: ue ? 0.0018 + G * 0.003 : 0,
            energyFloorSoftness: ue ? 0.016 : 0.001,
            chromaticOffsetPx: Math.min(20, Math.max(0, Math.pow(Math.max(0, chromatic), 1.08) * (2.4 + Math.sqrt(Math.max(1, radius)) * 0.82)))
        };

        // —— optics 段 ——
        var optics = null;
        if (ue) {
            optics = {
                mode: style,
                strength: style === 'starburst'
                    ? clamp((0.28 + u * 0.72 + (1 - G) * 0.08) * (0.9 + Math.pow(starLength / 220, 0.7) * 0.2), 0, 1.25, 0.68)
                    : clamp((0.3 + u * 0.76 + (1 - G) * 0.075) * (0.95 + Math.pow(streakLength / 300, 0.72) * 0.22), 0, 1.32, 0.72),
                length: style === 'starburst' ? clamp(starLength * (0.92 + u * 0.16), 8, 260, 58) : clamp(streakLength * (0.96 + u * 0.2), 14, 360, 86),
                sharpness: style === 'starburst' ? 1.82 : 2.32,
                coreMix: style === 'starburst' ? 0.32 : 0.26,
                verticalTightness: style === 'anamorphic' ? 0.48 : 1,
                diagonalMix: style === 'starburst' ? 0.58 : 0,
                starCount: starCount,
                rotation: style === 'starburst' ? starRotation : 0,
                visibility: Ge,
                sourceGate: style === 'starburst'
                    ? clamp(0.012 + G * 0.08 + Fe * 0.038, 0.008, 0.18, 0.036)
                    : clamp(0.015 + G * 0.07 + Fe * 0.03, 0.008, 0.16, 0.03),
                sourceGateSoftness: style === 'starburst' ? clamp(0.02 + G * 0.05, 0.012, 0.09, 0.03) : clamp(0.018 + G * 0.045, 0.01, 0.08, 0.026),
                baseVeil: style === 'starburst' ? 0.018 : 0.016,
                normalization: style === 'starburst' ? clamp(0.58 + Fe * 0.12, 0.54, 0.78, 0.62) : clamp(0.56 + Fe * 0.1, 0.52, 0.72, 0.58),
                uiLength: style === 'anamorphic' ? streakLength : starLength
            };
        }

        var blur = {
            mipCount: mipCount,
            lastMipMix: lastMipMix,
            mipWeights: mipWeights,
            pyramidWeight: pyramidWeight,
            optics: optics
        };

        return { style: style, source: source, blur: blur, composite: composite, triggerMode: triggerMode };
    }

    function normalizeWeights(H, total) {
        var sum = 0, i;
        for (i = 0; i < H.length; i++) sum += Math.max(0, H[i]);
        if (sum <= 1e-6) return H.slice();
        var scaled = [];
        for (i = 0; i < H.length; i++) scaled.push(Math.max(0, H[i]) / sum * total);
        return scaled;
    }

    // ---------- 源蒙版 / 高光发射层 ----------
    function buildSourceMask(baseImg, p) {
        var w = baseImg.width, h = baseImg.height, n = w * h;
        var source = makeImage(w, h);
        var lum = new Float32Array(n), protection = new Float32Array(n), darkM = new Float32Array(n), emission = new Float32Array(n);

        // metrics：sRGB→linear，计算 maxChannel/minChannel/luma/sat
        var chMax = new Float32Array(n), chMin = new Float32Array(n), cLinR = new Float32Array(n), cLinG = new Float32Array(n), cLinB = new Float32Array(n);
        var i;
        for (i = 0; i < n; i++) {
            var sr = baseImg.r[i], sg = baseImg.g[i], sb = baseImg.b[i];
            var mx = Math.max(sr, sg, sb), mn = Math.min(sr, sg, sb);
            chMax[i] = mx; chMin[i] = mn;
            var rl = srgbToLinear(sr), gl = srgbToLinear(sg), bl = srgbToLinear(sb);
            cLinR[i] = rl; cLinG[i] = gl; cLinB[i] = bl;
            lum[i] = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
        }
        var sat = new Float32Array(n);
        for (i = 0; i < n; i++) sat[i] = chMax[i] <= 0 ? 0 : (chMax[i] - chMin[i]) / chMax[i];

        // 局部均值（一维 box blur）
        var localMean = boxBlur(lum, w, h, p.localRadius);

        var tL = p.triggerMode > 0.5;
        var tMid = p.triggerMode < 1.5;
        for (i = 0; i < n; i++) {
            var mm = chMax[i], mnN = chMin[i];
            var luma = lum[i], s = sat[i];
            var localM = localMean[i];
            var contrast = Math.max(0, luma - localM);
            var specular = Math.max(0, mm - localM);
            var brightness = Math.max(luma * 0.45 + mm * 0.55, mm * 0.86);

            var thresholdGate = softThreshold(brightness, p.thresholdHigh, p.thresholdKnee);
            var secondaryThresholdGate = smooth01(p.thresholdLow, p.thresholdHigh + p.thresholdKnee * 0.5, brightness);
            var brightPass = thresholdGate;
            var contrastScore = smooth01(p.contrastLow, p.contrastHigh, contrast);
            var specularScore = smooth01(p.specularLow, p.specularHigh, specular);
            var brightEnergy = Math.pow(saturate(brightPass), tL ? (tMid ? 1.58 : 1.42) : 1.16);
            var specularPass = Math.pow(specularScore, 1.16) * secondaryThresholdGate * smooth01(0.055, 0.22, specular);
            var rimPass = contrastScore * thresholdGate * smooth01(0.82, 0.98, brightness);

            var highLightness = smooth01(0.7, 0.95, luma);
            var veryHighLightness = smooth01(0.84, 0.985, luma);
            var clothContrast = 1 - smooth01(0.028, 0.16, contrast);
            var lowSat = 1 - smooth01(0.12, 0.36, s);
            var whiteFlat = highLightness * clothContrast * lowSat * (0.9 + veryHighLightness * 0.58);

            var skinHue = isSkinHue(chMax[i], chMin[i], baseImg.r[i], baseImg.g[i], baseImg.b[i]);
            var skinColor = skinHue * smooth01(0.16, 0.36, s) * (1 - smooth01(0.78, 0.96, s)) * smooth01(0.38, 0.74, luma) * (1 - smooth01(0.9, 1.0, luma));
            var dark = 1 - smooth01(0.18, 0.42, brightness);
            var midtoneReject = 1 - smooth01(0.48, 0.72, brightness);
            var protectionBase = saturate(whiteFlat * p.whiteProtect + skinColor * p.skinProtect * 0.9 + dark * p.darkProtect + midtoneReject * 0.62);

            var nearClip = smooth01(0.975, 1.0, mm);
            var clippingDetail = saturate(smooth01(0.12, 0.34, specular) * 0.72 + contrastScore * thresholdGate * 0.18 + s * 0.1);
            var nearClipException = nearClip * clippingDetail * thresholdGate;
            var protect = saturate(protectionBase * (1 - nearClipException * 0.42));

            var colorReflection = smooth01(0.1, 0.48, s) * smooth01(0.52, 0.92, brightness);
            var coloredEmitter = smooth01(0.38, 0.82, s)
                * smooth01(Math.max(0.42, p.thresholdLow * 0.62), Math.max(0.55, p.thresholdHigh * 0.92), mm)
                * smooth01(p.specularLow * 0.65, p.specularHigh * 0.8, specular);
            var opticalPointSignal = saturate(specularScore * (tL ? (tMid ? 0.78 : 0.62) : 0.78) + contrastScore * (tL ? (tMid ? 0.32 : 0.24) : 0.32) + nearClip * 0.58 + colorReflection * 0.18);
            var opticalPointGate = tL ? smooth01(tMid ? 0.2 : 0.14, tMid ? 0.72 : 0.58, opticalPointSignal) : 1.0;
            var opticalAreaGuard = tL ? (tMid ? 0.16 + opticalPointGate * 0.84 : 0.28 + opticalPointGate * 0.72) : 1.0;

            var emissionEnergy;
            if (tL) {
                emissionEnergy = brightEnergy * (tMid ? 0.98 : 1.1) * (1 + colorReflection * 0.12) * opticalAreaGuard
                    + specularPass * (tMid ? 0.82 : 0.64)
                    + coloredEmitter * (tMid ? 0.42 : 0.5)
                    + rimPass * (tMid ? 0.018 : 0.05);
            } else {
                emissionEnergy = brightEnergy * (1.2 + colorReflection * 0.18) + specularPass * 0.48 + coloredEmitter * 0.68 + rimPass * 0.028;
            }
            var neutralClothReject = whiteFlat * (1 - specularScore * 0.42) * (1 - nearClipException * 0.35) * (1 - colorReflection * 0.32);
            emissionEnergy *= 1 - protect * (tL ? (tMid ? 0.93 : 0.9) : 0.86);
            emissionEnergy *= 1 - neutralClothReject * (tL ? 0.94 : 0.82);
            emissionEnergy *= smooth01(p.lowEnergyCutoff * 0.62, p.lowEnergyCutoff * 2.6, emissionEnergy);
            emissionEnergy = tL
                ? saturate(Math.pow(Math.max(0, emissionEnergy), tMid ? 1.12 : 1.08) * (tMid ? 1.08 : 1.14))
                : saturate(Math.pow(Math.max(0, emissionEnergy), 1.04) * 1.18);

            var neutralHighlight = brightPass * (1 - s) * smooth01(0.82, 1.0, mm);
            var warmColorHint = smooth01(0.018, 0.16, Math.max(Math.abs(cLinR[i] - cLinG[i]), Math.abs(cLinG[i] - cLinB[i])));
            var chromaKeep = clamp(0.34 + s * 1.05 + warmColorHint * 0.24 + colorReflection * 0.22 + p.chromaBoost * 0.3 - neutralHighlight * 0.06, 0.18, 0.98);

            var ecR = lerp(brightness, cLinR[i], chromaKeep);
            var ecG = lerp(brightness, cLinG[i], chromaKeep);
            var ecB = lerp(brightness, cLinB[i], chromaKeep);
            source.r[i] = ecR * emissionEnergy;
            source.g[i] = ecG * emissionEnergy;
            source.b[i] = ecB * emissionEnergy;
            lum[i] = luma;
            protection[i] = protect;
            darkM[i] = dark;
            emission[i] = emissionEnergy;
        }

        // 源蒙版羽化（sourceFeatherRadius）
        if (p.sourceFeatherRadius > 1) {
            var fr = p.sourceFeatherRadius;
            var flatR = source.r, flatG = source.g, flatB = source.b;
            var fr2 = Math.max(1, Math.round(fr));
            source.r = boxBlur(flatR, w, h, fr2);
            source.g = boxBlur(flatG, w, h, fr2);
            source.b = boxBlur(flatB, w, h, fr2);
        }

        return {
            sourceLayer: source,
            masks: { lum: lum, protection: protection, dark: darkM, emission: emission },
            width: w, height: h
        };
    }

    function softThreshold(value, threshold, knee) {
        var safeKnee = Math.max(0.0001, knee);
        var soft = clamp(value - threshold + safeKnee, 0, safeKnee * 2);
        var curved = (soft * soft) / (safeKnee * 4);
        return saturate(Math.max(curved, value - threshold) / Math.max(value, 0.0001));
    }
    function isSkinHue(mx, mn, r, g, b) {
        var delta = mx - mn;
        if (delta > 1e-4 && r === mx && r > 0) {
            var hue = ((g - b) / delta) * 60;
            if (hue < 0) hue += 360;
            return (hue >= 5 && hue <= 52) ? 1 : 0;
        }
        return 0;
    }

    // ---------- 多尺度高斯金字塔 ----------
    var DS_KERNEL = [0.03125, 0.0625, 0.125, 0.25, 0.5, 1.0, 2.0, 1.0, 0.5, 0.25, 0.125, 0.0625, 0.03125];
    var DS_SUM = 0;
    for (var _ki = 0; _ki < DS_KERNEL.length; _ki++) DS_SUM += DS_KERNEL[_ki];

    function downsample(src) {
        var w = src.width, h = src.height;
        var dw = Math.max(1, Math.floor(w / 2)), dh = Math.max(1, Math.floor(h / 2));
        var tmp = makeImage(dw, h);
        var ox, oy, k;
        for (oy = 0; oy < h; oy++) {
            for (ox = 0; ox < dw; ox++) {
                var cx = ox * 2 + 0.5;
                var r = 0, g = 0, b = 0;
                for (k = 0; k < 13; k++) {
                    var sx = cx + (k - 6);
                    var px = sx < 0 ? 0 : (sx >= w ? w - 1 : Math.floor(sx));
                    var idx = oy * w + px;
                    var wgt = DS_KERNEL[k] / DS_SUM;
                    r += src.r[idx] * wgt; g += src.g[idx] * wgt; b += src.b[idx] * wgt;
                }
                var ii = oy * dw + ox;
                tmp.r[ii] = r; tmp.g[ii] = g; tmp.b[ii] = b;
            }
        }
        var out = makeImage(dw, dh);
        for (oy = 0; oy < dh; oy++) {
            for (ox = 0; ox < dw; ox++) {
                var cy = oy * 2 + 0.5;
                var r2 = 0, g2 = 0, b2 = 0;
                for (k = 0; k < 13; k++) {
                    var sy = cy + (k - 6);
                    var py = sy < 0 ? 0 : (sy >= h ? h - 1 : Math.floor(sy));
                    var idx2 = py * dw + ox;
                    var wgt2 = DS_KERNEL[k] / DS_SUM;
                    r2 += tmp.r[idx2] * wgt2; g2 += tmp.g[idx2] * wgt2; b2 += tmp.b[idx2] * wgt2;
                }
                var ii2 = oy * dw + ox;
                out.r[ii2] = r2; out.g[ii2] = g2; out.b[ii2] = b2;
            }
        }
        return out;
    }
    function scaleImage(img, weight) {
        var out = makeImage(img.width, img.height);
        var n = img.width * img.height;
        for (var i = 0; i < n; i++) { out.r[i] = img.r[i] * weight; out.g[i] = img.g[i] * weight; out.b[i] = img.b[i] * weight; }
        return out;
    }
    function upsampleAdd(small, big, weight) {
        var w = big.width, h = big.height, sw = small.width, sh = small.height;
        var out = makeImage(w, h);
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var sx = (x + 0.5) * sw / w - 0.5, sy = (y + 0.5) * sh / h - 0.5;
                var c = sampleBilinear(small, sx, sy);
                var idx = y * w + x;
                out.r[idx] = c.r * weight + big.r[idx];
                out.g[idx] = c.g * weight + big.g[idx];
                out.b[idx] = c.b * weight + big.b[idx];
            }
        }
        return out;
    }
    function blitScaled(full, half, weight) {
        var w = full.width, h = full.height, hw = half.width, hh = half.height;
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var sx = (x + 0.5) * hw / w - 0.5, sy = (y + 0.5) * hh / h - 0.5;
                var c = sampleBilinear(half, sx, sy);
                var idx = y * w + x;
                full.r[idx] = c.r * weight; full.g[idx] = c.g * weight; full.b[idx] = c.b * weight;
            }
        }
    }

    function buildMultiScaleGlow(sourceLayer, blurParams) {
        var w = sourceLayer.width, h = sourceLayer.height;
        var mipCount = blurParams.mipCount || 4;
        var mipWeights = blurParams.mipWeights || [0.52, 0.86, 0.72, 0.46, 0.28, 0.16, 0.1];
        var mips = [], current = sourceLayer, i;
        for (i = 0; i < mipCount; i++) {
            if (current.width <= 1 && current.height <= 1) break;
            current = downsample(current);
            mips.push(current);
        }
        var result;
        if (mips.length) {
            result = scaleImage(mips[mips.length - 1], mipWeights[mips.length - 1] || 0);
            for (i = mips.length - 2; i >= 0; i--) {
                result = upsampleAdd(result, mips[i], mipWeights[i] || 0);
            }
        } else {
            result = scaleImage(sourceLayer, mipWeights[0] || 1);
        }
        var full = makeImage(w, h);
        blitScaled(full, result, blurParams.pyramidWeight || 1);
        var glowLayer = applyOptics(full, sourceLayer, blurParams.opts || blurParams.optics);
        return { glowLayer: glowLayer, levels: mips };
    }

    // ---------- 光学层（星芒 / 拉丝） ----------
    function sourceGateAt(src, x, y, gate, softness) {
        var e = maxChannel(src, x, y);
        return smoothstep(gate, gate + Math.max(0.006, softness), e);
    }
    function samplePair(src, x, y, dirX, dirY, distance, weight, spread, gate, softness, accum, totalW) {
        var nx = -dirY, ny = dirX;
        var taps = [0, -1, 1];
        for (var t = 0; t < 3; t++) {
            var cross = taps[t];
            var tapW = cross === 0 ? 1.0 : 0.36;
            var ox = dirX * distance + nx * spread * cross;
            var oy = dirY * distance + ny * spread * cross;
            var ax = x + ox, ay = y + oy, bx = x - ox, by = y - oy;
            var iA = sampleClampIdx(src, ax, ay), iB = sampleClampIdx(src, bx, by);
            var gateA = sourceGateAt(src, ax, ay, gate, softness), gateB = sourceGateAt(src, bx, by, gate, softness);
            var pairW = weight * tapW * (0.14 + Math.max(gateA, gateB) * 0.86);
            var warmA = hash12(Math.floor(ax / 8), Math.floor(ay / 8));
            var warmB = hash12(Math.floor(bx / 8) + 17, Math.floor(by / 8) + 3);
            var rA = src.r[iA], gA = src.g[iA], bA = src.b[iA];
            var rB = src.r[iB], gB = src.g[iB], bB = src.b[iB];
            var trA = rA * (1 + warmA * 0.08), tgA = gA * (1 + warmA * 0.02), tbA = bA * (1 - warmA * 0.035);
            var trB = rB * (1 + warmB * 0.06), tgB = gB * (1 + warmB * 0.01), tbB = bB * (1 + warmB * 0.05);
            var wA = gateA * (0.38 + gateA * 0.62), wB = gateB * (0.38 + gateB * 0.62);
            accum.r += (trA * wA + trB * wB) * pairW;
            accum.g += (tgA * wA + tgB * wB) * pairW;
            accum.b += (tbA * wA + tbB * wB) * pairW;
            totalW.v += pairW * 2;
        }
    }
    function applyOptics(glowFull, sourceLayer, optics) {
        if (!optics || optics.strength <= 0.0001 || optics.length <= 0.5) return glowFull;
        var w = glowFull.width, h = glowFull.height;
        var anamorphic = optics.mode === 'anamorphic';
        var out = makeImage(w, h);
        var n = w * h, i;
        for (i = 0; i < n; i++) { out.r[i] = glowFull.r[i] * clamp(optics.baseVeil + 0.035, 0, 1); out.g[i] = glowFull.g[i] * clamp(optics.baseVeil + 0.035, 0, 1); out.b[i] = glowFull.b[i] * clamp(optics.baseVeil + 0.035, 0, 1); }
        var rotRad = optics.rotation * Math.PI / 180;
        var cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
        var steps = clamp(Math.ceil(optics.length / (anamorphic ? 6.8 : 7.8)), anamorphic ? 18 : 14, anamorphic ? 46 : 32);
        var rays = anamorphic ? 0 : clamp(Math.floor((optics.starCount || 6) + 0.5), 4, 12);
        var gate = optics.sourceGate || 0.03, soft = optics.sourceGateSoftness || 0.03;

        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var idx = y * w + x;
                var se = maxChannel(sourceLayer, x, y);
                var localGate = Math.pow(clamp(Math.max(se, sourceGateAt(sourceLayer, x, y, gate, soft)) * 1.35, 0, 1), 0.62);
                var accum = { r: lerp(se, glowFull.r[idx], clamp(optics.coreMix, 0, 0.35)) * optics.coreMix, g: lerp(se, glowFull.g[idx], clamp(optics.coreMix, 0, 0.35)) * optics.coreMix, b: lerp(se, glowFull.b[idx], clamp(optics.coreMix, 0, 0.35)) * optics.coreMix };
                var totalW = { v: optics.coreMix };
                var step;
                for (step = 1; step <= steps; step++) {
                    var t = step / steps, dist = t * optics.length;
                    var shoulder = Math.exp(-t * (anamorphic ? 2.45 : 2.05));
                    var tail = Math.pow(Math.max(0, 1 - t), anamorphic ? 2.2 : 1.85);
                    var centerRidge = 0.58 + 0.42 * Math.exp(-t * 9);
                    var nearFade = smoothstep(0, anamorphic ? 0.032 : 0.04, t);
                    var falloff = (shoulder * 0.58 + tail * 0.42) * centerRidge * nearFade * (anamorphic ? 0.32 : 0.26);
                    if (falloff <= 0.0001) continue;
                    var spread = anamorphic ? clamp(0.82 + optics.length / 220, 0.65, 2.5) : clamp(0.68 + optics.length / 280, 0.55, 2.1);
                    if (anamorphic) {
                        var dx1 = cosR, dy1 = sinR;
                        var hw = falloff * lerp(0.96, 1.04, hash12(step, optics.length * 0.017));
                        samplePair(sourceLayer, x, y, dx1, dy1, dist, hw, spread, gate, soft, accum, totalW);
                        var dx2 = -sinR, dy2 = cosR;
                        samplePair(sourceLayer, x, y, dx2, dy2, dist * 0.055, falloff * 0.018 * optics.verticalTightness, spread * 0.75, gate, soft, accum, totalW);
                    } else {
                        var ray;
                        for (ray = 0; ray < rays; ray++) {
                            var rayHash = hash12(ray * 19, rays * 7 + optics.rotation * 0.013);
                            var angle = 6.28318530718 * ray / rays + (rayHash - 0.5) * 0.03;
                            var dirX = cosR * Math.cos(angle) - sinR * Math.sin(angle);
                            var dirY = sinR * Math.cos(angle) + cosR * Math.sin(angle);
                            var axisWeight = ray === 0 ? 1 : lerp(0.28, 0.58, Math.abs(Math.cos(angle)));
                            var rayGain = axisWeight * lerp(0.78, 1.12, rayHash);
                            samplePair(sourceLayer, x, y, dirX, dirY, dist * lerp(0.72, 1.04, rayHash), falloff * rayGain, spread, gate, soft, accum, totalW);
                        }
                    }
                }
                var norm = Math.max(0.0001, totalW.v * clamp(optics.normalization || 0.6, 0.18, 1.4));
                var shapedR = accum.r / norm, shapedG = accum.g / norm, shapedB = accum.b / norm;
                var auraAmt = anamorphic ? 0.18 : 0.22;
                var mixAmount = clamp(optics.strength * (0.34 + localGate * 0.5), 0, 0.78);
                var sparkle = anamorphic ? 1 : 1 + localGate * optics.strength * 0.08;
                out.r[idx] = glowFull.r[idx] * clamp(optics.baseVeil + 0.035, 0, 1) + glowFull.r[idx] * auraAmt * optics.strength + shapedR * sparkle * mixAmount;
                out.g[idx] = glowFull.g[idx] * clamp(optics.baseVeil + 0.035, 0, 1) + glowFull.g[idx] * auraAmt * optics.strength + shapedG * sparkle * mixAmount;
                out.b[idx] = glowFull.b[idx] * clamp(optics.baseVeil + 0.035, 0, 1) + glowFull.b[idx] * auraAmt * optics.strength + shapedB * sparkle * mixAmount;
            }
        }
        return out;
    }

    // ---------- 合成 ----------
    function applySaturation(c, sat) {
        var l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        return { r: l + (c.r - l) * sat, g: l + (c.g - l) * sat, b: l + (c.b - l) * sat };
    }
    function applyColorShift(c, amount) {
        amount = clamp(amount, -1, 1);
        if (amount >= 0) return { r: c.r * (1 + amount * 0.34), g: c.g * (1 + amount * 0.1), b: c.b * (1 - amount * 0.24) };
        var cool = -amount;
        return { r: c.r * (1 - cool * 0.18), g: c.g * (1 + cool * 0.04), b: c.b * (1 + cool * 0.38) };
    }
    function applyTint(c, tint, amount) {
        amount = clamp(amount, 0, 1);
        var l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        return { r: lerp(c.r, l * tint.r * 1.32, amount), g: lerp(c.g, l * tint.g * 1.32, amount), b: lerp(c.b, l * tint.b * 1.32, amount) };
    }
    function toneMapGlow(c, intensity, shoulder) {
        var er = Math.max(c.r, 0) * intensity, eg = Math.max(c.g, 0) * intensity, eb = Math.max(c.b, 0) * intensity;
        var peak = Math.max(er, eg, eb);
        if (peak <= 0.000001) return { r: 0, g: 0, b: 0 };
        var response = clamp(1.08 - clamp(shoulder, 0.04, 0.95) * 0.45, 0.65, 1.08);
        var mapped = 1 - Math.exp(-peak * response);
        var factor = mapped / peak;
        return { r: er * factor, g: eg * factor, b: eb * factor };
    }
    function visibilityGate(c, floor, softness) {
        if (floor <= 0.000001) return c;
        return { r: c.r * smoothstep(floor, floor + softness, c.r), g: c.g * smoothstep(floor, floor + softness, c.g), b: c.b * smoothstep(floor, floor + softness, c.b) };
    }
    function computeGlowPixel(glowLayer, masks, comp, x, y, w, h) {
        var protect = masks.protection[y * w + x];
        var off = comp.chromaticOffsetPx || 0;
        var idx = sampleClampIdx(glowLayer, x, y);
        var rG, gG, bG;
        if (off > 0.01) {
            rG = sampleBilinear(glowLayer, x + off, y).r;
            gG = glowLayer.g[idx];
            bG = sampleBilinear(glowLayer, x - off, y).b;
        } else {
            rG = glowLayer.r[idx]; gG = glowLayer.g[idx]; bG = glowLayer.b[idx];
        }
        var centerMax = Math.max(glowLayer.r[idx], glowLayer.g[idx], glowLayer.b[idx]);
        var chromaStrength = Math.pow(clamp(comp.chromatic, 0, 1), 1.16);
        var edgeGate = masks.emission[y * w + x] * (0.44 + (1 - protect) * 0.24);
        var fringeR = Math.max(0, rG - centerMax * 0.7) * chromaStrength * 0.86 * edgeGate;
        var fringeB = Math.max(0, bG - centerMax * 0.7) * chromaStrength * 0.86 * edgeGate;

        var glow = { r: rG * (1 + comp.warmth), g: gG * (1 + comp.warmth * 0.35), b: bG * (1 - comp.warmth * 0.28) };
        glow = applyColorShift(glow, comp.colorShift);
        glow = applyTint(glow, comp.colorTint, comp.colorAmount);
        glow.r += fringeR; glow.b += fringeB;
        glow = applySaturation(glow, comp.saturation);
        glow = visibilityGate(toneMapGlow(glow, comp.intensity, comp.shoulder), comp.energyFloor, comp.energyFloorSoftness);
        return glow;
    }

    function newImageData(w, h) {
        var width = Math.max(1, w), height = Math.max(1, h);
        var bytes = new Uint8ClampedArray(width * height * 4);
        if (typeof ImageData === 'function') {
            try { return new ImageData(bytes, width, height); } catch (ignoreImageDataError) {}
        }
        var c = document.createElement('canvas');
        c.width = width; c.height = height;
        var context = c.getContext('2d');
        if (context && typeof context.createImageData === 'function') return context.createImageData(width, height);
        if (context && typeof context.getImageData === 'function') return context.getImageData(0, 0, width, height);
        return { width: width, height: height, data: bytes };
    }
    function encodeGlow(glow) {
        var r = linearToSrgb(clamp(glow.r, 0, 1));
        var g = linearToSrgb(clamp(glow.g, 0, 1));
        var b = linearToSrgb(clamp(glow.b, 0, 1));
        return { r: Math.round(clamp(r, 0, 1) * 255 + 0.5), g: Math.round(clamp(g, 0, 1) * 255 + 0.5), b: Math.round(clamp(b, 0, 1) * 255 + 0.5) };
    }

    // 纯辉光层（写回 Photoshop）
    function renderGlowLayer(glowLayer, masks, comp, w, h) {
        var imgData = newImageData(w, h), d = imgData.data;
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var glow = computeGlowPixel(glowLayer, masks, comp, x, y, w, h);
                var enc = encodeGlow(glow);
                var i = (y * w + x) * 4;
                d[i] = enc.r; d[i + 1] = enc.g; d[i + 2] = enc.b; d[i + 3] = 255;
            }
        }
        return imgData;
    }

    // base + 辉光 → 屏幕混合预览
    function composeProtected(baseImgData, glowLayer, masks, comp) {
        var w = baseImgData.width, h = baseImgData.height;
        var imgData = newImageData(w, h), d = imgData.data, bd = baseImgData.data;
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var glow = computeGlowPixel(glowLayer, masks, comp, x, y, w, h);
                var enc = encodeGlow(glow);
                var i = (y * w + x) * 4;
                var br = bd[i], bg = bd[i + 1], bb = bd[i + 2];
                d[i] = Math.round(255 - ((255 - br) * (255 - enc.r)) / 255);
                d[i + 1] = Math.round(255 - ((255 - bg) * (255 - enc.g)) / 255);
                d[i + 2] = Math.round(255 - ((255 - bb) * (255 - enc.b)) / 255);
                d[i + 3] = bd[i + 3];
            }
        }
        return imgData;
    }

    // ---------- 便捷入口 ----------
    function createPreview(baseImageData, uiParams, isPreview) {
        var params = normalizeGlowParams(uiParams);
        var w = baseImageData.width, h = baseImageData.height;
        var pixelCount = w * h;
        // 预览模式性能保护：大图跳过光学层，避免 CPU 卡死。
        // 阈值与预览源图尺寸配套：预览最长边 384px，1:1 选区约 147k 像素，
        // 所以阈值取 180000，保证正常预览仍带光学层；
        // 提阈值前请先确认预览图尺寸没变，否则会出现「预览不含光学层、最终结果有」。
        if (isPreview !== false && pixelCount > 180000 && params.blur && params.blur.optics) {
            params.blur.optics = null;
        }
        var basePlanes = imageDataToSRGBPlanes(baseImageData);
        var source = buildSourceMask(basePlanes, params.source);
        var blur = buildMultiScaleGlow(source.sourceLayer, params.blur || blurParamsOf(params));
        var comp = params.composite;
        var glowImg = renderGlowLayer(blur.glowLayer, source.masks, comp, w, h);
        var prevImg = composeProtected(baseImageData, blur.glowLayer, source.masks, comp);
        return { previewImageData: prevImg, glowLayerImageData: glowImg, params: params, source: source };
    }
    function blurParamsOf(params) { return params.blur; }

    return {
        normalizeGlowParams: normalizeGlowParams,
        buildSourceMask: buildSourceMask,
        buildMultiScaleGlow: buildMultiScaleGlow,
        renderGlowLayer: renderGlowLayer,
        composeProtected: composeProtected,
        createPreview: createPreview,
        imageDataToSRGBPlanes: imageDataToSRGBPlanes
    };
})();
