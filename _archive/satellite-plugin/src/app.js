// ============================================================
//  app.js — 启动编排
//
//  加载顺序在 index.html 里固定，本文件最后执行，负责：
//    1. 读配置、读预设、读共享配置文件
//    2. 组装圆环菜单树并绑事件
//    3. 跑生成 / 回写 / 对话这些真正的动作
//
//  圆环唤出方式（按可靠性从高到低）：
//    顶栏按钮 → 面板内右键 → 拖拽空白处
//    快捷键走 manifest 的 command 入口，能否生效取决于 PS 版本。
// ============================================================

(function () {
    'use strict';

    var presetCache = [];
    var chatImageAttached = false;
    var pieSummonGuard = 0;

    // ---------- 预设 ----------

    async function loadPresets() {
        try {
            var fs = require('uxp').storage.localFileSystem;
            var pluginFolder = await fs.getPluginFolder();
            var assets = await pluginFolder.getEntry('assets');
            var presets = await assets.getEntry('presets');
            var file = await presets.getEntry('yushe.json');
            var content = await file.read();
            presetCache = normalizePresets(JSON.parse(content));
        } catch (error) {
            // H5 环境下没有 getPluginFolder，退回到相对路径 fetch
            try {
                var response = await fetch('assets/presets/yushe.json', { cache: 'no-store' });
                presetCache = normalizePresets(await response.json());
            } catch (fallbackError) {
                presetCache = [];
                SatBase.status('预设加载失败：' + fallbackError.message, 'warn');
            }
        }
        return presetCache;
    }

    function normalizePresets(raw) {
        if (!Array.isArray(raw)) return [];
        return raw.filter(function (item) {
            return item && item.name && item.prompt;
        }).map(function (item) {
            return {
                name: String(item.name),
                prompt: String(item.prompt),
                category: String(item.category || '未分类')
            };
        });
    }

    // ---------- 共享配置 ----------

    // 主插件会在配置变更时自动重新导出，这边定期比对签名把新密钥收进来。
    // 不比对文件时间戳，因为导出时间戳每次都会变、会造成无意义的刷新。
    var SHARED_POLL_MS = 30000;
    var sharedSignature = '';

    function sharedSignatureOf(payload) {
        if (!payload || !payload.channels) return '';
        return Object.keys(payload.channels).sort().map(function (name) {
            var channel = payload.channels[name];
            return name + ':' + channel.baseUrl + ':' + channel.apiKey;
        }).join('|');
    }

    function startSharedConfigWatch() {
        setInterval(async function () {
            try {
                var path = SatStore.get().sharedConfigPath || SatSharedConfig.defaultPath();
                var payload = await SatSharedConfig.read(path);
                var signature = sharedSignatureOf(payload);
                if (signature === sharedSignature) return;
                sharedSignature = signature;
                SatStore.setShared(payload, '已自动同步');
                refreshViews();
                SatViews.renderSettings();
                SatBridge.pushState(true);
                SatBase.status('已从主插件同步到新的渠道配置', 'ok');
            } catch (error) {
                // 文件可能还没生成或正被写入，下一轮再试
            }
        }, SHARED_POLL_MS);
    }

    async function reloadSharedConfig(silent) {
        var config = SatStore.get();
        var path = config.sharedConfigPath || SatSharedConfig.defaultPath();
        try {
            var payload = await SatSharedConfig.read(path);
            sharedSignature = sharedSignatureOf(payload);
            SatStore.setShared(payload, '已读取：' + SatBase.truncate(payload.__path || path, 40));
            if (!config.imageModel && payload.models && payload.models.image) {
                SatStore.patch({ imageModel: payload.models.image }, { persist: true });
            }
            if (!config.chatModel && payload.models && payload.models.chat) {
                SatStore.patch({ chatModel: payload.models.chat }, { persist: true });
            }
            if (!silent) SatBase.status('共享配置已读取', 'ok');
        } catch (error) {
            // 读不到不是致命错误：本地覆盖仍然可用
            var fromToken = await SatSharedConfig.readFromToken();
            if (fromToken) {
                SatStore.setShared(fromToken, '已从手选文件读取');
                if (!silent) SatBase.status('共享配置已从手选文件读取', 'ok');
            } else {
                SatStore.setShared(null, '读取失败：' + SatBase.truncate(error.message, 46));
                if (!silent) SatBase.status('共享配置读取失败，可用本地覆盖', 'warn');
            }
        }
        SatViews.renderSettings();
        SatViews.renderHome();
    }

    // ---------- 圆环菜单树 ----------

    function aspectChildren() {
        var current = SatStore.get().aspectRatio;
        return SatProviders.ASPECT_RATIOS.map(function (label) {
            return {
                label: label + (label === current ? ' ✓' : ''),
                hint: '设为 ' + label,
                run: function () {
                    SatStore.patch({ aspectRatio: label });
                    refreshViews();
                    SatBase.status('比例已设为 ' + label, 'ok');
                }
            };
        });
    }

    function resolutionChildren() {
        var current = SatStore.get().imageResolution;
        return SatProviders.RESOLUTIONS.map(function (label) {
            return {
                label: (label === 'auto' ? '自动' : label) + (label === current ? ' ✓' : ''),
                run: function () {
                    SatStore.patch({ imageResolution: label });
                    refreshViews();
                    SatBase.status('分辨率已设为 ' + label, 'ok');
                }
            };
        });
    }

    function countChildren() {
        var current = SatStore.get().imageCount;
        return [1, 2, 3, 4].map(function (n) {
            return {
                label: n + ' 张' + (n === current ? ' ✓' : ''),
                run: function () {
                    SatStore.patch({ imageCount: n });
                    refreshViews();
                    SatBase.status('生成数量已设为 ' + n, 'ok');
                }
            };
        });
    }

    function channelChildren() {
        var current = SatStore.get().channel;
        var channels = SatStore.channels();
        return SatProviders.channelNames().map(function (name) {
            var meta = SatProviders.channelInfo(name);
            var usable = !!channels[name].apiKey || meta.apiKeyOptional;
            return {
                label: meta.label + (name === current ? ' ✓' : ''),
                hint: usable ? '' : '缺密钥',
                disabled: !usable,
                children: modelChildren(name)
            };
        });
    }

    /**
     * 同一渠道的模型名往往只差后缀（nano-banana-fast / -2 / -pro / -pro-vip），
     * 圆环扇区里塞不下全名，全截断成 "nano-banana…" 就分不出谁是谁了。
     * 这里按兄弟项的公共前缀缩写，切点必须落在分隔符上，避免把单词切一半。
     */
    function commonPrefix(names) {
        if (!names || names.length < 2) return '';
        var prefix = names[0];
        names.forEach(function (name) {
            var i = 0;
            while (i < prefix.length && i < name.length && prefix.charAt(i) === name.charAt(i)) i += 1;
            prefix = prefix.slice(0, i);
        });
        if (!prefix) return '';
        var onBoundary = names.every(function (name) {
            return name.length === prefix.length || /[-_. ]/.test(name.charAt(prefix.length));
        });
        if (onBoundary) return prefix;
        var cut = Math.max(prefix.lastIndexOf('-'), prefix.lastIndexOf('_'), prefix.lastIndexOf('.'));
        return cut > 0 ? prefix.slice(0, cut) : '';
    }

    function shortModelLabels(names) {
        var prefix = commonPrefix(names);
        if (!prefix) return names.slice();
        return names.map(function (name) {
            var short = name.slice(prefix.length).replace(/^[-_.\s]+/, '');
            return short || name;
        });
    }

    function modelChildren(channel) {
        var meta = SatProviders.channelInfo(channel) || {};
        var list = meta.imageModels || [];
        var labels = shortModelLabels(list);
        var items = list.map(function (name, index) {
            return {
                label: labels[index],
                hint: name,
                run: function () {
                    SatStore.patch({ channel: channel, imageModel: SatProviders.buildModel(channel, name) });
                    refreshViews();
                    SatBase.status('模型已切换到 ' + name, 'ok');
                }
            };
        });
        items.push({
            label: '参数页…',
            run: function () { openView('viewParams'); }
        });
        return items;
    }

    function presetCategoryChildren() {
        var buckets = SatViews.presetCategories();
        return Object.keys(buckets).map(function (category) {
            var list = buckets[category];
            return {
                label: category + ' (' + list.length + ')',
                children: list.map(function (preset) {
                    return {
                        label: preset.name,
                        hint: '填入提示词',
                        run: function () { applyPreset(preset); }
                    };
                })
            };
        });
    }

    function buildMenuTree() {
        var config = SatStore.get();
        var parsed = SatProviders.parseModel(config.imageModel);
        var meta = SatProviders.channelInfo(parsed.channel || config.channel) || { label: '未选' };
        var result = SatStore.lastResult();

        return [
            {
                label: '生成',
                hint: '按当前参数出图',
                run: function () { runGenerate(); }
            },
            {
                label: '参数',
                hint: '比例/模型/数量',
                children: [
                    { label: '比例 ' + config.aspectRatio, children: aspectChildren() },
                    { label: '分辨率 ' + config.imageResolution, children: resolutionChildren() },
                    { label: '数量 ' + config.imageCount, children: countChildren() },
                    { label: '渠道 ' + meta.label, children: channelChildren() },
                    { label: '模型', children: modelChildren(parsed.channel || config.channel) },
                    { label: '参数页…', run: function () { openView('viewParams'); } }
                ]
            },
            {
                label: '预设',
                hint: SatBase.truncate(config.lastPrompt || '未选', 8),
                children: presetCategoryChildren()
            },
            {
                label: '对话',
                hint: '多轮问答',
                run: function () { openView('viewChat'); }
            },
            {
                label: '读选区',
                hint: '抓当前选区',
                run: function () { readSelection(); }
            },
            {
                label: result ? '回写' : '回写',
                hint: result ? '放回文档' : '还没有结果',
                disabled: !result,
                run: function () { placeResult(); }
            },
            {
                label: '设置',
                hint: '渠道与密钥',
                run: function () { openView('viewSettings'); }
            }
        ];
    }

    // ---------- 动作 ----------

    function refreshViews() {
        SatViews.renderHome();
        SatViews.renderParams();
        // 参数一变就同步给圆环，否则圆环上的 ✓ 和标题会停在旧值
        SatBridge.pushState();
    }

    // ---------- 圆环桥接 ----------

    function setupBridge() {
        SatBridge.on('generate', function () { return runGenerate(); });

        SatBridge.on('setParam', function (message) {
            var key = String(message.key || '');
            var value = message.value;
            if (key === 'model') {
                var parsed = SatProviders.parseModel(String(value));
                SatStore.patch({
                    channel: parsed.channel || SatStore.get().channel,
                    imageModel: String(value)
                });
            } else if (key === 'aspectRatio') {
                SatStore.patch({ aspectRatio: String(value) });
            } else if (key === 'resolution') {
                SatStore.patch({ imageResolution: String(value) });
            } else if (key === 'count') {
                SatStore.patch({ imageCount: Math.max(1, Math.min(4, Number(value) || 1)) });
            } else {
                return;
            }
            refreshViews();
            SatBase.status('圆环已切换 ' + key, 'ok');
        });

        SatBridge.on('applyPreset', function (message) {
            var wanted = String(message.name || '');
            var found = presetCache.filter(function (item) { return item.name === wanted; })[0];
            if (found) applyPreset(found);
            else SatBase.status('圆环指定的预设没找到：' + wanted, 'warn');
        });

        SatBridge.on('readSelection', function () { return readSelection(); });
        SatBridge.on('placeResult', function () { return placeResult(); });

        // 对话需要键盘输入，圆环本身承接不了，所以打开面板里的对话视图
        SatBridge.on('openChat', function () {
            openView('viewChat');
            SatBase.status('已打开对话', 'ok');
        });

        SatBridge.onStatusChange(function (connected, text, kind) {
            var node = SatBase.el('satBridgeStatus');
            if (!node) return;
            node.textContent = text;
            node.className = kind === 'ok' ? 'sat-ok' : (kind === 'warn' ? 'sat-warn' : '');
        });
    }

    // 缩略图不由插件生成。
    // UXP 的 canvas 是纯绘图上下文（没有 drawImage / getImageData / toDataURL），
    // createImageBitmap 也不存在，插件这边**没有任何办法**缩放一张图。
    // 所以直接把原图 data URL 交给原生助手，那边用 NSImage 解码缩放。
    // 上限 12MB 是为了防止超大图把 WebSocket 帧撑爆。
    var MAX_RESULT_PAYLOAD = 12 * 1024 * 1024;

    function openView(id) {
        SatViews.showView(id);
        if (id === 'viewParams') SatViews.renderParams();
        else if (id === 'viewPresets') SatViews.renderPresets();
        else if (id === 'viewChat') SatViews.renderChat();
        else if (id === 'viewSettings') SatViews.renderSettings();
        else SatViews.renderHome();
    }

    async function readSelection() {
        if (!SatPs.available()) {
            SatBase.status('当前环境没有 Photoshop 宿主', 'error');
            return null;
        }
        var doc = SatPs.describeDocument();
        if (!doc.open) {
            SatBase.status('请先打开一个文档', 'error');
            return null;
        }
        try {
            SatBase.status('正在读取选区…');
            var captured = await SatPs.captureAsDataUrl(doc.selection || SatPs.documentBounds());
            SatStore.addReference({
                dataUrl: captured.dataUrl,
                width: captured.width,
                height: captured.height,
                label: doc.hasSelection ? '选区' : '整图'
            });
            // 有选区时顺带把比例对齐到选区，省得用户手调
            if (doc.hasSelection && doc.selection) {
                var aspect = SatProviders.aspectFromSize(doc.selection.width, doc.selection.height);
                SatStore.patch({ aspectRatio: aspect });
            }
            refreshViews();
            SatViews.renderReferenceList();
            SatBase.status('已读取 ' + captured.width + '×' + captured.height + ' 作为参考图', 'ok');
            return captured;
        } catch (error) {
            SatBase.status('读取失败：' + error.message, 'error');
            return null;
        }
    }

    function currentChannelRoute() {
        var config = SatStore.get();
        var parsed = SatProviders.parseModel(config.imageModel);
        var channel = parsed.channel || config.channel;
        var meta = SatProviders.channelInfo(channel);
        if (!meta) return { error: '模型值缺少渠道前缀，请在参数页重新选一次模型' };
        var route = SatStore.channels()[channel] || {};
        return {
            channel: channel,
            meta: meta,
            model: parsed.model,
            baseUrl: route.baseUrl || meta.defaultBaseUrl,
            apiKey: route.apiKey || ''
        };
    }

    async function runGenerate() {
        if (SatStore.isBusy()) {
            SatBase.status('正在生成中，请等当前任务结束', 'warn');
            return null;
        }
        var config = SatStore.get();
        var prompt = String((SatBase.el('satPrompt') || {}).value || config.lastPrompt || '').trim();
        if (!prompt) {
            SatBase.status('提示词是空的：先在首页写一句，或从预设里选一个', 'error');
            openView('viewHome');
            return null;
        }

        // 生成一律交给主插件执行。卫星自己不碰渠道 —— 两边各有一套请求逻辑
        // 迟早会行为漂移，密钥也要配两份，那就不是「卫星」了。
        if (!SatMainLink.isAvailable()) {
            var reason = SatMainLink.unavailableReason();
            SatBase.status('无法生成：' + reason, 'error');
            SatBridge.progress('failure', reason);
            return null;
        }

        SatStore.patch({ lastPrompt: prompt });
        SatStore.setBusy(true);
        setGenerateButtonState(true);
        SatBase.status('已转交主插件执行…');
        SatBridge.progress('running', '已转交主插件…');

        try {
            var commandId = await SatMainLink.invoke('generate', {
                prompt: prompt,
                resolution: config.imageResolution,
                count: config.imageCount,
                model: config.imageModel
            });

            var result = await SatMainLink.waitForResult(commandId, function (state, message) {
                if (!message) return;
                SatBase.status(message);
                if (state === 'running') SatBridge.progress('running', message);
            });

            if (result.state !== 'success') {
                var failure = result.message || '生成失败';
                SatBase.status(failure, 'error');
                SatBridge.progress('failure', failure);
                return null;
            }

            if (result.imageUrl) {
                SatStore.setResult({
                    dataUrl: result.imageUrl,
                    prompt: prompt,
                    model: config.imageModel,
                    at: new Date().toISOString()
                });
                SatViews.renderHome();
            }
            SatBase.status('生成完成 · 由主插件执行', 'ok');
            SatBridge.progress('success', '生成完成', result.imageUrl || '');
            return result.imageUrl || null;
        } catch (error) {
            SatBase.status('生成失败：' + error.message, 'error');
            SatBridge.progress('failure', error.message);
            return null;
        } finally {
            SatStore.setBusy(false);
            setGenerateButtonState(false);
        }
    }


    function setGenerateButtonState(busy) {
        var button = SatBase.el('satGenerateBtn');
        if (button) {
            button.disabled = busy;
            button.textContent = busy ? '生成中…' : '生成';
        }
    }

    async function placeResult() {
        var result = SatStore.lastResult();
        if (!result) {
            SatBase.status('还没有可回写的结果', 'warn');
            return;
        }
        if (!SatPs.available()) {
            SatBase.status('当前环境没有 Photoshop 宿主', 'error');
            return;
        }
        var doc = SatPs.describeDocument();
        if (!doc.open) {
            SatBase.status('没有打开的文档，改用「另存为」或新建文档', 'warn');
            return;
        }
        try {
            SatBase.status('正在写回文档…');
            var bounds = doc.selection || SatPs.documentBounds();
            var placed = await SatPs.placeAtBounds(result.dataUrl, bounds, '幻梦卫星 生成结果');
            SatBase.status('已写回为新图层（layer ' + placed.layerId + '）', 'ok');
        } catch (error) {
            SatBase.status('回写失败：' + error.message, 'error');
        }
    }

    async function saveResult() {
        var result = SatStore.lastResult();
        if (!result) return;
        try {
            var path = await SatPs.saveAs(result.dataUrl, 'huanmeng-satellite.png');
            if (path) SatBase.status('已保存到 ' + path, 'ok');
        } catch (error) {
            SatBase.status('保存失败：' + error.message, 'error');
        }
    }

    function applyPreset(preset) {
        if (!preset) return;
        var promptNode = SatBase.el('satPrompt');
        if (promptNode) promptNode.value = preset.prompt;
        SatStore.patch({ lastPrompt: preset.prompt });
        openView('viewHome');
        SatViews.renderHome();
        SatBase.status('已套用预设「' + preset.name + '」', 'ok');
    }

    async function sendChat() {
        var input = SatBase.el('satChatInput');
        var text = input ? String(input.value || '').trim() : '';
        if (!text) {
            SatBase.status('先说点什么', 'warn');
            return;
        }
        var route = currentChannelRoute();
        var meta = SatProviders.channelInfo(route.channel) || {};
        var config = SatStore.get();
        var parsedChat = SatProviders.parseModel(config.chatModel);
        var chatChannel = parsedChat.channel || route.channel;
        var chatMeta = SatProviders.channelInfo(chatChannel) || meta;
        var chatRoute = SatStore.channels()[chatChannel] || {};
        var chatModel = parsedChat.model || (chatMeta.chatModels && chatMeta.chatModels[0]) || '';

        if (!chatModel) {
            SatBase.status('当前渠道没有可用的对话模型', 'error');
            return;
        }
        if (!chatRoute.apiKey && !chatMeta.apiKeyOptional) {
            SatBase.status('缺少 ' + chatMeta.label + ' 的对话密钥', 'error');
            return;
        }

        var image = null;
        if (chatImageAttached) {
            var captured = await SatPs.captureAsDataUrl();
            image = captured ? captured.dataUrl : null;
            if (!image) SatBase.status('带图失败，本次按纯文字发送', 'warn');
        }

        SatStore.pushChat({ role: 'user', content: text, image: image ? 'attached' : '' });
        if (input) input.value = '';
        SatViews.renderChat();
        SatBase.status('正在等待 ' + chatMeta.label + ' 回复…');

        var history = SatStore.chatHistory().slice(-8).map(function (message) {
            return { role: message.role === 'user' ? 'user' : 'assistant', content: message.content };
        });
        if (image) history[history.length - 1].image = image;

        try {
            var result = await SatProviders.chat({
                channel: chatChannel,
                baseUrl: chatRoute.baseUrl || chatMeta.defaultBaseUrl,
                apiKey: chatRoute.apiKey || '',
                model: chatModel,
                messages: history
            });
            if (result.error) {
                SatBase.status(result.error, 'error');
                return;
            }
            var reply = SatProviders.extractChatText(result.data);
            if (!reply) {
                SatBase.status('回复是空的：该模型可能不支持纯文本返回', 'warn');
                return;
            }
            SatStore.pushChat({ role: 'assistant', content: reply });
            SatViews.renderChat();
            SatBase.status('已回复', 'ok');
        } catch (error) {
            SatBase.status('对话失败：' + error.message, 'error');
        }
    }

    // ---------- 圆环唤出 ----------

    function summonPie(mode, event) {
        if (SatStore.isBusy()) {
            SatBase.status('生成中不打开圆环', 'warn');
            return;
        }
        var now = Date.now();
        if (now - pieSummonGuard < 250) return;
        pieSummonGuard = now;

        void event;
        var opened = SatPie.open({
            dragMode: mode === 'drag',
            items: buildMenuTree,
            onClose: function (reason) {
                if (reason === 'cancel') SatBase.status('已取消', 'info');
            }
        });
        if (!opened) {
            SatBase.status('圆环打不开：面板太小，把面板拉大或改成浮动窗口', 'warn');
        }
    }

    function bindSummon() {
        var stage = SatBase.el('satStage');
        if (!stage) return;

        // 按住右键拖动 = Blender 手感：按下唤出、移动选择、松开执行
        stage.addEventListener('pointerdown', function (event) {
            if (SatPie.isOpen()) return;
            var target = event.target || {};
            var tag = String(target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea') return;
            var button = typeof event.button === 'number' ? event.button : -1;
            var buttons = typeof event.buttons === 'number' ? event.buttons : 0;
            if (button !== 2 && buttons !== 2) return;
            if (event.preventDefault) event.preventDefault();
            summonPie('drag', event);
        });

        // 右键菜单事件兜底：某些 PS 版本不把 button=2 的 pointerdown 送进面板
        stage.addEventListener('contextmenu', function (event) {
            if (event.preventDefault) event.preventDefault();
            if (SatPie.isOpen()) return;
            summonPie('click', event);
        });

        SatPie.bind(buildMenuTree, { resummon: function () { summonPie('click'); } });
    }

    // ---------- 入口与事件 ----------

    function bindUi() {
        var bindings = [
            ['satPieBtn', function () { summonPie('click'); }],
            ['satSettingsBtn', function () { openView('viewSettings'); }],
            ['satQuickParamsBtn', function () { openView('viewParams'); }],
            ['satQuickPresetsBtn', function () { openView('viewPresets'); }],
            ['satParamsBack', function () { openView('viewHome'); }],
            ['satPresetsBack', function () { openView('viewHome'); }],
            ['satChatBack', function () { openView('viewHome'); }],
            ['satSettingsBack', function () { openView('viewHome'); }],
            ['satGenerateBtn', function () { runGenerate(); }],
            ['satReadSelectionBtn', function () { readSelection(); }],
            ['satAddRefBtn', function () { readSelection(); }],
            ['satPlaceBtn', function () { placeResult(); }],
            ['satSaveAsBtn', function () { saveResult(); }],
            ['satChatSend', function () { sendChat(); }],
            ['satChatClear', function () {
                SatStore.clearChat();
                SatViews.renderChat();
                SatBase.status('对话已清空', 'ok');
            }],
            ['satClearRefBtn', function () {
                SatStore.clearReferences();
                SatViews.renderReferenceList();
                SatViews.renderHome();
                SatBase.status('参考图已清空', 'ok');
            }],
            ['satSharedReload', function () { reloadSharedConfig(false); }],
            ['satSharedPick', async function () {
                try {
                    var picked = await SatSharedConfig.pick();
                    if (!picked) return;
                    SatStore.patch({ sharedConfigPath: picked.path });
                    SatStore.setShared(picked.config, '已读取手选文件');
                    if (picked.config.models && picked.config.models.image) {
                        SatStore.patch({ imageModel: picked.config.models.image });
                    }
                    if (picked.config.models && picked.config.models.chat) {
                        SatStore.patch({ chatModel: picked.config.models.chat });
                    }
                    SatViews.renderSettings();
                    SatViews.renderHome();
                    SatBase.status('已读取 ' + picked.path, 'ok');
                } catch (error) {
                    SatBase.status('选择文件失败：' + error.message, 'error');
                }
            }],
            ['satSettingsSave', function () {
                SatStore.patchOverride(SatViews.readSettingsInputs());
                SatViews.renderHome();
                SatBase.status('本地覆盖已保存', 'ok');
            }]
        ];

        bindings.forEach(function (pair) {
            var node = SatBase.el(pair[0]);
            if (!node) return;
            node.onclick = pair[1];
        });

        var prompt = SatBase.el('satPrompt');
        if (prompt) {
            prompt.oninput = function () {
                SatStore.patch({ lastPrompt: prompt.value }, { persist: false });
            };
        }

        var presetSearch = SatBase.el('satPresetSearch');
        if (presetSearch) {
            presetSearch.oninput = function () {
                SatViews.setPresetKeyword(presetSearch.value);
                SatViews.renderPresets();
            };
        }

        var chatWithImage = SatBase.el('satChatWithImage');
        if (chatWithImage) {
            chatWithImage.onclick = function () {
                chatImageAttached = !chatImageAttached;
                if (chatImageAttached) chatWithImage.classList.add('sat-active');
                else chatWithImage.classList.remove('sat-active');
            };
        }

        window.addEventListener('resize', function () { SatPie.refresh(); });
    }

    function setupEntrypoints() {
        try {
            var entrypoints = require('uxp').entrypoints;
            if (!entrypoints || typeof entrypoints.setup !== 'function') return;
            entrypoints.setup({
                panels: {
                    satellitePanel: {
                        show: function () {
                            // 面板被打开时刷新一次宿主状态，避免显示过期信息
                            refreshViews();
                        }
                    }
                },
                commands: {
                    satellitePieCommand: function () {
                        // manifest 里配了快捷键 Cmd/Ctrl+Shift+9
                        summonPie('click');
                    }
                }
            });
        } catch (error) {
            console.error('[卫星] entrypoints 注册失败：' + error.message);
        }
    }

    // ---------- 启动 ----------

    async function init() {
        SatStore.load();
        SatBase.status('正在初始化…');

        setupEntrypoints();
        bindUi();
        bindSummon();
        setupBridge();

        if (!SatPs.available()) {
            SatBase.status('没有检测到 Photoshop 宿主，只能浏览界面', 'warn');
        }

        await loadPresets();
        await reloadSharedConfig(true);

        var config = SatStore.get();
        if (!config.imageModel) {
            var meta = SatProviders.channelInfo(config.channel) || {};
            var model = (meta.imageModels && meta.imageModels[0]) || '';
            SatStore.patch({ imageModel: SatProviders.buildModel(config.channel, model) });
        }
        if (!config.chatModel) {
            SatStore.patch({ chatModel: SatProviders.buildModel('grs', 'gemini-3.1-pro') });
        }

        var promptNode = SatBase.el('satPrompt');
        if (promptNode && config.lastPrompt) promptNode.value = config.lastPrompt;

        SatViews.showView('viewHome');
        refreshViews();
        SatBase.status('就绪 · 预设 ' + presetCache.length + ' 条', 'ok');

        // 助手可能还没启动，或者中途被关掉。open() 内部自带指数退避重连，
        // 这里只管发起，不需要处理失败。
        SatBridge.open();
        startSharedConfigWatch();
    }

    window.SatApp = {
        presets: function () { return presetCache; },
        applyPreset: applyPreset,
        runGenerate: runGenerate,
        readSelection: readSelection,
        placeResult: placeResult,
        openView: openView,
        reloadSharedConfig: reloadSharedConfig,
        summonPie: summonPie
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { init(); });
    } else {
        init();
    }
})();
