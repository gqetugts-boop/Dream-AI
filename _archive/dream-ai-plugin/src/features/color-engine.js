/*
 * features/color-engine.js — 色彩空间、低频重建与参考图校色算法
 *
 * 职责：
 *   1. sRGB ↔ 线性 sRGB ↔ CIEXYZ(D65) ↔ CIELab 互转；
 *   2. 低频重建（可分离盒式模糊，多趟近似高斯），供小波/多尺度色彩匹配使用；
 *   3. 参考图驱动的五种色彩迁移：均值方差、直方图匹配、Reinhard、
 *      柔光混合、仅亮度对齐；
 *   4. 结构差异蒙版（两图亮度梯度差 → 权重 → 羽化）。
 *
 * 输入：图像对象 { data, width, height, channels }，交错通道，channels = 3 | 4，
 *       像素为 0-255 字节；data 也可以是 Uint8Array。
 * 输出：全新对象 { data: Uint8ClampedArray, width, height, channels }，
 *       输入缓冲永不被改写（含 strength = 0 的短路路径）。
 * 边界：纯算法模块。不访问 DOM / 宿主 / 网络，不注册事件，不写存储，
 *       也不包含任何面向用户的文案（i18n 由 UI 层负责，本文件只返回键名）。
 *       可在 Node 下直接加载（tests/run-tests.mjs 会这样调用）。
 *
 * 性能约定：大图可达 2048×2048（约 400 万像素）。
 *   - 缓冲只在每趟开始分配一次，绝不逐像素 new 对象；
 *   - 全部使用 TypedArray，热循环里只出现 for 循环与算术，
 *     不使用 Array.prototype.forEach / map；
 *   - 字节 → 线性走 256 项查找表，避免在热循环里调 Math.pow。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.ColorEngine) return;

    var util = DreamAI.util || {};

    /* ============================================================
     * 0. 数值辅助与选项归一化
     * ============================================================ */

    var EPS_STD = 1e-3;              // 通道标准差下限：低于它视为「没有对比度」
    var ALPHA_SKIP = 12;             // 蒙版计算中 alpha 低于该值的像素不参与
    var SHARED_WEIGHT = 0.25;        // sharedRatio 统计所用的权重阈值
    var MAX_FEATHER_RADIUS = 24;     // 羽化半径上限
    var LAB_SLOPE = 7.787;           // CIELab f(t) 线性段斜率
    var LAB_OFFSET = 16 / 116;       // CIELab f(t) 线性段截距
    var LAB_DELTA = 0.008856;        // CIELab f(t) 分段阈值

    /** Math.cbrt 兜底（老引擎可能没有） */
    var cbrt = Math.cbrt || function (value) {
        return value < 0 ? -Math.pow(-value, 1 / 3) : Math.pow(value, 1 / 3);
    };

    /** 默认选项：所有 transfer* 共用同一个选项袋，各自忽略用不到的键 */
    var DEFAULT_OPTIONS = {
        strength: 100,               // 0-100；0 表示原样返回（逐字节等于输入）
        useLab: true,                // 均值方差迁移是否在 CIELab 空间进行
        mask: null,                  // Float32Array，每像素权重 0..1
        preserveAlpha: true,         // true 时 alpha 原样透传
        lowFrequencyRadius: 0,       // 0 = 按图像尺寸自动推算
        lowFrequencyPasses: 3,       // 低频重建趟数
        featherRadius: 16,           // computeMask 的羽化半径
        gradientThreshold: 72        // computeMask 的梯度差阈值（0-255 尺度）
    };

    function toNumber(value, fallback) {
        if (typeof util.toNumber === 'function') return util.toNumber(value, fallback);
        var n = Number(value);
        if (isFinite(n)) return n;
        var f = Number(fallback);
        return isFinite(f) ? f : 0;
    }

    function clampNumber(value, min, max, fallback) {
        if (typeof util.clamp === 'function') return util.clamp(value, min, max, fallback);
        var n = toNumber(value, fallback === undefined ? min : fallback);
        if (n < min) return min;
        if (n > max) return max;
        return n;
    }

    /** 归一化选项袋：强度转 0..1，半径取整，非法 mask 视为无 mask */
    function normalizeOptions(options) {
        var opts = options || {};
        var mask = opts.mask;
        var radius = Math.round(toNumber(opts.lowFrequencyRadius, 0));
        var passes = Math.round(toNumber(opts.lowFrequencyPasses, DEFAULT_OPTIONS.lowFrequencyPasses));
        var feather = Math.round(clampNumber(
            opts.featherRadius === undefined ? DEFAULT_OPTIONS.featherRadius : opts.featherRadius,
            0, MAX_FEATHER_RADIUS, DEFAULT_OPTIONS.featherRadius
        ));
        return {
            strength: clampNumber(opts.strength === undefined ? 100 : opts.strength, 0, 100, 100) / 100,
            useLab: opts.useLab === undefined ? true : !!opts.useLab,
            preserveAlpha: opts.preserveAlpha === undefined ? true : !!opts.preserveAlpha,
            mask: mask && mask.length ? mask : null,
            lowFrequencyRadius: radius > 0 ? radius : 0,
            lowFrequencyPasses: passes >= 1 ? passes : 1,
            featherRadius: feather,
            gradientThreshold: Math.max(1, toNumber(opts.gradientThreshold, DEFAULT_OPTIONS.gradientThreshold))
        };
    }

    /** 像素权重：mask 缺省为 1，越界读数按 1 处理，NaN / 负数归 0 */
    function maskWeight(mask, index, strength) {
        if (!mask) return strength;
        var weight = mask[index];
        if (weight === undefined) return strength;
        if (!(weight > 0)) return 0;
        if (weight > 1) weight = 1;
        return weight * strength;
    }

    /** 默认低频半径：max(4, round(min(width, height) / 16)) */
    function autoRadius(width, height) {
        var shortSide = Math.min(width, height);
        var radius = Math.round(shortSide / 16);
        return radius > 4 ? radius : 4;
    }

    /* ============================================================
     * 1. 图像缓冲
     * ============================================================ */

    /**
     * 归一化输入图像：只读校验 + 偏短缓冲补零。
     * 补零是为了让主循环不做边界判断，代价只落在非法输入上。
     */
    function normalizeImage(image) {
        var width = Math.max(1, Math.round(toNumber(image && image.width, 1)));
        var height = Math.max(1, Math.round(toNumber(image && image.height, 1)));
        var channels = toNumber(image && image.channels, 4) >= 4 ? 4 : 3;
        var expected = width * height * channels;
        var source = image && image.data ? image.data : null;
        var data;
        if (source && source.length >= expected) {
            data = source;
        } else {
            data = new Uint8Array(expected);
            if (source) {
                if (typeof source.subarray === 'function') data.set(source.subarray(0, Math.min(source.length, expected)));
                else data.set(source.slice ? source.slice(0, expected) : source);
            }
        }
        return {
            data: data,
            width: width,
            height: height,
            channels: channels,
            count: width * height
        };
    }

    /** 新建输出图像缓冲（Uint8ClampedArray 写入时自动钳制并取整） */
    function createImage(width, height, channels) {
        return {
            data: new Uint8ClampedArray(width * height * channels),
            width: width,
            height: height,
            channels: channels
        };
    }

    /** 原样拷贝输入缓冲（strength = 0 等短路路径用，保证逐字节一致） */
    function copyInto(src, out) {
        var length = out.data.length;
        var source = src.data;
        if (typeof source.subarray === 'function') {
            out.data.set(source.subarray(0, length));
            return out;
        }
        for (var i = 0; i < length; i++) out.data[i] = source[i] || 0;
        return out;
    }

    /** 把 3 个颜色字节从源拷到目标（带 alpha 时 alpha 单独处理） */
    function copyColor(data, outData, offset) {
        outData[offset] = data[offset];
        outData[offset + 1] = data[offset + 1];
        outData[offset + 2] = data[offset + 2];
    }

    /* ============================================================
     * 2. 色彩空间：sRGB ↔ 线性 ↔ CIEXYZ(D65) ↔ CIELab
     * ============================================================ */

    /** 256 项 sRGB → 线性查找表（字节输入覆盖绝大多数热循环调用） */
    var SRGB_TO_LINEAR = (function () {
        var table = new Float64Array(256);
        for (var i = 0; i < 256; i++) {
            var c = i / 255;
            table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        }
        return table;
    })();

    // 复用的临时数组：模块内同步执行，单线程下可安全共享，避免逐像素分配
    var LAB_SCRATCH = new Float64Array(3);
    var LINEAR_SCRATCH = new Float64Array(3);

    /**
     * sRGB 编码值 → 线性值。
     * @param {number} value 0-255（允许小数）
     * @returns {number} 0..1
     */
    function srgbToLinear(value) {
        var n = Number(value);
        if (!isFinite(n)) n = 0;
        if (n <= 0) return 0;
        if (n >= 255) return 1;
        var index = n | 0;
        if (index === n) return SRGB_TO_LINEAR[index];
        var c = n / 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    /**
     * 线性值 → sRGB 编码值（未取整，调用方写字节时由 Uint8ClampedArray 取整）。
     * @param {number} value 0..1
     * @returns {number} 0..255（已钳制）
     */
    function linearToSrgb(value) {
        var v = Number(value);
        if (!isFinite(v) || v <= 0) return 0;
        if (v >= 1) return 255;
        return (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
    }

    /** 热循环版本：字节走查表，非整数输入退回精确公式 */
    function linearize(value) {
        if (value >= 0 && value <= 255) {
            var index = value | 0;
            if (index === value) return SRGB_TO_LINEAR[index];
        }
        return srgbToLinear(value);
    }

    /** CIELab 的 f(t) */
    function labF(t) {
        return t > LAB_DELTA ? cbrt(t) : LAB_SLOPE * t + LAB_OFFSET;
    }

    /** CIELab 的 f⁻¹(t) */
    function labFInverse(t) {
        var cube = t * t * t;
        return cube > LAB_DELTA ? cube : (t - LAB_OFFSET) / LAB_SLOPE;
    }

    /**
     * 线性 sRGB(0..1) → CIELab(D65)，结果写入 out[0..2]，不分配对象。
     * 矩阵为 sRGB D65 标准矩阵，白点 Xn=0.95047 / Yn=1 / Zn=1.08883。
     */
    function linearRgbToLab(r, g, b, out) {
        var x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
        var y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
        var z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
        var fx = labF(x);
        var fy = labF(y);
        var fz = labF(z);
        out[0] = 116 * fy - 16;
        out[1] = 500 * (fx - fy);
        out[2] = 200 * (fy - fz);
        return out;
    }

    /** CIELab(D65) → 线性 sRGB(0..1)，结果可能越界，调用方负责钳制 */
    function labToLinearRgb(L, a, b, out) {
        var fy = (L + 16) / 116;
        var fx = fy + a / 500;
        var fz = fy - b / 200;
        var x = labFInverse(fx) * 0.95047;
        var y = labFInverse(fy);
        var z = labFInverse(fz) * 1.08883;
        out[0] = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
        out[1] = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
        out[2] = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
        return out;
    }

    /**
     * sRGB → CIELab(D65)。
     * @param {number} r 0-255
     * @param {number} g 0-255
     * @param {number} b 0-255
     * @returns {{L:number,a:number,b:number}}
     */
    function srgbToLab(r, g, b) {
        var lab = linearRgbToLab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), LAB_SCRATCH);
        return { L: lab[0], a: lab[1], b: lab[2] };
    }

    /**
     * CIELab(D65) → sRGB。
     * @returns {{r:number,g:number,b:number}} 0-255，已钳制并取整
     */
    function labToSrgb(L, a, b) {
        var linear = labToLinearRgb(
            toNumber(L, 0), toNumber(a, 0), toNumber(b, 0), LINEAR_SCRATCH
        );
        return {
            r: Math.round(linearToSrgb(linear[0])),
            g: Math.round(linearToSrgb(linear[1])),
            b: Math.round(linearToSrgb(linear[2]))
        };
    }

    /* ============================================================
     * 3. 可分离盒式模糊（滑动窗口，O(N)，与半径无关）
     * ============================================================ */

    /**
     * 水平方向一趟盒式模糊。
     * 窗口固定为 2r+1 个采样，越界部分按复制边缘取值（不缩小窗口、不额外分配边界缓冲），
     * 因此边框与画面内部的模糊强度一致。只处理前 colorChannels 个通道，
     * alpha 留给调用方决定（通常是原样透传）。
     * 半径不小于图宽时窗口已覆盖整行，钳制到 width-1 保持结果不变并限制初始化开销。
     */
    function boxBlurRow(src, dst, width, height, channels, colorChannels, radius) {
        var r = radius >= width ? width - 1 : radius;
        var inverse = 1 / (2 * r + 1);
        var acc = new Float64Array(colorChannels);
        var y, x, c, k;
        for (y = 0; y < height; y++) {
            var row = y * width * channels;
            for (c = 0; c < colorChannels; c++) acc[c] = 0;
            // 初始窗口：x=0 处 [-r, r] 的复制取样
            for (k = -r; k <= r; k++) {
                var seedX = k < 0 ? 0 : (k > width - 1 ? width - 1 : k);
                var seed = row + seedX * channels;
                for (c = 0; c < colorChannels; c++) acc[c] += src[seed + c];
            }
            for (x = 0; x < width; x++) {
                var at = row + x * channels;
                for (c = 0; c < colorChannels; c++) dst[at + c] = acc[c] * inverse;
                // 滑窗前移：加入 x+r+1，移除 x-r（两端都按复制边缘钳制）
                var addX = x + r + 1;
                if (addX > width - 1) addX = width - 1;
                var subX = x - r < 0 ? 0 : x - r;
                var add = row + addX * channels;
                var sub = row + subX * channels;
                for (c = 0; c < colorChannels; c++) acc[c] += src[add + c] - src[sub + c];
            }
        }
    }

    /**
     * 垂直方向一趟盒式模糊。
     * 累加器必须按列独立（窗口跨越整行），所以是 width × colorChannels 的一维数组；
     * 窗口沿 y 推进，每行进出各一次，访问顺序对缓存友好。
     * 边界语义与水平方向一致：固定 2r+1 窗口 + 复制边缘。
     */
    function boxBlurColumn(src, dst, width, height, channels, colorChannels, radius) {
        var r = radius >= height ? height - 1 : radius;
        var inverse = 1 / (2 * r + 1);
        var acc = new Float64Array(width * colorChannels);
        var x, y, c, k;
        for (k = -r; k <= r; k++) {
            var seedY = k < 0 ? 0 : (k > height - 1 ? height - 1 : k);
            var seedRow = seedY * width * channels;
            for (x = 0; x < width; x++) {
                var seed = seedRow + x * channels;
                var seedAcc = x * colorChannels;
                for (c = 0; c < colorChannels; c++) acc[seedAcc + c] += src[seed + c];
            }
        }
        for (y = 0; y < height; y++) {
            var outRow = y * width * channels;
            for (x = 0; x < width; x++) {
                var at = outRow + x * channels;
                var atAcc = x * colorChannels;
                for (c = 0; c < colorChannels; c++) dst[at + c] = acc[atAcc + c] * inverse;
            }
            var addY = y + r + 1;
            if (addY > height - 1) addY = height - 1;
            var subY = y - r < 0 ? 0 : y - r;
            var addRow = addY * width * channels;
            var subRow = subY * width * channels;
            for (x = 0; x < width; x++) {
                var add = addRow + x * channels;
                var sub = subRow + x * channels;
                var updAcc = x * colorChannels;
                for (c = 0; c < colorChannels; c++) acc[updAcc + c] += src[add + c] - src[sub + c];
            }
        }
    }

    /**
     * 多趟可分离盒式模糊（近似高斯）。
     * 缓冲按趟复用（a/b 乒乓），返回 Float32Array 结果（可能是 a 或 b）。
     */
    function blurPlanes(source, width, height, channels, colorChannels, radius, passes) {
        var length = width * height * channels;
        var bufferA = new Float32Array(length);
        var bufferB = new Float32Array(length);
        var i;
        for (i = 0; i < length; i++) bufferA[i] = source[i];
        for (var pass = 0; pass < passes; pass++) {
            boxBlurRow(bufferA, bufferB, width, height, channels, colorChannels, radius);
            boxBlurColumn(bufferB, bufferA, width, height, channels, colorChannels, radius);
        }
        return bufferA;
    }

    /**
     * 低频重建：可分离盒式模糊低通。
     * radius 默认 max(4, round(min(width,height)/16))，passes 默认 3。
     * alpha 通道不参与模糊、原样保留（避免半透明边缘被抹出光晕）。
     * @param {{data:*,width:number,height:number,channels:number}} image
     * @param {{radius?:number,passes?:number}} [options]
     * @returns {{data:Uint8ClampedArray,width:number,height:number,channels:number}}
     */
    function reconstructLowFrequency(image, options) {
        var opts = options || {};
        var src = normalizeImage(image);
        var out = createImage(src.width, src.height, src.channels);
        var radius = Math.round(toNumber(
            opts.radius === undefined ? opts.lowFrequencyRadius : opts.radius,
            autoRadius(src.width, src.height)
        ));
        var passes = Math.round(toNumber(
            opts.passes === undefined ? opts.lowFrequencyPasses : opts.passes,
            DEFAULT_OPTIONS.lowFrequencyPasses
        ));
        if (!isFinite(radius) || radius < 1 || !isFinite(passes) || passes < 1) {
            return copyInto(src, out);
        }

        var blurred = blurPlanes(src.data, src.width, src.height, src.channels, 3, radius, passes);
        var data = src.data;
        var outData = out.data;
        var count = src.count;
        if (src.channels === 4) {
            for (var i = 0; i < count; i++) {
                var o = i * 4;
                outData[o] = blurred[o];
                outData[o + 1] = blurred[o + 1];
                outData[o + 2] = blurred[o + 2];
                outData[o + 3] = data[o + 3];
            }
        } else {
            var length = count * 3;
            for (var j = 0; j < length; j++) outData[j] = blurred[j];
        }
        return out;
    }

    /* ============================================================
     * 4. Lab 面与统计
     * ============================================================ */

    /**
     * 源图 → Lab 三个 Float32 面（各 count 长）。
     * 源图只需要转一次，缓存成面比逐像素重复转换更省时间。
     */
    function toLabPlanes(image) {
        var count = image.count;
        var data = image.data;
        var channels = image.channels;
        var planeL = new Float32Array(count);
        var planeA = new Float32Array(count);
        var planeB = new Float32Array(count);
        var lab = LAB_SCRATCH;
        for (var i = 0; i < count; i++) {
            var o = i * channels;
            linearRgbToLab(linearize(data[o]), linearize(data[o + 1]), linearize(data[o + 2]), lab);
            planeL[i] = lab[0];
            planeA[i] = lab[1];
            planeB[i] = lab[2];
        }
        return { L: planeL, a: planeA, b: planeB };
    }

    /** 由和 / 平方和收尾出均值与标准差 */
    function finalizeStats(sums, squares, count, mean, std) {
        var n = count > 0 ? count : 1;
        for (var c = 0; c < 3; c++) {
            mean[c] = sums[c] / n;
            var variance = squares[c] / n - mean[c] * mean[c];
            std[c] = variance > 0 ? Math.sqrt(variance) : 0;
        }
        return { mean: mean, std: std };
    }

    /** 一个平面的和 / 平方和 */
    function accumulatePlane(plane, count, sums, squares, index) {
        var sum = 0;
        var square = 0;
        for (var i = 0; i < count; i++) {
            var v = plane[i];
            sum += v;
            square += v * v;
        }
        sums[index] = sum;
        squares[index] = square;
    }

    /** 源图 Lab 三分量统计（面已就绪，直接累加） */
    function labPlanesStats(planes, count) {
        var sums = new Float64Array(3);
        var squares = new Float64Array(3);
        accumulatePlane(planes.L, count, sums, squares, 0);
        accumulatePlane(planes.a, count, sums, squares, 1);
        accumulatePlane(planes.b, count, sums, squares, 2);
        return finalizeStats(sums, squares, count, new Float64Array(3), new Float64Array(3));
    }

    /** 参考图 Lab 统计：边转边累加，不缓存整幅 Lab，省下 3 个面 */
    function referenceLabStats(image) {
        var sums = new Float64Array(3);
        var squares = new Float64Array(3);
        var data = image.data;
        var channels = image.channels;
        var count = image.count;
        var lab = LAB_SCRATCH;
        for (var i = 0; i < count; i++) {
            var o = i * channels;
            linearRgbToLab(linearize(data[o]), linearize(data[o + 1]), linearize(data[o + 2]), lab);
            sums[0] += lab[0]; squares[0] += lab[0] * lab[0];
            sums[1] += lab[1]; squares[1] += lab[1] * lab[1];
            sums[2] += lab[2]; squares[2] += lab[2] * lab[2];
        }
        return finalizeStats(sums, squares, count, new Float64Array(3), new Float64Array(3));
    }

    /** 按通道累加字节和 / 平方和（sRGB 直通路径用） */
    function accumulateBytes(data, count, channels, activeChannels, sums, squares) {
        for (var i = 0; i < count; i++) {
            var o = i * channels;
            for (var c = 0; c < activeChannels; c++) {
                var v = data[o + c];
                sums[c] += v;
                squares[c] += v * v;
            }
        }
    }

    /**
     * 统计迁移所需的参考均值与缩放比率。
     * 源标准差接近 0（纯色）时比率取 0：把该通道压到参考均值，
     * 避免「除以近零方差」把噪声放大成条纹。
     */
    function statisticsTransfer(srcSums, srcSquares, refSums, refSquares, srcCount, refCount, activeChannels) {
        var srcMean = new Float64Array(activeChannels);
        var refMean = new Float64Array(activeChannels);
        var ratio = new Float64Array(activeChannels);
        var srcN = srcCount > 0 ? srcCount : 1;
        var refN = refCount > 0 ? refCount : 1;
        for (var c = 0; c < activeChannels; c++) {
            srcMean[c] = srcSums[c] / srcN;
            refMean[c] = refSums[c] / refN;
            var srcVariance = srcSquares[c] / srcN - srcMean[c] * srcMean[c];
            var refVariance = refSquares[c] / refN - refMean[c] * refMean[c];
            var srcStd = srcVariance > 0 ? Math.sqrt(srcVariance) : 0;
            var refStd = refVariance > 0 ? Math.sqrt(refVariance) : 0;
            ratio[c] = srcStd > EPS_STD ? refStd / srcStd : 0;
        }
        return { srcMean: srcMean, refMean: refMean, ratio: ratio };
    }

    /**
     * Lab 空间的逐像素统计映射。
     * luminanceOnly = true 时只替换 L，保留源图 a/b（仅亮度对齐）；
     * 否则 L/a/b 三个通道各自独立映射。
     * 与源像素按 w（strength × mask）在字节域混合，保证 strength = 0 时原样。
     */
    function applyLabTransfer(src, planes, srcStats, refStats, out, opts, luminanceOnly) {
        var count = src.count;
        var channels = src.channels;
        var data = src.data;
        var outData = out.data;
        var hasAlpha = channels === 4;
        var mask = opts.mask;
        var strength = opts.strength;

        var meanL = srcStats.mean[0];
        var meanA = srcStats.mean[1];
        var meanB = srcStats.mean[2];
        var targetL = refStats.mean[0];
        var targetA = refStats.mean[1];
        var targetB = refStats.mean[2];
        var ratioL = srcStats.std[0] > EPS_STD ? refStats.std[0] / srcStats.std[0] : 0;
        var ratioA = srcStats.std[1] > EPS_STD ? refStats.std[1] / srcStats.std[1] : 0;
        var ratioB = srcStats.std[2] > EPS_STD ? refStats.std[2] / srcStats.std[2] : 0;

        var lab = LAB_SCRATCH;
        var linear = LINEAR_SCRATCH;
        for (var i = 0; i < count; i++) {
            var o = i * channels;
            var w = maskWeight(mask, i, strength);
            if (w > 0) {
                var L = targetL + (planes.L[i] - meanL) * ratioL;
                var a = luminanceOnly ? planes.a[i] : targetA + (planes.a[i] - meanA) * ratioA;
                var b = luminanceOnly ? planes.b[i] : targetB + (planes.b[i] - meanB) * ratioB;
                labToLinearRgb(L, a, b, linear);
                outData[o] = data[o] + (linearToSrgb(linear[0]) - data[o]) * w;
                outData[o + 1] = data[o + 1] + (linearToSrgb(linear[1]) - data[o + 1]) * w;
                outData[o + 2] = data[o + 2] + (linearToSrgb(linear[2]) - data[o + 2]) * w;
            } else {
                copyColor(data, outData, o);
            }
            if (hasAlpha) outData[o + 3] = data[o + 3];
        }
        return out;
    }

    /* ============================================================
     * 5. 迁移算法
     * ============================================================ */

    /**
     * 均值方差迁移的公共实现。
     * @param {string} space 'lab' 走 CIELab，'rgb' 走 sRGB 逐通道
     */
    function transferStatistics(source, reference, options, space) {
        var opts = normalizeOptions(options);
        var src = normalizeImage(source);
        var ref = normalizeImage(reference);
        var out = createImage(src.width, src.height, src.channels);
        if (opts.strength <= 0) return copyInto(src, out);

        if (space === 'lab') {
            var planes = toLabPlanes(src);
            var srcStats = labPlanesStats(planes, src.count);
            var refStats = referenceLabStats(ref);
            return applyLabTransfer(src, planes, srcStats, refStats, out, opts, false);
        }

        var channels = src.channels;
        // preserveAlpha 为 false 且两图都有 alpha 时，alpha 也一起做统计迁移
        var activeChannels = channels === 4 && ref.channels === 4 && !opts.preserveAlpha ? 4 : 3;
        var srcSums = new Float64Array(4);
        var srcSquares = new Float64Array(4);
        var refSums = new Float64Array(4);
        var refSquares = new Float64Array(4);
        accumulateBytes(src.data, src.count, channels, activeChannels, srcSums, srcSquares);
        accumulateBytes(ref.data, ref.count, ref.channels, activeChannels, refSums, refSquares);
        var stats = statisticsTransfer(srcSums, srcSquares, refSums, refSquares, src.count, ref.count, activeChannels);

        var data = src.data;
        var outData = out.data;
        var mask = opts.mask;
        var strength = opts.strength;
        var count = src.count;
        var i, o, c, value;
        for (i = 0; i < count; i++) {
            o = i * channels;
            var w = maskWeight(mask, i, strength);
            if (w <= 0) {
                copyColor(data, outData, o);
            } else {
                for (c = 0; c < 3; c++) {
                    value = data[o + c];
                    var mapped = stats.refMean[c] + (value - stats.srcMean[c]) * stats.ratio[c];
                    outData[o + c] = value + (mapped - value) * w;
                }
                if (channels === 4 && activeChannels === 4) {
                    value = data[o + 3];
                    var mappedAlpha = stats.refMean[3] + (value - stats.srcMean[3]) * stats.ratio[3];
                    outData[o + 3] = value + (mappedAlpha - value) * w;
                }
            }
            if (channels === 4 && activeChannels !== 4) outData[o + 3] = data[o + 3];
        }
        return out;
    }

    /**
     * 均值方差迁移。useLab 默认 true：在 CIELab 里逐通道对齐均值与标准差，
     * 能同时修正整体色偏与对比度；useLab = false 时在 sRGB 字节域逐通道处理。
     * @param {{data:*,width:number,height:number,channels:number}} source
     * @param {{data:*,width:number,height:number,channels:number}} reference
     * @param {{strength?:number,useLab?:boolean,mask?:Float32Array,preserveAlpha?:boolean}} [options]
     */
    function transferMeanStd(source, reference, options) {
        var opts = normalizeOptions(options);
        return transferStatistics(source, reference, options, opts.useLab ? 'lab' : 'rgb');
    }

    /**
     * Reinhard 色彩迁移：在 CIELab 空间对 L/a/b 独立做统计迁移后回到 sRGB。
     * （useLab 对本方法无意义，永远走 Lab，只读取 strength / mask / preserveAlpha。）
     */
    function transferReinhard(source, reference, options) {
        return transferStatistics(source, reference, options, 'lab');
    }

    /* ---------- 直方图匹配 ---------- */

    /** 统计前 activeChannels 个通道的 256 桶直方图（布局：channel * 256 + value） */
    function histogramBytes(data, count, channels, activeChannels, hist) {
        for (var i = 0; i < count; i++) {
            var o = i * channels;
            for (var c = 0; c < activeChannels; c++) hist[c * 256 + data[o + c]]++;
        }
    }

    /** 归一化累积分布 */
    function normalizedCdf(hist, channel) {
        var cdf = new Float64Array(256);
        var base = channel * 256;
        var total = 0;
        var v;
        for (v = 0; v < 256; v++) total += hist[base + v];
        if (total <= 0) {
            for (v = 0; v < 256; v++) cdf[v] = 1;
            return cdf;
        }
        var acc = 0;
        for (v = 0; v < 256; v++) {
            acc += hist[base + v];
            cdf[v] = acc / total;
        }
        return cdf;
    }

    /**
     * 直方图匹配：逐通道 256 桶 CDF 反查，得到 256 项映射表，
     * 再按 strength / mask 与源值混合。alpha 默认原样透传。
     */
    function transferHistogram(source, reference, options) {
        var opts = normalizeOptions(options);
        var src = normalizeImage(source);
        var ref = normalizeImage(reference);
        var out = createImage(src.width, src.height, src.channels);
        if (opts.strength <= 0) return copyInto(src, out);

        var channels = src.channels;
        var activeChannels = channels === 4 && ref.channels === 4 && !opts.preserveAlpha ? 4 : 3;
        var srcHist = new Uint32Array(256 * activeChannels);
        var refHist = new Uint32Array(256 * activeChannels);
        histogramBytes(src.data, src.count, channels, activeChannels, srcHist);
        histogramBytes(ref.data, ref.count, ref.channels, activeChannels, refHist);

        // 映射表：源值 → 参考图中 CDF 首次不小于它的桶（单调游标，一趟扫完）
        var lut = new Float64Array(256 * activeChannels);
        var c, v;
        for (c = 0; c < activeChannels; c++) {
            var srcCdf = normalizedCdf(srcHist, c);
            var refCdf = normalizedCdf(refHist, c);
            var cursor = 0;
            for (v = 0; v < 256; v++) {
                while (cursor < 255 && refCdf[cursor] < srcCdf[v]) cursor++;
                lut[c * 256 + v] = cursor;
            }
        }

        var data = src.data;
        var outData = out.data;
        var mask = opts.mask;
        var strength = opts.strength;
        var count = src.count;
        for (var i = 0; i < count; i++) {
            var o = i * channels;
            var w = maskWeight(mask, i, strength);
            if (w <= 0) {
                copyColor(data, outData, o);
            } else {
                for (c = 0; c < 3; c++) {
                    var value = data[o + c];
                    outData[o + c] = value + (lut[c * 256 + value] - value) * w;
                }
                if (channels === 4 && activeChannels === 4) {
                    var alphaValue = data[o + 3];
                    outData[o + 3] = alphaValue + (lut[3 * 256 + alphaValue] - alphaValue) * w;
                }
            }
            if (channels === 4 && activeChannels !== 4) outData[o + 3] = data[o + 3];
        }
        return out;
    }

    /* ---------- 柔光混合 ---------- */

    /** W3C / Photoshop 柔光公式，base / blend 均为 0..1 */
    function softLightChannel(base, blend) {
        if (blend <= 0.5) return base - (1 - 2 * blend) * base * (1 - base);
        var d = base <= 0.25 ? ((16 * base - 12) * base + 4) * base : Math.sqrt(base);
        return base + (2 * blend - 1) * (d - base);
    }

    /**
     * 柔光混合：把参考图的低频色彩（去掉细节，只留整体色调与明暗）
     * 以柔光方式叠到源图上，叠加量由 strength × mask 控制。
     * 参考图与源图尺寸不同时，按归一化坐标最近邻取样（低频层本身很平滑，取样误差可忽略）。
     */
    function transferSoftLight(source, reference, options) {
        var opts = normalizeOptions(options);
        var src = normalizeImage(source);
        var ref = normalizeImage(reference);
        var out = createImage(src.width, src.height, src.channels);
        if (opts.strength <= 0) return copyInto(src, out);

        var radius = opts.lowFrequencyRadius > 0
            ? opts.lowFrequencyRadius
            : autoRadius(ref.width, ref.height);
        var low = blurPlanes(
            ref.data, ref.width, ref.height, ref.channels, 3,
            radius, opts.lowFrequencyPasses
        );

        var data = src.data;
        var outData = out.data;
        var channels = src.channels;
        var hasAlpha = channels === 4;
        var mask = opts.mask;
        var strength = opts.strength;
        var refWidth = ref.width;
        var refHeight = ref.height;
        var refChannels = ref.channels;
        var scaleX = refWidth / src.width;
        var scaleY = refHeight / src.height;
        var x = 0;
        var y = 0;
        var count = src.count;
        for (var i = 0; i < count; i++) {
            var o = i * channels;
            var w = maskWeight(mask, i, strength);
            if (w > 0) {
                var rx = ((x + 0.5) * scaleX) | 0;
                if (rx >= refWidth) rx = refWidth - 1;
                var ry = ((y + 0.5) * scaleY) | 0;
                if (ry >= refHeight) ry = refHeight - 1;
                var ro = (ry * refWidth + rx) * refChannels;
                for (var c = 0; c < 3; c++) {
                    var base = data[o + c] / 255;
                    var blended = softLightChannel(base, low[ro + c] / 255) * 255;
                    outData[o + c] = data[o + c] + (blended - data[o + c]) * w;
                }
            } else {
                copyColor(data, outData, o);
            }
            if (hasAlpha) outData[o + 3] = data[o + 3];
            x++;
            if (x >= src.width) { x = 0; y++; }
        }
        return out;
    }

    /* ---------- 仅亮度对齐 ---------- */

    /**
     * 仅亮度对齐：保留源图色度（a/b 原样），只把 L 通道的均值 / 标准差
     * 映射到参考图。适合「只要明暗匹配、不想染色」的场景。
     */
    function alignLuminance(source, reference, options) {
        var opts = normalizeOptions(options);
        var src = normalizeImage(source);
        var ref = normalizeImage(reference);
        var out = createImage(src.width, src.height, src.channels);
        if (opts.strength <= 0) return copyInto(src, out);

        var planes = toLabPlanes(src);
        var srcStats = labPlanesStats(planes, src.count);
        var refStats = referenceLabStats(ref);
        return applyLabTransfer(src, planes, srcStats, refStats, out, opts, true);
    }

    /* ============================================================
     * 6. 结构差异蒙版
     * ============================================================ */

    /** 取 (x,y) 处的 Rec.709 亮度，坐标越界时钳制（等效复制边缘） */
    function lumaAt(data, width, height, channels, x, y) {
        if (x < 0) x = 0; else if (x >= width) x = width - 1;
        if (y < 0) y = 0; else if (y >= height) y = height - 1;
        var o = (y * width + x) * channels;
        return 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    }

    /**
     * 中心差分梯度幅值（0-255 尺度）。
     * 只取 4 个邻域，边界靠钳制取样，不需要额外的填充缓冲。
     */
    function gradientMagnitude(data, width, height, channels, x, y) {
        var left = lumaAt(data, width, height, channels, x - 1, y);
        var right = lumaAt(data, width, height, channels, x + 1, y);
        var up = lumaAt(data, width, height, channels, x, y - 1);
        var down = lumaAt(data, width, height, channels, x, y + 1);
        var gx = (right - left) * 0.5;
        var gy = (down - up) * 0.5;
        return Math.sqrt(gx * gx + gy * gy);
    }

    /**
     * 结构差异蒙版：
     *   delta  = |gradSource - gradReference|（两图亮度梯度幅值之差）
     *   weight = clamp(1 - delta / 阈值, 0, 1)     —— 阈值默认 72（0-255 尺度）
     *   alpha < 12 的像素权重直接置 0（两图任一为透明都算）
     *   最后用可分离盒式模糊做羽化，radius = clamp(round(featherRadius), 0, 24)，默认 16。
     * @returns {{mask:Float32Array, sharedRatio:number}} sharedRatio 为羽化后权重 > 0.25 的像素占比
     */
    function computeMask(source, reference, options) {
        var opts = options || {};
        var src = normalizeImage(source);
        var ref = normalizeImage(reference);
        var width = src.width;
        var height = src.height;
        var count = src.count;
        var threshold = Math.max(1, toNumber(opts.gradientThreshold, DEFAULT_OPTIONS.gradientThreshold));
        var featherRadius = Math.round(clampNumber(
            opts.featherRadius === undefined ? DEFAULT_OPTIONS.featherRadius : opts.featherRadius,
            0, MAX_FEATHER_RADIUS, DEFAULT_OPTIONS.featherRadius
        ));
        var mask = new Float32Array(count);
        var srcData = src.data;
        var refData = ref.data;
        var srcChannels = src.channels;
        var refChannels = ref.channels;
        var inverseThreshold = 1 / threshold;
        // 参考图尺寸不同时按归一化坐标取样，保证梯度比较的是同一处结构
        var scaleX = ref.width / width;
        var scaleY = ref.height / height;

        var x = 0;
        var y = 0;
        for (var i = 0; i < count; i++) {
            var weight = 0;
            var rx = ((x + 0.5) * scaleX) | 0;
            if (rx >= ref.width) rx = ref.width - 1;
            var ry = ((y + 0.5) * scaleY) | 0;
            if (ry >= ref.height) ry = ref.height - 1;
            var opaque = srcChannels < 4 || srcData[i * srcChannels + 3] >= ALPHA_SKIP;
            if (opaque && (refChannels < 4 || refData[(ry * ref.width + rx) * refChannels + 3] >= ALPHA_SKIP)) {
                var delta = Math.abs(
                    gradientMagnitude(srcData, width, height, srcChannels, x, y) -
                    gradientMagnitude(refData, ref.width, ref.height, refChannels, rx, ry)
                );
                weight = 1 - delta * inverseThreshold;
                if (weight < 0) weight = 0; else if (weight > 1) weight = 1;
            }
            mask[i] = weight;
            x++;
            if (x >= width) { x = 0; y++; }
        }

        if (featherRadius >= 1) {
            var softened = new Float32Array(count);
            boxBlurRow(mask, softened, width, height, 1, 1, featherRadius);
            boxBlurColumn(softened, mask, width, height, 1, 1, featherRadius);
        }

        var shared = 0;
        for (var j = 0; j < count; j++) {
            if (mask[j] > SHARED_WEIGHT) shared++;
        }
        return {
            mask: mask,
            sharedRatio: count > 0 ? shared / count : 0
        };
    }

    /* ============================================================
     * 7. 公开 API
     * ============================================================ */

    /** 可选算法：labelKey 只返回键名，由 UI 层用 DreamAI.I18n.t() 解析 */
    var METHODS = [
        { id: 'meanStd', labelKey: 'tools.methodMeanStd' },
        { id: 'histogram', labelKey: 'tools.methodHistogram' },
        { id: 'reinhard', labelKey: 'tools.methodReinhard' },
        { id: 'softLight', labelKey: 'tools.methodSoftLight' },
        { id: 'luminance', labelKey: 'tools.methodLuminanceOnly' }
    ];

    DreamAI.ColorEngine = {
        srgbToLab: srgbToLab,
        labToSrgb: labToSrgb,
        srgbToLinear: srgbToLinear,
        linearToSrgb: linearToSrgb,
        reconstructLowFrequency: reconstructLowFrequency,
        transferMeanStd: transferMeanStd,
        transferHistogram: transferHistogram,
        transferReinhard: transferReinhard,
        transferSoftLight: transferSoftLight,
        alignLuminance: alignLuminance,
        METHODS: METHODS,
        computeMask: computeMask,
        DEFAULT_OPTIONS: DEFAULT_OPTIONS
    };
})(typeof window !== 'undefined' ? window : this);
