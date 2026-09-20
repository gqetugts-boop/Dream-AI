/*
 * ui/pages/forge.js — Forge / SD WebUI 工作台
 *
 * 职责：连接配置、模型与采样器刷新、文生图 / 图生图参数、LoRA 与 ControlNet
 *       叠加、进度轮询、结果回写与预设存取。
 * 边界：HTTP 细节全在 src/local/forge.js；本页只做界面与任务编排。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    DreamAI.Router.register({
        id: 'forge',
        group: 'engine',
        labelKey: 'nav.forge',
        glyph: '◈',
        order: 20,
        build: function (W) {
            var config = {};
            var selection = null;
            var running = false;
            var controller = null;
            var loras = [];
            var controlNets = [];
            var loraModels = [];
            var cnModules = [];
            var cnModels = [];

            /* ---------- 连接 ---------- */
            var modeSelect = W.select([
                { value: 'local', labelKey: 'engine.modeLocal' },
                { value: 'cloud', labelKey: 'engine.modeCloud' }
            ], 'local', { onChange: function () { syncMode(); markDirty(); } });
            var localUrlInput = W.input({ value: '', mono: true, onInput: markDirty });
            var cloudUrlInput = W.input({ value: '', mono: true, onInput: markDirty });
            var tokenInput = W.input({ value: '', type: 'password', placeholderKey: 'engine.tokenOptional', onInput: markDirty });
            var statusNode = el('span', { class: 'field-hint' });
            var localField = W.field('engine.localUrl', localUrlInput);
            var cloudField = W.field('engine.cloudUrl', cloudUrlInput);

            var connectCard = W.card('engine.connection', { persistKey: 'forge-conn' }, null);
            connectCard.cardBody.appendChild(W.field('engine.mode', modeSelect));
            connectCard.cardBody.appendChild(localField);
            connectCard.cardBody.appendChild(cloudField);
            connectCard.cardBody.appendChild(W.field('engine.token', tokenInput));
            connectCard.cardBody.appendChild(el('div', { class: 'btn-row' }, [
                W.button('engine.connect', { variant: 'primary', size: 'sm', onClick: testConnection }),
                W.button('engine.models', { variant: 'ghost', size: 'sm', onClick: function () { refreshResources(true); } }),
                W.button('app.save', { size: 'sm', onClick: function () { saveConfig(true); } })
            ]));
            connectCard.cardBody.appendChild(el('div', { class: 'engine-status' }, [statusNode]));

            /* ---------- 提示词与基础参数 ---------- */
            var promptArea = W.textarea({ placeholderKey: 'ws.promptPlaceholder', rows: 3, onInput: markDirty });
            var negativeArea = W.textarea({ placeholderKey: 'ws.negativePlaceholder', rows: 2, onInput: markDirty });
            var generateModeSelect = W.select([
                { value: 'img2img', labelKey: 'ws.modeImg2img' },
                { value: 'txt2img', labelKey: 'ws.modeTxt2img' }
            ], 'img2img', { onChange: function () { syncModeUi(); markDirty(); } });
            var modelSelect = W.select([], '', { placeholderKey: 'field.modelAuto', emptyKey: 'app.none' });
            var samplerSelect = W.select([], 'Euler a', { placeholderKey: 'field.sampler' });

            var stepsSlider = W.slider({ labelKey: 'field.steps', min: 1, max: 150, step: 1, value: 20 });
            var cfgSlider = W.slider({ labelKey: 'field.cfg', min: 1, max: 30, step: 0.5, value: 7 });
            var denoiseSlider = W.slider({ labelKey: 'field.denoise', min: 0, max: 1, step: 0.01, value: 0.75 });
            var batchSlider = W.slider({ labelKey: 'field.batch', min: 1, max: 8, step: 1, value: 1 });
            var widthSlider = W.slider({ labelKey: 'field.width', min: 256, max: 2048, step: 64, value: 1024 });
            var heightSlider = W.slider({ labelKey: 'field.height', min: 256, max: 2048, step: 64, value: 1024 });
            var seedInput = W.input({ value: '-1', number: true, onInput: markDirty });

            var promptCard = W.card('ws.prompt', { emphasis: 'primary' }, null);
            promptCard.cardBody.appendChild(W.field('field.positive', promptArea));
            promptCard.cardBody.appendChild(W.field('field.negative', negativeArea));

            var paramCard = W.card('engine.title', { persistKey: 'forge-params' }, null);
            paramCard.cardBody.appendChild(el('div', { class: 'param-grid' }, [
                el('div', { class: 'param-cell' }, [W.field('ws.mode', generateModeSelect)]),
                el('div', { class: 'param-cell' }, [W.field('field.model', modelSelect)])
            ]));
            paramCard.cardBody.appendChild(W.field('field.sampler', samplerSelect));
            paramCard.cardBody.appendChild(el('div', { class: 'param-grid' }, [
                el('div', { class: 'param-cell' }, [stepsSlider]),
                el('div', { class: 'param-cell' }, [cfgSlider])
            ]));
            paramCard.cardBody.appendChild(el('div', { class: 'param-grid' }, [
                el('div', { class: 'param-cell' }, [denoiseSlider]),
                el('div', { class: 'param-cell' }, [batchSlider])
            ]));
            paramCard.cardBody.appendChild(el('div', { class: 'param-grid' }, [
                el('div', { class: 'param-cell' }, [widthSlider]),
                el('div', { class: 'param-cell' }, [heightSlider])
            ]));
            paramCard.cardBody.appendChild(W.field('field.seed', seedInput, 'field.seedRandom'));

            /* ---------- 输入图 ---------- */
            var selectionBlock = W.selectionPreview({
                actions: [W.miniButton('selection.read', { onClick: readSelection })]
            });
            var inputCard = W.card('selection.title', { persistKey: 'forge-input' }, null);
            inputCard.cardBody.appendChild(selectionBlock);

            /* ---------- LoRA / ControlNet ---------- */
            var loraHost = el('div', { class: 'stack', style: { gap: '6px' } });
            var cnHost = el('div', { class: 'stack', style: { gap: '6px' } });
            var advancedCard = W.card('engine.lora', { persistKey: 'forge-advanced', collapsed: true }, null);
            advancedCard.cardBody.appendChild(el('div', { class: 'section-head' }, [
                el('div', { class: 'section-title', text: W.t('engine.lora'), 'data-i18n': 'engine.lora' }),
                W.miniButton('engine.addLora', { onClick: function () { loras.push({ name: '', weight: 1 }); renderLoras(); } })
            ]));
            advancedCard.cardBody.appendChild(loraHost);
            advancedCard.cardBody.appendChild(el('div', { class: 'divider' }));
            advancedCard.cardBody.appendChild(el('div', { class: 'section-head' }, [
                el('div', { class: 'section-title', text: W.t('engine.controlnet'), 'data-i18n': 'engine.controlnet' }),
                W.miniButton('engine.addControlNet', { onClick: function () { controlNets.push({ enabled: true, module: 'none', model: 'None', weight: 1 }); renderControlNets(); } })
            ]));
            advancedCard.cardBody.appendChild(cnHost);

            /* ---------- 执行 ---------- */
            var progressBar = el('span', { class: 'progress-bar' });
            var progressWrap = el('div', { class: 'progress', hidden: true }, [progressBar]);
            var runStatus = el('div', { class: 'field-hint', text: W.t('engine.waiting'), 'data-i18n': 'engine.waiting' });
            var generateBtn = W.button('engine.generate', { variant: 'primary', size: 'lg', glyph: '▶', block: true, onClick: run });
            var stopBtn = W.button('engine.stop', { variant: 'quiet', size: 'lg', disabled: true, onClick: stop });
            var presetSaveBtn = W.miniButton('engine.presetSave', { onClick: savePreset });

            var runCard = W.card('engine.forgeTitle', { emphasis: 'primary', extra: presetSaveBtn }, null);
            runCard.cardBody.appendChild(progressWrap);
            runCard.cardBody.appendChild(runStatus);
            runCard.cardBody.appendChild(el('div', { class: 'action-bar', style: { border: 'none', padding: '0', boxShadow: 'none', background: 'transparent' } }, [
                el('div', { class: 'action-bar-main' }, [generateBtn]),
                stopBtn
            ]));

            var resultFrame = W.previewFrame({ placeholderKey: 'ws.resultEmpty' });
            var resultCard = W.card('ws.resultTitle', { persistKey: 'forge-result', collapsed: true }, null);
            resultCard.cardBody.appendChild(resultFrame);

            var page = W.page('engine.forgeTitle', { id: 'forge', subtitleKey: 'engine.title' });
            page.appendChild(connectCard);
            page.appendChild(promptCard);
            page.appendChild(paramCard);
            page.appendChild(inputCard);
            page.appendChild(advancedCard);
            page.appendChild(runCard);
            page.appendChild(resultCard);

            /* ============================================================
             * 行为
             * ============================================================ */

            function markDirty() { markDirty.flag = true; }

            function restore() {
                config = DreamAI.Forge ? DreamAI.Forge.loadConfig() : {};
                modeSelect.setValue(config.endpointMode || 'local', true);
                localUrlInput.value = config.localUrl || '';
                cloudUrlInput.value = config.cloudUrl || '';
                tokenInput.value = config.apiToken || '';
                promptArea.value = config.prompt || '';
                negativeArea.value = config.negativePrompt || '';
                generateModeSelect.setValue(config.generateMode || 'img2img', true);
                stepsSlider.setValue(util.toNumber(config.steps, 20), true);
                cfgSlider.setValue(util.toNumber(config.cfg, 7), true);
                denoiseSlider.setValue(util.toNumber(config.denoise, 0.75), true);
                batchSlider.setValue(util.toNumber(config.batch, 1), true);
                widthSlider.setValue(util.toNumber(config.width, 1024), true);
                heightSlider.setValue(util.toNumber(config.height, 1024), true);
                seedInput.value = String(config.seed === undefined ? -1 : config.seed);
                loras = Array.isArray(config.loras) ? config.loras.slice() : [];
                controlNets = Array.isArray(config.controlNets) ? config.controlNets.slice() : [];
                renderLoras();
                renderControlNets();
                syncMode();
                syncModeUi();
            }

            function syncMode() {
                var isCloud = modeSelect.getValue() === 'cloud';
                localField.style.display = isCloud ? 'none' : '';
                cloudField.style.display = isCloud ? 'none' : '';
            }

            function syncModeUi() {
                var isImg2img = generateModeSelect.getValue() === 'img2img';
                denoiseSlider.style.opacity = isImg2img ? '1' : '0.45';
                inputCard.style.opacity = isImg2img ? '1' : '0.72';
            }

            function endpoint() {
                return modeSelect.getValue() === 'cloud'
                    ? cloudUrlInput.value.trim()
                    : localUrlInput.value.trim();
            }

            function buildCtx(onProgress) {
                return {
                    baseUrl: endpoint(),
                    apiToken: tokenInput.value.trim(),
                    timeout: 3600000,
                    pollInterval: 1000,
                    log: function (level, message, meta) {
                        if (typeof DreamAI.logbus[level] === 'function') DreamAI.logbus[level](message, meta);
                        else DreamAI.logbus.info(message, meta);
                    },
                    onProgress: onProgress,
                    signal: controller ? controller.signal : null
                };
            }

            function saveConfig(notify) {
                if (!DreamAI.Forge) return;
                DreamAI.Forge.saveConfig({
                    endpointMode: modeSelect.getValue(),
                    localUrl: localUrlInput.value.trim(),
                    cloudUrl: cloudUrlInput.value.trim(),
                    apiToken: tokenInput.value.trim(),
                    generateMode: generateModeSelect.getValue(),
                    prompt: promptArea.value,
                    negativePrompt: negativeArea.value,
                    model: modelSelect.getValue() || '',
                    sampler: samplerSelect.getValue() || 'Euler a',
                    steps: stepsSlider.getValue(),
                    cfg: cfgSlider.getValue(),
                    denoise: denoiseSlider.getValue(),
                    batch: batchSlider.getValue(),
                    seed: util.toNumber(seedInput.value, -1),
                    width: widthSlider.getValue(),
                    height: heightSlider.getValue(),
                    loras: loras,
                    controlNets: controlNets
                });
                markDirty.flag = false;
                if (notify) DreamAI.Shell.toast('app.saved', { tone: 'ok' });
            }

            function testConnection() {
                if (!DreamAI.Forge) {
                    DreamAI.Shell.toast('app.notConfigured', { tone: 'warn' });
                    return;
                }
                if (!endpoint()) {
                    DreamAI.Shell.toast('app.needUrl', { tone: 'warn' });
                    return;
                }
                saveConfig(false);
                statusNode.textContent = W.t('app.testing');
                Promise.resolve(DreamAI.Forge.testConnection(buildCtx(null))).then(function (result) {
                    statusNode.textContent = W.t('engine.connected');
                    var models = (result && result.models) || [];
                    if (models.length) {
                        modelSelect.setItems(models.map(function (m) { return { value: m.id || m, label: m.id || m }; }), true);
                        if (config.model) modelSelect.setValue(config.model, true);
                    }
                    var samplers = (result && result.samplers) || [];
                    if (samplers.length) {
                        samplerSelect.setItems(samplers.map(function (s) { return { value: s, label: s }; }), true);
                        samplerSelect.setValue(config.sampler || samplers[0], true);
                    }
                }, function (error) {
                    statusNode.textContent = W.t('engine.connectFail', { reason: error && error.message ? error.message : String(error) });
                });
            }

            function refreshResources(notify) {
                if (!DreamAI.Forge) return;
                var ctx = buildCtx(null);
                statusNode.textContent = W.t('app.loading');
                Promise.resolve()
                    .then(function () {
                        return Promise.all([
                            DreamAI.Forge.listModels(ctx),
                            DreamAI.Forge.listSamplers(ctx),
                            DreamAI.Forge.listLoras(ctx).catch(function () { return []; }),
                            DreamAI.Forge.listControlNets(ctx).catch(function () { return { modules: [], models: [] }; })
                        ]);
                    })
                    .then(function (results) {
                        var models = Array.isArray(results[0]) ? results[0] : [];
                        var samplers = Array.isArray(results[1]) ? results[1] : [];
                        loraModels = Array.isArray(results[2]) ? results[2] : [];
                        var cn = results[3] || {};
                        cnModules = Array.isArray(cn.modules) ? cn.modules : [];
                        cnModels = Array.isArray(cn.models) ? cn.models : [];
                        modelSelect.setItems(models.map(function (m) { return { value: m.id || m, label: m.id || m }; }), true);
                        samplerSelect.setItems(samplers.map(function (s) { return { value: s, label: s }; }), true);
                        renderLoras();
                        renderControlNets();
                        statusNode.textContent = W.t('engine.connected');
                        if (notify) DreamAI.Shell.toast(W.t('settings.modelsFetched', { count: models.length }), { tone: 'ok' });
                    }, function (error) {
                        statusNode.textContent = W.t('engine.connectFail', { reason: error && error.message ? error.message : String(error) });
                    });
            }

            function renderLoras() {
                util.clear(loraHost);
                if (!loras.length) {
                    loraHost.appendChild(el('div', { class: 'field-hint', text: W.t('app.none'), 'data-i18n': 'app.none' }));
                    return;
                }
                for (var i = 0; i < loras.length; i++) {
                    (function (index) {
                        var options = loraModels.map(function (item) {
                            return { value: item.name, label: item.alias || item.name };
                        });
                        if (!options.length) options = [{ value: '', labelKey: 'app.none' }];
                        var select = W.select(options, loras[index].name, {
                            placeholderKey: 'engine.lora',
                            onChange: function (value) { loras[index].name = value; markDirty.flag = true; }
                        });
                        var weight = W.slider({
                            labelKey: 'engine.weight',
                            min: 0,
                            max: 2,
                            step: 0.05,
                            value: util.toNumber(loras[index].weight, 1),
                            onInput: function (value) { loras[index].weight = value; }
                        });
                        loraHost.appendChild(el('div', { class: 'engine-lora-row' }, [
                            el('div', { class: 'inline', style: { justifyContent: 'space-between' } }, [
                                el('span', { class: 'field-hint', text: W.t('engine.lora') + ' ' + (index + 1) }),
                                W.miniButton('app.remove', { onClick: function () { loras.splice(index, 1); renderLoras(); } })
                            ]),
                            select,
                            weight
                        ]));
                    })(i);
                }
            }

            function renderControlNets() {
                util.clear(cnHost);
                if (!controlNets.length) {
                    cnHost.appendChild(el('div', { class: 'field-hint', text: W.t('app.none'), 'data-i18n': 'app.none' }));
                    return;
                }
                for (var i = 0; i < controlNets.length; i++) {
                    (function (index) {
                        var entry = controlNets[index];
                        var moduleOptions = (cnModules.length ? cnModules : ['none']).map(function (m) {
                            return { value: m, label: m };
                        });
                        var modelOptions = (cnModels.length ? cnModels : ['None']).map(function (m) {
                            return { value: m, label: m };
                        });
                        var moduleSelect = W.select(moduleOptions, entry.module, {
                            onChange: function (value) { entry.module = value; markDirty.flag = true; }
                        });
                        var modelSelect2 = W.select(modelOptions, entry.model, {
                            onChange: function (value) { entry.model = value; markDirty.flag = true; }
                        });
                        var weight = W.slider({
                            labelKey: 'engine.weight',
                            min: 0,
                            max: 2,
                            step: 0.05,
                            value: util.toNumber(entry.weight, 1),
                            onInput: function (value) { entry.weight = value; }
                        });
                        cnHost.appendChild(el('div', { class: 'engine-cn-card' }, [
                            el('div', { class: 'inline', style: { justifyContent: 'space-between' } }, [
                                el('span', { class: 'engine-cn-title', text: W.t('engine.controlnet') + ' ' + (index + 1) }),
                                W.miniButton('app.remove', { onClick: function () { controlNets.splice(index, 1); renderControlNets(); } })
                            ]),
                            W.row('engine.preprocessor', moduleSelect),
                            W.row('engine.cnModel', modelSelect2),
                            weight
                        ]));
                    })(i);
                }
            }

            function readSelection() {
                if (!DreamAI.PhotoIO || !DreamAI.PhotoIO.isAvailable()) {
                    DreamAI.Shell.toast('selection.browserOnly', { tone: 'warn' });
                    return Promise.resolve(null);
                }
                DreamAI.Shell.status('selection.reading', { key: 'selection.reading', tone: 'busy' });
                return DreamAI.PhotoIO.readSelection().then(function (sample) {
                    selection = sample;
                    selectionBlock.update(sample);
                    return sample;
                }, function () {
                    DreamAI.Shell.toast('selection.empty', { tone: 'warn' });
                    return null;
                });
            }

            function setRunning(value) {
                running = !!value;
                generateBtn.setAttribute('disabled', running ? '' : null);
                stopBtn.setAttribute('disabled', running ? null : '');
                progressWrap.removeAttribute('hidden');
                if (!running) setTimeout(function () { progressWrap.setAttribute('hidden', ''); }, 1200);
            }

            function setProgress(percent, detail) {
                if (percent === null || percent === undefined || percent < 0) return;
                var clamped = util.clamp(percent, 0, 100);
                progressBar.style.width = clamped + '%';
                runStatus.textContent = detail || (W.t('engine.progress') + ' ' + Math.round(clamped) + '%');
                DreamAI.Shell.setProgress(clamped);
            }

            function run() {
                if (running || !DreamAI.Forge) return;
                var mode = generateModeSelect.getValue();
                if (!(promptArea.value || '').trim()) {
                    DreamAI.Shell.toast('ws.needPrompt', { tone: 'warn' });
                    return;
                }
                if (mode === 'img2img' && !selection) {
                    DreamAI.Shell.toast('ws.needSelection', { tone: 'warn' });
                    return;
                }
                if (!endpoint()) {
                    DreamAI.Shell.toast('app.needUrl', { tone: 'warn' });
                    return;
                }
                saveConfig(false);
                controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
                setRunning(true);
                setProgress(5, W.t('app.busy'));

                var request = {
                    prompt: promptArea.value,
                    negativePrompt: negativeArea.value,
                    mode: mode,
                    images: mode === 'img2img' && selection ? [selection.dataUrl] : [],
                    params: {
                        model: modelSelect.getValue() || '',
                        sampler: samplerSelect.getValue() || 'Euler a',
                        steps: stepsSlider.getValue(),
                        cfg: cfgSlider.getValue(),
                        denoise: denoiseSlider.getValue(),
                        batch: batchSlider.getValue(),
                        seed: util.toNumber(seedInput.value, -1),
                        width: widthSlider.getValue(),
                        height: heightSlider.getValue(),
                        loras: loras.filter(function (item) { return item.name; }),
                        controlNets: controlNets.filter(function (item) { return item.enabled && item.module && item.module !== 'none'; })
                    }
                };

                Promise.resolve(DreamAI.Forge.run(buildCtx(setProgress), request))
                    .then(function (result) {
                        setProgress(100, W.t('state.done'));
                        if (result && result.images && result.images.length) {
                            resultFrame.setImage(result.images[0].dataUrl);
                            resultCard.setCollapsed(false);
                            archive(result.images, request);
                            writeBack(result.images[0]);
                        } else {
                            DreamAI.Shell.toast('state.failed', { tone: 'error' });
                        }
                    }, function (error) {
                        var reason = error && error.message ? error.message : String(error);
                        setProgress(0, reason);
                        DreamAI.Shell.toast(reason, { tone: 'error' });
                        DreamAI.logbus.error('Forge 生成失败：' + reason, { domain: 'forge' });
                    })
                    .then(function () {
                        setRunning(false);
                        controller = null;
                        DreamAI.Shell.setProgress(null);
                    });
            }

            function stop() {
                if (!DreamAI.Forge || !running) return;
                if (controller) {
                    try { controller.abort(); } catch (error) { /* 忽略 */ }
                }
                Promise.resolve(DreamAI.Forge.interrupt(buildCtx(null))).then(function () {
                    DreamAI.Shell.toast('engine.canceled', { tone: 'warn' });
                }, function () { /* 静默 */ });
            }

            function archive(images, request) {
                if (!DreamAI.Gallery) return;
                for (var i = 0; i < images.length; i++) {
                    DreamAI.Gallery.add(images[i].dataUrl, {
                        prompt: request.prompt,
                        providerId: 'forge',
                        modelId: request.params.model || 'forge',
                        mode: request.mode,
                        width: images[i].width || request.params.width,
                        height: images[i].height || request.params.height
                    });
                }
            }

            function writeBack(image) {
                if (!image) return;
                var behavior = DreamAI.App.get('settings.behavior', {}) || {};
                if (behavior.autoReturn === false) return;
                if (!DreamAI.PhotoReturn || !DreamAI.PhotoReturn.isAvailable()) return;
                DreamAI.PhotoReturn.place(image.dataUrl, {
                    bounds: selection ? selection.bounds : null,
                    documentId: selection ? selection.documentId : undefined,
                    layerName: 'Dream AI Forge',
                    blendMode: behavior.returnBlendMode || 'normal',
                    feather: util.toNumber(behavior.returnFeather, 0),
                    colorMatch: behavior.colorMatchOnReturn !== false,
                    colorMatchMethod: behavior.colorMatchMethod || 'meanStd',
                    colorMatchReference: selection ? selection.dataUrl : null
                }).then(function (result) {
                    DreamAI.Shell.toast(W.t('return.done', { name: result.layerName }), { tone: 'ok' });
                }, function (error) {
                    DreamAI.Shell.toast(W.t('return.failed', { reason: error && error.message ? error.message : String(error) }), { tone: 'error' });
                });
            }

            function savePreset() {
                // 插件不内置提示词库：把当前提示词存成用户自建条目，存在自定义域里，
                // 不随插件分发，也不出现在任何"推荐"位置。
                DreamAI.Shell.prompt('engine.presetName', { placeholderKey: 'engine.presetName' }).then(function (name) {
                    if (!name) return;
                    // 存在独立域里（不是 workbench 界面状态），键名也刻意保持 kebab-case
                    var stored = DreamAI.Store.read('custom-prompts', { items: [] });
                    var custom = Array.isArray(stored.items) ? stored.items.slice() : [];
                    custom.push({
                        id: util.uid('custom'),
                        name: name,
                        prompt: promptArea.value,
                        negativePrompt: negativeArea.value,
                        size: widthSlider.getValue() + 'x' + heightSlider.getValue(),
                        note: [modelSelect.getValue(), samplerSelect.getValue()].filter(Boolean).join(' · '),
                        createdAt: Date.now()
                    });
                    DreamAI.Store.write('custom-prompts', { items: custom.slice(-50) });
                    DreamAI.Shell.toast('app.saved', { tone: 'ok' });
                });
            }

            return {
                el: page,
                mount: function () {
                    restore();
                    refreshResources(false);
                },
                unmount: function () { if (markDirty.flag) saveConfig(false); },
                refresh: function () { syncModeUi(); }
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
