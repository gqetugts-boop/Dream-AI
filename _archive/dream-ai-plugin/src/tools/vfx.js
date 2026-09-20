/*
 * tools/vfx.js — 位移特效面板（UI 层）
 *
 * 职责：
 *   1. 用 ui/widgets.js 的控件工厂搭出位移特效编辑器：效果类型、参数滑块、
 *      流向 / 中心点、辉光着色、提示词补充、预览（含位移图检视）、写入文档；
 *   2. 控件值一律经 VfxCore.normalizeSettings 归一化，保证「切效果 → 载入该效果预设」
 *      与内核行为完全一致；
 *   3. 读取选区 → 解码成 ImageData → VfxCore.render() → 画进预览画布；
 *      可切换显示「位移图（RGB）」或「位移后的画面」；
 *   4. 写入时把渲染结果编码成 PNG data URL，再经 DreamAI.PhotoReturn.place()
 *      以 normal 混合模式回写。
 *
 * 输入：buildPanel(ctx)，ctx = { W, getSelection(), readSelection(), toast(), status() }。
 * 输出：{ el, dispose?, refresh? }。
 * 边界：
 *   - 本文件不含任何算法：位移场与重采样全部在 tools/vfx-core.js；
 *   - 粒子 / 烟雾是「提示词补充」，只进 prompt，不参与 CPU 渲染（界面已标注）；
 *   - 不新建 <style>：只用既有 class + 少量内联 style；
 *   - PhotoIO / PhotoReturn 缺失（浏览器预览）时降级为提示 + 禁用写入；
 *   - 一切异常都在内部消化并写 DreamAI.logbus，绝不从 buildPanel 抛出。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};

    // 幂等保护：重复加载不覆盖已存在的实例
    if (DreamAI.VfxTool) return;

    var util = DreamAI.util;

    /* ============================================================
     * 0. 常量与降级兜底
     * ============================================================ */

    var STORE_DOMAIN = 'tools.vfx';

    var FALLBACK_EFFECTS = ['heat', 'airflow', 'blade', 'ripple'];
    var FALLBACK_RANGES = {
        intensity: [0, 100], range: [10, 100], feather: [0, 100], angle: [-180, 180],
        detail: [0, 100], glow: [0, 100], glowColorAmount: [0, 100], brush: [8, 120],
        octaves: [1, 6], phase: [0, 360]
    };
    var FALLBACK_SETTINGS = {
        effect: 'heat', flowMode: 'linear', intensity: 48, range: 62, feather: 54, angle: 90,
        detail: 58, glow: 12, glowColor: '#ffd27a', glowColorAmount: 28, glowColorEnabled: true,
        brush: 42, centerX: 0.5, centerY: 0.5, octaves: 4, phase: 0
    };

    /** 两列栅格里的参数滑块（上下限一律取 VfxCore.RANGES） */
    var SLIDERS = [
        { key: 'intensity', labelKey: 'vfx.intensity', step: 1 },
        { key: 'range', labelKey: 'vfx.range', step: 1 },
        { key: 'feather', labelKey: 'vfx.feather', step: 1 },
        { key: 'detail', labelKey: 'vfx.detail', step: 1 },
        { key: 'glow', labelKey: 'vfx.glow', step: 1 },
        { key: 'glowColorAmount', labelKey: 'vfx.glowColorAmount', step: 1 },
        { key: 'brush', labelKey: 'vfx.brush', step: 1 },
        { key: 'angle', labelKey: 'vfx.angle', step: 1 },
        { key: 'octaves', labelKey: 'vfx.octaves', step: 1 },
        { key: 'phase', labelKey: 'vfx.phase', step: 1 }
    ];

    /** 中心点：归一化坐标 0-1，步长 0.01 */
    var CENTER_SLIDERS = [
        { key: 'centerX', labelKey: 'vfx.centerX', step: 0.01 },
        { key: 'centerY', labelKey: 'vfx.centerY', step: 0.01 }
    ];

    /* ============================================================
     * 1. 小工具
     * ============================================================ */

    function log(level, message, meta) {
        try {
            var bus = DreamAI.logbus;
            if (bus && typeof bus[level] === 'function') bus[level](message, meta || { domain: 'vfx' });
        } catch (error) { /* 日志失败不能影响面板 */ }
    }

    function rangeOf(key) {
        var core = DreamAI.VfxCore;
        if (key === 'centerX' || key === 'centerY') return [0, 1];
        if (core && core.RANGES && core.RANGES[key]) return core.RANGES[key];
        if (FALLBACK_RANGES[key]) return FALLBACK_RANGES[key];
        return [0, 100];
    }

    function defaultOf(key) {
        var core = DreamAI.VfxCore;
        var source = (core && core.DEFAULT_SETTINGS) ? core.DEFAULT_SETTINGS : FALLBACK_SETTINGS;
        var value = source[key];
        if (value === undefined) value = FALLBACK_SETTINGS[key];
        // 中心点是归一化坐标，兜底必须落在画面中心而不是 0
        if (value === undefined) value = (key === 'centerX' || key === 'centerY') ? 0.5 : 0;
        return value;
    }

    /** 效果清单：用内核的 EFFECTS（每项带 labelKey） */
    function effectList() {
        var core = DreamAI.VfxCore;
        if (core && core.EFFECTS && core.EFFECTS.length) {
            var list = [];
            for (var i = 0; i < core.EFFECTS.length; i++) {
                list.push({ id: core.EFFECTS[i].id, labelKey: core.EFFECTS[i].labelKey });
            }
            return list;
        }
        var fallback = [];
        for (var j = 0; j < FALLBACK_EFFECTS.length; j++) {
            fallback.push({ id: FALLBACK_EFFECTS[j], labelKey: 'vfx.effect' + FALLBACK_EFFECTS[j].charAt(0).toUpperCase() + FALLBACK_EFFECTS[j].slice(1) });
        }
        return fallback;
    }

    /** 归一化设置：优先走内核，保证切效果时补齐该效果预设 */
    function normalizeSettings(raw) {
        var core = DreamAI.VfxCore;
        if (core && typeof core.normalizeSettings === 'function') return core.normalizeSettings(raw);
        var out = {};
        var keys = Object.keys(FALLBACK_SETTINGS);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var range = rangeOf(key);
            if (key === 'glowColorEnabled') {
                out[key] = raw && raw[key] !== undefined ? !!raw[key] : FALLBACK_SETTINGS[key];
            } else if (key === 'glowColor') {
                out[key] = (raw && raw[key]) ? String(raw[key]) : FALLBACK_SETTINGS[key];
            } else if (key === 'effect' || key === 'flowMode') {
                out[key] = (raw && raw[key]) ? String(raw[key]) : FALLBACK_SETTINGS[key];
            } else {
                out[key] = util.clamp(raw ? raw[key] : undefined, range[0], range[1], FALLBACK_SETTINGS[key]);
            }
        }
        out.octaves = Math.round(out.octaves);
        return out;
    }

    function readStore() {
        try {
            if (DreamAI.Store && typeof DreamAI.Store.read === 'function') return DreamAI.Store.read(STORE_DOMAIN, {});
        } catch (error) {
            log('warn', '读取 tools.vfx 失败：' + (error && error.message), { domain: 'vfx' });
        }
        return {};
    }

    function writeStore(patch) {
        try {
            if (DreamAI.Store && typeof DreamAI.Store.write === 'function') DreamAI.Store.write(STORE_DOMAIN, patch, {});
        } catch (error) {
            log('warn', '写入 tools.vfx 失败：' + (error && error.message), { domain: 'vfx' });
        }
    }

    /** canvas 2D 能力探测（UXP 各版本实现不一，必须先探再用） */
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

    /** RGBA 缓冲区 → 新 canvas（不支持时返回 null） */
    function paintCanvas(rgba, width, height, label) {
        try {
            if (!canvasSupported()) return null;
            var canvas = global.document.createElement('canvas');
            var ctx2d = canvas.getContext('2d');
            if (!ctx2d) return null;
            canvas.width = Math.max(1, Math.round(width));
            canvas.height = Math.max(1, Math.round(height));
            canvas.style.width = '100%';
            canvas.style.height = 'auto';
            canvas.style.display = 'block';
            canvas.setAttribute('role', 'img');
            if (label) canvas.setAttribute('aria-label', label);
            if (typeof global.ImageData === 'function') {
                ctx2d.putImageData(new global.ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height), 0, 0);
            } else {
                ctx2d.putImageData({ data: new Uint8ClampedArray(rgba), width: canvas.width, height: canvas.height }, 0, 0);
            }
            return canvas;
        } catch (error) {
            log('warn', '预览绘制失败：' + (error && error.message), { domain: 'vfx' });
            return null;
        }
    }

    /** data URL → ImageData（Image 解码 + canvas 取像素） */
    function decodeImageData(dataUrl) {
        return new Promise(function (resolve, reject) {
            if (!dataUrl) {
                reject(new Error(DreamAI.I18n.t('vfx.decodeFailed')));
                return;
            }
            if (!canvasSupported()) {
                reject(new Error(DreamAI.I18n.t('vfx.noCanvas')));
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
                    reject(new Error(DreamAI.I18n.t('vfx.decodeFailed')));
                }
            };
            image.onerror = function () {
                reject(new Error(DreamAI.I18n.t('vfx.decodeFailed')));
            };
            image.src = dataUrl;
        });
    }

    /** RGBA → PNG data URL（走项目的 PhotoEncode） */
    function encodePngDataUrl(rgba, width, height) {
        return new Promise(function (resolve, reject) {
            var encode = DreamAI.PhotoEncode;
            if (!encode || typeof encode.encodePng !== 'function') {
                reject(new Error(DreamAI.I18n.t('vfx.noEncoder')));
                return;
            }
            try {
                var png = encode.encodePng({ data: rgba, width: width, height: height, channels: 4 });
                resolve(util.base64ToDataUrl(util.arrayBufferToBase64(png), 'image/png'));
            } catch (error) {
                reject(new Error(DreamAI.I18n.t('vfx.encodeFailed')));
            }
        });
    }

    /* ============================================================
     * 2. 面板
     * ============================================================ */

    function buildPanel(panelCtx) {
        var ctx = panelCtx || {};
        var W = ctx.W || DreamAI.Widgets;
        if (!W) {
            log('error', '控件工厂缺席，位移特效面板无法构建', { domain: 'vfx' });
            return null;
        }
        try {
            return build(ctx, W);
        } catch (error) {
            log('error', '位移特效面板构建失败：' + (error && error.message), { domain: 'vfx' });
            return {
                el: util.el('div', { class: 'tool-panel' }, [W.hint('vfx.buildFailed', 'error')]),
                dispose: function () {},
                refresh: function () {}
            };
        }
    }

    function build(ctx, W) {
        var el = util.el;
        var t = function (key, params) { return DreamAI.I18n.t(key, params || {}); };

        function toast(textOrKey, options) {
            try {
                if (typeof ctx.toast === 'function') { ctx.toast(textOrKey, options || {}); return; }
                if (DreamAI.Shell && DreamAI.Shell.toast) DreamAI.Shell.toast(textOrKey, options || {});
            } catch (error) {
                log('warn', 'toast 失败：' + (error && error.message), { domain: 'vfx' });
            }
        }

        function status(textOrKey, options) {
            try {
                if (typeof ctx.status === 'function') { ctx.status(textOrKey, options || {}); return; }
                if (DreamAI.Shell && DreamAI.Shell.status) DreamAI.Shell.status(textOrKey, options || {});
            } catch (error) {
                log('warn', 'status 失败：' + (error && error.message), { domain: 'vfx' });
            }
        }

        /* ---------- 2.1 状态 ---------- */

        var stored = readStore();
        var state = {
            settings: normalizeSettings(stored && stored.settings ? stored.settings : {}),
            selection: null,
            rendered: null,       // VfxCore.render 的结果（保留位移图供检视）
            promptHints: {
                particles: (stored && stored.particles) ? String(stored.particles) : '',
                smoke: (stored && stored.smoke) ? String(stored.smoke) : ''
            },
            viewDisplacement: !!(stored && stored.viewDisplacement),
            busy: false
        };

        function persist() {
            writeStore({
                settings: state.settings,
                particles: state.promptHints.particles,
                smoke: state.promptHints.smoke,
                viewDisplacement: state.viewDisplacement,
                updatedAt: Date.now ? Date.now() : 0
            });
        }

        var persistTimer = null;
        function persistSoon() {
            if (persistTimer) clearTimeout(persistTimer);
            persistTimer = setTimeout(function () {
                persistTimer = null;
                persist();
            }, 250);
        }

        /** 改一个参数：合并后整体归一化（切效果即载入该效果的整套预设） */
        function setSettings(patch) {
            var next = {};
            var key;
            for (key in state.settings) if (Object.prototype.hasOwnProperty.call(state.settings, key)) next[key] = state.settings[key];
            for (key in patch) if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
            applyNormalized(next);
        }

        /**
         * 切换效果：VfxCore.normalizeSettings 只在字段缺失时才取该效果的预设，
         * 想真正载入预设必须显式只传 { effect } 再取归一化结果。
         */
        function loadEffect(effectId) {
            applyNormalized(normalizeSettings({ effect: effectId }));
        }

        function applyNormalized(next) {
            state.settings = normalizeSettings(next);
            // 设置变了，旧渲染结果不再对应当前参数
            state.rendered = null;
            syncWriteEnabled();
        }

        /* ---------- 2.2 控件 ---------- */

        var sliderNodes = [];
        var chipNodes = [];

        function makeSlider(spec) {
            var range = rangeOf(spec.key);
            var node = W.slider({
                labelKey: spec.labelKey,
                min: range[0],
                max: range[1],
                step: spec.step || 1,
                value: util.toNumber(state.settings[spec.key], defaultOf(spec.key)),
                onInput: function (value) {
                    var patch = {};
                    patch[spec.key] = util.clamp(value, range[0], range[1], defaultOf(spec.key));
                    setSettings(patch);
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

        var mainGrid = makeParamGrid(SLIDERS);
        var centerGrid = makeParamGrid(CENTER_SLIDERS);

        var effectChips = W.chipGroup(effectList().map(function (item) {
            return { value: item.id, labelKey: item.labelKey };
        }), state.settings.effect, function (value) {
            loadEffect(value);
            syncFromSettings();
            persist();
            toast('vfx.effectApplied', { tone: 'info' });
        });
        chipNodes.push(effectChips);

        var flowSelect = W.select([
            { value: 'radial', labelKey: 'vfx.flowRadial' },
            { value: 'linear', labelKey: 'vfx.flowLinear' },
            { value: 'swirl', labelKey: 'vfx.flowSwirl' }
        ], state.settings.flowMode, {
            onChange: function (value) {
                applySettings({ flowMode: value });
                persist();
            }
        });

        var colorPicker = W.colorPicker({
            value: state.settings.glowColor,
            onChange: function (hex) {
                applySettings({ glowColor: hex });
                persistSoon();
            }
        });

        var glowColorCheck = W.checkbox('vfx.glowColorEnabled', !!state.settings.glowColorEnabled, {
            onChange: function (checked) {
                applySettings({ glowColorEnabled: !!checked });
                syncColorUi();
                persist();
            }
        });

        var pickFgBtn = W.button('vfx.pickForeground', {
            variant: 'ghost',
            size: 'sm',
            glyph: '⊙',
            onClick: function () { pickForeground(); }
        });

        var particlesInput = W.input({
            value: state.promptHints.particles,
            placeholderKey: 'vfx.particlePlaceholder',
            onInput: function (value) {
                state.promptHints.particles = String(value || '');
                persistSoon();
            }
        });

        var smokeInput = W.input({
            value: state.promptHints.smoke,
            placeholderKey: 'vfx.smokePlaceholder',
            onInput: function (value) {
                state.promptHints.smoke = String(value || '');
                persistSoon();
            }
        });

        /* ---------- 2.3 预览与动作 ---------- */

        var previewFrame = W.previewFrame({ placeholderKey: 'tools.previewEmpty' });
        var showMapCheck = W.checkbox('vfx.viewDisplacement', !!state.viewDisplacement, {
            onChange: function (checked) {
                state.viewDisplacement = !!checked;
                persist();
                // 已有渲染结果时直接换视图，不必重算
                if (state.rendered) paint();
                else redraw();
            }
        });

        var previewBtn = W.button('tools.preview', {
            variant: 'primary',
            size: 'lg',
            glyph: '◆',
            block: true,
            onClick: function () { runRender(); }
        });

        var writeBtn = W.button('vfx.write', {
            variant: 'ghost',
            size: 'lg',
            glyph: '⇩',
            block: true,
            disabled: true,
            onClick: function () { runWrite(); }
        });

        var resetBtn = W.button('vfx.reset', {
            variant: 'quiet',
            size: 'sm',
            glyph: '↺',
            onClick: function () { runReset(); }
        });

        var envHint = W.hint('vfx.browserOnly', 'warn');
        envHint.setAttribute('hidden', '');
        var selectionState = el('div', { class: 'field-hint muted', text: t('tools.needSelection'), 'data-i18n': 'tools.needSelection' });
        var colorWrap = el('div', { class: 'stack' }, [colorPicker]);

        /* ---------- 2.4 装配 ---------- */

        var panel = el('div', { class: 'tool-panel' }, [
            el('div', { class: 'field' }, [
                el('div', { class: 'field-label', text: t('vfx.effect'), 'data-i18n': 'vfx.effect' }),
                effectChips
            ]),
            el('div', { class: 'param-grid' }, [
                (function () {
                    var cell = W.field('vfx.flowMode', flowSelect);
                    cell.className = 'param-cell';
                    return cell;
                })()
            ]),
            selectionState,
            envHint,
            mainGrid,
            W.divider(),
            el('div', { class: 'stack' }, [
                el('div', { class: 'field-label', text: t('vfx.center'), 'data-i18n': 'vfx.center' }),
                centerGrid
            ]),
            W.divider(),
            el('div', { class: 'stack' }, [
                glowColorCheck,
                pickFgBtn,
                colorWrap
            ]),
            W.hint('vfx.glowColorHint', 'plain'),
            W.divider(),
            el('div', { class: 'stack' }, [
                el('div', { class: 'field-label', text: t('vfx.promptHints'), 'data-i18n': 'vfx.promptHints' }),
                W.field('vfx.particles', particlesInput, 'vfx.particlesHint'),
                W.field('vfx.smoke', smokeInput, 'vfx.smokeHint')
            ]),
            previewFrame,
            showMapCheck,
            W.hint('vfx.blendHint', 'info'),
            el('div', { class: 'action-bar' }, [
                el('div', { class: 'action-bar-main' }, [previewBtn]),
                writeBtn
            ]),
            el('div', { class: 'btn-row btn-row-end' }, [resetBtn])
        ]);

        /* ---------- 2.5 同步逻辑 ---------- */

        function applySettings(patch) {
            setSettings(patch);
            syncFromSettings();
        }

        /** 把 state.settings 推回控件（silent） */
        function syncFromSettings() {
            var i;
            for (i = 0; i < sliderNodes.length; i++) {
                var entry = sliderNodes[i];
                entry.node.setValue(util.toNumber(state.settings[entry.key], defaultOf(entry.key)), true);
            }
            for (i = 0; i < chipNodes.length; i++) {
                if (typeof chipNodes[i].setValue === 'function') chipNodes[i].setValue(state.settings.effect);
            }
            if (flowSelect && typeof flowSelect.setValue === 'function') flowSelect.setValue(state.settings.flowMode, true);
            if (colorPicker && typeof colorPicker.setValue === 'function') colorPicker.setValue(state.settings.glowColor);
            if (glowColorCheck && typeof glowColorCheck.setValue === 'function') glowColorCheck.setValue(!!state.settings.glowColorEnabled);
            if (showMapCheck && typeof showMapCheck.setValue === 'function') showMapCheck.setValue(!!state.viewDisplacement);
            syncColorUi();
            syncWriteEnabled();
        }

        /** 着色开关关掉、或着色量为 0 时，色板不参与计算 */
        function syncColorUi() {
            if (!colorWrap) return;   // 装配未完成（构造期的回调）时跳过
            var on = !!state.settings.glowColorEnabled && util.toNumber(state.settings.glowColorAmount, 0) > 0;
            colorWrap.style.opacity = on ? '1' : '0.55';
            colorWrap.setAttribute('data-disabled', on ? 'false' : 'true');
            var controls = colorWrap.querySelectorAll ? colorWrap.querySelectorAll('button, input, [role="slider"], .range-track') : [];
            for (var i = 0; i < controls.length; i++) controls[i].style.pointerEvents = on ? '' : 'none';
        }

        function setBusy(on, labelKey) {
            state.busy = !!on;
            var label = state.busy ? (labelKey || 'tools.preview') : 'tools.preview';
            previewBtn.lastChild.textContent = t(label);
            previewBtn.lastChild.setAttribute('data-i18n', label);
            if (state.busy) {
                previewBtn.setAttribute('disabled', '');
                writeBtn.setAttribute('disabled', '');
            } else {
                previewBtn.removeAttribute('disabled');
                syncWriteEnabled();
            }
        }

        function syncWriteEnabled() {
            if (!writeBtn) return;   // 控件尚未装配完成（W.colorPicker 构造时会回调一次）
            var canWrite = !!state.rendered && !state.busy && !!(DreamAI.PhotoReturn && typeof DreamAI.PhotoReturn.place === 'function');
            if (canWrite) writeBtn.removeAttribute('disabled');
            else writeBtn.setAttribute('disabled', '');
        }

        function syncSelectionUi(selection) {
            state.selection = selection || null;
            if (selection) {
                selectionState.removeAttribute('data-i18n');
                selectionState.textContent = t('selection.info', { w: selection.width, h: selection.height });
            } else {
                selectionState.setAttribute('data-i18n', 'tools.needSelection');
                selectionState.textContent = t('tools.needSelection');
            }
        }

        /* ---------- 2.6 宿主能力 ---------- */

        function readStoredSelection() {
            if (typeof ctx.readSelection === 'function') {
                try {
                    var fromCtx = ctx.readSelection();
                    if (fromCtx && typeof fromCtx.then === 'function') return fromCtx;
                    if (fromCtx) return Promise.resolve(fromCtx);
                } catch (error) {
                    log('warn', 'ctx.readSelection 失败，改用 getSelection：' + (error && error.message), { domain: 'vfx' });
                }
            }
            if (typeof ctx.getSelection === 'function') {
                try {
                    var alt = ctx.getSelection();
                    if (alt && typeof alt.then === 'function') return alt;
                    if (alt) return Promise.resolve(alt);
                } catch (error) {
                    log('warn', 'ctx.getSelection 失败：' + (error && error.message), { domain: 'vfx' });
                }
            }
            if (DreamAI.App && DreamAI.App.selection) return Promise.resolve(DreamAI.App.selection);
            return Promise.resolve(null);
        }

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

        /* ---------- 2.7 预览 ---------- */

        /** 用最近一次渲染结果重画（只换视图，不重算） */
        function paint() {
            if (!state.rendered) return false;
            var view = state.viewDisplacement
                ? { data: state.rendered.displacement, width: state.rendered.imageData.width, height: state.rendered.imageData.height, channels: 4 }
                : state.rendered.imageData;
            var canvas = paintCanvas(view.data, view.width, view.height, t(state.viewDisplacement ? 'vfx.viewDisplacement' : 'tools.preview'));
            if (!canvas) {
                toast('vfx.noCanvas', { tone: 'error' });
                return false;
            }
            previewFrame.setCanvas(canvas);
            return true;
        }

        function redraw() {
            try { previewFrame.clear(); } catch (error) { /* 忽略 */ }
        }

        function runRender() {
            if (state.busy) return;
            if (syncEnvHint()) {
                toast('vfx.browserOnly', { tone: 'warn' });
                return;
            }
            if (!canvasSupported()) {
                toast('vfx.noCanvas', { tone: 'error' });
                return;
            }
            if (!DreamAI.VfxCore || typeof DreamAI.VfxCore.render !== 'function') {
                toast('vfx.noCore', { tone: 'error' });
                return;
            }
            setBusy(true, 'vfx.rendering');
            status('vfx.rendering', { key: 'vfx.rendering', tone: 'busy' });

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
                    // setTimeout 0：先让「渲染中…」渲染出来，再跑同步重采样
                    return new Promise(function (resolve) {
                        setTimeout(function () {
                            var result = DreamAI.VfxCore.render(imageData, state.settings);
                            resolve({ imageData: imageData, result: result });
                        }, 0);
                    });
                });
            }).then(function (built) {
                if (!built) return;
                state.rendered = built.result;
                if (!paint()) {
                    setBusy(false);
                    return;
                }
                persist();
                status('vfx.previewReady', {
                    key: 'vfx.previewReady',
                    tone: 'ok',
                    autoClear: 2400,
                    params: {
                        size: built.result.imageData.width + '×' + built.result.imageData.height,
                        effect: t(effectLabelKey(state.settings.effect))
                    }
                });
                setBusy(false);
            }).catch(function (error) {
                log('warn', '位移特效渲染失败：' + (error && error.message), { domain: 'vfx' });
                toast(error && error.message ? error.message : 'vfx.decodeFailed', { tone: 'error' });
                status('state.failed', { key: 'state.failed', tone: 'error', autoClear: 3000 });
                setBusy(false);
            });
        }

        function effectLabelKey(effectId) {
            var core = DreamAI.VfxCore;
            if (core && core.EFFECTS) {
                for (var i = 0; i < core.EFFECTS.length; i++) {
                    if (core.EFFECTS[i].id === effectId) return core.EFFECTS[i].labelKey;
                }
            }
            return 'vfx.effect' + String(effectId || '').charAt(0).toUpperCase() + String(effectId || '').slice(1);
        }

        /* ---------- 2.8 写入与吸色 ---------- */

        function runWrite() {
            if (state.busy) return;
            if (syncEnvHint()) {
                toast('vfx.browserOnly', { tone: 'warn' });
                return;
            }
            if (!state.rendered) {
                toast('vfx.writeNeedsPreview', { tone: 'info' });
                runRender();
                return;
            }
            var selection = state.selection;
            if (!selection) {
                toast('tools.needSelection', { tone: 'warn' });
                return;
            }
            setBusy(true, 'vfx.writing');
            status('vfx.writing', { key: 'vfx.writing', tone: 'busy' });

            var image = state.rendered.imageData;
            encodePngDataUrl(image.data, image.width, image.height).then(function (dataUrl) {
                status('vfx.encoding', { key: 'vfx.encoding', tone: 'busy' });
                // PhotoReturn.place 内部已做 psLock.acquire + executeAsModal（INTERNALS §5），
                // 外层重复加锁会自己等自己，所以这里只 await 它返回的 Promise。
                return DreamAI.PhotoReturn.place(dataUrl, {
                    bounds: selection.bounds || null,
                    documentId: selection.documentId,
                    layerName: t('vfx.layerName'),
                    blendMode: 'normal'
                });
            }).then(function (placed) {
                var name = (placed && placed.layerName) ? placed.layerName : t('vfx.layerName');
                toast('vfx.generated', { tone: 'ok' });
                status('vfx.writeDone', {
                    key: 'vfx.writeDone',
                    tone: 'ok',
                    autoClear: 3000,
                    params: { name: name }
                });
                setBusy(false);
            }).catch(function (error) {
                log('error', '位移特效写入失败：' + (error && error.message), { domain: 'vfx' });
                toast('vfx.writeFailed', { tone: 'error', params: { reason: (error && error.message) ? error.message : '' } });
                status('state.failed', { key: 'state.failed', tone: 'error', autoClear: 3000 });
                setBusy(false);
            });
        }

        /** 吸取 Photoshop 前景色写入色板（不依赖选区） */
        function pickForeground() {
            var io = DreamAI.PhotoIO;
            if (!io || typeof io.getForegroundColor !== 'function' || (typeof io.isAvailable === 'function' && !io.isAvailable())) {
                toast('vfx.browserOnly', { tone: 'warn' });
                return;
            }
            status('vfx.pickForeground', { key: 'vfx.pickForeground', tone: 'busy' });
            Promise.resolve()
                .then(function () { return io.getForegroundColor(); })
                .then(function (color) {
                    var hex = (color && color.hex) ? String(color.hex) : '';
                    if (!hex) throw new Error(t('vfx.pickFailed'));
                    applySettings({ glowColor: hex, glowColorEnabled: true });
                    persist();
                    toast('vfx.picked', { tone: 'ok', params: { hex: hex } });
                    status('vfx.picked', { key: 'vfx.picked', tone: 'ok', autoClear: 2400, params: { hex: hex } });
                })
                .catch(function (error) {
                    log('warn', '吸取前景色失败：' + (error && error.message), { domain: 'vfx' });
                    toast('vfx.pickFailed', { tone: 'error' });
                });
        }

        /* ---------- 2.9 重置与挂载 ---------- */

        function runReset() {
            loadEffect(state.settings.effect);   // 只传 effect，等于「恢复该效果的整套预设」
            redraw();
            syncFromSettings();
            persist();
            toast('vfx.resetDone', { tone: 'ok' });
        }

        var disposeSelection = null;
        try {
            if (DreamAI.bus && typeof DreamAI.bus.on === 'function') {
                disposeSelection = DreamAI.bus.on('selection:change', function (payload) {
                    var sample = payload && payload.sample;
                    syncSelectionUi(sample || state.selection);
                });
            }
        } catch (error) {
            log('warn', '订阅 selection:change 失败：' + (error && error.message), { domain: 'vfx' });
        }

        function refresh() {
            try {
                var restored = readStore();
                if (restored && restored.settings) state.settings = normalizeSettings(restored.settings);
                syncEnvHint();
                syncFromSettings();
            } catch (error) {
                log('warn', '位移特效面板 refresh 失败：' + (error && error.message), { domain: 'vfx' });
            }
        }

        syncFromSettings();
        syncEnvHint();
        syncSelectionUi(DreamAI.App ? DreamAI.App.selection : null);
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
                state.rendered = null;
                redraw();
            },
            refresh: refresh
        };
    }

    /* ============================================================
     * 3. 对外接口
     * ============================================================ */

    DreamAI.VfxTool = {
        buildPanel: buildPanel,
        DEFAULTS: normalizeSettings({}),
        STORE_DOMAIN: STORE_DOMAIN
    };
})(typeof window !== 'undefined' ? window : this);
