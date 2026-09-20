/*
 * ui/pages/comfyui.js — ComfyUI 工作台
 *
 * 职责：连接配置、工作流导入与校验、参数注入、选区上传、生成与进度、结果回写。
 * 边界：HTTP 细节全在 src/local/comfyui.js；本页只做界面与任务编排。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    DreamAI.Router.register({
        id: 'comfyui',
        group: 'engine',
        labelKey: 'nav.comfyui',
        glyph: '◈',
        order: 10,
        build: function (W) {
            var config = {};
            var params = [];
            var selection = null;
            var running = false;
            var controller = null;
            var progressTimer = null;
            var progressValue = 0;

            /* ---------- 连接配置 ---------- */
            var modeSelect = W.select([
                { value: 'local', labelKey: 'engine.modeLocal' },
                { value: 'cloud', labelKey: 'engine.modeCloud' }
            ], 'local', { onChange: function () { syncMode(); markDirty(); } });
            var localUrlInput = W.input({ value: '', mono: true, onInput: markDirty });
            var cloudUrlInput = W.input({ value: '', mono: true, onInput: markDirty });
            var tokenInput = W.input({ value: '', type: 'password', placeholderKey: 'engine.tokenOptional', onInput: markDirty });
            var timeoutSlider = W.slider({ labelKey: 'field.timeout', min: 60, max: 86400, step: 60, value: 3600 });
            var statusNode = el('span', { class: 'field-hint', text: W.t('app.notConfigured') });
            var localField = W.field('engine.localUrl', localUrlInput);
            var cloudField = W.field('engine.cloudUrl', cloudUrlInput);

            var connectCard = W.card('engine.connection', { persistKey: 'comfy-conn' }, null);
            connectCard.cardBody.appendChild(el('div', { class: 'param-grid' }, [
                el('div', { class: 'param-cell' }, [W.field('engine.mode', modeSelect)]),
                el('div', { class: 'param-cell' }, [timeoutSlider])
            ]));
            connectCard.cardBody.appendChild(localField);
            connectCard.cardBody.appendChild(cloudField);
            connectCard.cardBody.appendChild(W.field('engine.token', tokenInput));
            connectCard.cardBody.appendChild(el('div', { class: 'btn-row' }, [
                W.button('engine.connect', { variant: 'primary', size: 'sm', onClick: testConnection }),
                W.button('app.save', { size: 'sm', onClick: function () { saveConfig(true); } })
            ]));
            connectCard.cardBody.appendChild(el('div', { class: 'engine-status' }, [statusNode]));

            /* ---------- 工作流 ---------- */
            var workflowArea = W.textarea({
                placeholderKey: 'engine.workflowPaste',
                mono: true,
                tall: true,
                onInput: function () { markDirty(); }
            });
            var workflowFile = el('input', { type: 'file', accept: '.json,application/json', class: 'file-input' });
            workflowFile.addEventListener('change', loadWorkflowFile);
            var workflowName = el('span', { class: 'field-hint' });
            var paramsHost = el('div', { class: 'engine-params' });
            var promptArea = W.textarea({ placeholderKey: 'ws.promptPlaceholder', rows: 3, onInput: markDirty });
            var negativeArea = W.textarea({ placeholderKey: 'ws.negativePlaceholder', rows: 2, onInput: markDirty });

            var workflowCard = W.card('engine.workflow', {
                extra: el('div', { class: 'inline' }, [workflowName])
            }, null);
            workflowCard.cardBody.appendChild(el('div', { class: 'btn-row' }, [
                W.button('engine.workflowLoad', { variant: 'ghost', size: 'sm', glyph: '↑', onClick: function () { workflowFile.click(); } }),
                W.button('engine.workflowValidate', { variant: 'ghost', size: 'sm', onClick: validateWorkflow }),
                W.button('app.clear', { variant: 'quiet', size: 'sm', onClick: function () {
                    workflowArea.value = '';
                    workflowName.textContent = '';
                    markDirty();
                } })
            ]));
            workflowCard.cardBody.appendChild(workflowFile);
            workflowCard.cardBody.appendChild(workflowArea);
            workflowCard.cardBody.appendChild(el('div', { class: 'divider' }));
            workflowCard.cardBody.appendChild(W.field('field.positive', promptArea));
            workflowCard.cardBody.appendChild(W.field('field.negative', negativeArea));
            workflowCard.cardBody.appendChild(paramsHost);

            /* ---------- 输入与执行 ---------- */
            var selectionBlock = W.selectionPreview({
                actions: [W.miniButton('selection.read', { onClick: readSelection })]
            });
            var inputCard = W.card('selection.title', { persistKey: 'comfy-input', collapsed: true }, null);
            inputCard.cardBody.appendChild(selectionBlock);

            var progressBar = el('span', { class: 'progress-bar' });
            var progressWrap = el('div', { class: 'progress', hidden: true }, [progressBar]);
            var runStatus = el('div', { class: 'field-hint', text: W.t('engine.waiting'), 'data-i18n': 'engine.waiting' });
            var generateBtn = W.button('engine.generate', { variant: 'primary', size: 'lg', glyph: '▶', block: true, onClick: run });
            var stopBtn = W.button('engine.stop', { variant: 'quiet', size: 'lg', disabled: true, onClick: stop });

            var runCard = W.card('engine.title', { emphasis: 'primary' }, null);
            runCard.cardBody.appendChild(progressWrap);
            runCard.cardBody.appendChild(runStatus);
            runCard.cardBody.appendChild(el('div', { class: 'action-bar', style: { border: 'none', padding: '0', boxShadow: 'none', background: 'transparent' } }, [
                el('div', { class: 'action-bar-main' }, [generateBtn]),
                stopBtn
            ]));

            var resultFrame = W.previewFrame({ placeholderKey: 'ws.resultEmpty' });
            var resultCard = W.card('ws.resultTitle', { persistKey: 'comfy-result', collapsed: true }, null);
            resultCard.cardBody.appendChild(resultFrame);

            var page = W.page('engine.comfyTitle', { id: 'comfyui', subtitleKey: 'engine.title' });
            page.appendChild(connectCard);
            page.appendChild(workflowCard);
            page.appendChild(inputCard);
            page.appendChild(runCard);
            page.appendChild(resultCard);

            /* ============================================================
             * 行为
             * ============================================================ */

            function markDirty() { markDirty.flag = true; }

            function restore() {
                config = DreamAI.ComfyUI ? DreamAI.ComfyUI.loadConfig() : {};
                modeSelect.setValue(config.endpointMode || 'local', true);
                localUrlInput.value = config.localUrl || '';
                cloudUrlInput.value = config.cloudUrl || '';
                tokenInput.value = config.apiToken || '';
                timeoutSlider.setValue(util.toNumber(config.timeout, 3600), true);
                workflowArea.value = config.workflowJson || '';
                workflowName.textContent = config.workflowName || '';
                promptArea.value = config.prompt || '';
                syncMode();
                renderParams();
            }

            function syncMode() {
                var isCloud = modeSelect.getValue() === 'cloud';
                localField.style.display = isCloud ? 'none' : '';
                cloudField.style.display = isCloud ? 'none' : '';
            }

            function saveConfig(notify) {
                if (!DreamAI.ComfyUI) return;
                DreamAI.ComfyUI.saveConfig({
                    endpointMode: modeSelect.getValue(),
                    localUrl: localUrlInput.value.trim(),
                    cloudUrl: cloudUrlInput.value.trim(),
                    apiToken: tokenInput.value.trim(),
                    timeout: timeoutSlider.getValue(),
                    workflowJson: workflowArea.value,
                    workflowName: workflowName.textContent,
                    prompt: promptArea.value
                });
                markDirty.flag = false;
                if (notify) DreamAI.Shell.toast('app.saved', { tone: 'ok' });
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
                    timeout: util.toNumber(timeoutSlider.getValue(), 3600) * 1000,
                    pollInterval: 1000,
                    log: function (level, message, meta) {
                        if (typeof DreamAI.logbus[level] === 'function') DreamAI.logbus[level](message, meta);
                        else DreamAI.logbus.info(message, meta);
                    },
                    onProgress: onProgress,
                    signal: controller ? controller.signal : null
                };
            }

            function testConnection() {
                if (!DreamAI.ComfyUI) {
                    DreamAI.Shell.toast('app.notConfigured', { tone: 'warn' });
                    return;
                }
                if (!endpoint()) {
                    DreamAI.Shell.toast('app.needUrl', { tone: 'warn' });
                    return;
                }
                saveConfig(false);
                statusNode.textContent = W.t('app.testing');
                Promise.resolve(DreamAI.ComfyUI.testConnection(buildCtx(null))).then(function (result) {
                    statusNode.textContent = W.t('engine.connected') + (result && result.device ? ' · ' + result.device : '');
                    DreamAI.Shell.status('app.online', { key: 'app.online', tone: 'ok', autoClear: 2200 });
                }, function (error) {
                    statusNode.textContent = W.t('engine.connectFail', { reason: error && error.message ? error.message : String(error) });
                });
            }

            function loadWorkflowFile() {
                var file = workflowFile.files && workflowFile.files[0];
                workflowFile.value = '';
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function () {
                    workflowArea.value = String(reader.result || '');
                    workflowName.textContent = file.name || '';
                    markDirty.flag = true;
                    validateWorkflow();
                };
                reader.readAsText(file);
            }

            function validateWorkflow() {
                if (!DreamAI.ComfyUI) return;
                var text = workflowArea.value.trim();
                if (!text) {
                    DreamAI.Shell.toast('engine.workflowEmpty', { tone: 'warn' });
                    return;
                }
                var result = DreamAI.ComfyUI.validateWorkflow(text);
                if (result.ok) {
                    DreamAI.Shell.toast(W.t('engine.workflowValid', { count: result.nodeCount }), { tone: 'ok' });
                    var parsed = parseWorkflow(text);
                    if (parsed) params = DreamAI.ComfyUI.extractParams(parsed);
                    renderParams();
                } else {
                    DreamAI.Shell.toast(result.reason || W.t('engine.workflowInvalid', { reason: '' }), { tone: 'error' });
                }
            }

            function parseWorkflow(text) {
                try {
                    var parsed = JSON.parse(text);
                    if (parsed && parsed.prompt) return parsed.prompt;
                    return parsed;
                } catch (error) {
                    return null;
                }
            }

            function renderParams() {
                util.clear(paramsHost);
                if (!params.length) return;
                paramsHost.appendChild(el('div', { class: 'strong', text: W.t('engine.paramsLoaded', { count: params.length }) }));
                for (var i = 0; i < params.length; i++) {
                    (function (param) {
                        var value = param.value;
                        var control;
                        if (typeof value === 'number') {
                            control = W.input({
                                value: String(value),
                                number: true,
                                onChange: function (next) { param.value = util.toNumber(next, value); }
                            });
                        } else {
                            control = W.input({
                                value: value === undefined || value === null ? '' : String(value),
                                onChange: function (next) { param.value = next; }
                            });
                        }
                        paramsHost.appendChild(W.row(param.label || (param.nodeId + '.' + param.key), control));
                    })(params[i]);
                }
                paramsHost.appendChild(el('div', { class: 'btn-row' }, [
                    W.button('app.reset', { variant: 'quiet', size: 'sm', onClick: function () {
                        var parsed = parseWorkflow(workflowArea.value);
                        if (parsed) { params = DreamAI.ComfyUI.extractParams(parsed); renderParams(); }
                    } })
                ]));
            }

            function collectParamPatch() {
                var patch = {};
                for (var i = 0; i < params.length; i++) {
                    patch[params[i].nodeId + '.' + params[i].key] = params[i].value;
                }
                return patch;
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
                }, function (error) {
                    DreamAI.Shell.toast('selection.empty', { tone: 'warn' });
                    return null;
                });
            }

            function setRunning(value) {
                running = !!value;
                generateBtn.setAttribute('disabled', running ? '' : null);
                stopBtn.setAttribute('disabled', running ? null : '');
                progressWrap.removeAttribute('hidden');
                if (!running) {
                    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
                    setTimeout(function () { progressWrap.setAttribute('hidden', ''); }, 1200);
                }
            }

            function setProgress(percent, detail) {
                progressValue = util.clamp(percent, 0, 100);
                progressBar.style.width = progressValue + '%';
                runStatus.textContent = detail || (W.t('engine.progress') + ' ' + Math.round(progressValue) + '%');
                DreamAI.Shell.setProgress(progressValue);
            }

            function run() {
                if (running || !DreamAI.ComfyUI) return;
                var text = workflowArea.value.trim();
                if (!text) {
                    DreamAI.Shell.toast('engine.workflowEmpty', { tone: 'warn' });
                    return;
                }
                var validation = DreamAI.ComfyUI.validateWorkflow(text);
                if (!validation.ok) {
                    DreamAI.Shell.toast(validation.reason, { tone: 'error' });
                    return;
                }
                if (!endpoint()) {
                    DreamAI.Shell.toast('app.needUrl', { tone: 'warn' });
                    return;
                }
                saveConfig(false);
                controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
                setRunning(true);
                setProgress(3, W.t('app.busy'));

                var images = selection ? [selection.dataUrl] : [];
                var request = {
                    workflow: text,
                    prompt: promptArea.value,
                    negativePrompt: negativeArea.value,
                    images: images,
                    params: collectParamPatch()
                };

                Promise.resolve(DreamAI.ComfyUI.run(buildCtx(setProgress), request))
                    .then(function (result) {
                        setProgress(100, W.t('state.done'));
                        if (result && result.images && result.images.length) {
                            resultFrame.setImage(result.images[0].dataUrl);
                            resultCard.setCollapsed(false);
                            archive(result.images, request.prompt);
                            writeBack(result.images[0]);
                        } else {
                            DreamAI.Shell.toast('state.failed', { tone: 'error' });
                        }
                    }, function (error) {
                        var reason = error && error.message ? error.message : String(error);
                        setProgress(0, reason);
                        DreamAI.Shell.toast(reason, { tone: 'error' });
                        DreamAI.logbus.error('ComfyUI 生成失败：' + reason, { domain: 'comfyui' });
                    })
                    .then(function () {
                        setRunning(false);
                        controller = null;
                        DreamAI.Shell.setProgress(null);
                    });
            }

            function stop() {
                if (!DreamAI.ComfyUI || !running) return;
                if (controller) {
                    try { controller.abort(); } catch (error) { /* 忽略 */ }
                }
                Promise.resolve(DreamAI.ComfyUI.interrupt(buildCtx(null))).then(function () {
                    DreamAI.Shell.toast('engine.canceled', { tone: 'warn' });
                }, function () { /* 中断失败也保持静默 */ });
            }

            function archive(images, prompt) {
                if (!DreamAI.Gallery || !images.length) return;
                for (var i = 0; i < images.length; i++) {
                    DreamAI.Gallery.add(images[i].dataUrl, {
                        prompt: prompt,
                        providerId: 'comfyui',
                        modelId: workflowName.textContent || 'comfyui',
                        mode: selection ? 'img2img' : 'txt2img',
                        width: images[i].width,
                        height: images[i].height
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
                    layerName: 'Dream AI ComfyUI',
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

            return {
                el: page,
                mount: restore,
                unmount: function () { if (markDirty.flag) saveConfig(false); },
                refresh: renderParams
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
