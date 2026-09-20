/*
 * ui/pages/toolbox.js — 工具箱
 *
 * 职责：把本地算法工具（辉光 / 位移特效 / 色彩融合 / 示波器）与常用 Photoshop
 *       操作汇总到一个页面，工具之间用标签切换。
 * 边界：算法在 tools/*-core.js，回写在 photo-return.js，本页只做界面与编排。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    var TABS = [
        { id: 'glow', labelKey: 'tools.glow' },
        { id: 'vfx', labelKey: 'tools.vfx' },
        { id: 'color', labelKey: 'tools.colorMatch' },
        { id: 'scope', labelKey: 'tools.scope' },
        { id: 'actions', labelKey: 'tools.actions' }
    ];

    DreamAI.Router.register({
        id: 'toolbox',
        group: 'create',
        labelKey: 'nav.toolbox',
        glyph: '⚒',
        order: 20,
        build: function (W) {
            var panels = {};
            var activeTab = 'glow';
            var tabBar = el('div', { class: 'tool-tabs', role: 'tablist' });
            var panelHost = el('div', { class: 'stack', style: { gap: '0px' } });

            var page = W.page('tools.title', { id: 'toolbox', subtitleKey: 'tools.local' });
            page.appendChild(tabBar);
            page.appendChild(panelHost);

            /* ============================================================
             * 工具上下文：交给各面板使用
             * ============================================================ */
            var toolCtx = {
                W: W,
                getSelection: function () { return DreamAI.App.selection; },
                readSelection: readSelection,
                toast: function (keyOrText, options) { DreamAI.Shell.toast(keyOrText, options); },
                status: function (keyOrText, options) { DreamAI.Shell.status(keyOrText, options); }
            };

            function readSelection() {
                if (!DreamAI.PhotoIO || !DreamAI.PhotoIO.isAvailable()) {
                    DreamAI.Shell.toast('selection.browserOnly', { tone: 'warn' });
                    return Promise.reject(new Error(DreamAI.I18n.t('selection.browserOnly')));
                }
                DreamAI.Shell.status('selection.reading', { key: 'selection.reading', tone: 'busy' });
                return DreamAI.PhotoIO.readSelection();
            }

            /* ============================================================
             * 面板构建
             * ============================================================ */
            function buildTabBar() {
                util.clear(tabBar);
                for (var i = 0; i < TABS.length; i++) {
                    (function (tab) {
                        var btn = el('button', {
                            type: 'button',
                            class: 'tool-tab',
                            role: 'tab',
                            dataset: { tab: tab.id },
                            'aria-selected': String(tab.id === activeTab),
                            text: W.t(tab.labelKey),
                            onclick: function () { activateTab(tab.id); }
                        });
                        tabBar.appendChild(btn);
                    })(TABS[i]);
                }
            }

            function ensurePanel(id) {
                if (panels[id]) return panels[id];
                var node;
                if (id === 'glow') {
                    node = buildGlowPanel();
                } else if (id === 'vfx') {
                    node = buildVfxPanel();
                } else if (id === 'color') {
                    node = buildColorPanel();
                } else if (id === 'scope') {
                    node = buildScopePanel();
                } else {
                    node = buildActionsPanel();
                }
                var wrap = el('div', { class: 'tool-panel', dataset: { panel: id } }, [node]);
                panels[id] = wrap;
                panelHost.appendChild(wrap);
                return wrap;
            }

            function activateTab(id) {
                activeTab = id;
                var tabs = tabBar.querySelectorAll('.tool-tab');
                for (var i = 0; i < tabs.length; i++) {
                    tabs[i].setAttribute('aria-selected', String(tabs[i].getAttribute('data-tab') === id));
                }
                for (var key in panels) {
                    if (!Object.prototype.hasOwnProperty.call(panels, key)) continue;
                    if (key === id) panels[key].removeAttribute('hidden');
                    else panels[key].setAttribute('hidden', '');
                }
                var wrap = ensurePanel(id);
                wrap.removeAttribute('hidden');
            }

            /* ---------- 辉光 ---------- */
            function buildGlowPanel() {
                if (DreamAI.GlowTool && typeof DreamAI.GlowTool.buildPanel === 'function') {
                    try {
                        var built = DreamAI.GlowTool.buildPanel(toolCtx);
                        return built && built.el ? built.el : built;
                    } catch (error) {
                        DreamAI.logbus.error('辉光面板构建失败：' + (error && error.message ? error.message : String(error)), { domain: 'toolbox' });
                    }
                }
                return W.hint('app.notConfigured', 'warn');
            }

            /* ---------- 位移特效 ---------- */
            function buildVfxPanel() {
                if (DreamAI.VfxTool && typeof DreamAI.VfxTool.buildPanel === 'function') {
                    try {
                        var built = DreamAI.VfxTool.buildPanel(toolCtx);
                        return built && built.el ? built.el : built;
                    } catch (error) {
                        DreamAI.logbus.error('特效面板构建失败：' + (error && error.message ? error.message : String(error)), { domain: 'toolbox' });
                    }
                }
                return W.hint('app.notConfigured', 'warn');
            }

            /* ---------- 色彩融合 ---------- */
            function buildColorPanel() {
                var card = W.card('tools.colorMatch', { emphasis: 'primary' }, null);
                var methodSelect = W.select([], 'meanStd', {});
                var strengthSlider = W.slider({ labelKey: 'tools.strength', min: 0, max: 100, step: 1, value: 100 });
                var useLabCheck = W.checkbox('tools.methodReinhard', true, {});
                var previewFrame = W.previewFrame({ placeholderKey: 'tools.previewEmpty', maxHeight: 220 });
                var info = W.hint('tools.runOnSelection', 'plain', 'i');
                var state = { reference: null, preview: null, params: null };

                function refreshMethods() {
                    var methods = DreamAI.ColorEngine && DreamAI.ColorEngine.METHODS ? DreamAI.ColorEngine.METHODS : [];
                    var items = methods.map(function (m) { return { value: m.id, labelKey: m.labelKey, label: m.id }; });
                    if (!items.length) {
                        items = [
                            { value: 'meanStd', labelKey: 'tools.methodMeanStd' },
                            { value: 'histogram', labelKey: 'tools.methodHistogram' }
                        ];
                    }
                    methodSelect.setItems(items, true);
                }

                function options() {
                    return {
                        strength: strengthSlider.getValue(),
                        useLab: useLabCheck.getValue(),
                        preserveAlpha: true,
                        featherRadius: 16
                    };
                }

                function decodeSelection() {
                    return readSelection().then(function (selection) {
                        return decodeDataUrl(selection.dataUrl).then(function (image) {
                            return { selection: selection, image: image };
                        });
                    });
                }

                function preview() {
                    if (!DreamAI.ColorEngine) {
                        DreamAI.Shell.toast('app.notConfigured', { tone: 'warn' });
                        return;
                    }
                    DreamAI.Shell.status('app.busy', { key: 'app.busy', tone: 'busy' });
                    decodeSelection().then(function (bundle) {
                        // 「色彩融合」需要一个参考色：默认用选区低频重建作为参考，
                        // 也可由用户先「读取参考」再预览。
                        var reference = state.reference || DreamAI.ColorEngine.reconstructLowFrequency(bundle.image, {
                            radius: Math.max(4, Math.round(Math.min(bundle.image.width, bundle.image.height) / 16)),
                            passes: 3
                        });
                        var method = methodSelect.getValue() || 'meanStd';
                        var fn = DreamAI.ColorEngine[mapMethod(method)] || DreamAI.ColorEngine.transferMeanStd;
                        var result = fn(bundle.image, reference, options());
                        state.preview = result;
                        state.params = bundle;
                        var dataUrl = imageToDataUrl(result);
                        previewFrame.setImage(dataUrl);
                        DreamAI.Shell.status('app.ready', { key: 'app.ready', tone: 'idle' });
                    }, function (error) {
                        DreamAI.Shell.toast(error && error.message ? error.message : String(error), { tone: 'warn' });
                    });
                }

                function readReference() {
                    readSelection().then(function (selection) {
                        decodeDataUrl(selection.dataUrl).then(function (image) {
                            state.reference = image;
                            DreamAI.Shell.toast('selection.ready', { tone: 'ok' });
                        });
                    }, function () { /* 已提示 */ });
                }

                function commit() {
                    if (!state.preview) {
                        DreamAI.Shell.toast('tools.previewEmpty', { tone: 'warn' });
                        return;
                    }
                    var selection = DreamAI.App.selection;
                    var dataUrl = imageToDataUrl(state.preview);
                    placeResult(dataUrl, {
                        bounds: selection ? selection.bounds : null,
                        documentId: selection ? selection.documentId : undefined,
                        layerName: 'Dream AI Color Match'
                    });
                }

                card.cardBody.appendChild(W.field('tools.method', methodSelect));
                card.cardBody.appendChild(strengthSlider);
                card.cardBody.appendChild(useLabCheck);
                card.cardBody.appendChild(info);
                card.cardBody.appendChild(previewFrame);
                card.cardBody.appendChild(el('div', { class: 'btn-row' }, [
                    W.button('tools.preview', { variant: 'ghost', onClick: preview }),
                    W.button('selection.read', { variant: 'ghost', onClick: readReference }),
                    W.button('tools.commit', { variant: 'primary', onClick: commit })
                ]));
                refreshMethods();
                return card;
            }

            function mapMethod(id) {
                if (id === 'meanStd') return 'transferMeanStd';
                if (id === 'histogram') return 'transferHistogram';
                if (id === 'reinhard') return 'transferReinhard';
                if (id === 'softLight') return 'transferSoftLight';
                if (id === 'luminance') return 'alignLuminance';
                return 'transferMeanStd';
            }

            /* ---------- 示波器 ---------- */
            function buildScopePanel() {
                // 画布实际像素尺寸在 draw() 里按容器宽度设定，
                // 这里只给一个初始值，避免窄面板下画布比容器宽导致横向溢出
                var canvas = el('canvas', { class: 'scope-canvas', width: '320', height: '200' });
                var modeChips = W.chipGroup([
                    { value: 'waveform', labelKey: 'tools.scopeWaveform' },
                    { value: 'parade', labelKey: 'tools.scopeParade' },
                    { value: 'histogram', labelKey: 'tools.scopeHistogram' },
                    { value: 'vectorscope', labelKey: 'tools.scopeVectorscope' }
                ], 'waveform', function () { draw(); });
                var liveCheck = W.checkbox('tools.scopeLive', false, {
                    onChange: function (checked) { setLive(checked); }
                });
                var currentImage = null;
                var timer = null;

                var card = W.card('tools.scope', { emphasis: 'primary' }, null);
                card.cardBody.appendChild(modeChips);
                card.cardBody.appendChild(el('div', { class: 'scope-frame' }, [canvas]));
                card.cardBody.appendChild(el('div', { class: 'inline', style: { justifyContent: 'space-between' } }, [
                    liveCheck,
                    el('div', { class: 'inline' }, [
                        W.miniButton('selection.read', { onClick: capture }),
                        W.miniButton('app.refresh', { onClick: draw })
                    ])
                ]));

                function capture() {
                    readSelection().then(function (selection) {
                        decodeDataUrl(selection.dataUrl).then(function (image) {
                            currentImage = image;
                            draw();
                        });
                    }, function () { /* 已提示 */ });
                }

                function setLive(enabled) {
                    if (timer) { clearInterval(timer); timer = null; }
                    if (!enabled) return;
                    timer = setInterval(capture, 3000);
                }

                /** 按容器可用宽度重算画布像素尺寸：窄面板下自动缩小，绝不横向溢出 */
                function fitCanvas() {
                    var host = canvas.parentNode;
                    var available = 320;
                    if (host && host.getBoundingClientRect) {
                        var rect = host.getBoundingClientRect();
                        if (rect && rect.width > 0) available = Math.floor(rect.width);
                    }
                    var width = util.clamp(available, 200, 720);
                    var height = Math.round(width * 0.44);
                    if (canvas.width !== width) canvas.width = width;
                    if (canvas.height !== height) canvas.height = height;
                }

                function draw() {
                    var ctx = canvas.getContext ? canvas.getContext('2d') : null;
                    if (!ctx) return;
                    fitCanvas();
                    var width = canvas.width;
                    var height = canvas.height;
                    ctx.fillStyle = '#1D1B23';
                    ctx.fillRect(0, 0, width, height);
                    if (!currentImage || !DreamAI.Scope) {
                        ctx.fillStyle = '#837C8C';
                        ctx.font = '12px sans-serif';
                        ctx.fillText(W.t('tools.previewEmpty'), 12, 24);
                        return;
                    }
                    var mode = activeMode();
                    if (mode === 'histogram') drawHistogram(ctx, width, height);
                    else if (mode === 'parade') drawParade(ctx, width, height);
                    else if (mode === 'vectorscope') drawVector(ctx, width, height);
                    else drawWaveform(ctx, width, height);
                }

                function activeMode() {
                    var chips = modeChips.children;
                    for (var i = 0; i < chips.length; i++) {
                        if (chips[i].getAttribute('aria-pressed') === 'true') return chips[i].getAttribute('data-value');
                    }
                    return 'waveform';
                }

                function drawGrid(ctx, width, height, columns, rows) {
                    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
                    ctx.lineWidth = 1;
                    var i;
                    for (i = 1; i < columns; i++) {
                        var x = Math.round((width / columns) * i) + 0.5;
                        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
                    }
                    for (i = 1; i < rows; i++) {
                        var y = Math.round((height / rows) * i) + 0.5;
                        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
                    }
                }

                function drawWaveform(ctx, width, height) {
                    var data = DreamAI.Scope.waveform(currentImage, { columns: width, bins: height });
                    var image = ctx.createImageData(width, height);
                    for (var x = 0; x < width; x++) {
                        for (var b = 0; b < height; b++) {
                            var count = data.bins0[x * height + b];
                            if (!count) continue;
                            var intensity = util.clamp(40 + Math.log(1 + count) * 55, 0, 255);
                            var y = height - 1 - b;
                            var offset = (y * width + x) * 4;
                            image.data[offset] = intensity;
                            image.data[offset + 1] = intensity;
                            image.data[offset + 2] = intensity;
                            image.data[offset + 3] = 255;
                        }
                    }
                    ctx.putImageData(image, 0, 0);
                    drawGrid(ctx, width, height, 4, 4);
                }

                function drawParade(ctx, width, height) {
                    var third = Math.floor(width / 3);
                    var data = DreamAI.Scope.parade(currentImage, { columns: third, bins: height });
                    var plane = [data.r, data.g, data.b];
                    var tint = [[255, 90, 90], [90, 235, 130], [110, 150, 255]];
                    for (var c = 0; c < 3; c++) {
                        for (var x = 0; x < third; x++) {
                            for (var b = 0; b < height; b++) {
                                var count = plane[c][x * height + b];
                                if (!count) continue;
                                var intensity = util.clamp(util.toNumber(count, 0) * 22, 0, 255) / 255;
                                ctx.fillStyle = 'rgba(' + tint[c][0] + ',' + tint[c][1] + ',' + tint[c][2] + ',' + intensity.toFixed(3) + ')';
                                ctx.fillRect(c * third + x, height - 1 - b, 1, 1);
                            }
                        }
                    }
                    drawGrid(ctx, width, height, 6, 4);
                }

                function drawHistogram(ctx, width, height) {
                    var hist = DreamAI.Scope.histogram(currentImage);
                    var max = 1;
                    var i;
                    for (i = 0; i < 256; i++) {
                        max = Math.max(max, hist.luma[i], hist.r[i], hist.g[i], hist.b[i]);
                    }
                    var channels = [
                        { data: hist.r, color: 'rgba(255,110,110,0.75)' },
                        { data: hist.g, color: 'rgba(120,240,150,0.75)' },
                        { data: hist.b, color: 'rgba(130,170,255,0.75)' }
                    ];
                    for (var c = 0; c < channels.length; c++) {
                        ctx.beginPath();
                        ctx.moveTo(0, height);
                        for (i = 0; i < 256; i++) {
                            var x = (i / 255) * width;
                            var y = height - (channels[c].data[i] / max) * (height - 8);
                            ctx.lineTo(x, y);
                        }
                        ctx.strokeStyle = channels[c].color;
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    }
                    drawGrid(ctx, width, height, 4, 4);
                }

                function drawVector(ctx, width, height) {
                    var size = Math.min(width, height);
                    var data = DreamAI.Scope.vectorscope(currentImage, { size: size });
                    var image = ctx.createImageData(size, size);
                    var max = 1;
                    for (var i = 0; i < data.data.length; i++) max = Math.max(max, data.data[i]);
                    for (var y = 0; y < size; y++) {
                        for (var x = 0; x < size; x++) {
                            var count = data.data[y * size + x];
                            var offset = (y * size + x) * 4;
                            if (!count) {
                                image.data[offset + 3] = 255;
                                continue;
                            }
                            var intensity = util.clamp(40 + Math.log(1 + count) * 60, 0, 255);
                            image.data[offset] = intensity;
                            image.data[offset + 1] = intensity * 0.9;
                            image.data[offset + 2] = 255 - intensity * 0.25;
                            image.data[offset + 3] = 255;
                        }
                    }
                    ctx.putImageData(image, Math.round((width - size) / 2), Math.round((height - size) / 2));
                    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
                    ctx.beginPath();
                    ctx.arc(width / 2, height / 2, size * 0.22, 0, Math.PI * 2);
                    ctx.stroke();
                }

                return card;
            }

            /* ---------- 常用 PS 操作 ---------- */
            function buildActionsPanel() {
                var card = W.card('tools.actions', { emphasis: 'primary' }, null);
                card.cardBody.appendChild(W.hint('tools.runOnSelection', 'plain', 'i'));
                // 按钮定义与执行逻辑集中在 core/ps-actions.js，页面只负责摆放
                if (DreamAI.PsActions) {
                    card.cardBody.appendChild(DreamAI.PsActions.buildGrid(W, { columns: 2 }));
                } else {
                    card.cardBody.appendChild(W.hint('app.notConfigured', 'warn'));
                }
                card.cardBody.appendChild(el('div', { class: 'divider' }));
                card.cardBody.appendChild(el('div', { class: 'btn-row' }, [
                    W.button('vfx.pickForeground', {
                        variant: 'ghost',
                        onClick: function () {
                            if (DreamAI.PsActions) DreamAI.PsActions.sampleForeground();
                        }
                    })
                ]));
                return card;
            }

            /* ============================================================
             * 公用：解码 data URL → ImageData，ImageData → data URL
             * ============================================================ */
            function decodeDataUrl(dataUrl) {
                return new Promise(function (resolve, reject) {
                    if (typeof global.Image !== 'function') {
                        reject(new Error(DreamAI.I18n.t('app.notConfigured')));
                        return;
                    }
                    var image = new global.Image();
                    image.onload = function () {
                        try {
                            var canvas = global.document.createElement('canvas');
                            canvas.width = image.naturalWidth || image.width;
                            canvas.height = image.naturalHeight || image.height;
                            var ctx = canvas.getContext('2d');
                            ctx.drawImage(image, 0, 0);
                            resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
                        } catch (error) {
                            reject(error);
                        }
                    };
                    image.onerror = function () {
                        reject(new Error(DreamAI.I18n.t('state.failed')));
                    };
                    image.src = dataUrl;
                });
            }

            function imageToDataUrl(imageData) {
                var canvas = global.document.createElement('canvas');
                canvas.width = imageData.width;
                canvas.height = imageData.height;
                var ctx = canvas.getContext('2d');
                var data = imageData instanceof global.ImageData
                    ? imageData
                    : new global.ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
                ctx.putImageData(data, 0, 0);
                return canvas.toDataURL('image/png');
            }

            function placeResult(dataUrl, options) {
                if (!DreamAI.PhotoReturn || !DreamAI.PhotoReturn.isAvailable()) {
                    DreamAI.Shell.toast('return.disabled', { tone: 'warn' });
                    return;
                }
                DreamAI.Shell.status('state.returning', { key: 'state.returning', tone: 'busy' });
                DreamAI.PhotoReturn.place(dataUrl, options).then(function () {
                    DreamAI.Shell.toast('tools.committed', { tone: 'ok' });
                    DreamAI.Shell.status('app.ready', { key: 'app.ready', tone: 'idle' });
                }, function (error) {
                    DreamAI.Shell.toast(W.t('return.failed', { reason: error && error.message ? error.message : String(error) }), { tone: 'error' });
                    DreamAI.Shell.status('app.ready', { key: 'app.ready', tone: 'idle' });
                });
            }

            buildTabBar();
            ensurePanel(activeTab);
            panelHost.children[0].removeAttribute('hidden');

            return {
                el: page,
                mount: function () {
                    buildTabBar();
                    activateTab(activeTab);
                },
                refresh: function () {
                    var wrap = panels[activeTab];
                    if (wrap && wrap.__refresh) wrap.__refresh();
                }
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
