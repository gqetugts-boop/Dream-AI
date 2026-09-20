/*
 * ui/pages/workbench.js — 生图工作台
 *
 * 职责：
 *   - 选区预览与读取；
 *   - 参考图槽位（选区 / 上传，最多 4 张）；
 *   - 提示词与预设套用；
 *   - 渠道、模型、尺寸、数量等生成参数；
 *   - 提交任务并展示最近结果。
 * 边界：不做网络请求（交给 task-queue + providers）、不做回写（交给 photo-return）。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    var MAX_PROMPT = 5000;

    // 常用输出尺寸（按渠道能力给出通用档位）
    var SIZES = [
        { value: '1024x1024', ratio: '1:1' },
        { value: '1024x1536', ratio: '2:3' },
        { value: '1536x1024', ratio: '3:2' },
        { value: '896x1152', ratio: '3:4' },
        { value: '1152x896', ratio: '4:3' },
        { value: 'auto', ratio: 'auto' }
    ];

    DreamAI.Router.register({
        id: 'workbench',
        group: 'create',
        labelKey: 'nav.workbench',
        glyph: '◇',
        order: 10,
        build: function (W) {
            var state = {
                mode: 'txt2img',
                prompt: '',
                negativePrompt: '',
                providerId: '',
                modelId: '',
                size: '1024x1024',
                count: 1,
                useSelection: true,
                autoReturn: true,
                colorMatch: true,
                blendScreen: false,
                feather: 0,
                running: false,
                activeTaskId: null
            };
            var refs = [];
            var disposers = [];
            var logbus = DreamAI.logbus;

            /* ---------- 顶部：模式与选区 ---------- */
            var modeChips = W.chipGroup([
                { value: 'txt2img', labelKey: 'ws.modeTxt2img', glyph: '▤' },
                { value: 'img2img', labelKey: 'ws.modeImg2img', glyph: '▣' }
            ], state.mode, function (value) {
                state.mode = value;
                syncMode();
                persist();
            });

            var selectionBlock = W.selectionPreview({
                actions: [
                    W.miniButton('selection.read', { onClick: readSelection }),
                    W.miniButton('reference.addSelection', { onClick: addSelectionAsReference })
                ]
            });

            var modeHint = W.hint('ws.modeTxt2img', 'plain', '·');

            /* ---------- 参考图 ---------- */
            var refGrid = W.slotGrid([]);
            var refCounter = el('span', { class: 'slot-counter', text: '0 / 4' });
            var fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, class: 'file-input' });
            fileInput.addEventListener('change', function () {
                var files = fileInput.files ? Array.prototype.slice.call(fileInput.files) : [];
                for (var i = 0; i < files.length; i++) readFileAsReference(files[i]);
                fileInput.value = '';
            });

            var refCard = W.card('reference.title', {
                persistKey: 'wb-refs',
                extra: refCounter,
                subtitleKey: 'reference.hint'
            });
            refCard.cardBody.appendChild(el('div', { class: 'slot-toolbar' }, [
                el('span', { class: 'field-hint', text: W.t('reference.hint'), 'data-i18n': 'reference.hint' }),
                el('div', { class: 'inline' }, [
                    W.miniButton('reference.clearAll', { onClick: clearReferences })
                ])
            ]));
            refCard.cardBody.appendChild(refGrid);
            refCard.cardBody.appendChild(el('div', { class: 'btn-row' }, [
                W.button('reference.addSelection', { variant: 'ghost', size: 'sm', glyph: '▣', onClick: addSelectionAsReference }),
                W.button('reference.addUpload', { variant: 'ghost', size: 'sm', glyph: '↑', onClick: function () { fileInput.click(); } }),
                fileInput
            ]));

            /* ---------- 提示词 ---------- */
            var charCount = W.counter(MAX_PROMPT);
            var promptArea = W.textarea({
                placeholderKey: 'ws.promptPlaceholder',
                maxLength: MAX_PROMPT,
                tall: true,
                onInput: function (value) {
                    state.prompt = value;
                    charCount.setCount(value.length);
                    persistSoon();
                }
            });
            var negativeArea = W.textarea({
                placeholderKey: 'ws.negativePlaceholder',
                maxLength: MAX_PROMPT,
                onInput: function (value) {
                    state.negativePrompt = value;
                    persistSoon();
                }
            });
            var negativeToggle = W.checkbox('field.negative', false, {
                onChange: function (checked) { negativeWrap.removeAttribute('hidden'); negativeWrap.style.display = checked ? '' : 'none'; }
            });

            var promptCard = W.card('ws.prompt', { emphasis: 'primary' }, null);
            promptCard.cardBody.appendChild(promptArea);
            promptCard.cardBody.appendChild(el('div', { class: 'input-meta' }, [
                el('span', { text: W.t('ws.prompt'), 'data-i18n': 'ws.prompt' }),
                charCount
            ]));
            var negativeWrap = el('div', { class: 'field', hidden: true, style: { display: 'none' } }, [negativeArea]);
            negativeWrap.style.display = 'none';
            promptCard.cardBody.appendChild(negativeToggle);
            promptCard.cardBody.appendChild(negativeWrap);

            /* ---------- 渠道与模型 ---------- */
            var providerSelect = W.select([], '', {
                onChange: function (value) {
                    state.providerId = value;
                    DreamAI.App.saveWorkbench({ providerId: value });
                    DreamAI.App.saveSettings({ activeChannelId: value }, { silent: true });
                    refreshModels();
                    syncProviderHint();
                }
            });
            var modelSelect = W.select([], '', {
                placeholderKey: 'field.modelAuto',
                emptyKey: 'app.none',
                onChange: function (value) {
                    state.modelId = value;
                    DreamAI.App.saveWorkbench({ modelId: value });
                }
            });
            var modelFetchBtn = W.miniButton('settings.fetchModels', { onClick: function () { refreshModels(true); } });
            var providerStatus = el('span', { class: 'field-hint' });
            var providerHint = W.hint('settings.channelNative', 'plain', 'i');

            var sizeSelect = W.select(SIZES.map(function (item) {
                return { value: item.value, label: item.value === 'auto' ? W.t('app.auto') : item.value.replace('x', ' × '), note: item.ratio };
            }), state.size, {
                onChange: function (value) {
                    state.size = value;
                    DreamAI.App.saveWorkbench({ size: value });
                }
            });
            var countSelect = W.select([1, 2, 3, 4].map(function (n) {
                return { value: n, label: String(n) };
            }), 1, {
                onChange: function (value) {
                    state.count = util.toNumber(value, 1);
                    DreamAI.App.saveWorkbench({ count: state.count });
                }
            });

            var channelCard = W.card('field.provider', { persistKey: 'wb-channel' }, null);
            channelCard.cardBody.appendChild(W.row('field.provider', providerSelect));
            channelCard.cardBody.appendChild(W.row(
                'field.model',
                el('div', { class: 'inline', style: { gap: '4px' } }, [modelSelect, modelFetchBtn])
            ));
            channelCard.cardBody.appendChild(providerStatus);
            channelCard.cardBody.appendChild(providerHint);
            channelCard.cardBody.appendChild(W.divider());
            channelCard.cardBody.appendChild(el('div', { class: 'param-grid' }, [
                el('div', { class: 'param-cell' }, [W.field('field.size', sizeSelect)]),
                el('div', { class: 'param-cell' }, [W.field('field.count', countSelect)])
            ]));

            /* ---------- 回写设置 ---------- */
            var autoReturnCheck = W.checkbox('return.auto', true, {
                onChange: function (checked) { state.autoReturn = checked; DreamAI.App.saveWorkbench({ autoReturn: checked }); }
            });
            var colorMatchCheck = W.checkbox('return.colorMatch', true, {
                onChange: function (checked) { state.colorMatch = checked; DreamAI.App.saveWorkbench({ colorMatchOnReturn: checked }); }
            });
            var screenCheck = W.checkbox('return.blendScreen', false, {
                onChange: function (checked) { state.blendScreen = checked; DreamAI.App.saveWorkbench({ blendScreen: checked }); }
            });
            var featherSlider = W.slider({
                labelKey: 'return.feather',
                min: 0,
                max: 60,
                step: 1,
                value: 0,
                onInput: function (value) {
                    state.feather = value;
                    DreamAI.App.saveWorkbench({ returnFeather: value });
                }
            });

            var returnCard = W.card('return.title', { persistKey: 'wb-return', collapsed: true }, null);
            returnCard.cardBody.appendChild(autoReturnCheck);
            returnCard.cardBody.appendChild(colorMatchCheck);
            returnCard.cardBody.appendChild(screenCheck);
            returnCard.cardBody.appendChild(featherSlider);

            /* ---------- 操作区与结果 ---------- */
            var renderBtn = W.button('ws.render', { variant: 'primary', size: 'lg', glyph: '▶', block: true, onClick: submit });
            var stopBtn = W.button('ws.stop', { variant: 'quiet', size: 'lg', onClick: stopActive, disabled: true });
            var batchBtn = W.miniButton('batch.add', { onClick: addToBatch });
            var actionBar = el('div', { class: 'action-bar' }, [
                el('div', { class: 'action-bar-main' }, [renderBtn]),
                stopBtn
            ]);

            var resultFrame = W.previewFrame({ placeholderKey: 'ws.resultEmpty' });
            var resultMeta = el('div', { class: 'field-hint' });
            var resultCard = W.card('ws.resultTitle', { persistKey: 'wb-result', collapsed: true, extra: batchBtn }, null);
            resultCard.cardBody.appendChild(resultFrame);
            resultCard.cardBody.appendChild(resultMeta);

            /* ---------- 组装页面 ---------- */
            var page = W.page('ws.title', { id: 'workbench', subtitleKey: 'ws.styleHint' });
            page.appendChild(el('div', { class: 'section-head' }, [
                el('div', { class: 'section-title', text: W.t('ws.mode'), 'data-i18n': 'ws.mode' }),
                el('div', { class: 'section-actions' }, [modeChips])
            ]));
            page.appendChild(selectionBlock);
            page.appendChild(modeHint);
            page.appendChild(promptCard);
            page.appendChild(refCard);
            page.appendChild(channelCard);
            page.appendChild(returnCard);
            page.appendChild(actionBar);
            page.appendChild(resultCard);

            /* ============================================================
             * 行为
             * ============================================================ */

            var persistSoon = util.debounce(function () { persist(); }, 400);

            function persist() {
                DreamAI.App.saveWorkbench({
                    mode: state.mode,
                    prompt: state.prompt,
                    negativePrompt: state.negativePrompt,
                    providerId: state.providerId,
                    modelId: state.modelId,
                    size: state.size,
                    count: state.count
                });
            }

            function syncMode() {
                var isImg2img = state.mode === 'img2img';
                modeHint.setText(null, isImg2img ? 'ws.modeImg2img' : 'ws.modeTxt2img');
                if (isImg2img && !DreamAI.App.selection) modeHint.setTone('warn');
                else modeHint.setTone('plain');
                renderBtn.setAttribute('disabled', state.running ? '' : null);
            }

            function refreshProviders() {
                var providers = DreamAI.Providers ? DreamAI.Providers.list() : [];
                var items = [];
                for (var i = 0; i < providers.length; i++) {
                    items.push({ value: providers[i].id, labelKey: providers[i].labelKey, label: providers[i].id });
                }
                providerSelect.setItems(items, true);
                var preferred = DreamAI.App.get('settings.activeChannelId', '');
                var exists = items.some(function (item) { return item.value === preferred; });
                if (!state.providerId || !items.some(function (item) { return item.value === state.providerId; })) {
                    state.providerId = exists ? preferred : (items.length ? items[0].value : '');
                }
                providerSelect.setValue(state.providerId, true);
                refreshModels();
                syncProviderHint();
            }

            function refreshModels(forceFetch) {
                var provider = DreamAI.Providers ? DreamAI.Providers.get(state.providerId) : null;
                var cached = DreamAI.App.get('settings.modelCache.' + state.providerId, []);
                var items = (Array.isArray(cached) ? cached : []).map(function (id) {
                    return { value: id, label: id };
                });
                modelSelect.setItems(items, true);
                if (state.modelId && items.some(function (item) { return item.value === state.modelId; })) {
                    modelSelect.setValue(state.modelId, true);
                } else {
                    state.modelId = '';
                    modelSelect.setValue('', true);
                }
                modelFetchBtn.removeAttribute('disabled');
                if (!provider) {
                    providerStatus.textContent = W.t('app.notConfigured');
                    return;
                }
                if (!provider.supports || !provider.supports.models) {
                    providerStatus.textContent = W.t('app.notConfigured');
                } else if (items.length) {
                    providerStatus.textContent = W.t('settings.modelsFetched', { count: items.length });
                } else {
                    providerStatus.textContent = W.t('app.notConfigured');
                }
                if (forceFetch) fetchModels();
            }

            function fetchModels() {
                var provider = DreamAI.Providers ? DreamAI.Providers.get(state.providerId) : null;
                if (!provider || typeof provider.listModels !== 'function') {
                    W.pill('');
                    return Promise.resolve();
                }
                modelFetchBtn.setAttribute('disabled', '');
                providerStatus.textContent = W.t('app.testing');
                return Promise.resolve()
                    .then(function () {
                        var ctx = DreamAI.Providers.createContext(provider.id);
                        return provider.listModels(ctx);
                    })
                    .then(function (models) {
                        var ids = (Array.isArray(models) ? models : []).map(function (item) {
                            return typeof item === 'string' ? item : item.id;
                        }).filter(Boolean);
                        var patch = {};
                        patch[provider.id] = ids;
                        DreamAI.App.saveSettings({ modelCache: patch }, { silent: true });
                        refreshModels();
                        DreamAI.Shell.toast(W.t('settings.modelsFetched', { count: ids.length }), { tone: 'ok' });
                    }, function (error) {
                        providerStatus.textContent = W.t('settings.testFail', { reason: error && error.message ? error.message : String(error) });
                        providerStatus.setAttribute('data-tone', 'error');
                        DreamAI.logbus.warn('拉取模型失败：' + (error && error.message), { domain: 'workbench' });
                    })
                    .then(function () { modelFetchBtn.removeAttribute('disabled'); });
            }

            function syncProviderHint() {
                var provider = DreamAI.Providers ? DreamAI.Providers.get(state.providerId) : null;
                var key = provider && provider.id === 'native' ? 'settings.channelNative'
                    : provider && provider.id === 'xai' ? 'settings.channelXai'
                        : provider && provider.id === 'grok' ? 'settings.channelGrok'
                            : 'settings.channelOpenAI';
                providerHint.setText(null, key);
            }

            function refreshSelection() {
                selectionBlock.update(DreamAI.App.selection);
                syncMode();
            }

            /*
             * 读取选区。
             *
             * 每一步都写一条日志：这条链路会跨"界面 → PhotoIO → psLock → UXP 宿主"
             * 四层，任何一层静默失败都会表现成"点了没反应"。有分步日志之后，
             * 点一次就能从日志看出卡在哪一层，不必再猜。
             */
            function readSelection() {
                var io = DreamAI.PhotoIO;
                logbus.info('请求读取选区', { domain: 'workbench', step: 'start' });

                if (!io) {
                    logbus.error('PhotoIO 未加载', { domain: 'workbench', step: 'guard' });
                    DreamAI.Shell.toast('selection.browserOnly', { tone: 'warn' });
                    return Promise.resolve(null);
                }
                var available = false;
                try { available = io.isAvailable(); } catch (e) { available = false; }
                if (!available) {
                    logbus.warn('宿主不支持读取选区（hasPhotoshop=' +
                        (DreamAI.host && DreamAI.host.hasPhotoshop) + '）', { domain: 'workbench', step: 'guard' });
                    DreamAI.Shell.toast('selection.browserOnly', { tone: 'warn' });
                    selectionBlock.setStatus(W.t('selection.browserOnly'), 'warn');
                    return Promise.resolve(null);
                }

                DreamAI.Shell.status('selection.reading', { key: 'selection.reading', tone: 'busy' });
                selectionBlock.setStatus(W.t('selection.reading'), 'plain');

                return Promise.resolve(io.readSelection()).then(function (sample) {
                    var dataUrl = sample && sample.dataUrl ? String(sample.dataUrl) : '';
                    logbus.success('选区读取成功 ' + (sample ? sample.width + 'x' + sample.height : '?') +
                        ' · 图像 ' + Math.round(dataUrl.length / 1024) + ' KB', { domain: 'workbench', step: 'done' });
                    DreamAI.Shell.status('selection.ready', { key: 'selection.ready', tone: 'ok', autoClear: 2000 });
                    refreshSelection();
                    return sample;
                }, function (error) {
                    var reason = error && error.message ? error.message : String(error);
                    logbus.error('读取选区失败：' + reason, {
                        domain: 'workbench',
                        step: 'failed',
                        stack: error && error.stack ? String(error.stack).split('\n').slice(0, 3).join(' | ') : ''
                    });
                    DreamAI.Shell.toast(reason, { tone: 'error' });
                    DreamAI.Shell.status('selection.empty', { key: 'selection.empty', tone: 'warn', autoClear: 2600 });
                    selectionBlock.setStatus(reason, 'error');
                    return null;
                });
            }

            function readFileAsReference(file) {
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function () {
                    addReference({
                        id: util.uid('ref'),
                        dataUrl: String(reader.result || ''),
                        source: 'upload',
                        name: file.name || '',
                        addedAt: Date.now()
                    });
                };
                reader.onerror = function () {
                    DreamAI.Shell.toast('app.empty', { tone: 'error' });
                };
                reader.readAsDataURL(file);
            }

            function addSelectionAsReference() {
                var selection = DreamAI.App.selection;
                if (!selection) {
                    DreamAI.Shell.toast('selection.empty', { tone: 'warn' });
                    return;
                }
                addReference({
                    id: util.uid('ref'),
                    dataUrl: selection.dataUrl,
                    width: selection.width,
                    height: selection.height,
                    source: 'selection',
                    addedAt: Date.now()
                });
            }

            function addReference(entry) {
                if (!DreamAI.App.addReference(entry)) return;
                renderReferences();
            }

            function clearReferences() {
                DreamAI.App.setReferences([]);
                renderReferences();
            }

            function renderReferences() {
                refs = DreamAI.App.references.slice();
                var max = util.toNumber(DreamAI.App.get('settings.behavior.referenceMax', 4), 4);
                util.clear(refGrid);
                for (var i = 0; i < max; i++) {
                    refGrid.appendChild(W.imageSlot({
                        index: i,
                        dataUrl: refs[i] ? refs[i].dataUrl : '',
                        emptyKey: 'reference.empty',
                        onRemove: function (index) {
                            var target = refs[index];
                            if (target) DreamAI.App.removeReference(target.id);
                            renderReferences();
                        },
                        onClick: function (index) {
                            if (refs[index]) return;
                            addSelectionAsReference();
                        }
                    }));
                }
                refCounter.textContent = W.t('reference.count', { used: refs.length, max: max });
            }

            function buildRequest() {
                var inputs = [];
                if (state.mode === 'img2img' && DreamAI.App.selection) {
                    inputs.push({ dataUrl: DreamAI.App.selection.dataUrl, role: 'init' });
                }
                for (var i = 0; i < refs.length; i++) {
                    inputs.push({ dataUrl: refs[i].dataUrl, role: 'reference' });
                }
                return {
                    prompt: state.prompt,
                    negativePrompt: state.negativePrompt,
                    mode: inputs.length ? (state.mode === 'img2img' ? 'img2img' : 'edit') : 'txt2img',
                    size: state.size,
                    count: state.count,
                    images: inputs
                };
            }

            function submit() {
                if (state.running) return;
                if (!state.prompt.trim()) {
                    DreamAI.Shell.toast('ws.needPrompt', { tone: 'warn' });
                    promptArea.focus && promptArea.focus();
                    return;
                }
                if (state.mode === 'img2img' && !DreamAI.App.selection) {
                    DreamAI.Shell.toast('ws.needSelection', { tone: 'warn' });
                    return;
                }
                if (!DreamAI.TaskQueue) {
                    DreamAI.Shell.toast('state.failed', { tone: 'error' });
                    return;
                }
                var selection = DreamAI.App.selection;
                var task = DreamAI.TaskQueue.enqueue({
                    title: util.truncate(state.prompt, 40),
                    providerId: state.providerId,
                    modelId: state.modelId,
                    mode: buildRequest().mode,
                    prompt: buildPromptWithSystem(state.prompt, state.negativePrompt),
                    request: buildRequest(),
                    autoReturn: state.autoReturn,
                    selectionBounds: selection ? selection.bounds : null,
                    selectionDocumentId: selection ? selection.documentId : null,
                    selectionDataUrl: selection ? selection.dataUrl : null,
                    returnOptions: {
                        bounds: selection ? selection.bounds : null,
                        documentId: selection ? selection.documentId : undefined,
                        blendMode: state.blendScreen ? 'screen' : 'normal',
                        feather: state.feather,
                        colorMatch: state.colorMatch,
                        colorMatchMethod: DreamAI.App.get('settings.behavior.colorMatchMethod', 'meanStd'),
                        colorMatchReference: selection ? selection.dataUrl : null
                    }
                });
                state.running = true;
                state.activeTaskId = task.id;
                syncRunningUi(true);
                DreamAI.Shell.toast(W.t('ws.submitted', { id: task.id.slice(-6) }), { tone: 'info' });
            }

            function buildPromptWithSystem(prompt, negative) {
                var sys = DreamAI.App.get('settings.systemPrompt', {}) || {};
                var parts = [];
                if (sys.positive) parts.push(sys.positive);
                parts.push(prompt);
                var negativeParts = [];
                if (negative) negativeParts.push(negative);
                if (sys.negative) negativeParts.push(sys.negative);
                return {
                    prompt: parts.join(', '),
                    negativePrompt: negativeParts.join(', ')
                };
            }

            function syncRunningUi(running) {
                state.running = !!running;
                renderBtn.setAttribute('disabled', running ? '' : null);
                renderBtn.lastChild.textContent = running ? W.t('ws.renderBusy') : W.t('ws.render');
                stopBtn.setAttribute('disabled', running ? null : '');
            }

            function stopActive() {
                if (state.activeTaskId && DreamAI.TaskQueue) {
                    DreamAI.TaskQueue.cancel(state.activeTaskId);
                }
                syncRunningUi(false);
            }

            function addToBatch() {
                if (!DreamAI.Batch) return;
                if (!state.prompt.trim()) {
                    DreamAI.Shell.toast('ws.needPrompt', { tone: 'warn' });
                    return;
                }
                DreamAI.Batch.add({
                    prompt: state.prompt,
                    negativePrompt: state.negativePrompt,
                    providerId: state.providerId,
                    modelId: state.modelId,
                    size: state.size,
                    count: state.count,
                    note: ''
                });
                DreamAI.Shell.toast('batch.added', { tone: 'ok' });
            }

            function onTaskUpdate(payload) {
                var task = payload && payload.task;
                if (!task) return;
                if (task.id !== state.activeTaskId) return;
                if (task.state === 'done') {
                    syncRunningUi(false);
                    showResult(task);
                } else if (task.state === 'failed' || task.state === 'canceled' || task.state === 'timeout') {
                    syncRunningUi(false);
                    if (task.error) DreamAI.Shell.toast(task.error, { tone: 'error' });
                }
            }

            function showResult(task) {
                if (!task.images || !task.images.length) return;
                var image = task.images[0];
                resultFrame.setImage(image.dataUrl);
                var parts = [];
                if (image.width && image.height) parts.push(image.width + ' × ' + image.height);
                if (task.modelId) parts.push(task.modelId);
                if (task.startedAt && task.finishedAt) parts.push(util.formatDuration((task.finishedAt - task.startedAt) / 1000));
                if (task.meta && task.meta.returned) parts.push(W.t('return.asLayer') + ': ' + task.meta.returned);
                resultMeta.textContent = parts.join(' · ');
                resultCard.setCollapsed(false);
            }

            function restore() {
                var workbench = DreamAI.App.workbench || {};
                state.mode = workbench.mode === 'img2img' ? 'img2img' : 'txt2img';
                state.prompt = workbench.prompt || '';
                state.negativePrompt = workbench.negativePrompt || '';
                state.providerId = workbench.providerId || DreamAI.App.get('settings.activeChannelId', '');
                state.modelId = workbench.modelId || '';
                state.size = workbench.size || '1024x1024';
                state.count = util.toNumber(workbench.count, 1);
                state.autoReturn = workbench.autoReturn !== false;
                state.colorMatch = workbench.colorMatchOnReturn !== false;
                state.blendScreen = !!workbench.blendScreen;
                state.feather = util.toNumber(workbench.returnFeather, 0);

                modeChips.setValue(state.mode);
                promptArea.value = state.prompt;
                negativeArea.value = state.negativePrompt;
                charCount.setCount(state.prompt.length);
                sizeSelect.setValue(state.size, true);
                countSelect.setValue(state.count, true);
                autoReturnCheck.setValue(state.autoReturn);
                colorMatchCheck.setValue(state.colorMatch);
                screenCheck.setValue(state.blendScreen);
                featherSlider.setValue(state.feather, true);
                if (state.negativePrompt) {
                    negativeWrap.style.display = '';
                    negativeWrap.removeAttribute('hidden');
                    negativeToggle.setValue(true);
                }
            }

            disposers.push(DreamAI.bus.on('task:update', onTaskUpdate));
            disposers.push(DreamAI.bus.on('task:finished', onTaskUpdate));
            disposers.push(DreamAI.bus.on('selection:change', refreshSelection));
            disposers.push(DreamAI.bus.on('references:change', renderReferences));

            return {
                el: page,
                mount: function () {
                    restore();
                    refreshProviders();
                    renderReferences();
                    refreshSelection();
                    syncMode();
                },
                unmount: function () {
                    persist();
                },
                refresh: function () {
                    refreshSelection();
                }
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
