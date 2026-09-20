// ============================================================
//  views.js — 首页 / 参数 / 预设 / 对话 / 设置 五个视图
//
//  下拉一律内联展开（在主插件里已确认：浮层方案会被同页卡片盖住，
//  UXP 合成器不按全局 z-index 排序）。
//  所有动作通过 window.SatApp 回调，避免与 app.js 形成加载期循环依赖。
// ============================================================

window.SatViews = (function () {
    var VIEWS = ['viewHome', 'viewParams', 'viewPresets', 'viewChat', 'viewSettings'];
    var presetState = { category: '全部', keyword: '' };

    function app() {
        return window.SatApp || {};
    }

    function showView(name) {
        VIEWS.forEach(function (id) {
            SatBase.show(SatBase.el(id), id === name);
        });
    }

    function activeView() {
        for (var i = 0; i < VIEWS.length; i += 1) {
            var node = SatBase.el(VIEWS[i]);
            if (node && !node.classList.contains('sat-hidden')) return VIEWS[i];
        }
        return '';
    }

    // ---------- 通用控件 ----------

    /** 内联展开下拉。选项在文档流里展开，不用浮层。 */
    function inlineSelect(hostId, options, currentValue, onPick) {
        var host = SatBase.el(hostId);
        if (!host) return;
        SatBase.clear(host);

        var current = null;
        options.forEach(function (option) {
            if (String(option.value) === String(currentValue)) current = option;
        });
        if (!current && options.length) current = options[0];

        var wrapper = SatBase.make('div', 'sat-inline-select');
        var trigger = SatBase.make('div', 'sat-inline-trigger');
        trigger.appendChild(SatBase.make('span', 'sat-inline-value',
            current ? current.text : (options.length ? '（无选项）' : '（空）')));
        trigger.appendChild(SatBase.make('span', 'sat-inline-caret', '▼'));
        wrapper.appendChild(trigger);

        var list = SatBase.make('div', 'sat-inline-list');
        list.classList.add('sat-hidden');
        options.forEach(function (option) {
            var row = SatBase.make('div', 'sat-inline-option', option.text);
            if (current && String(option.value) === String(current.value)) row.classList.add('sat-active');
            row.onclick = function () {
                list.classList.add('sat-hidden');
                onPick(option.value, option);
            };
            list.appendChild(row);
        });
        wrapper.appendChild(list);

        trigger.onclick = function () {
            if (list.classList.contains('sat-hidden')) list.classList.remove('sat-hidden');
            else list.classList.add('sat-hidden');
        };

        host.appendChild(wrapper);
    }

    /** 一排可选标签。 */
    function chips(hostId, options, currentValue, onPick) {
        var host = SatBase.el(hostId);
        if (!host) return;
        SatBase.clear(host);
        options.forEach(function (option) {
            var chip = SatBase.make('div', 'sat-chip', option.text);
            if (String(option.value) === String(currentValue)) chip.classList.add('sat-active');
            if (option.disabled) chip.classList.add('sat-pie-disabled');
            chip.onclick = function () {
                if (option.disabled) return;
                onPick(option.value, option);
            };
            host.appendChild(chip);
        });
    }

    // ---------- 首页 ----------

    function renderHome() {
        var config = SatStore.get();
        var document_ = SatPs.available() ? SatPs.describeDocument() : { open: false };
        var channels = SatStore.channels();
        var fallbackMeta = SatProviders.channelInfo(config.channel) || {};
        var fallbackModel = (fallbackMeta.imageModels && fallbackMeta.imageModels[0]) || '';
        var parsed = SatProviders.parseModel(config.imageModel
            || SatProviders.buildModel(config.channel, fallbackModel));
        var info = SatProviders.channelInfo(parsed.channel || config.channel);

        var parts = [];
        parts.push(info ? info.label : '未选渠道');
        parts.push(parsed.model || '未选模型');
        parts.push(config.aspectRatio);
        parts.push(config.imageResolution === 'auto' ? '自动分辨率' : config.imageResolution);
        parts.push(config.imageCount + ' 张');
        if (config.referenceImages.length) parts.push('参考图 ' + config.referenceImages.length);
        var summary = SatBase.el('satParamSummary');
        if (summary) summary.textContent = parts.join(' · ');

        var keyMissing = [];
        Object.keys(channels).forEach(function (name) {
            var meta = SatProviders.channelInfo(name);
            if (!meta || meta.apiKeyOptional) return;
            if (!channels[name].apiKey) keyMissing.push(meta.label);
        });

        var promptMeta = SatBase.el('satPromptMeta');
        if (promptMeta) {
            var bits = [];
            bits.push(document_.open
                ? ('文档 ' + SatBase.truncate(document_.name, 18) + (document_.hasSelection ? ' · 有选区' : ' · 无选区'))
                : '没有打开的文档');
            if (keyMissing.length) {
                bits.push('缺密钥：' + keyMissing.join('/')
                    + '（打开主插件「设置 → 卫星插件共享配置」点一次导出即可自动同步）');
            }
            promptMeta.textContent = bits.join(' | ');
            promptMeta.className = keyMissing.length ? 'sat-note sat-danger' : 'sat-note';
        }

        var preview = SatBase.el('satPreview');
        var empty = SatBase.el('satPreviewEmpty');
        var result = SatStore.lastResult();
        if (preview) {
            if (result && result.dataUrl) {
                preview.src = result.dataUrl;
                preview.style.display = 'block';
                SatBase.show(empty, false);
            } else {
                preview.removeAttribute('src');
                preview.style.display = 'none';
                SatBase.show(empty, true);
            }
        }
        var hasResult = !!(result && result.dataUrl);
        var place = SatBase.el('satPlaceBtn');
        var saveAs = SatBase.el('satSaveAsBtn');
        if (place) place.disabled = !hasResult;
        if (saveAs) saveAs.disabled = !hasResult;
        // 没结果时整行藏掉，紧凑面板里每一点高度都要省
        SatBase.show(SatBase.el('satResultRow'), hasResult);
    }

    // ---------- 参数 ----------

    function renderParams() {
        var config = SatStore.get();
        var channels = SatStore.channels();

        chips('satChannelChips', SatProviders.channelNames().map(function (name) {
            var meta = SatProviders.channelInfo(name);
            return {
                value: name,
                text: meta.label + (meta.verified ? '' : '（未验证）'),
                disabled: !channels[name].apiKey && !meta.apiKeyOptional
            };
        }), config.channel, function (value) {
            var meta = SatProviders.channelInfo(value);
            var model = (meta.imageModels && meta.imageModels[0]) || '';
            SatStore.patch({ channel: value, imageModel: SatProviders.buildModel(value, model) });
            renderParams();
            renderHome();
            SatBase.status('已切换到 ' + meta.label, 'ok');
        });

        var activeMeta = SatProviders.channelInfo(config.channel) || {};
        var modelList = activeMeta.imageModels || [];
        var parsed = SatProviders.parseModel(config.imageModel);
        var modelOptions = modelList.map(function (name) {
            return { value: SatProviders.buildModel(config.channel, name), text: name };
        });
        if (parsed.channel === config.channel && parsed.model && modelList.indexOf(parsed.model) === -1) {
            modelOptions.unshift({ value: config.imageModel, text: parsed.model + '（自定义）' });
        }
        if (!modelOptions.length) {
            modelOptions.push({ value: config.imageModel, text: config.imageModel || '（该渠道无内置模型，请用共享配置指定）' });
        }
        inlineSelect('satImageModelSelect', modelOptions, config.imageModel, function (value) {
            SatStore.patch({ imageModel: value });
            renderParams();
            renderHome();
        });

        chips('satAspectChips', SatProviders.ASPECT_RATIOS.map(function (label) {
            return { value: label, text: label };
        }), config.aspectRatio, function (value) {
            SatStore.patch({ aspectRatio: value });
            renderParams();
            renderHome();
        });

        chips('satResolutionChips', SatProviders.RESOLUTIONS.map(function (label) {
            return { value: label, text: label === 'auto' ? '自动' : label };
        }), config.imageResolution, function (value) {
            SatStore.patch({ imageResolution: value });
            renderParams();
            renderHome();
        });

        chips('satCountChips', [1, 2, 3, 4].map(function (n) {
            return { value: n, text: n + ' 张' };
        }), config.imageCount, function (value) {
            SatStore.patch({ imageCount: Number(value) });
            renderParams();
            renderHome();
        });

        renderReferenceList();
    }

    function renderReferenceList() {
        var host = SatBase.el('satReferenceList');
        if (!host) return;
        SatBase.clear(host);
        var images = SatStore.get().referenceImages;
        if (!images.length) {
            host.appendChild(SatBase.make('div', 'sat-note', '还没有参考图。有参考图时请求会走 edits 端点。'));
            return;
        }
        images.forEach(function (image, index) {
            var row = SatBase.make('div', 'sat-row');
            var thumb = SatBase.make('img');
            thumb.src = image.dataUrl;
            thumb.style.width = '44px';
            thumb.style.height = '44px';
            thumb.style.borderRadius = SatBase.shapeRadius('squircle');
            thumb.style.marginRight = '6px';
            row.appendChild(thumb);
            row.appendChild(SatBase.make('div', 'sat-note',
                '#' + (index + 1) + ' ' + (image.label || '') + ' ' + image.width + '×' + image.height));
            var remove = SatBase.make('button', 'sat-icon-btn', '移除');
            remove.onclick = function () {
                var list = SatStore.get().referenceImages.slice();
                list.splice(index, 1);
                SatStore.patch({ referenceImages: list });
                renderReferenceList();
                renderHome();
            };
            row.appendChild(remove);
            host.appendChild(row);
        });
    }

    // ---------- 预设 ----------

    function renderPresets() {
        var presets = app().presets ? app().presets() : [];
        var categories = ['全部'];
        presets.forEach(function (preset) {
            var category = preset.category || '未分类';
            if (categories.indexOf(category) === -1) categories.push(category);
        });

        chips('satPresetCategories', categories.map(function (name) {
            return { value: name, text: name };
        }), presetState.category, function (value) {
            presetState.category = value;
            renderPresets();
        });

        var keyword = presetState.keyword.trim().toLowerCase();
        var filtered = presets.filter(function (preset) {
            if (presetState.category !== '全部' && (preset.category || '未分类') !== presetState.category) return false;
            if (!keyword) return true;
            return (preset.name || '').toLowerCase().indexOf(keyword) > -1
                || (preset.prompt || '').toLowerCase().indexOf(keyword) > -1;
        });

        var host = SatBase.el('satPresetList');
        if (host) {
            SatBase.clear(host);
            if (!filtered.length) {
                host.appendChild(SatBase.make('div', 'sat-empty', '没有匹配的预设'));
            }
            filtered.slice(0, 120).forEach(function (preset) {
                var row = SatBase.make('div', 'sat-inline-option');
                row.textContent = preset.name + '  ·  ' + SatBase.truncate(preset.prompt, 26);
                row.onclick = function () { app().applyPreset(preset); };
                host.appendChild(row);
            });
        }

        var count = SatBase.el('satPresetCount');
        if (count) count.textContent = '共 ' + presets.length + ' 条，当前显示 ' + filtered.length + ' 条';
    }

    function setPresetCategory(category) {
        presetState.category = category;
    }

    function setPresetKeyword(keyword) {
        presetState.keyword = String(keyword || '');
    }

    function presetCategories() {
        var presets = app().presets ? app().presets() : [];
        var buckets = {};
        presets.forEach(function (preset) {
            var category = preset.category || '未分类';
            if (!buckets[category]) buckets[category] = [];
            buckets[category].push(preset);
        });
        return buckets;
    }

    // ---------- 对话 ----------

    function renderChat() {
        var config = SatStore.get();
        var channels = SatStore.channels();
        var chatChannels = SatProviders.channelNames().filter(function (name) {
            var meta = SatProviders.channelInfo(name);
            return meta.chatModels && meta.chatModels.length;
        });

        var parsed = SatProviders.parseModel(config.chatModel);
        var channel = parsed.channel || chatChannels[0] || 'grs';
        var meta = SatProviders.channelInfo(channel) || {};

        inlineSelect('satChatModelSelect', (meta.chatModels || []).map(function (name) {
            return { value: SatProviders.buildModel(channel, name), text: name };
        }), config.chatModel || SatProviders.buildModel(channel, (meta.chatModels || [])[0] || ''), function (value) {
            SatStore.patch({ chatModel: value });
            renderChat();
        });

        var host = SatBase.el('satChatLog');
        if (host) {
            SatBase.clear(host);
            var history = SatStore.chatHistory();
            if (!history.length) {
                host.appendChild(SatBase.make('div', 'sat-empty', '还没有对话。可以勾选「带当前选区图」一起发。'));
            }
            history.forEach(function (message) {
                var bubble = SatBase.make('div', 'sat-msg ' + (message.role === 'user' ? 'sat-msg-user' : 'sat-msg-ai'));
                var who = message.role === 'user' ? '我' : 'AI';
                bubble.appendChild(SatBase.make('div', 'sat-msg-meta', who + (message.image ? ' · 带图' : '')));
                bubble.appendChild(SatBase.make('div', null, message.content));
                host.appendChild(bubble);
            });
            host.scrollTop = host.scrollHeight;
        }

        var unknownChannel = chatChannels.indexOf(channel) === -1;
        if (unknownChannel && host) {
            host.appendChild(SatBase.make('div', 'sat-note sat-danger', '当前没有可用对话渠道，请先在设置里配置密钥'));
        }
        void channels;
    }

    // ---------- 设置 ----------

    function renderSettings() {
        var config = SatStore.get();
        var status = SatStore.sharedStatus();

        var pathInput = SatBase.el('satSharedPath');
        if (pathInput) {
            pathInput.value = config.sharedConfigPath || SatSharedConfig.defaultPath();
            pathInput.onchange = function () {
                SatStore.patch({ sharedConfigPath: pathInput.value.trim() });
            };
        }

        var statusNode = SatBase.el('satSharedStatus');
        if (statusNode) {
            var channels = SatStore.channels();
            var known = Object.keys(channels).filter(function (name) { return !!channels[name].apiKey; });
            statusNode.textContent = status.message + (known.length ? ' · 已有密钥：' + known.join('/') : ' · 还没有任何密钥');
            statusNode.className = known.length ? 'sat-note sat-ok-text' : 'sat-note';
        }

        var overrides = config.overrides;
        bindInput('satSetGrsUrl', overrides.grsUrl);
        bindInput('satSetGrsKey', overrides.grsKey);
        bindInput('satSetNewApiUrl', overrides.newApiUrl);
        bindInput('satSetNewApiKey', overrides.newApiKey);
        bindInput('satSetXaiUrl', overrides.xaiUrl);
        bindInput('satSetXaiKey', overrides.xaiKey);

        chips('satShapeChips', [
            { value: 'circle', text: '圆形' },
            { value: 'squircle', text: '方圆形' }
        ], config.shape, function (value) {
            SatStore.patch({ shape: value });
            renderSettings();
            SatBase.status('圆环形状已切换，下次唤出生效', 'ok');
        });

        chips('satRadiusChips', [
            { value: 'normal', text: '标准' }
        ], config.radiusScale, function (value) {
            SatStore.patch({ radiusScale: value });
        });
    }

    function bindInput(id, value) {
        var node = SatBase.el(id);
        if (!node) return;
        node.value = value || '';
        node.onchange = function () { /* 统一由保存按钮写入 */ };
    }

    function readSettingsInputs() {
        function valueOf(id) {
            var node = SatBase.el(id);
            return node ? String(node.value || '').trim() : '';
        }
        return {
            grsUrl: valueOf('satSetGrsUrl'),
            grsKey: valueOf('satSetGrsKey'),
            newApiUrl: valueOf('satSetNewApiUrl'),
            newApiKey: valueOf('satSetNewApiKey'),
            xaiUrl: valueOf('satSetXaiUrl'),
            xaiKey: valueOf('satSetXaiKey')
        };
    }

    return {
        showView: showView,
        activeView: activeView,
        inlineSelect: inlineSelect,
        chips: chips,
        renderHome: renderHome,
        renderParams: renderParams,
        renderPresets: renderPresets,
        renderChat: renderChat,
        renderSettings: renderSettings,
        renderReferenceList: renderReferenceList,
        setPresetCategory: setPresetCategory,
        setPresetKeyword: setPresetKeyword,
        presetCategories: presetCategories,
        readSettingsInputs: readSettingsInputs
    };
})();
