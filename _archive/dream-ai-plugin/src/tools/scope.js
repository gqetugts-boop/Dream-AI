/*
 * tools/scope.js — 示波器统计内核（直方图 / 波形图 / RGB 分量图 / 矢量示波器 / 缩略采样）
 *
 * 职责：
 *   1. histogram：R/G/B 与 Rec.709 亮度直方图，每通道桶数之和严格等于像素数；
 *   2. waveform：按列聚合的亮度波形矩阵（附 R/G/B 三张同尺寸矩阵）；
 *   3. parade：RGB 分量图，每个通道一张按列聚合的波形矩阵；
 *   4. vectorscope：Cb/Cr 色差平面上的 2D 分布，灰轴落在画面中心、饱和度向外扩散；
 *   5. sample：给绘制用的降采样 RGBA 拷贝（盒式平均，绝不放大）。
 *
 * 输入：{ data, width, height, channels }（交错通道，1-4，取值 0-255）+ 可选选项对象。
 * 输出：各类统计缓冲区（Uint32Array / Uint8ClampedArray，全部新建，不修改入参）。
 *
 * 边界：
 *   - 纯算法模块：不碰 DOM / Canvas / Photoshop，可在 Node 下直接跑测试；
 *   - 逐像素循环内零分配；
 *   - 选项缺失、类型错误、超界一律走默认值或钳制，绝不抛异常。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.Scope) return;

    var util = DreamAI.util;

    var BUCKETS = 256;
    var LUMA_R = 0.2126;
    var LUMA_G = 0.7152;
    var LUMA_B = 0.0722;

    /* ============================================================
     * 1. 默认值与上限
     * ============================================================ */

    /** 各功能的默认参数（面板初始化时直接读这里） */
    var DEFAULTS = {
        waveform: { columns: 256, bins: 128 },
        parade: { columns: 256, bins: 128 },
        vectorscope: { size: 160 },
        sample: { maxSize: 320 }
    };

    /** 安全上限：避免面板传入离谱数值把内存吃满 */
    var LIMITS = {
        columns: [1, 2048],
        bins: [2, 1024],
        size: [8, 512],
        maxSize: [8, 4096]
    };

    /* ============================================================
     * 2. 入参净化
     * ============================================================ */

    /** 取整并钳制；非数字回落到默认值 */
    function toInt(value, fallback, min, max) {
        var n = Number(value);
        if (value === undefined || value === null || value === '' || !isFinite(n)) n = fallback;
        n = Math.round(n);
        if (!isFinite(n)) n = fallback;
        if (n < min) return min;
        if (n > max) return max;
        return n;
    }

    /** 选项对象必须是普通对象，字符串/数字/null 一律丢弃改用默认值 */
    function optionValue(options, group, key) {
        var base = DEFAULTS[group] || {};
        if (!options || typeof options !== 'object') return base[key];
        var value = options[key];
        return value === undefined || value === null ? base[key] : value;
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

    /** 归一化图像描述：缺失字段用安全值补齐，返回只读意义上的新描述对象 */
    function normalizeImage(image) {
        var width = Math.max(1, Math.round(util.toNumber(image && image.width, 1)));
        var height = Math.max(1, Math.round(util.toNumber(image && image.height, 1)));
        var channels = channelsOf(image);
        var needed = width * height * channels;
        var data = (image && image.data && image.data.length >= needed)
            ? image.data
            : new Uint8ClampedArray(needed);
        return { data: data, width: width, height: height, channels: channels };
    }

    /** 8 位采样值 → 桶下标（值域 0-255 映射到 bins 个桶，255 落在最后一桶） */
    function bucketOf(value, bins) {
        var index = (value * bins / BUCKETS) | 0;
        if (index < 0) return 0;
        if (index >= bins) return bins - 1;
        return index;
    }

    /** 像素水平位置 → 波形列下标 */
    function columnOf(x, width, columns) {
        var column = (x * columns / width) | 0;
        if (column < 0) return 0;
        if (column >= columns) return columns - 1;
        return column;
    }

    /* ============================================================
     * 3. 直方图
     * ============================================================ */

    /**
     * @returns {{r:Uint32Array,g:Uint32Array,b:Uint32Array,luma:Uint32Array}} 每张表 256 桶
     */
    function histogram(image) {
        var src = normalizeImage(image);
        var data = src.data;
        var width = src.width;
        var height = src.height;
        var channels = src.channels;

        var r = new Uint32Array(BUCKETS);
        var g = new Uint32Array(BUCKETS);
        var b = new Uint32Array(BUCKETS);
        var luma = new Uint32Array(BUCKETS);

        for (var y = 0; y < height; y++) {
            var rowBase = y * width;
            for (var x = 0; x < width; x++) {
                var offset = (rowBase + x) * channels;
                var cr = data[offset];
                var cg = channels > 1 ? data[offset + 1] : cr;
                var cb = channels > 2 ? data[offset + 2] : cr;
                r[cr]++;
                g[cg]++;
                b[cb]++;
                var level = Math.round(LUMA_R * cr + LUMA_G * cg + LUMA_B * cb);
                if (level < 0) level = 0;
                else if (level > 255) level = 255;
                luma[level]++;
            }
        }

        return { r: r, g: g, b: b, luma: luma };
    }

    /* ============================================================
     * 4. 波形图与 RGB 分量图
     * ============================================================ */

    /**
     * 按列聚合的亮度波形。
     * bins0 / binsR / binsG / binsB 均为 columns × bins 矩阵，索引 = 列 × bins + 桶。
     * max 取四张矩阵的峰值，绘制方用它在 0-1 之间归一化。
     */
    function waveform(image, options) {
        var src = normalizeImage(image);
        var columns = toInt(optionValue(options, 'waveform', 'columns'),
            DEFAULTS.waveform.columns, LIMITS.columns[0], LIMITS.columns[1]);
        var bins = toInt(optionValue(options, 'waveform', 'bins'),
            DEFAULTS.waveform.bins, LIMITS.bins[0], LIMITS.bins[1]);

        var size = columns * bins;
        var bins0 = new Uint32Array(size);
        var binsR = new Uint32Array(size);
        var binsG = new Uint32Array(size);
        var binsB = new Uint32Array(size);

        var data = src.data;
        var width = src.width;
        var height = src.height;
        var channels = src.channels;

        for (var y = 0; y < height; y++) {
            var rowBase = y * width;
            for (var x = 0; x < width; x++) {
                var offset = (rowBase + x) * channels;
                var cr = data[offset];
                var cg = channels > 1 ? data[offset + 1] : cr;
                var cb = channels > 2 ? data[offset + 2] : cr;
                var base = columnOf(x, width, columns) * bins;
                var level = Math.round(LUMA_R * cr + LUMA_G * cg + LUMA_B * cb);
                if (level < 0) level = 0;
                else if (level > 255) level = 255;
                bins0[base + bucketOf(level, bins)]++;
                binsR[base + bucketOf(cr, bins)]++;
                binsG[base + bucketOf(cg, bins)]++;
                binsB[base + bucketOf(cb, bins)]++;
            }
        }

        var max = 0;
        for (var i = 0; i < size; i++) {
            if (bins0[i] > max) max = bins0[i];
            if (binsR[i] > max) max = binsR[i];
            if (binsG[i] > max) max = binsG[i];
            if (binsB[i] > max) max = binsB[i];
        }

        return {
            columns: columns,
            bins: bins,
            bins0: bins0,
            binsR: binsR,
            binsG: binsG,
            binsB: binsB,
            max: max
        };
    }

    /**
     * RGB 分量图：每个通道一张按列聚合的波形矩阵。
     * @returns {{columns:number,bins:number,r:Uint32Array,g:Uint32Array,b:Uint32Array,max:number}}
     */
    function parade(image, options) {
        var src = normalizeImage(image);
        var columns = toInt(optionValue(options, 'parade', 'columns'),
            DEFAULTS.parade.columns, LIMITS.columns[0], LIMITS.columns[1]);
        var bins = toInt(optionValue(options, 'parade', 'bins'),
            DEFAULTS.parade.bins, LIMITS.bins[0], LIMITS.bins[1]);

        var size = columns * bins;
        var r = new Uint32Array(size);
        var g = new Uint32Array(size);
        var b = new Uint32Array(size);

        var data = src.data;
        var width = src.width;
        var height = src.height;
        var channels = src.channels;

        for (var y = 0; y < height; y++) {
            var rowBase = y * width;
            for (var x = 0; x < width; x++) {
                var offset = (rowBase + x) * channels;
                var cr = data[offset];
                var cg = channels > 1 ? data[offset + 1] : cr;
                var cb = channels > 2 ? data[offset + 2] : cr;
                var base = columnOf(x, width, columns) * bins;
                r[base + bucketOf(cr, bins)]++;
                g[base + bucketOf(cg, bins)]++;
                b[base + bucketOf(cb, bins)]++;
            }
        }

        var max = 0;
        for (var i = 0; i < size; i++) {
            if (r[i] > max) max = r[i];
            if (g[i] > max) max = g[i];
            if (b[i] > max) max = b[i];
        }

        return { columns: columns, bins: bins, r: r, g: g, b: b, max: max };
    }

    /* ============================================================
     * 5. 矢量示波器
     * ============================================================ */

    /**
     * Cb/Cr 色差平面分布。灰（无色）落在网格中心，饱和度越大越靠外。
     * 采样 size × size 个点，每个点落入一个格子，因此 data 之和恒等于 size²。
     * @returns {{size:number,data:Uint32Array,max:number}}
     */
    function vectorscope(image, options) {
        var src = normalizeImage(image);
        var size = toInt(optionValue(options, 'vectorscope', 'size'),
            DEFAULTS.vectorscope.size, LIMITS.size[0], LIMITS.size[1]);

        var data = new Uint32Array(size * size);
        var source = src.data;
        var width = src.width;
        var height = src.height;
        var channels = src.channels;
        var half = (size - 1) / 2;
        var max = 0;

        for (var sy = 0; sy < size; sy++) {
            var sourceY = ((sy + 0.5) * height / size) | 0;
            if (sourceY >= height) sourceY = height - 1;
            var rowBase = sourceY * width;
            for (var sx = 0; sx < size; sx++) {
                var sourceX = ((sx + 0.5) * width / size) | 0;
                if (sourceX >= width) sourceX = width - 1;
                var offset = (rowBase + sourceX) * channels;
                var cr = source[offset];
                var cg = channels > 1 ? source[offset + 1] : cr;
                var cb = channels > 2 ? source[offset + 2] : cr;
                // Rec.601 色差：无色（R=G=B）时两轴都为 0
                var chromaB = -0.168736 * cr - 0.331264 * cg + 0.5 * cb;
                var chromaR = 0.5 * cr - 0.418688 * cg - 0.081312 * cb;
                var gx = Math.round(half + (chromaB / 127.5) * half);
                var gy = Math.round(half - (chromaR / 127.5) * half);
                if (gx < 0) gx = 0;
                else if (gx >= size) gx = size - 1;
                if (gy < 0) gy = 0;
                else if (gy >= size) gy = size - 1;
                var index = gy * size + gx;
                data[index]++;
                if (data[index] > max) max = data[index];
            }
        }

        return { size: size, data: data, max: max };
    }

    /* ============================================================
     * 6. 缩略采样（绘制用）
     * ============================================================ */

    /**
     * 盒式平均降采样成 RGBA 拷贝：只在缩小时重采样，绝不放大；
     * 源图本来就没超标时按原尺寸拷贝，并把通道强制成 4。
     * @returns {{width:number,height:number,data:Uint8ClampedArray,scale:number}}
     */
    function sample(image, options) {
        var src = normalizeImage(image);
        var maxSize = toInt(optionValue(options, 'sample', 'maxSize'),
            DEFAULTS.sample.maxSize, LIMITS.maxSize[0], LIMITS.maxSize[1]);

        var source = src.data;
        var width = src.width;
        var height = src.height;
        var channels = src.channels;
        var longest = Math.max(width, height);
        var factor = longest > maxSize ? maxSize / longest : 1;
        var outWidth = Math.max(1, Math.round(width * factor));
        var outHeight = Math.max(1, Math.round(height * factor));
        var out = new Uint8ClampedArray(outWidth * outHeight * 4);

        var x;
        var y;
        var target;
        if (outWidth === width && outHeight === height) {
            // 无需缩放：直接展开成 RGBA
            for (y = 0; y < height; y++) {
                var rowBase = y * width;
                for (x = 0; x < width; x++) {
                    var offset = (rowBase + x) * channels;
                    target = (rowBase + x) * 4;
                    var sr = source[offset];
                    out[target] = sr;
                    out[target + 1] = channels > 1 ? source[offset + 1] : sr;
                    out[target + 2] = channels > 2 ? source[offset + 2] : sr;
                    out[target + 3] = channels > 3 ? source[offset + 3] : 255;
                }
            }
            return { width: width, height: height, data: out, scale: 1 };
        }

        for (y = 0; y < outHeight; y++) {
            var y0 = Math.floor(y * height / outHeight);
            var y1 = Math.floor((y + 1) * height / outHeight);
            if (y1 <= y0) y1 = y0 + 1;
            if (y1 > height) y1 = height;
            for (x = 0; x < outWidth; x++) {
                var x0 = Math.floor(x * width / outWidth);
                var x1 = Math.floor((x + 1) * width / outWidth);
                if (x1 <= x0) x1 = x0 + 1;
                if (x1 > width) x1 = width;

                var sumR = 0;
                var sumG = 0;
                var sumB = 0;
                var sumA = 0;
                var count = 0;
                for (var sy = y0; sy < y1; sy++) {
                    var sourceRow = sy * width;
                    for (var sx = x0; sx < x1; sx++) {
                        var srcOffset = (sourceRow + sx) * channels;
                        var r0 = source[srcOffset];
                        var g0 = channels > 1 ? source[srcOffset + 1] : r0;
                        var b0 = channels > 2 ? source[srcOffset + 2] : r0;
                        var a0 = channels > 3 ? source[srcOffset + 3] : 255;
                        sumR += r0;
                        sumG += g0;
                        sumB += b0;
                        sumA += a0;
                        count++;
                    }
                }
                if (count <= 0) count = 1;
                target = (y * outWidth + x) * 4;
                out[target] = sumR / count;
                out[target + 1] = sumG / count;
                out[target + 2] = sumB / count;
                out[target + 3] = sumA / count;
            }
        }

        return { width: outWidth, height: outHeight, data: out, scale: outWidth / width };
    }

    /* ============================================================
     * 7. 注册
     * ============================================================ */

    DreamAI.Scope = {
        DEFAULTS: DEFAULTS,
        LIMITS: LIMITS,
        histogram: histogram,
        waveform: waveform,
        parade: parade,
        vectorscope: vectorscope,
        sample: sample
    };
})(typeof window !== 'undefined' ? window : this);
