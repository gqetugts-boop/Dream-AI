/*
 * tools/glow.js — 辉光面板（UI 层）
 *
 * 职责：
 *   1. 用 ui/widgets.js 的控件工厂搭出辉光编辑器：风格、调音滑块、光学子卡、
 *      色板、预览、写入文档；
 *   2. 把控件值归一化成 GlowCore 认得的参数对象（一律经 GlowCore.normalizeParams，
 *      保证「切风格 → 重载该风格预设」与内核行为完全一致）；
 *   3. 读取选区 → 解码成 ImageData → GlowCore.preview() → 画进预览画布，
 *      并把最后一次的辉光 Float32Array 留住，供写入时复用；
 *   4. 写入时把辉光转成 RGBA（GlowCore.renderGlowLayer）→ PNG data URL
 *      → DreamAI.PhotoReturn.place(..., { blendMode: 'screen' })。
 *
 * 输入：buildPanel(ctx)，ctx = { W, getSelection(), readSelection(), toast(), status() }。
 * 输出：{ el, dispose?, refresh? }，el 为可直接插入页面容器的节点。
 * 边界：
 *   - 本文件不含任何算法：像素运算全部在 tools/glow-core.js；
 *   - 不新建 <style>：只用既有 class + 少量内联 style（本面板会被插进页面里）；
 *   - PhotoIO / PhotoReturn / PhotoEncode 缺失（浏览器预览）时降级为只读提示，
 *     只禁用按钮，绝不抛错；
 *   - 所有面向用户的文案都走 DreamAI.I18n.t(key)，文件头尾不允许出现硬编码文案。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};

    // 幂等保护：重复加载不覆盖已存在的实例
    if (DreamAI.GlowTool) return;

    var util = DreamAI.util;

    /* ============================================================
     * 0. 常量与降级兜底
     * ============================================================ */

    // 面板依赖的 Store 域（见 CONTRACT.md 第 6 节）
    var STORE_DOMAIN = 'tools.glow';

    // 内核缺失时用的兜底值；正常情况下全部以内核导出的为准
    var FALLBACK_STYLES = ['whiteSoft', 'shine', 'starburst', 'anamorphic', 'darkSoft'];
    var FALLBACK_RANGES = {
        strength: [1, 100], radius: [1, 500], threshold: [0, 100],
        saturation: [-100, 100], brightnessBias: [-100, 100], colorShift: [-180, 180],
        starLength: [10, 220], starCount: [4, 12], starRotation: [-90, 90], starVisible: [0, 100],
        streakLength: [16, 300], streakVisible: [0, 100], chromatic: [0, 100], colorAmount: [0, 100]
    };
    var FALLBACK_PARAMS = {
        style: 'whiteSoft', strength: 47, radius: 81, threshold: 81, saturation: 0,
        brightnessBias: 0, colorShift: 0, starLength: 58, starCount: 6, starRotation: 0,
        starVisible: 68, streakLength: 86, streakVisible: 62, chromatic: 0, colorAmount: 0,
        colorHex: '#ffd27a'
    };

    /** 全局滑块（两列栅格） */
    var CORE_SLIDERS = [
        { key: 'strength', labelKey: 'tools.glow.strength' },
        { key: 'radius', labelKey: 'tools.glow.radius' },
        { key: 'threshold', labelKey: 'tools.glow.threshold' },
        { key: 'saturation', labelKey: 'tools.glow.saturation' },
        { key: 'brightnessBias', labelKey: 'tools.glow.brightnessBias' },
        { key: 'colorShift', labelKey: 'tools.glow.colorShift' }
    ];

    /** 光学子卡里的滑块（starburst / anamorphic 才真正参与计算） */
    var OPTICAL_SLIDERS = [
        { key: 'starLength', labelKey: 'tools.glow.starLength' },
        { key: 'starCount', labelKey: 'tools.glow.starCount' },
        { key: 'starRotation', labelKey: 'tools.glow.starRotation' },
        { key: 'starVisible', labelKey: 'tools.glow.starVisible' },
        { key: 'streakLength', labelKey: 'tools.glow.streakLength' },
        { key: 'streakVisible', labelKey: 'tools.glow.streakVisible' },
        { key: 'chromatic', labelKey: 'tools.glow.chromatic' }
    ];

    /* ============================================================
     * 1. 小工具（不依赖内核与 DOM，纯函数）
     * ============================================================ */

    function log(level, message, meta) {
        try {
            var bus = DreamAI.logbus;
            if (bus && typeof bus[level] === 'function') bus[level](message, meta || { domain: 'glow' });
        } catch (error) { /* 日志失败不能影响面板 */ }
    }

    /** 内核参数区间；内核缺失时用兜底表 */
    function rangeOf(key) {
        var core = DreamAI.GlowCore;
        if (core && core.RANGES && core.RANGES[key]) return core.RANGES[key];
        if (FALLBACK_RANGES[key]) return FALLBACK_RANGES[key];
        return [0, 100];
    }

    function defaultOf(key) {
        var core = DreamAI.GlowCore;
        var source = (core && core.DEFAULT_PARAMS) ? core.DEFAULT_PARAMS : FALLBACK_PARAMS;
        return source[key];
    }

    /** 风格清单：用内核的 STYLES，图标文字与显示名各自 i18n */
    function styleList() {
        var core = DreamAI.GlowCore;
        var ids = (core && core.STYLES && core.STYLES.length) ? core.STYLES : FALLBACK_STYLES;
        var out = [];
        for (var i = 0; i < ids.length; i++) {
            var preset = core && core.PRESETS ? core.PRESETS[ids[i]] : null;
            out.push({
                id: ids[i],
                labelKey: (preset && preset.labelKey) ? preset.labelKey : ('tools.glow.preset.' + ids[i])
            });
        }
        return out;
    }

    /**
     * 归一化参数。能拿到内核时一律走内核的 normalizeParams，
     * 这样「只给 { style: 'x' } 时补齐该风格全部预设值」的行为与算法层完全一致。
     */
    function normalizeParams(raw) {
        var core = DreamAI.GlowCore;
        if (core && typeof core.normalizeParams === 'function') return core.normalizeParams(raw);
        var out = { style: FALLBACK_PARAMS.style };
        var keys = Object.keys(FALLBACK_RANGES);
        for (var i = 0; i < keys.length; i++) {
            out[keys[i]] = util.clamp(raw ? raw[keys[i]] : undefined, FALLBACK_RANGES[keys[i]][0], FALLBACK_RANGES[keys[i]][1], defaultOf(keys[i]));
        }
        out.starCount = Math.round(out.starCount);
        out.colorHex = (raw && raw.colorHex) ? String(raw.colorHex) : FALLBACK_PARAMS.colorHex;
        return out;
    }

    /** 该风格是否启用光学特效（星芒 / 拉丝），驱动子卡的禁用态 */
    function styleUsesOptics(styleId) {
        var core = DreamAI.GlowCore;
        if (!core || typeof core.normalizeParams !== 'function') return true;
        var preset = core.normalizeParams({ style: styleId }).preset || {};
        return util.toNumber(preset.rayGain, 0) > 0 || util.toNumber(preset.streakGain, 0) > 0;
    }

    /** 读 Store，任何异常都退化成默认值（浏览器预览下 Store 可能缺席） */
    function readStore() {
        try {
            if (DreamAI.Store && typeof DreamAI.Store.read === 'function') return DreamAI.Store.read(STORE_DOMAIN, {});
        } catch (error) {
            log('warn', '读取 tools.glow 失败：' + (error && error.message), { domain: 'glow' });
        }
        return {};
    }

    function writeStore(patch) {
        try {
            if (DreamAI.Store && typeof DreamAI.Store.write === 'function') DreamAI.Store.write(STORE_DOMAIN, patch, {});
        } catch (error) {
            log('warn', '写入 tools.glow 失败：' + (error && error.message), { domain: 'glow' });
        }
    }

    /* ============================================================
     * 2. 宿主能力：选区读取、图像解码、PNG 编码、回写
     * ============================================================ */

    /** 装饰一个 canvas：统一尺寸与无障碍属性 */
    function decorateCanvas(canvas, width, height, label) {
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.style.display = 'block';
        canvas.setAttribute('role', 'img');
        if (label) canvas.setAttribute('aria-label', label);
        return canvas;
    }

    /**
     * 把 RGBA 缓冲区画进一个新 canvas。
     * @returns {HTMLCanvasElement|null} 无 canvas 2D 能力时返回 null（调用方给本地化报错）
     */
    function paintCanvas(rgba, width, height, label) {
        try {
            if (typeof global.document === 'undefined' || !global.document.createElement) return null;
            var canvas = global.document.createElement('canvas');
            if (!canvas || typeof canvas.getContext !== 'function') return null;
            var ctx2d = canvas.getContext('2d');
            if (!ctx2d) return null;
            decorateCanvas(canvas, width, height, label);
            if (typeof global.ImageData === 'function') {
                ctx2d.putImageData(new global.ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height), 0, 0);
            } else {
                // 退路：手工构造 {data,width,height} 再交给 putImageData
                ctx2d.putImageData({ data: new Uint8ClampedArray(rgba), width: canvas.width, height: canvas.height }, 0, 0);
            }
            return canvas;
        } catch (error) {
            log('warn', '预览绘制失败：' + (error && error.message), { domain: 'glow' });
            return null;
        }
    }

    /** 画布 2D 能力探测（UXP 的 canvas 实现因版本而异，必须先探再用） */
    function canvasSupported() {
        try {
            if (typeof global.document === 'undefined' || !global.document.createElement) return false;
            var probe = global.document.createElement('canvas');
            if (!probe || typeof probe.getContext !== 'function') return false;
            return !!probe.getContext('2d');
        } catch (error) {
            return false;
        }
    }

    /** data URL → ImageData（Image 解码 + canvas 取像素），返回 Promise */
    function decodeImageData(dataUrl) {
        return new Promise(function (resolve, reject) {
            if (!dataUrl) {
                reject(new Error(DreamAI.I18n.t('tools.glow.decodeFailed')));
                return;
            }
            if (!canvasSupported()) {
                reject(new Error(DreamAI.I18n.t('tools.glow.noCanvas')));
                return;
            }
            var image = new global.Image();
            image.onload = function () {
                try {
                    var width = Math.max(1, image.naturalWidth || image.width || 1);
                    var height = Math.max(1, image.naturalHeight || image.height || 1);
                    var canvas = global.document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    var ctx2d = canvas.getContext('2d');
                    ctx2d.drawImage(image, 0, 0, width, height);
                    var got = ctx2d.getImageData(0, 0, width, height);
                    resolve({ data: got.data, width: got.width, height: got.height, channels: 4 });
                } catch (error) {
                    reject(new Error(DreamAI.I18n.t('tools.glow.decodeFailed')));
                }
            };
            image.onerror = function () {
                reject(new Error(DreamAI.I18n.t('tools.glow.decodeFailed')));
            };
            image.src = dataUrl;
        });
    }

    /** RGBA 缓冲区 → PNG data URL（走项目的 PhotoEncode，不依赖宿主） */
    function encodePngDataUrl(rgba, width, height) {
        return new Promise(function (resolve, reject) {
            var encode = DreamAI.PhotoEncode;
            if (!encode || typeof encode.encodePng !== 'function') {
                reject(new Error(DreamAI.I18n.t('tools.glow.noEncoder')));
                return;
            }
            try {
                var png = encode.encodePng({ data: rgba, width: width, height: height, channels: 4 });
                var base64 = util.arrayBufferToBase64(png);
                resolve(util.base64ToDataUrl(base64, 'image/png'));
            } catch (error) {
                reject(new Error(DreamAI.I18n.t('tools.glow.encodeFailed')));
            }
        });
    }

    /* ============================================================
     * 3. 面板
     * ============================================================ */

    /**
     * 构建辉光面板。
     * @param {{W?:Object, getSelection?:Function, readSelection?:Function,
     *          toast?:Function, status?:Function}} [panelCtx]
     * @returns {{el:HTMLElement, dispose:Function, refresh:Function}|null}
     */
    function buildPanel(panelCtx) {
        var ctx = panelCtx || {};
        var W = ctx.W || DreamAI.Widgets;
        if (!W) {
            log('error', '控件工厂缺席，辉光面板无法构建', { domain: 'glow' });
            return null;
        }
        try {
            return build(ctx, W);
        } catch (error) {
            // 构建失败绝不允许冒泡到页面：返回一个只含错误提示的降级面板
            log('error', '辉光面板构建失败：' + (error && error.message), { domain: 'glow' });
            return {
                el: util.el('div', { class: 'tool-panel' }, [W.hint('tools.glow.buildFailed', 'error')]),
                dispose: function () {},
                refresh: function () {}
            };
        }
    }

    function build(ctx, W) {
        var el = util.el;
        var t = function (key, params) { return DreamAI.I18n.t(key, params || {}); };

        // 面板级反馈：ctx 提供就用 ctx，否则回落到 Shell
        function toast(textOrKey, options) {
            try {
                if (typeof ctx.toast === 'function') { ctx.toast(textOrKey, options || {}); return; }
                if (DreamAI.Shell && DreamAI.Shell.toast) DreamAI.Shell.toast(textOrKey, options || {});
            } catch (error) {
                log('warn', 'toast 失败：' + (error && error.message), { domain: 'glow' });
            }
        }

        function status(textOrKey, options) {
            try {
                if (typeof ctx.status === 'function') { ctx.status(textOrKey, options || {}); return; }
                if (DreamAI.Shell && DreamAI.Shell.status) DreamAI.Shell.status(textOrKey, options || {});
            } catch (error) {
                log('warn', 'status 失败：' + (error && error.message), { domain: 'glow' });
            }
        }

        /* ---------- 3.1 状态 ---------- */

        var stored = readStore();
        var state = {
            params: normalizeParams(stored && stored.params ? stored.params : {}),
            selection: null,
            glow: null,          // 最近一次计算的辉光（Float32Array）
            width: 0,            // 与 glow 对应的像素尺寸
            height: 0,
            busy: false
        };
        var busyLabelKey = 'tools.glow.preview';

        function persist() {
            writeStore({ params: state.params, updatedAt: Date.now ? Date.now() : 0 });
        }

        /** 改一个参数：先合并再整体归一化，保证派生量（颜色、风格预设）同步 */
        function setParams(patch) {
            var next = {};
            var key;
            for (key in state.params) if (Object.prototype.hasOwnProperty.call(state.params, key)) next[key] = state.params[key];
            for (key in patch) if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
            applyNormalized(next);
        }

        /**
         * 切换风格：GlowCore.normalizeParams 只在「UI 没给值时」才回落到预设，
         * 所以想真正载入某风格的调音值，必须显式只传 { style } 再取归一化结果。
         */
        function loadStyle(styleId) {
            applyNormalized(normalizeParams({ style: styleId }));
        }

        function applyNormalized(next) {
            state.params = normalizeParams(next);
            // 参数变了，旧辉光不再对应当前设置，必须重算后才能写入
            state.glow = null;
            syncWriteEnabled();
        }

        /* ---------- 3.2 控件 ---------- */

        var sliderNodes = [];
        var chipNodes = [];

        function makeSlider(spec) {
            var range = rangeOf(spec.key);
            var node = W.slider({
                labelKey: spec.labelKey,
                min: range[0],
                max: range[1],
                step: 1,
                value: util.toNumber(state.params[spec.key], defaultOf(spec.key)),
                onInput: function (value) {
                    applyParamQuiet(spec.key, util.clamp(value, range[0], range[1], defaultOf(spec.key)));
                    persistSoon();
                }
            });
            sliderNodes.push({ key: spec.key, node: node });
            return node;
        }

        function makeParamGrid(specs) {
            var cells = [];
            for (var i = 0; i < specs.length; i++) {
                var field = W.field(specs[i].labelKey, makeSlider(specs[i]));
                field.className = 'param-cell';
                cells.push(field);
            }
            return el('div', { class: 'param-grid' }, cells);
        }

        var coreGrid = makeParamGrid(CORE_SLIDERS);
        var opticalGrid = makeParamGrid(OPTICAL_SLIDERS);

        var styleChips = W.chipGroup(styleList().map(function (item) {
            return { value: item.id, labelKey: item.labelKey };
        }), state.params.style, function (value) {
            loadStyle(value);
            syncFromParams();
            persist();
            toast('tools.glow.styleApplied', { tone: 'info' });
        });
        chipNodes.push(styleChips);

        var colorPicker = W.colorPicker({
            value: state.params.colorHex,
            onChange: function (hex) {
                applyParam('colorHex', hex);
                persistSoon();
            }
        });
        var colorField = W.field('tools.glow.colorHex', colorPicker, 'tools.glow.colorHint');

        var colorAmountField = W.field('tools.glow.colorAmount', makeSlider({ key: 'colorAmount', labelKey: 'tools.glow.colorAmount' }));
        colorAmountField.className = 'param-cell';

        // 光学子卡：星芒 / 拉丝 / 色散
        var opticalCard = W.card('tools.glow.optical', { collapsed: true, subtitleKey: 'tools.glow.opticalHint' });
        opticalCard.cardBody.appendChild(el('div', { class: 'stack' }, [
            opticalGrid,
            el('div', { class: 'inline' }, [
                W.hint('tools.glow.starHint', 'plain'),
                W.hint('tools.glow.streakHint', 'plain')
            ]),
            el('div', { class: 'param-grid' }, [colorAmountField]),
            colorField
        ]));

        // 预览：decode → core.preview → 画布
        var previewFrame = W.previewFrame({ placeholderKey: 'tools.previewEmpty' });

        var previewBtn = W.button('tools.glow.preview', {
            variant: 'primary',
            size: 'lg',
            glyph: '◆',
            block: true,
            onClick: function () { runPreview(); }
        });

        var writeBtn = W.button('tools.glow.write', {
            variant: 'ghost',
            size: 'lg',
            glyph: '⇩',
            block: true,
            disabled: true,
            onClick: function () { runWrite(); }
        });

        var resetBtn = W.button('tools.glow.reset', {
            variant: 'quiet',
            size: 'sm',
            glyph: '↺',
            onClick: function () { runReset(); }
        });

        var envHint = W.hint('tools.glow.browserOnly', 'warn');
        envHint.setAttribute('hidden', '');

        var selectionState = el('div', { class: 'field-hint muted', text: t('tools.needSelection'), 'data-i18n': 'tools.needSelection' });

        var styleField = el('div', { class: 'field' }, [
            el('div', { class: 'field-label', text: t('tools.glow.style'), 'data-i18n': 'tools.glow.style' }),
            styleChips
        ]);

        /* ---------- 3.3 装配 ---------- */

        var panel = el('div', { class: 'tool-panel' }, [
            styleField,
            selectionState,
            envHint,
            coreGrid,
            opticalCard,
            W.divider(),
            previewFrame,
            W.hint('tools.glow.screenHint', 'info'),
            el('div', { class: 'action-bar' }, [
                el('div', { class: 'action-bar-main' }, [previewBtn]),
                writeBtn
            ]),
            el('div', { class: 'btn-row btn-row-end' }, [resetBtn])
        ]);

        /* ---------- 3.4 同步逻辑 ---------- */

        function applyParam(key, value) {
            var patch = {};
            patch[key] = value;
            setParams(patch);
            syncFromParams();
        }

        /** 滑块拖拽路径：控件自己已经显示新值，但色板可用性仍要跟着染色量走 */
        function applyParamQuiet(key, value) {
            var patch = {};
            patch[key] = value;
            setParams(patch);
            if (key === 'colorAmount') syncStyleDependent(state.params);
        }

        /** 把 state.params 推回所有控件（silent，不触发回调） */
        function syncFromParams() {
            var i;
            for (i = 0; i < sliderNodes.length; i++) {
                var entry = sliderNodes[i];
                entry.node.setValue(util.toNumber(state.params[entry.key], defaultOf(entry.key)), true);
            }
            for (i = 0; i < chipNodes.length; i++) {
                if (typeof chipNodes[i].setValue === 'function') chipNodes[i].setValue(state.params.style);
            }
            if (colorPicker && typeof colorPicker.setValue === 'function') colorPicker.setValue(state.params.colorHex);
            syncStyleUi();
            syncWriteEnabled();
        }

        /** 风格相关的可用性：光学子卡与色板 */
        function syncStyleDependent(params) {
            var p = params || state.params;
            // W.colorPicker 在构造时就会回调一次（widgets.js 末尾直接 emit），
            // 那一刻色板节点还没赋值，必须容忍未装配状态。
            if (!colorField) return;
            var opticalOn = styleUsesOptics(p.style);
            opticalCard.setAttribute('data-disabled', opticalOn ? 'false' : 'true');
            opticalCard.style.opacity = opticalOn ? '1' : '0.55';
            var controls = opticalCard.querySelectorAll ? opticalCard.querySelectorAll('button, input, [role="slider"]') : [];
            for (var i = 0; i < controls.length; i++) {
                controls[i].style.pointerEvents = opticalOn ? '' : 'none';
                if (opticalOn) controls[i].removeAttribute('aria-disabled');
                else controls[i].setAttribute('aria-disabled', 'true');
            }
            // 染色量为 0 时色板不参与计算（与内核 resolveTint 一致）
            var tintOn = util.toNumber(p.colorAmount, 0) > 0;
            colorField.style.opacity = tintOn ? '1' : '0.55';
            colorField.setAttribute('data-disabled', tintOn ? 'false' : 'true');
            var tintControls = colorField.querySelectorAll ? colorField.querySelectorAll('button, input, [role="slider"], .range-track') : [];
            for (var j = 0; j < tintControls.length; j++) {
                tintControls[j].style.pointerEvents = tintOn ? '' : 'none';
            }
        }

        function syncStyleUi() {
            syncStyleDependent(state.params);
        }

        /** 没有预览结果就没有东西可写 */
        function syncWriteEnabled() {
            if (!writeBtn) return;   // 控件尚未装配完成（构造期的回调）时直接跳过
            var canWrite = !!state.glow && !state.busy && !!(DreamAI.PhotoReturn && typeof DreamAI.PhotoReturn.place === 'function');
            if (canWrite) writeBtn.removeAttribute('disabled');
            else writeBtn.setAttribute('disabled', '');
        }

        /** 选区状态行：没选区时提示 tools.needSelection */
        function syncSelectionUi(selection) {
            state.selection = selection || null;
            if (selection) {
                selectionState.removeAttribute('data-i18n');
                selectionState.textContent = t('selection.info', { w: selection.width, h: selection.height });
                selectionState.className = 'field-hint muted';
            } else {
                selectionState.setAttribute('data-i18n', 'tools.needSelection');
                selectionState.textContent = t('tools.needSelection');
                selectionState.className = 'field-hint muted';
            }
        }

        /** 忙碌态：按钮文案 + 禁用，防止重复触发重算法 */
        function setBusy(on, labelKey) {
            state.busy = !!on;
            busyLabelKey = labelKey || 'tools.glow.preview';
            var showLabel = state.busy ? busyLabelKey : 'tools.glow.preview';
            previewBtn.lastChild.textContent = t(showLabel);
            previewBtn.lastChild.setAttribute('data-i18n', showLabel);
            if (state.busy) {
                previewBtn.setAttribute('disabled', '');
                writeBtn.setAttribute('disabled', '');
            } else {
                previewBtn.removeAttribute('disabled');
                syncWriteEnabled();
            }
        }

        var persistTimer = null;
        function persistSoon() {
            if (persistTimer) clearTimeout(persistTimer);
            persistTimer = setTimeout(function () {
                persistTimer = null;
                persist();
            }, 250);
        }

        /* ---------- 3.5 选区与能力探测 ---------- */

        function readStoredSelection() {
            if (typeof ctx.readSelection === 'function') {
                try {
                    var sync = ctx.readSelection();
                    if (sync && typeof sync.then === 'function') return sync;
                    if (sync) return Promise.resolve(sync);
                } catch (error) {
                    log('warn', 'ctx.readSelection 失败，改用 getSelection：' + (error && error.message), { domain: 'glow' });
                }
            }
            if (typeof ctx.getSelection === 'function') {
                try {
                    var fromCtx = ctx.getSelection();
                    if (fromCtx && typeof fromCtx.then === 'function') return fromCtx;
                    if (fromCtx) return Promise.resolve(fromCtx);
                } catch (error) {
                    log('warn', 'ctx.getSelection 失败：' + (error && error.message), { domain: 'glow' });
                }
            }
            if (DreamAI.App && DreamAI.App.selection) return Promise.resolve(DreamAI.App.selection);
            return Promise.resolve(null);
        }

        /** 当前是否具备「读选区 + 回写」的宿主能力 */
        function hostReady() {
            var io = DreamAI.PhotoIO;
            var ret = DreamAI.PhotoReturn;
            return !!(io && typeof io.isAvailable === 'function' && io.isAvailable() &&
                ret && typeof ret.place === 'function');
        }

        function syncEnvHint() {
            if (hostReady()) {
                envHint.setAttribute('hidden', '');
                return false;
            }
            envHint.removeAttribute('hidden');
            setBusy(false);
            writeBtn.setAttribute('disabled', '');
            return true;
        }

        /* ---------- 3.6 预览 ---------- */

        function runPreview() {
            if (state.busy) return;
            if (syncEnvHint()) {
                toast('tools.glow.browserOnly', { tone: 'warn' });
                return;
            }
            if (!canvasSupported()) {
                toast('tools.glow.noCanvas', { tone: 'error' });
                return;
            }
            if (!DreamAI.GlowCore || typeof DreamAI.GlowCore.preview !== 'function') {
                toast('tools.glow.noCore', { tone: 'error' });
                return;
            }
            // 先让按钮进入忙碌态（同步算法会把主线程占满，之后才有机会重绘）
            setBusy(true, 'tools.glow.previewing');
            status('tools.glow.previewing', { key: 'tools.glow.previewing', tone: 'busy' });

            readStoredSelection().then(function (selection) {
                if (!selection || !selection.dataUrl) {
                    syncSelectionUi(null);
                    toast('tools.needSelection', { tone: 'warn' });
                    status('tools.needSelection', { key: 'tools.needSelection', tone: 'warn', autoClear: 2600 });
                    setBusy(false);
                    return null;
                }
                syncSelectionUi(selection);
                return decodeImageData(selection.dataUrl).then(function (imageData) {
                    // setTimeout 0：把同步算法排到下一帧，先让「计算中…」渲染出来
                    return new Promise(function (resolve) {
                        setTimeout(function () {
                            var result = DreamAI.GlowCore.preview(imageData, state.params, { isPreview: true });
                            resolve({ imageData: imageData, result: result });
                        }, 0);
                    });
                });
            }).then(function (built) {
                if (!built) return;
                var result = built.result;
                var composed = result.preview;
                var canvas = paintCanvas(composed.data, composed.width, composed.height, t('tools.glow.preview'));
                if (!canvas) {
                    toast('tools.glow.noCanvas', { tone: 'error' });
                    setBusy(false);
                    return;
                }
                previewFrame.setCanvas(canvas);
                state.glow = result.glow;
                state.width = composed.width;
                state.height = composed.height;
                persist();
                status('tools.glow.previewReady', {
                    key: 'tools.glow.previewReady',
                    tone: 'ok',
                    autoClear: 2400,
                    params: { size: composed.width + '×' + composed.height, style: t(styleLabelKey(state.params.style)) }
                });
                toast('tools.glow.previewReady', {
                    tone: 'ok',
                    params: { size: composed.width + '×' + composed.height, style: t(styleLabelKey(state.params.style)) }
                });
                setBusy(false);
            }).catch(function (error) {
                log('warn', '辉光预览失败：' + (error && error.message), { domain: 'glow' });
                toast(error && error.message ? error.message : 'tools.glow.decodeFailed', { tone: 'error' });
                status('state.failed', { key: 'state.failed', tone: 'error', autoClear: 3000 });
                setBusy(false);
            });
        }

        function styleLabelKey(styleId) {
            var core = DreamAI.GlowCore;
            var preset = core && core.PRESETS ? core.PRESETS[styleId] : null;
            return (preset && preset.labelKey) ? preset.labelKey : ('tools.glow.preset.' + styleId);
        }

        /* ---------- 3.7 写入文档 ---------- */

        function runWrite() {
            if (state.busy) return;
            if (syncEnvHint()) {
                toast('tools.glow.browserOnly', { tone: 'warn' });
                return;
            }
            if (!state.glow) {
                // 还没预览：先算一遍，算完再写
                toast('tools.glow.writeNeedsPreview', { tone: 'info' });
                runPreview();
                return;
            }
            if (!DreamAI.GlowCore || typeof DreamAI.GlowCore.renderGlowLayer !== 'function') {
                toast('tools.glow.noCore', { tone: 'error' });
                return;
            }
            var selection = state.selection;
            if (!selection) {
                toast('tools.needSelection', { tone: 'warn' });
                return;
            }

            setBusy(true, 'tools.glow.writing');
            status('tools.glow.writing', { key: 'tools.glow.writing', tone: 'busy' });

            // 先出 RGBA 图层（同步，放下一帧），再编码 PNG，再回写
            new Promise(function (resolve) {
                setTimeout(function () {
                    resolve(DreamAI.GlowCore.renderGlowLayer(state.glow, state.params, state.width, state.height));
                }, 0);
            }).then(function (layer) {
                return encodePngDataUrl(layer.data, layer.width, layer.height).then(function (dataUrl) {
                    return { dataUrl: dataUrl, layer: layer };
                });
            }).then(function (encoded) {
                status('tools.glow.encoding', { key: 'tools.glow.encoding', tone: 'busy' });
                // PhotoReturn.place 内部自带 psLock.acquire + executeAsModal（INTERNALS §5），
                // 外层再包一次 acquire 会和它自己死锁，所以这里只 await 它的 Promise。
                return DreamAI.PhotoReturn.place(encoded.dataUrl, {
                    bounds: selection.bounds || null,
                    documentId: selection.documentId,
                    layerName: t('tools.glow.layerName'),
                    blendMode: 'screen',
                    feather: 0
                });
            }).then(function (placed) {
                var name = (placed && placed.layerName) ? placed.layerName : t('tools.glow.layerName');
                toast('tools.committed', { tone: 'ok' });
                toast('tools.glow.writeDone', { tone: 'ok', params: { name: name } });
                status('tools.glow.writeDone', {
                    key: 'tools.glow.writeDone',
                    tone: 'ok',
                    autoClear: 3000,
                    params: { name: name }
                });
                setBusy(false);
            }).catch(function (error) {
                log('error', '辉光写入失败：' + (error && error.message), { domain: 'glow' });
                toast('tools.glow.writeFailed', { tone: 'error', params: { reason: (error && error.message) ? error.message : '' } });
                status('state.failed', { key: 'state.failed', tone: 'error', autoClear: 3000 });
                setBusy(false);
            });
        }

        /* ---------- 3.8 重置 ---------- */

        function runReset() {
            loadStyle(state.params.style);   // 只传 style，等于「恢复该风格的整套预设」
            previewFrame.clear();
            syncFromParams();
            persist();
            toast('tools.glow.resetDone', { tone: 'ok' });
        }

        /* ---------- 3.9 挂载 ---------- */

        var disposeSelection = null;
        try {
            if (DreamAI.bus && typeof DreamAI.bus.on === 'function') {
                disposeSelection = DreamAI.bus.on('selection:change', function (payload) {
                    var sample = payload && payload.sample;
                    if (sample) {
                        syncSelectionUi(sample);
                        return;
                    }
                    // 选区被清掉：旧辉光依然可写（bounds 还在），只是提示重新读取
                    syncSelectionUi(state.selection);
                });
            }
        } catch (error) {
            log('warn', '订阅 selection:change 失败：' + (error && error.message), { domain: 'glow' });
        }

        function refresh() {
            try {
                syncEnvHint();
                syncFromParams();
                var restored = normalizeParams(readStore().params || {});
                state.params = restored;
                syncFromParams();
            } catch (error) {
                log('warn', '辉光面板 refresh 失败：' + (error && error.message), { domain: 'glow' });
            }
        }

        // 初次同步：把恢复出来的参数推到控件上
        syncFromParams();
        syncEnvHint();
        syncSelectionUi(null);
        if (DreamAI.App && DreamAI.App.selection) syncSelectionUi(DreamAI.App.selection);
        setTimeout(function () {
            try {
                var current = readStoredSelection();
                if (current && typeof current.then === 'function') current.then(syncSelectionUi, function () {});
            } catch (error) { /* 忽略 */ }
        }, 0);

        return {
            el: panel,
            dispose: function () {
                if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
                if (typeof disposeSelection === 'function') disposeSelection();
                state.glow = null;
                try { previewFrame.clear(); } catch (error) { /* 忽略 */ }
            },
            refresh: refresh
        };
    }

    /* ============================================================
     * 4. 对外接口
     * ============================================================ */

    DreamAI.GlowTool = {
        buildPanel: buildPanel,
        // 面板默认参数（与内核 DEFAULT_PARAMS 同源，内核缺席时用兜底表）
        DEFAULTS: normalizeParams({}),
        STORE_DOMAIN: STORE_DOMAIN
    };
})(typeof window !== 'undefined' ? window : this);
