/*
 * tools/glow-core.js — 辉光核心算法（纯计算，无 DOM / 无宿主依赖）
 *
 * 职责：
 *   - 把交错 RGB(A) 像素解析为「线性光下的发射强度」：哪些像素应该发光，
 *     哪些必须被保护（白墙、肤色、暗部），全部用软阈值避免色阶断裂；
 *   - 用高斯金字塔做多尺度扩散（半径越大，能量越偏向粗层级），
 *     并可选叠加星芒（旋转光线）与变形宽银幕（横向拉丝）；
 *   - 屏幕混合、染色 / 饱和度 / 色调映射，产出可直接写入 Photoshop 的 RGBA 图层；
 *   - 提供受保护的预览合成。
 *
 * 输入：
 *   image = { data, width, height, channels }，data 为交错通道（0-255，channels = 3 或 4）；
 *   params = UI 参数对象（可含垃圾数据，内部一律归一化后再用）。
 * 输出：
 *   Float32Array（发射蒙版 / 辉光，长度 width*height，取值 0..1）；
 *   Uint8ClampedArray（RGBA 图层、预览图，交错通道）。
 *
 * 边界：
 *   - 不访问 DOM、canvas、Photoshop API；不产生任何面向用户的文案（i18n 键由 UI 层解析）；
 *   - 所有归一化函数对垃圾输入永不抛错，只做钳制与回退；
 *   - 大图路径全程写入预分配缓冲，逐像素不做对象分配；
 *   - 本模块只做「发光源 → 辉光」的推导，文档写入与锁定由上层负责。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.GlowCore) return;

    var util = DreamAI.util;

    /* ============================================================
     * 1. 风格、预设与参数范围
     * ============================================================ */

    /** 风格 id（ASCII；显示名由 UI 用 tools.glow.preset.<style> 解析） */
    var STYLES = ['whiteSoft', 'shine', 'starburst', 'anamorphic', 'darkSoft'];

    /** 参数范围 [min, max]，UI 滑块与归一化共用同一份真相 */
    var RANGES = {
        strength: [1, 100],
        radius: [1, 500],
        threshold: [0, 100],
        saturation: [-100, 100],
        brightnessBias: [-100, 100],
        colorShift: [-180, 180],
        starLength: [10, 220],
        starCount: [4, 12],
        starRotation: [-90, 90],
        starVisible: [0, 100],
        streakLength: [16, 300],
        streakVisible: [0, 100],
        chromatic: [0, 100],
        colorAmount: [0, 100]
    };

    /** 触发方式：自动 / 跟随选区 / 手动 */
    var TRIGGER_MODES = ['auto', 'selection', 'manual'];

    var DEFAULT_COLOR_HEX = '#ffd27a';

    /**
     * 风格预设。
     *
     * 除 UI 的调参键之外，每个预设还带 4 个算法专用调音键：
     *   coreBoost   —— 紧致核心（原始尺度）在最终辉光里的占比；
     *   rayGain     —— 星芒增益，0 表示该风格不产生旋转光线；
     *   streakGain  —— 横向拉丝增益，0 表示该风格不产生变形宽银幕条纹；
     *   protection  —— 保护蒙版的整体倍率（> 1 更保守）。
     * 未被某个风格启用的旋钮一律保留默认值，避免归一化结果与文档默认值不一致。
     */
    var PRESETS = {
        // 柔和白色辉光：通用人像 / 产品，保护最强，核心干净
        whiteSoft: {
            labelKey: 'tools.glow.preset.whiteSoft',
            strength: 47, radius: 81, threshold: 81, saturation: 0, brightnessBias: 0, colorShift: 0,
            starLength: 58, starCount: 6, starRotation: 0, starVisible: 68,
            streakLength: 86, streakVisible: 62, chromatic: 0, colorAmount: 0, colorHex: DEFAULT_COLOR_HEX,
            coreBoost: 0.30, rayGain: 0, streakGain: 0, protection: 1
        },
        // 闪耀：更紧的核心、更宽的柔光，轻微染色与色散
        shine: {
            labelKey: 'tools.glow.preset.shine',
            strength: 68, radius: 132, threshold: 64, saturation: 12, brightnessBias: 6, colorShift: 4,
            starLength: 58, starCount: 6, starRotation: 0, starVisible: 68,
            streakLength: 86, streakVisible: 62, chromatic: 8, colorAmount: 26, colorHex: '#fff0cf',
            coreBoost: 0.42, rayGain: 0, streakGain: 0, protection: 1
        },
        // 星芒：多角度旋转光线
        starburst: {
            labelKey: 'tools.glow.preset.starburst',
            strength: 62, radius: 120, threshold: 70, saturation: 6, brightnessBias: 4, colorShift: 0,
            starLength: 150, starCount: 8, starRotation: 12, starVisible: 84,
            streakLength: 86, streakVisible: 62, chromatic: 10, colorAmount: 22, colorHex: '#ffe7b4',
            coreBoost: 0.36, rayGain: 1.05, streakGain: 0, protection: 1
        },
        // 变形宽银幕：横向蓝色拉丝
        anamorphic: {
            labelKey: 'tools.glow.preset.anamorphic',
            strength: 64, radius: 146, threshold: 66, saturation: 16, brightnessBias: 4, colorShift: -6,
            starLength: 58, starCount: 6, starRotation: 0, starVisible: 68,
            streakLength: 230, streakVisible: 90, chromatic: 16, colorAmount: 38, colorHex: '#9fd0ff',
            coreBoost: 0.28, rayGain: 0, streakGain: 1.1, protection: 1
        },
        // 暗场柔光：低阈值 + 强保护，只让真正的点光源发亮
        darkSoft: {
            labelKey: 'tools.glow.preset.darkSoft',
            strength: 38, radius: 96, threshold: 38, saturation: -10, brightnessBias: 10, colorShift: 0,
            starLength: 58, starCount: 6, starRotation: 0, starVisible: 68,
            streakLength: 86, streakVisible: 62, chromatic: 0, colorAmount: 0, colorHex: DEFAULT_COLOR_HEX,
            coreBoost: 0.22, rayGain: 0, streakGain: 0, protection: 1.2
        }
    };

    /** 文档化默认值；PRESETS.whiteSoft 与它逐项一致 */
    var DEFAULT_PARAMS = {
        style: STYLES[0],
        strength: 47,
        radius: 81,
        threshold: 81,
        saturation: 0,
        brightnessBias: 0,
        colorShift: 0,
        starLength: 58,
        starCount: 6,
        starRotation: 0,
        starVisible: 68,
        streakLength: 86,
        streakVisible: 62,
        chromatic: 0,
        colorAmount: 0,
        colorHex: DEFAULT_COLOR_HEX,
        preset: PRESETS[STYLES[0]],
        triggerMode: 'auto'
    };

    /** 辉光整体增益：多尺度扩散会把能量摊薄，这里补回可感知的强度 */
    var GLOW_GAIN = 1.45;

    /** 预览合成的高光拐点（软肩起点） */
    var HIGHLIGHT_KNEE = 0.86;

    /* ============================================================
     * 2. 色彩与数值小工具
     * ============================================================ */

    /** sRGB（0-255）→ 线性光（0..1）查表，避免逐像素 pow */
    var SRGB_TO_LINEAR = (function () {
        var table = new Float32Array(256);
        for (var i = 0; i < 256; i++) {
            var c = i / 255;
            table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        }
        return table;
    })();

    /** 线性光（0..1）→ sRGB（0-255）查表 */
    var LINEAR_TO_SRGB = (function () {
        var table = new Uint8ClampedArray(1024);
        for (var i = 0; i < 1024; i++) {
            var c = i / 1023;
            var s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
            table[i] = Math.round(s * 255);
        }
        return table;
    })();

    /** 色调映射查表：软肩，高光滚降而不是硬切 */
    var TONE_LUT = (function () {
        var table = new Float32Array(256);
        for (var i = 0; i < 256; i++) {
            table[i] = 1 - Math.pow(1 - i / 255, 1.4);
        }
        return table;
    })();

    function srgbToLinear(value) {
        var v = value <= 0 ? 0 : (value >= 255 ? 255 : value);
        return SRGB_TO_LINEAR[v | 0];
    }

    function linearToSrgb(value) {
        var v = value <= 0 ? 0 : (value >= 1 ? 1 : value);
        return LINEAR_TO_SRGB[(v * 1023) | 0];
    }

    /** 内联版 smoothstep（比属性链查找快，逐像素循环里用） */
    function ss(edge0, edge1, x) {
        var span = edge1 - edge0;
        if (span > -1e-9 && span < 1e-9) return x < edge0 ? 0 : 1;
        var t = (x - edge0) / span;
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        return t * t * (3 - 2 * t);
    }

    function clamp01(value) {
        if (!(value > 0)) return 0;
        return value > 1 ? 1 : value;
    }

    function clampIndex(index, length) {
        if (index < 0) return 0;
        return index >= length ? length - 1 : index;
    }

    /** 高光软肩：拐点之上压向 1，避免死白 */
    function softShoulder(value) {
        var v = value <= 0 ? 0 : value;
        if (v <= HIGHLIGHT_KNEE) return v;
        var t = (v - HIGHLIGHT_KNEE) / (1 - HIGHLIGHT_KNEE);
        if (t > 1) t = 1;
        return HIGHLIGHT_KNEE + (1 - HIGHLIGHT_KNEE) * (1 - Math.pow(1 - t, 1.8)) * 0.985;
    }

    var HEX_PATTERN = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

    /** '#rrggbb' / '#rgb' → [r, g, b]（0..1），非法输入回退到 fallback */
    function hexToRgb(value, fallback) {
        var text = typeof value === 'string' ? value.replace(/\s+/g, '') : '';
        var match = text.match(HEX_PATTERN);
        if (!match) return hexToRgb(fallback || DEFAULT_COLOR_HEX, null) || [1, 0.8235, 0.4784];
        var body = match[1];
        if (body.length === 3) {
            body = body.charAt(0) + body.charAt(0) + body.charAt(1) + body.charAt(1) + body.charAt(2) + body.charAt(2);
        }
        var number = parseInt(body, 16);
        if (!isFinite(number)) return [1, 0.8235, 0.4784];
        return [
            ((number >> 16) & 0xFF) / 255,
            ((number >> 8) & 0xFF) / 255,
            (number & 0xFF) / 255
        ];
    }

    /** 归一化 hex 字符串；非法输入回退 */
    function normalizeHex(value, fallback) {
        var rgb = hexToRgb(value, null);
        if (!rgb) return fallback || DEFAULT_COLOR_HEX;
        return '#' + [(rgb[0] * 255) | 0, (rgb[1] * 255) | 0, (rgb[2] * 255) | 0].map(function (channel) {
            var code = channel.toString(16);
            return code.length === 1 ? '0' + code : code;
        }).join('');
    }

    /** RGB（0..1）→ HSL，h 单位度（0..360），s / l 为 0..1 */
    function rgbToHsl(r, g, b) {
        var max = r > g ? (r > b ? r : b) : (g > b ? g : b);
        var min = r < g ? (r < b ? r : b) : (g < b ? g : b);
        var l = (max + min) * 0.5;
        var delta = max - min;
        if (delta < 1e-6) return [0, 0, l];
        var s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
        var h;
        if (max === r) h = ((g - b) / delta) % 6;
        else if (max === g) h = (b - r) / delta + 2;
        else h = (r - g) / delta + 4;
        h *= 60;
        if (h < 0) h += 360;
        return [h, s, l];
    }

    /** HSL → RGB（0..1） */
    function hslToRgb(h, s, l) {
        var hue = ((h % 360) + 360) % 360 / 360;
        if (s <= 0) return [l, l, l];
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        function channel(t) {
            var value = t;
            if (value < 0) value += 1;
            if (value > 1) value -= 1;
            if (value < 1 / 6) return p + (q - p) * 6 * value;
            if (value < 1 / 2) return q;
            if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
            return p;
        }
        return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
    }

    /** 双线性采样（坐标超出范围时钳制到边缘） */
    function sampleBilinear(src, w, h, x, y) {
        var sx = x < 0 ? 0 : (x > w - 1 ? w - 1 : x);
        var sy = y < 0 ? 0 : (y > h - 1 ? h - 1 : y);
        var x0 = sx | 0;
        var y0 = sy | 0;
        var x1 = x0 + 1 < w ? x0 + 1 : w - 1;
        var y1 = y0 + 1 < h ? y0 + 1 : h - 1;
        var fx = sx - x0;
        var fy = sy - y0;
        var row0 = y0 * w;
        var row1 = y1 * w;
        var top = src[row0 + x0] + (src[row0 + x1] - src[row0 + x0]) * fx;
        var bottom = src[row1 + x0] + (src[row1 + x1] - src[row1 + x0]) * fx;
        return top + (bottom - top) * fy;
    }

    /** 把任意输入整理成指定长度的 Float32Array（多截少补，绝不产生 NaN） */
    function toFloatSource(values, length) {
        if (values && values.length === length && values instanceof Float32Array) return values;
        var out = new Float32Array(length);
        if (values && values.length) {
            var count = Math.min(values.length, length);
            for (var i = 0; i < count; i++) out[i] = util.toNumber(values[i], 0);
        }
        return out;
    }

    /** 读取图像元数据并做防御性修正 */
    function readImage(image) {
        var width = Math.max(1, Math.round(util.toNumber(image && image.width, 1)));
        var height = Math.max(1, Math.round(util.toNumber(image && image.height, 1)));
        var channels = Math.round(util.clamp(image && image.channels !== undefined ? image.channels : 4, 1, 4, 4));
        var data = image && image.data ? image.data : null;
        return { data: data, width: width, height: height, channels: channels };
    }

    /* ============================================================
     * 3. 参数归一化
     * ============================================================ */

    function normalizeStyleId(value) {
        if (typeof value === 'string') {
            for (var i = 0; i < STYLES.length; i++) {
                if (STYLES[i] === value) return value;
            }
        }
        return STYLES[0];
    }

    function has(object, key) {
        return !!object && Object.prototype.hasOwnProperty.call(object, key);
    }

    /** 预设副本（带 id，便于 UI 显示与回填） */
    function copyPreset(style) {
        var source = PRESETS[style] || PRESETS[STYLES[0]];
        var out = { id: style };
        for (var key in source) {
            if (has(source, key)) out[key] = source[key];
        }
        return out;
    }

    function normalizeTriggerMode(value) {
        if (typeof value === 'string') {
            for (var i = 0; i < TRIGGER_MODES.length; i++) {
                if (TRIGGER_MODES[i] === value) return value;
            }
        }
        return DEFAULT_PARAMS.triggerMode;
    }

    /** 读取预设里的算法调音键（不在 RANGES 里的内部参数） */
    function presetNumber(params, key, fallback) {
        var preset = params && params.preset;
        if (has(preset, key)) return util.toNumber(preset[key], fallback);
        return fallback;
    }

    /**
     * 归一化 UI 参数：先取风格预设为底，再用 UI 值覆盖，最后按 RANGES 钳制。
     * 任何垃圾输入（null / 字符串 / 越界 / 非数字）都不会抛错。
     */
    function normalizeParams(uiParams) {
        var ui = (uiParams && typeof uiParams === 'object') ? uiParams : {};
        var style = normalizeStyleId(ui.style);
        var preset = copyPreset(style);

        function pick(key) {
            var value = ui[key];
            if (value !== undefined && value !== null) return value;
            if (has(preset, key)) return preset[key];
            return DEFAULT_PARAMS[key];
        }

        function number(key) {
            var range = RANGES[key];
            var fallback = has(DEFAULT_PARAMS, key) ? DEFAULT_PARAMS[key] : range[0];
            if (!range) return util.toNumber(pick(key), fallback);
            return util.clamp(pick(key), range[0], range[1], fallback);
        }

        return {
            style: style,
            strength: number('strength'),
            radius: number('radius'),
            threshold: number('threshold'),
            saturation: number('saturation'),
            brightnessBias: number('brightnessBias'),
            colorShift: number('colorShift'),
            starLength: number('starLength'),
            starCount: Math.round(number('starCount')),
            starRotation: number('starRotation'),
            starVisible: number('starVisible'),
            streakLength: number('streakLength'),
            streakVisible: number('streakVisible'),
            chromatic: number('chromatic'),
            colorAmount: number('colorAmount'),
            colorHex: normalizeHex(pick('colorHex'), DEFAULT_COLOR_HEX),
            preset: preset,
            triggerMode: normalizeTriggerMode(ui.triggerMode)
        };
    }

    /**
     * 强度曲线：0..100 → 增益。
     * 用幂函数让低强度区间更细；strength = 1（也是 0 被钳制后的取值）恰好为 0，
     * 即「最小档 = 关闭辉光」，避免出现看不见却仍在计算的残留辉光。
     */
    function strengthScale(strength) {
        var s = util.clamp(strength, RANGES.strength[0], RANGES.strength[1], DEFAULT_PARAMS.strength);
        var t = (s - RANGES.strength[0]) / (RANGES.strength[1] - RANGES.strength[0]);
        if (!(t > 0)) return 0;
        return Math.pow(t, 1.25) * GLOW_GAIN;
    }

    /* ============================================================
     * 4. 发射蒙版（buildSource）
     * ============================================================ */

    /**
     * 解析图像，输出「发射强度」与三张蒙版。
     *
     * 发射由 4 项软权重叠加：
     *   亮度阈值项（threshold 之上的软过渡）、局部对比项（线性亮度 − 盒式模糊局部均值）、
     *   镜面项（最大通道高出局部均值的部分）、边缘光项（只取「比邻居亮」的一侧）。
     * 保护蒙版由三项合成：白墙（又亮又平）、肤色（红通道占优 + 真实彩度 + 色相 5..52 度）、暗部。
     *
     * @param {{data:*, width:number, height:number, channels:number}} image
     * @param {Object} [params] UI 参数（可未归一化）
     * @returns {{source:Float32Array, width:number, height:number,
     *            masks:{luminance:Float32Array, protection:Float32Array,
     *                   dark:Float32Array, emission:Float32Array}}}
     */
    function buildSource(image, params) {
        var p = normalizeParams(params);
        var info = readImage(image);
        var w = info.width;
        var h = info.height;
        var n = w * h;
        var ch = info.channels;
        var data = info.data;

        var source = new Float32Array(n);
        var luminanceMask = new Float32Array(n);
        var darkMask = new Float32Array(n);
        var protectionMask = new Float32Array(n);
        var emissionMask = new Float32Array(n);
        var masks = {
            luminance: luminanceMask,
            protection: protectionMask,
            dark: darkMask,
            emission: emissionMask
        };

        // 非类型化数组先转成 Uint8ClampedArray，保证下面的查表不会取到 undefined
        if (data && !(data instanceof Uint8Array) && typeof data.length === 'number') {
            var converted = new Uint8ClampedArray(data.length);
            for (var ci = 0; ci < data.length; ci++) converted[ci] = util.toNumber(data[ci], 0);
            data = converted;
        }
        if (!data || typeof data.length !== 'number' || data.length < n) {
            return { source: source, width: w, height: h, masks: masks };
        }
        if (data.length < n * ch) {
            if (data.length >= n * 4) ch = 4;
            else if (data.length >= n * 3) ch = 3;
            else ch = 1;
        }
        var hasColor = ch >= 3;

        /* ---- 第一遍：线性亮度 + 肤色保护 ---- */
        var luma = new Float32Array(n);
        var skinMask = new Uint8Array(n);   // 0..255 的肤色保护（内部量化，省内存）
        var i, x, y, o, r, g, b, maxChannel, minChannel, delta, hue, skin, value;

        for (i = 0; i < n; i++) {
            o = i * ch;
            if (hasColor) {
                r = SRGB_TO_LINEAR[data[o]];
                g = SRGB_TO_LINEAR[data[o + 1]];
                b = SRGB_TO_LINEAR[data[o + 2]];
            } else {
                r = g = b = SRGB_TO_LINEAR[data[o]];
            }
            var lumaValue = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            luma[i] = lumaValue;

            if (hasColor) {
                maxChannel = r > g ? (r > b ? r : b) : (g > b ? g : b);
                minChannel = r < g ? (r < b ? r : b) : (g < b ? g : b);
                delta = maxChannel - minChannel;
                // 肤色：红通道最大 + 有真实彩度 + 色相落在 2..58 度软窗内 + 亮度不过暗
                if (delta > 0.045 && r >= g && r >= b) {
                    hue = ((g - b) / delta) * 60;
                    if (hue < 0) hue += 360;
                    if (hue > 2 && hue < 58) {
                        skin = (1 - ss(48, 60, hue)) * ss(2, 12, hue) *
                            ss(0.045, 0.16, delta) * ss(0.05, 0.30, lumaValue);
                        skinMask[i] = skin > 0 ? Math.round(clamp01(skin) * 255) : 0;
                    }
                }
            }
        }

        /* ---- 局部均值：半径跟随辉光半径，衡量「相对整片辉光尺度」的对比 ---- */
        var localRadius = Math.round(util.clamp(p.radius * 0.25, 4, 64, 12));
        var mean = new Float32Array(n);
        var tmp = new Float32Array(n);
        var prefixW = new Float64Array(w + 1);
        var prefixH = new Float64Array(h + 1);
        boxBlurH(luma, tmp, w, h, localRadius, prefixW);
        boxBlurV(tmp, mean, w, h, localRadius, prefixH);

        /* ---- 第二遍：发射项 + 保护 ---- */
        var threshold = util.clamp(p.threshold, 0, 100, DEFAULT_PARAMS.threshold) / 100;
        var softHigh = util.clamp(0.04 + threshold * 0.94, 0.02, 0.99);
        var softLow = Math.max(0.005, softHigh - 0.16);
        var softTop = Math.min(1, softHigh + 0.16);
        var protectScale = util.clamp(presetNumber(p, 'protection', 1), 0, 3);

        for (y = 0; y < h; y++) {
            var row = y * w;
            for (x = 0; x < w; x++) {
                i = row + x;
                var localLuma = luma[i];
                var localMean = mean[i];
                var signed = localLuma - localMean;
                var absolute = signed < 0 ? -signed : signed;
                var positive = signed > 0 ? signed : 0;

                // 1) 亮度阈值项（软过渡，杜绝硬边）
                var luminanceTerm = ss(softLow, softTop, localLuma);
                // 2) 局部对比项：比周边（辉光尺度）亮多少
                var contrastTerm = ss(0.015, 0.20, positive);
                // 3) 镜面项：最大通道高出局部均值的部分
                var specular = 0;
                if (hasColor) {
                    o = i * ch;
                    maxChannel = SRGB_TO_LINEAR[data[o]];
                    value = SRGB_TO_LINEAR[data[o + 1]];
                    if (value > maxChannel) maxChannel = value;
                    value = SRGB_TO_LINEAR[data[o + 2]];
                    if (value > maxChannel) maxChannel = value;
                    specular = maxChannel - localMean;
                    if (specular < 0) specular = 0;
                }
                var specularTerm = ss(0.01, 0.22, specular);
                // 4) 边缘光项：只取「比邻居亮」的那一侧，暗侧不参与
                var rim = 0;
                if (x > 0) { value = localLuma - luma[i - 1]; if (value > rim) rim = value; }
                if (x + 1 < w) { value = localLuma - luma[i + 1]; if (value > rim) rim = value; }
                if (y > 0) { value = localLuma - luma[i - w]; if (value > rim) rim = value; }
                if (y + 1 < h) { value = localLuma - luma[i + w]; if (value > rim) rim = value; }
                var rimTerm = ss(0.01, 0.18, rim);

                var raw = 0.42 * luminanceTerm + 0.34 * contrastTerm + 0.16 * specularTerm + 0.16 * rimTerm;
                if (raw > 1) raw = 1;

                // 保护：白墙（亮且平）、肤色、暗部，三者概率式并集
                var dark = 1 - ss(0.008, 0.05, localLuma);
                var flatBright = ss(0.55, 0.88, localLuma) * (1 - ss(0.03, 0.20, absolute));
                var skinProtect = skinMask[i] / 255 * 0.9;
                var protection = 1 - (1 - dark) * (1 - flatBright) * (1 - skinProtect);
                protection = clamp01(protection * protectScale);

                luminanceMask[i] = luminanceTerm;
                darkMask[i] = dark;
                protectionMask[i] = protection;
                emissionMask[i] = raw;
                source[i] = raw * (1 - protection);
            }
        }

        return { source: source, width: w, height: h, masks: masks };
    }

    /* ============================================================
     * 5. 可分离盒式模糊 / 金字塔原语
     * ============================================================ */

    /** 水平盒式均值（边界按实际命中样本数归一，前缀和在 O(1) 内取窗） */
    function boxBlurH(src, dst, w, h, radius, prefix) {
        var r = radius < 1 ? 0 : Math.round(radius);
        var y, x, row, lo, hi, span;
        for (y = 0; y < h; y++) {
            row = y * w;
            prefix[0] = 0;
            for (x = 0; x < w; x++) prefix[x + 1] = prefix[x] + src[row + x];
            for (x = 0; x < w; x++) {
                lo = x - r;
                if (lo < 0) lo = 0;
                hi = x + r + 1;
                if (hi > w) hi = w;
                span = hi - lo;
                dst[row + x] = span > 0 ? (prefix[hi] - prefix[lo]) / span : 0;
            }
        }
    }

    /** 垂直盒式均值 */
    function boxBlurV(src, dst, w, h, radius, prefix) {
        var r = radius < 1 ? 0 : Math.round(radius);
        var x, y, lo, hi, span;
        for (x = 0; x < w; x++) {
            prefix[0] = 0;
            for (y = 0; y < h; y++) prefix[y + 1] = prefix[y] + src[y * w + x];
            for (y = 0; y < h; y++) {
                lo = y - r;
                if (lo < 0) lo = 0;
                hi = y + r + 1;
                if (hi > h) hi = h;
                span = hi - lo;
                dst[y * w + x] = span > 0 ? (prefix[hi] - prefix[lo]) / span : 0;
            }
        }
    }

    /** 双向盒式模糊，两次半径递减的遍历逼近高斯（图小，代价可忽略） */
    function blurBuffer(data, w, h, radius) {
        var tmp = new Float32Array(w * h);
        var prefixW = new Float64Array(w + 1);
        var prefixH = new Float64Array(h + 1);
        var r1 = radius < 1 ? 1 : Math.round(radius);
        var r2 = Math.max(1, Math.round(r1 * 0.6));
        boxBlurH(data, tmp, w, h, r1, prefixW);
        boxBlurV(tmp, data, w, h, r1, prefixH);
        boxBlurH(data, tmp, w, h, r2, prefixW);
        boxBlurV(tmp, data, w, h, r2, prefixH);
    }

    /** 5 抽头二项式平滑后二抽取，避免直接降采样产生锯齿与闪烁 */
    function downsample(src, sw, sh, dst, dw, dh) {
        var tmp = new Float32Array(dw * sh);
        var x, y, row, base;
        for (y = 0; y < sh; y++) {
            row = y * sw;
            for (x = 0; x < dw; x++) {
                base = x * 2;
                tmp[y * dw + x] = (
                    src[row + clampIndex(base - 2, sw)] +
                    4 * src[row + clampIndex(base - 1, sw)] +
                    6 * src[row + clampIndex(base, sw)] +
                    4 * src[row + clampIndex(base + 1, sw)] +
                    src[row + clampIndex(base + 2, sw)]
                ) * 0.0625;
            }
        }
        for (y = 0; y < dh; y++) {
            var r0 = clampIndex(y * 2 - 2, sh) * dw;
            var r1 = clampIndex(y * 2 - 1, sh) * dw;
            var r2 = clampIndex(y * 2, sh) * dw;
            var r3 = clampIndex(y * 2 + 1, sh) * dw;
            var r4 = clampIndex(y * 2 + 2, sh) * dw;
            var target = y * dw;
            for (x = 0; x < dw; x++) {
                dst[target + x] = (
                    tmp[r0 + x] + 4 * tmp[r1 + x] + 6 * tmp[r2 + x] + 4 * tmp[r3 + x] + tmp[r4 + x]
                ) * 0.0625;
            }
        }
    }

    /** 双线性放大到目标尺寸 */
    function upsampleBilinear(src, sw, sh, dst, dw, dh) {
        var xRatio = sw / dw;
        var yRatio = sh / dh;
        var x, y, sy, sx, y0, y1, x0, x1, fy, fx, row0, row1, top, bottom;
        for (y = 0; y < dh; y++) {
            sy = (y + 0.5) * yRatio - 0.5;
            if (sy < 0) sy = 0;
            if (sy > sh - 1) sy = sh - 1;
            y0 = sy | 0;
            y1 = y0 + 1 < sh ? y0 + 1 : sh - 1;
            fy = sy - y0;
            row0 = y0 * sw;
            row1 = y1 * sw;
            for (x = 0; x < dw; x++) {
                sx = (x + 0.5) * xRatio - 0.5;
                if (sx < 0) sx = 0;
                if (sx > sw - 1) sx = sw - 1;
                x0 = sx | 0;
                x1 = x0 + 1 < sw ? x0 + 1 : sw - 1;
                fx = sx - x0;
                top = src[row0 + x0] + (src[row0 + x1] - src[row0 + x0]) * fx;
                bottom = src[row1 + x0] + (src[row1 + x1] - src[row1 + x0]) * fx;
                dst[y * dw + x] = top + (bottom - top) * fy;
            }
        }
    }

    /**
     * 沿某角度的对称线性模糊：先把图旋转到水平、做一维盒式模糊、再旋转回来。
     * 结果写回 workA（workB 作为中间缓冲）。
     */
    function directionalBlur(src, w, h, angle, radius, workA, workB, prefix) {
        var cos = Math.cos(angle);
        var sin = Math.sin(angle);
        var cx = (w - 1) * 0.5;
        var cy = (h - 1) * 0.5;
        var x, y, dx, dy;
        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                dx = x - cx;
                dy = y - cy;
                workA[y * w + x] = sampleBilinear(src, w, h, cx + dx * cos + dy * sin, cy - dx * sin + dy * cos);
            }
        }
        boxBlurH(workA, workB, w, h, radius, prefix);
        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                dx = x - cx;
                dy = y - cy;
                workA[y * w + x] = sampleBilinear(workB, w, h, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
            }
        }
        return workA;
    }

    /** 选一个足够大又足够省的光学层：不超过 maxIndex，且短边不小于 minDimension */
    function pickOpticalLevel(levels, maxIndex, minDimension) {
        var index = 0;
        for (var k = 1; k < levels.length && k <= maxIndex; k++) {
            if (Math.min(levels[k].w, levels[k].h) < minDimension) break;
            index = k;
        }
        return index;
    }

    /* ============================================================
     * 6. 多尺度辉光（buildMultiScaleGlow）
     * ============================================================ */

    /**
     * 多尺度扩散。
     *
     * 流程：逐级平滑降采样建金字塔（4..7 级，随 radius 增加）→ 每级做可分离模糊
     * → 从最粗一级向上按「距离加权」累积（级 k 的等效全分辨率半径 = levelRadius * 2^k，
     * 越接近目标 radius 权重越高）→ 叠加紧致核心 → 可选星芒 / 横向拉丝 → 归一化 0..1。
     *
     * @param {Float32Array} source 长度 width*height 的发射强度
     * @param {number} width
     * @param {number} height
     * @param {Object} [params]
     * @param {{optical?:boolean}} [options] optical = false 时跳过星芒 / 拉丝（预览提速）
     * @returns {Float32Array}
     */
    function buildMultiScaleGlow(source, width, height, params, options) {
        var p = normalizeParams(params);
        var opts = options || {};
        var w = Math.max(1, Math.round(util.toNumber(width, 1)));
        var h = Math.max(1, Math.round(util.toNumber(height, 1)));
        var n = w * h;
        var out = new Float32Array(n);
        var i, k;

        var src = toFloatSource(source, n);

        // 强度：0 强度（被钳到 1）时增益约 0.005，配合「白墙不发光」几乎为零
        var gain = strengthScale(p.strength);

        /* ---- 金字塔 ---- */
        var radius = util.clamp(p.radius, RANGES.radius[0], RANGES.radius[1], DEFAULT_PARAMS.radius);
        var levelCount = util.clamp(4 + Math.floor(radius / 125), 4, 7);
        var levelRadius = util.clamp(Math.round(1 + radius * 0.05), 1, 10);

        var base = new Float32Array(n);
        for (i = 0; i < n; i++) {
            var raw = src[i];
            base[i] = raw > 0 ? (raw > 1 ? 1 : raw) : 0;
        }
        var levels = [{ w: w, h: h, data: base }];
        for (k = 1; k < levelCount; k++) {
            var prev = levels[k - 1];
            var dw = Math.max(1, prev.w >> 1);
            var dh = Math.max(1, prev.h >> 1);
            if (dw === prev.w && dh === prev.h) break;
            var next = new Float32Array(dw * dh);
            downsample(prev.data, prev.w, prev.h, next, dw, dh);
            levels.push({ w: dw, h: dh, data: next });
        }
        for (k = 0; k < levels.length; k++) {
            blurBuffer(levels[k].data, levels[k].w, levels[k].h, levelRadius);
        }

        /* ---- 距离加权：目标半径落在第几级（对数尺度） ---- */
        var targetLevel = Math.log(Math.max(1, radius) / levelRadius) / Math.LN2;
        var weights = [];
        var weightSum = 0;
        for (k = 0; k < levels.length; k++) {
            var distance = (k - targetLevel) / 1.2;
            var weight = Math.exp(-0.5 * distance * distance);
            weights.push(weight);
            weightSum += weight;
        }
        if (!(weightSum > 0)) weightSum = 1;

        /* ---- 自粗向细累积 ---- */
        var lastIndex = levels.length - 1;
        var accW = levels[lastIndex].w;
        var accH = levels[lastIndex].h;
        var acc = new Float32Array(accW * accH);
        var scale = weights[lastIndex] / weightSum;
        var lastData = levels[lastIndex].data;
        for (i = 0; i < acc.length; i++) acc[i] = lastData[i] * scale;

        for (k = lastIndex - 1; k >= 0; k--) {
            var level = levels[k];
            var size = level.w * level.h;
            var lifted = new Float32Array(size);
            upsampleBilinear(acc, accW, accH, lifted, level.w, level.h);
            var own = weights[k] / weightSum;
            var levelData = level.data;
            for (i = 0; i < size; i++) lifted[i] += levelData[i] * own;
            acc = lifted;
            accW = level.w;
            accH = level.h;
        }

        /* ---- 紧致核心 + 增益 + 归一化 ---- */
        var coreBoost = util.clamp(presetNumber(p, 'coreBoost', 0.25), 0, 0.9);
        var coreData = levels[0].data;
        for (i = 0; i < n; i++) {
            var value = (acc[i] * (1 - coreBoost) + coreData[i] * coreBoost) * gain;
            out[i] = clamp01(value);
        }

        /* ---- 光学特效 ---- */
        if (opts.optical !== false) {
            var rayGain = presetNumber(p, 'rayGain', 0);
            var streakGain = presetNumber(p, 'streakGain', 0);
            if (rayGain > 0 && p.starVisible > 0.5) addStarburst(out, w, h, p, levels, rayGain);
            if (streakGain > 0 && p.streakVisible > 0.5) addStreaks(out, w, h, p, levels, streakGain);
        }

        return out;
    }

    /** 星芒：在较粗的层上按 starCount 个角度做旋转线性模糊，再放大叠加 */
    function addStarburst(out, w, h, params, levels, rayGain) {
        var level = levels[pickOpticalLevel(levels, 3, 16)];
        var lw = level.w;
        var lh = level.h;
        var ln = lw * lh;
        var rays = new Float32Array(ln);
        var workA = new Float32Array(ln);
        var workB = new Float32Array(ln);
        var prefix = new Float64Array(lw + 1);
        var count = Math.max(2, Math.round(params.starCount));
        var baseAngle = params.starRotation * Math.PI / 180;
        // starLength 是全分辨率像素长度，折算到当前层；0.5 使其成为「半长」
        var radius = Math.max(1, Math.round(params.starLength * 0.5 * (lw / w)));
        var r, i;

        for (r = 0; r < count; r++) {
            var angle = baseAngle + (r * Math.PI * 2) / count;
            directionalBlur(level.data, lw, lh, -angle, radius, workA, workB, prefix);
            for (i = 0; i < ln; i++) rays[i] += workA[i] / count;
        }

        var lifted = new Float32Array(w * h);
        upsampleBilinear(rays, lw, lh, lifted, w, h);
        var amount = (params.starVisible / 100) * rayGain;
        for (i = 0; i < out.length; i++) out[i] = clamp01(out[i] + lifted[i] * amount);
    }

    /** 变形宽银幕：粗层上做长距离水平一维模糊，放大后叠加（纵向因缩放自然柔化） */
    function addStreaks(out, w, h, params, levels, streakGain) {
        var level = levels[pickOpticalLevel(levels, 2, 12)];
        var lw = level.w;
        var lh = level.h;
        var work = new Float32Array(lw * lh);
        var prefix = new Float64Array(lw + 1);
        var radius = Math.max(1, Math.round(params.streakLength * (lw / w)));

        boxBlurH(level.data, work, lw, lh, radius, prefix);

        var lifted = new Float32Array(w * h);
        upsampleBilinear(work, lw, lh, lifted, w, h);
        var amount = (params.streakVisible / 100) * streakGain;
        for (var i = 0; i < out.length; i++) out[i] = clamp01(out[i] + lifted[i] * amount);
    }

    /* ============================================================
     * 7. 混合与图层输出
     * ============================================================ */

    /**
     * 屏幕混合：out = 1 − (1 − base) × (1 − glow)，逐元素，长度以 base 为准。
     * 两端都钳制在 0..1，保证结果既不小于 base 也不超过 1。
     */
    function screenBlend(base, glow) {
        var length = base && base.length ? base.length : 0;
        var out = new Float32Array(length);
        var glowLength = glow && glow.length ? glow.length : 0;
        for (var i = 0; i < length; i++) {
            var b = clamp01(base[i]);
            var g = i < glowLength ? clamp01(glow[i]) : 0;
            out[i] = 1 - (1 - b) * (1 - g);
        }
        return out;
    }

    /** 由 colorHex + saturation + colorShift + colorAmount 求出图层染色 */
    function resolveTint(params) {
        var base = hexToRgb(params.colorHex, DEFAULT_COLOR_HEX);
        var hsl = rgbToHsl(base[0], base[1], base[2]);
        var hue = hsl[0] + util.toNumber(params.colorShift, 0);
        var saturation = util.clamp(hsl[1] * (1 + util.toNumber(params.saturation, 0) / 100), 0, 1);
        // 染色光要保持明亮，暗色 hex 会被抬到可用的明度区间
        var lightness = util.clamp(hsl[2], 0.55, 0.92, 0.75);
        var tinted = hslToRgb(hue, saturation, lightness);
        var amount = clamp01(util.clamp(params.colorAmount, 0, 100, 0) / 100);
        return [
            1 + (tinted[0] - 1) * amount,
            1 + (tinted[1] - 1) * amount,
            1 + (tinted[2] - 1) * amount
        ];
    }

    function toneMap(value) {
        if (!(value > 0)) return 0;
        if (value >= 1) return TONE_LUT[255];
        return TONE_LUT[(value * 255) | 0];
    }

    /**
     * 把 Float32 辉光转成可写入 Photoshop 的屏幕混合图层。
     * alpha 恒为 255（屏幕模式下黑色即「无贡献」）；未染色时是纯白辉光。
     *
     * @param {Float32Array} glow 0..1
     * @param {Object} params
     * @param {number} width
     * @param {number} height
     * @returns {{data:Uint8ClampedArray, width:number, height:number, glow:Float32Array}}
     */
    function renderGlowLayer(glow, params, width, height) {
        var p = normalizeParams(params);
        var w = Math.max(1, Math.round(util.toNumber(width, 1)));
        var h = Math.max(1, Math.round(util.toNumber(height, 1)));
        var n = w * h;
        var src = toFloatSource(glow, n);
        var data = new Uint8ClampedArray(n * 4);
        var tint = resolveTint(p);
        var bias = util.clamp(p.brightnessBias, -100, 100, 0) / 100 * 0.3;
        var fringe = util.clamp(p.chromatic, 0, 100, 0) / 100 * 3;   // 最大 3 像素的径向色散
        var centerX = (w - 1) * 0.5;
        var centerY = (h - 1) * 0.5;
        var normX = centerX > 0.5 ? centerX : 1;
        var normY = centerY > 0.5 ? centerY : 1;
        var i, o, x, y, g, red, green, blue, dx, dy;

        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                i = y * w + x;
                o = i * 4;
                g = src[i];
                data[o + 3] = 255;
                if (!(g > 0.0005)) continue;   // 无辉光 → 纯黑像素，屏幕混合时无影响
                if (g > 1) g = 1;

                if (fringe > 0.02) {
                    // 色散：红 / 蓝通道沿半径方向反向偏移
                    dx = (x - centerX) / normX;
                    dy = (y - centerY) / normY;
                    red = sampleBilinear(src, w, h, x + dx * fringe, y + dy * fringe);
                    green = g;
                    blue = sampleBilinear(src, w, h, x - dx * fringe, y - dy * fringe);
                } else {
                    red = green = blue = g;
                }

                var biasTerm = 1 - clamp01(red);
                data[o] = toneMap(red + bias * biasTerm) * tint[0] * 255;
                biasTerm = 1 - clamp01(green);
                data[o + 1] = toneMap(green + bias * biasTerm) * tint[1] * 255;
                biasTerm = 1 - clamp01(blue);
                data[o + 2] = toneMap(blue + bias * biasTerm) * tint[2] * 255;
            }
        }

        return { data: data, width: w, height: h, glow: src };
    }

    /**
     * 受保护的预览合成：线性光下屏幕混合，保留基图 alpha，
     * 基图已经很亮时减少辉光注入，最后过一个软肩保住高光层次。
     * 通道数与输入一致（3 → RGB，4 → RGBA）。
     */
    function composeProtected(baseImage, glow, params) {
        var p = normalizeParams(params);
        var info = readImage(baseImage);
        var w = info.width;
        var h = info.height;
        var ch = info.channels;
        var n = w * h;
        var data = info.data;
        var out = new Uint8ClampedArray(n * ch);
        var g = toFloatSource(glow, n);
        var hasColor = ch >= 3;
        // 高光保护强度跟随预设（protection 越大越保守）
        var guardAmount = util.clamp(0.55 * presetNumber(p, 'protection', 1), 0.2, 0.8);
        var i, o, r, green, blue, peak, guard, inject;

        if (data && !(data instanceof Uint8Array) && typeof data.length === 'number') {
            var converted = new Uint8ClampedArray(data.length);
            for (var ci = 0; ci < data.length; ci++) converted[ci] = util.toNumber(data[ci], 0);
            data = converted;
        }
        if (!data || typeof data.length !== 'number' || data.length < n) {
            return { data: out, width: w, height: h, channels: ch };
        }

        for (i = 0; i < n; i++) {
            o = i * ch;
            inject = clamp01(g[i]);
            if (hasColor) {
                r = SRGB_TO_LINEAR[clampIndex(data[o], 256)];
                green = SRGB_TO_LINEAR[clampIndex(data[o + 1], 256)];
                blue = SRGB_TO_LINEAR[clampIndex(data[o + 2], 256)];
            } else {
                r = green = blue = SRGB_TO_LINEAR[clampIndex(data[o], 256)];
            }
            // 高光保护：基图接近过曝时明显降低注入量
            peak = r > green ? r : green;
            if (blue > peak) peak = blue;
            guard = 1 - ss(0.72, 0.98, peak) * guardAmount;
            inject *= guard;

            if (hasColor) {
                out[o] = linearToSrgb(softShoulder(1 - (1 - r) * (1 - inject)));
                out[o + 1] = linearToSrgb(softShoulder(1 - (1 - green) * (1 - inject)));
                out[o + 2] = linearToSrgb(softShoulder(1 - (1 - blue) * (1 - inject)));
                if (ch === 4) out[o + 3] = data[o + 3];
            } else {
                out[o] = linearToSrgb(softShoulder(1 - (1 - r) * (1 - inject)));
                if (ch === 2) out[o + 1] = data[o + 1];
            }
        }

        return { data: out, width: w, height: h, channels: ch };
    }

    /**
     * 便捷入口：解析 → 多尺度辉光 → 受保护合成。
     *
     * @param {{data:*, width:number, height:number, channels:number}} baseImage
     * @param {Object} [uiParams]
     * @param {{isPreview?:boolean}} [options] isPreview = true 时跳过星芒 / 拉丝以提速
     * @returns {{preview:{data:Uint8ClampedArray,width:number,height:number,channels:number},
     *            glow:Float32Array, params:Object}}
     */
    function preview(baseImage, uiParams, options) {
        var opts = options || {};
        var p = normalizeParams(uiParams);
        var built = buildSource(baseImage, p);
        var glow = buildMultiScaleGlow(built.source, built.width, built.height, p, {
            optical: opts.isPreview !== true
        });
        var composed = composeProtected(baseImage, glow, p);
        return { preview: composed, glow: glow, params: p };
    }

    /* ============================================================
     * 8. 导出
     * ============================================================ */

    DreamAI.GlowCore = {
        STYLES: STYLES,
        PRESETS: PRESETS,
        RANGES: RANGES,
        TRIGGER_MODES: TRIGGER_MODES,
        DEFAULT_PARAMS: DEFAULT_PARAMS,
        normalizeParams: normalizeParams,
        buildSource: buildSource,
        buildMultiScaleGlow: buildMultiScaleGlow,
        screenBlend: screenBlend,
        renderGlowLayer: renderGlowLayer,
        composeProtected: composeProtected,
        preview: preview,
        // 以下为算法内部复用的小工具，UI 需要画色块 / 预览时可直接调用
        strengthScale: strengthScale,
        hexToRgb: hexToRgb,
        srgbToLinear: srgbToLinear,
        linearToSrgb: linearToSrgb
    };
})(typeof window !== 'undefined' ? window : this);
