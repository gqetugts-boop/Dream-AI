/*
 * ui/pages/settings.js — 设置
 *
 * 职责：
 *   - 服务渠道配置（密钥、地址、模型、连接测试）；
 *   - 生成行为默认值（回写、校色、并发、超时、采样上限）；
 *   - 系统提示词；
 *   - 数据与存储（画廊保留策略、清理、重置）。
 * 边界：只读写 DreamAI.App.settings / DreamAI.App.saveSettings，不直接碰 Provider 实现。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    DreamAI.Router.register({
        id: 'settings',
        group: 'system',
        labelKey: 'nav.settings',
        glyph: '⚙',
        order: 10,
        build: function (W) {
            var channelControls = {};
            var statusNodes = {};
            var dirty = false;
            var disposers = [];

            /* ============================================================
             * 渠道配置
             * ============================================================ */
            var channelContainer = el('div', { class: 'settings-group' });
            var channelCard = W.card('settings.channels', { persistKey: 'st-channels' }, null);
            channelCard.cardBody.appendChild(channelContainer);

            function buildChannels() {
                util.clear(channelContainer);
                channelControls = {};
                statusNodes = {};
                var providers = DreamAI.Providers ? DreamAI.Providers.list() : [];
                for (var i = 0; i < providers.length; i++) {
                    channelContainer.appendChild(buildChannelBlock(providers[i]));
                }
                if (!providers.length) {
                    channelContainer.appendChild(W.empty('⚙', 'app.notConfigured'));
                }
            }

            function buildChannelBlock(provider) {
                var channel = DreamAI.App.get('settings.channels.' + provider.id, {}) || {};
                var isNative = provider.id === 'native';

                var baseUrlInput = W.input({
                    value: channel.baseUrl || provider.defaultBaseUrl || '',
                    placeholder: provider.defaultBaseUrl || '',
                    mono: true,
                    onInput: function (value) { markDirty(); }
                });
                var keyInput = W.input({
                    value: channel.apiKey || '',
                    type: 'password',
                    placeholderKey: 'field.apiKey',
                    onInput: function () { markDirty(); }
                });
                var modelInput = W.input({
                    value: channel.model || '',
                    placeholderKey: 'field.modelAuto',
                    onInput: function () { markDirty(); }
                });
                var chatModelInput = W.input({
                    value: channel.chatModel || '',
                    placeholderKey: 'field.modelAuto',
                    onInput: function () { markDirty(); }
                });
                var statusNode = el('span', { class: 'field-hint', text: W.t('app.notConfigured') });
                var modelList = W.select([], '', { placeholderKey: 'field.modelAuto', emptyKey: 'app.none' });

                channelControls[provider.id] = {
                    provider: provider,
                    baseUrlInput: baseUrlInput,
                    keyInput: keyInput,
                    modelInput: modelInput,
                    chatModelInput: chatModelInput,
                    modelList: modelList
                };
                statusNodes[provider.id] = statusNode;

                var body = [];
                if (!isNative) {
                    body.push(W.field('field.baseUrl', baseUrlInput));
                    body.push(W.field('field.apiKey', keyInput));
                }
                body.push(W.field('field.model', modelInput));
                if (provider.supports && provider.supports.chat) {
                    body.push(W.field('field.model', chatModelInput, 'about.shortcutSendChat'));
                }

                var actions = [];
                if (provider.supports && provider.supports.models) {
                    actions.push(W.button('settings.test', {
                        variant: 'primary',
                        size: 'sm',
                        onClick: function () { testChannel(provider.id); }
                    }));
                    actions.push(W.button('settings.fetchModels', {
                        variant: 'ghost',
                        size: 'sm',
                        onClick: function () { fetchModels(provider.id); }
                    }));
                }
                if (provider.supports && provider.supports.balance) {
                    actions.push(W.button('settings.balance', {
                        variant: 'ghost',
                        size: 'sm',
                        onClick: function () { checkBalance(provider.id); }
                    }));
                }
                if (actions.length) {
                    body.push(el('div', { class: 'btn-row' }, actions));
                }
                body.push(el('div', { class: 'channel-status' }, [statusNode]));
                if (modelList) {
                    body.push(modelList);
                }

                var sub = W.card(provider.labelKey, { collapsed: true, persistKey: 'st-ch-' + provider.id }, null);
                for (var i = 0; i < body.length; i++) sub.cardBody.appendChild(body[i]);
                return sub;
            }

            function readChannel(providerId) {
                var controls = channelControls[providerId];
                if (!controls) return null;
                return {
                    baseUrl: controls.baseUrlInput.value.trim(),
                    apiKey: controls.keyInput.value.trim(),
                    model: controls.modelInput.value.trim(),
                    chatModel: controls.chatModelInput ? controls.chatModelInput.value.trim() : ''
                };
            }

            function collectChannels() {
                var out = {};
                for (var id in channelControls) {
                    if (!Object.prototype.hasOwnProperty.call(channelControls, id)) continue;
                    out[id] = readChannel(id);
                }
                return out;
            }

            function saveChannels() {
                var channels = DreamAI.App.get('settings.channels', {}) || {};
                var current = collectChannels();
                for (var id in current) {
                    if (!Object.prototype.hasOwnProperty.call(current, id)) continue;
                    channels[id] = util.deepMerge(channels[id] || {}, current[id]);
                }
                DreamAI.App.saveSettings({ channels: channels });
                return channels;
            }

            function buildContextFor(providerId) {
                saveChannels();
                return DreamAI.Providers.createContext(providerId);
            }

            function setStatus(providerId, text, tone) {
                var node = statusNodes[providerId];
                if (!node) return;
                node.textContent = text;
                if (tone) node.setAttribute('data-tone', tone);
                else node.removeAttribute('data-tone');
            }

            function testChannel(providerId) {
                var provider = DreamAI.Providers ? DreamAI.Providers.get(providerId) : null;
                if (!provider) return;
                setStatus(providerId, W.t('app.testing'), 'busy');
                DreamAI.Shell.status('app.testing', { key: 'app.testing', tone: 'busy' });
                Promise.resolve()
                    .then(function () {
                        var ctx = buildContextFor(providerId);
                        return typeof provider.test === 'function'
                            ? provider.test(ctx)
                            : provider.listModels(ctx).then(function (models) { return { ok: true, models: models }; });
                    })
                    .then(function (result) {
                        var models = result && result.models ? result.models : [];
                        setStatus(providerId, W.t('settings.testOk', { count: models.length }), 'ok');
                        DreamAI.Shell.status('app.online', { key: 'app.online', tone: 'ok', autoClear: 2200 });
                        if (models.length) cacheModels(providerId, models);
                    }, function (error) {
                        var reason = error && error.message ? error.message : String(error);
                        setStatus(providerId, W.t('settings.testFail', { reason: reason }), 'error');
                        DreamAI.Shell.toast(W.t('settings.testFail', { reason: reason }), { tone: 'error' });
                    });
            }

            function fetchModels(providerId) {
                var provider = DreamAI.Providers ? DreamAI.Providers.get(providerId) : null;
                if (!provider || typeof provider.listModels !== 'function') return;
                setStatus(providerId, W.t('app.loading'), 'busy');
                Promise.resolve()
                    .then(function () { return provider.listModels(buildContextFor(providerId)); })
                    .then(function (models) {
                        cacheModels(providerId, models);
                        setStatus(providerId, W.t('settings.modelsFetched', { count: models.length }), 'ok');
                    }, function (error) {
                        setStatus(providerId, W.t('settings.testFail', { reason: error && error.message }), 'error');
                    });
            }

            function cacheModels(providerId, models) {
                var ids = (Array.isArray(models) ? models : []).map(function (item) {
                    return typeof item === 'string' ? item : item.id;
                }).filter(Boolean);
                var patch = {};
                patch[providerId] = ids;
                DreamAI.App.saveSettings({ modelCache: patch }, { silent: true });
                var controls = channelControls[providerId];
                if (controls && controls.modelList) {
                    controls.modelList.setItems(ids.map(function (id) { return { value: id, label: id }; }), true);
                }
            }

            function checkBalance(providerId) {
                var provider = DreamAI.Providers ? DreamAI.Providers.get(providerId) : null;
                if (!provider || typeof provider.checkBalance !== 'function') return;
                setStatus(providerId, W.t('app.loading'), 'busy');
                Promise.resolve()
                    .then(function () { return provider.checkBalance(buildContextFor(providerId)); })
                    .then(function (result) {
                        setStatus(providerId, W.t('settings.balanceResult', { value: result && result.display ? result.display : '-' }), 'ok');
                    }, function (error) {
                        setStatus(providerId, W.t('settings.testFail', { reason: error && error.message }), 'error');
                    });
            }

            /* ============================================================
             * 生成行为
             * ============================================================ */
            var behavior = DreamAI.App.get('settings.behavior', {}) || {};

            var autoReturnCheck = W.checkbox('return.auto', behavior.autoReturn !== false, {});
            var colorMatchCheck = W.checkbox('return.colorMatch', behavior.colorMatchOnReturn !== false, {});
            var blendSelect = W.select([
                { value: 'normal', labelKey: 'return.blendNormal' },
                { value: 'screen', labelKey: 'return.blendScreen' }
            ], behavior.returnBlendMode || 'normal', {});
            var methodSelect = W.select([], behavior.colorMatchMethod || 'meanStd', {});
            var featherSlider = W.slider({ labelKey: 'return.feather', min: 0, max: 60, step: 1, value: util.toNumber(behavior.returnFeather, 0) });
            var pollSlider = W.slider({ labelKey: 'settings.pollInterval', min: 500, max: 20000, step: 500, value: util.toNumber(behavior.pollInterval, 3000) });
            var timeoutSlider = W.slider({ labelKey: 'settings.gpuQueue', min: 60, max: 3600, step: 30, value: Math.round(util.toNumber(behavior.requestTimeout, 300000) / 1000) });
            var concurrentSlider = W.slider({ labelKey: 'settings.maxConcurrent', min: 1, max: 5, step: 1, value: util.toNumber(behavior.maxConcurrent, 1) });
            var sampleSlider = W.slider({ labelKey: 'tools.sampleSize', min: 512, max: 4096, step: 128, value: util.toNumber(behavior.sampleMaxEdge, 1536) });
            var refSlider = W.slider({ labelKey: 'reference.title', min: 1, max: 4, step: 1, value: util.toNumber(behavior.referenceMax, 4) });

            function refreshMethodOptions() {
                var methods = DreamAI.ColorEngine && DreamAI.ColorEngine.METHODS ? DreamAI.ColorEngine.METHODS : [];
                var items = methods.map(function (method) {
                    return { value: method.id, labelKey: method.labelKey, label: method.id };
                });
                if (!items.length) {
                    items = [
                        { value: 'meanStd', labelKey: 'tools.methodMeanStd' },
                        { value: 'histogram', labelKey: 'tools.methodHistogram' }
                    ];
                }
                methodSelect.setItems(items, true);
            }

            var behaviorCard = W.card('settings.behavior', { persistKey: 'st-behavior' }, null);
            behaviorCard.cardBody.appendChild(autoReturnCheck);
            behaviorCard.cardBody.appendChild(colorMatchCheck);
            behaviorCard.cardBody.appendChild(W.row('return.colorMatchMethod', methodSelect));
            behaviorCard.cardBody.appendChild(W.row('return.blendScreen', blendSelect));
            behaviorCard.cardBody.appendChild(featherSlider);
            behaviorCard.cardBody.appendChild(el('div', { class: 'divider' }));
            behaviorCard.cardBody.appendChild(pollSlider);
            behaviorCard.cardBody.appendChild(timeoutSlider);
            behaviorCard.cardBody.appendChild(concurrentSlider);
            behaviorCard.cardBody.appendChild(sampleSlider);
            behaviorCard.cardBody.appendChild(refSlider);

            /* ============================================================
             * 系统提示词
             * ============================================================ */
            var systemPrompts = DreamAI.App.get('settings.systemPrompt', {}) || {};
            var chatPrompts = DreamAI.App.get('settings.chatSystemPrompt', {}) || {};
            var sysPositive = W.textarea({ placeholderKey: 'settings.systemPromptHint', value: systemPrompts.positive || '' });
            var sysNegative = W.textarea({ placeholderKey: 'settings.systemPromptHint', value: systemPrompts.negative || '' });
            var chatPositive = W.textarea({ placeholderKey: 'settings.systemPromptHint', value: chatPrompts.positive || '' });
            var chatNegative = W.textarea({ placeholderKey: 'settings.systemPromptHint', value: chatPrompts.negative || '' });

            var promptCard = W.card('settings.prompts', { persistKey: 'st-prompts', collapsed: true }, null);
            promptCard.cardBody.appendChild(W.field('settings.systemPromptPositive', sysPositive, 'settings.systemPromptHint'));
            promptCard.cardBody.appendChild(W.field('settings.systemPromptNegative', sysNegative));
            promptCard.cardBody.appendChild(el('div', { class: 'divider' }));
            promptCard.cardBody.appendChild(W.field('field.positive', chatPositive));
            promptCard.cardBody.appendChild(W.field('field.negative', chatNegative));

            /* ============================================================
             * 界面与数据
             * ============================================================ */
            var langSelect = W.select([
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en-US', label: 'English' }
            ], DreamAI.I18n.getLang(), {
                onChange: function (value) {
                    DreamAI.I18n.setLang(value);
                    DreamAI.App.saveSettings({ language: value }, { silent: true });
                }
            });
            var themeSelect = W.select([
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' }
            ], DreamAI.Theme.get(), {
                onChange: function (value) {
                    DreamAI.Theme.set(value);
                    DreamAI.App.saveSettings({ theme: value }, { silent: true });
                }
            });
            var accentSelect = W.select([
                { value: 'morandi', labelKey: 'field.accentMorandi' },
                { value: 'zhuang', labelKey: 'field.accentZhuang' }
            ], DreamAI.Theme.getAccent(), {
                onChange: function (value) {
                    DreamAI.Theme.setAccent(value);
                    DreamAI.App.saveSettings({ accent: value }, { silent: true });
                }
            });
            var scaleSlider = W.slider({
                labelKey: 'tools.spacer',
                min: 0.8,
                max: 1.6,
                step: 0.05,
                value: util.toNumber(DreamAI.App.get('settings.uiScale', 1), 1),
                onInput: function (value) {
                    DreamAI.App.applyUiScale(value);
                    DreamAI.App.saveSettings({ uiScale: value }, { silent: true });
                }
            });

            var retentionSelect = W.select([
                { value: 'count', labelKey: 'gallery.retentionCount' },
                { value: 'days', labelKey: 'gallery.retentionDays' },
                { value: 'both', labelKey: 'field.retention' }
            ], DreamAI.App.get('settings.gallery.mode', 'count'), {});
            var maxCountSlider = W.slider({ labelKey: 'gallery.retentionCount', min: 1, max: 500, step: 1, value: util.toNumber(DreamAI.App.get('settings.gallery.maxCount', 30), 30) });
            var maxDaysSlider = W.slider({ labelKey: 'gallery.retentionDays', min: 1, max: 365, step: 1, value: util.toNumber(DreamAI.App.get('settings.gallery.maxDays', 30), 30) });
            var galleryInfo = el('div', { class: 'field-hint' });

            var dataCard = W.card('settings.data', { persistKey: 'st-data', collapsed: true }, null);
            dataCard.cardBody.appendChild(W.row('field.language', langSelect));
            dataCard.cardBody.appendChild(W.row('field.theme', themeSelect));
            dataCard.cardBody.appendChild(W.row('field.accent', accentSelect));
            dataCard.cardBody.appendChild(scaleSlider);
            dataCard.cardBody.appendChild(el('div', { class: 'divider' }));
            dataCard.cardBody.appendChild(W.row('field.retention', retentionSelect));
            dataCard.cardBody.appendChild(maxCountSlider);
            dataCard.cardBody.appendChild(maxDaysSlider);
            dataCard.cardBody.appendChild(galleryInfo);
            dataCard.cardBody.appendChild(el('div', { class: 'btn-row' }, [
                W.button('gallery.prune', { variant: 'ghost', size: 'sm', onClick: pruneGallery }),
                W.button('settings.resetAll', { variant: 'danger', size: 'sm', onClick: resetAll }),
                W.button('app.save', { variant: 'primary', size: 'sm', onClick: function () { saveAll(true); } })
            ]));

            var page = W.page('settings.title', { id: 'settings' });
            page.appendChild(channelCard);
            page.appendChild(behaviorCard);
            page.appendChild(promptCard);
            page.appendChild(dataCard);

            /* ============================================================
             * 保存与刷新
             * ============================================================ */
            function markDirty() { dirty = true; }

            function saveAll(notify) {
                DreamAI.App.saveSettings({
                    channels: collectChannels(),
                    behavior: {
                        autoReturn: autoReturnCheck.getValue(),
                        colorMatchOnReturn: colorMatchCheck.getValue(),
                        colorMatchMethod: methodSelect.getValue(),
                        returnBlendMode: blendSelect.getValue(),
                        returnFeather: featherSlider.getValue(),
                        pollInterval: pollSlider.getValue(),
                        requestTimeout: timeoutSlider.getValue() * 1000,
                        maxConcurrent: concurrentSlider.getValue(),
                        sampleMaxEdge: sampleSlider.getValue(),
                        referenceMax: refSlider.getValue()
                    },
                    systemPrompt: {
                        positive: sysPositive.value,
                        negative: sysNegative.value
                    },
                    chatSystemPrompt: {
                        positive: chatPositive.value,
                        negative: chatNegative.value
                    },
                    gallery: {
                        mode: retentionSelect.getValue(),
                        maxCount: maxCountSlider.getValue(),
                        maxDays: maxDaysSlider.getValue()
                    },
                    uiScale: scaleSlider.getValue()
                });
                dirty = false;
                if (notify) {
                    DreamAI.Shell.toast('settings.savedAll', { tone: 'ok' });
                    DreamAI.logbus.info('设置已保存', { domain: 'settings' });
                }
            }

            function pruneGallery() {
                if (!DreamAI.Gallery) return;
                saveAll(false);
                DreamAI.Gallery.prune(DreamAI.Gallery.policy()).then(function (result) {
                    DreamAI.Shell.toast(W.t('gallery.pruned', { count: result && result.removed ? result.removed : 0 }), { tone: 'ok' });
                    refreshGalleryInfo();
                }, function (error) {
                    DreamAI.Shell.toast(W.t('state.failed') + ': ' + (error && error.message ? error.message : String(error)), { tone: 'error' });
                });
            }

            function resetAll() {
                DreamAI.Shell.confirm('settings.confirmReset', { danger: true }).then(function (ok) {
                    if (!ok) return;
                    var channels = DreamAI.App.get('settings.channels', {}) || {};
                    var cleared = {};
                    for (var id in channels) {
                        if (!Object.prototype.hasOwnProperty.call(channels, id)) continue;
                        cleared[id] = { baseUrl: channels[id].baseUrl || '', apiKey: '', model: channels[id].model || '' };
                    }
                    DreamAI.App.saveSettings(util.deepMerge(util.deepClone(DreamAI.App.SETTINGS_DEFAULTS), { channels: cleared }));
                    DreamAI.Shell.toast('settings.resetDone', { tone: 'ok' });
                    rebuild();
                });
            }

            function refreshGalleryInfo() {
                var policy = DreamAI.Gallery ? DreamAI.Gallery.policy() : { mode: 'count', maxCount: 30, maxDays: 30 };
                var count = DreamAI.Gallery ? DreamAI.Gallery.list().length : 0;
                galleryInfo.textContent = W.t('gallery.count', { count: count }) + ' · ' +
                    W.t('gallery.retentionCount') + ' ' + policy.maxCount + ' · ' +
                    W.t('gallery.retentionDays') + ' ' + policy.maxDays;
            }

            function rebuild() {
                buildChannels();
                refreshMethodOptions();
                var behavior2 = DreamAI.App.get('settings.behavior', {}) || {};
                autoReturnCheck.setValue(behavior2.autoReturn !== false);
                colorMatchCheck.setValue(behavior2.colorMatchOnReturn !== false);
                methodSelect.setValue(behavior2.colorMatchMethod || 'meanStd', true);
                blendSelect.setValue(behavior2.returnBlendMode || 'normal', true);
                featherSlider.setValue(util.toNumber(behavior2.returnFeather, 0), true);
                pollSlider.setValue(util.toNumber(behavior2.pollInterval, 3000), true);
                timeoutSlider.setValue(Math.round(util.toNumber(behavior2.requestTimeout, 300000) / 1000), true);
                concurrentSlider.setValue(util.toNumber(behavior2.maxConcurrent, 1), true);
                sampleSlider.setValue(util.toNumber(behavior2.sampleMaxEdge, 1536), true);
                refSlider.setValue(util.toNumber(behavior2.referenceMax, 4), true);
                var gallery = DreamAI.App.get('settings.gallery', {}) || {};
                retentionSelect.setValue(gallery.mode || 'count', true);
                maxCountSlider.setValue(util.toNumber(gallery.maxCount, 30), true);
                maxDaysSlider.setValue(util.toNumber(gallery.maxDays, 30), true);
                langSelect.setValue(DreamAI.I18n.getLang(), true);
                themeSelect.setValue(DreamAI.Theme.get(), true);
                accentSelect.setValue(DreamAI.Theme.getAccent(), true);
                scaleSlider.setValue(util.toNumber(DreamAI.App.get('settings.uiScale', 1), 1), true);
                refreshGalleryInfo();
            }

            // 快捷键保存
            if (global.document && global.document.addEventListener) {
                var onKey = function (event) {
                    var meta = event.metaKey || event.ctrlKey;
                    if (!meta) return;
                    if (String(event.key).toLowerCase() === 's') {
                        event.preventDefault();
                        saveAll(true);
                    }
                };
                global.document.addEventListener('keydown', onKey);
                disposers.push(function () { global.document.removeEventListener('keydown', onKey); });
            }

            disposers.push(DreamAI.bus.on('settings:change', function () {
                if (!dirty) rebuild();
            }));

            return {
                el: page,
                mount: function () { rebuild(); buildChannels(); refreshMethodOptions(); },
                unmount: function () { if (dirty) saveAll(false); },
                refresh: function () { refreshGalleryInfo(); }
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
