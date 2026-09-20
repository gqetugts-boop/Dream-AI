// ============================================================
//  ring-bridge.js — 连接「幻梦圆环」原生助手
//
//  合并之后这里就是唯一的桥：主插件直接和助手对话，
//  不再需要第二个插件、IPC、指令文件或共享配置。
//
//  助手是 WebSocket 服务端（127.0.0.1:8799），本插件是客户端 ——
//  UXP 只有 WebSocket 客户端 API，开不了监听端口（真机实测）。
//
//  圆环显示的状态全部**从本插件自己的 DOM 读**，
//  这样圆环和面板永远一致，不会出现两套参数各说各话。
// ============================================================

window.HuanmengRingBridge = (function () {
    var URL = 'ws://127.0.0.1:8799';
    var RECONNECT_BASE_MS = 800;
    var RECONNECT_MAX_MS = 15000;
    var STATE_THROTTLE_MS = 250;

    var socket = null;
    var reconnectTimer = null;
    var reconnectDelay = RECONNECT_BASE_MS;
    var connected = false;
    var attempts = 0;
    var lastStateAt = 0;
    var stateTimer = null;
    var lastCommandId = '';

    // ---------- 小工具 ----------

    function $(id) { return document.getElementById(id); }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function controlValue(id) {
        var node = $(id);
        return node ? String(node.value || '') : '';
    }

    function controlOptions(id) {
        var node = $(id);
        if (!node || !node.options) return [];
        var out = [];
        for (var i = 0; i < node.options.length; i += 1) {
            var option = node.options[i];
            out.push({ value: String(option.value), text: String(option.text || option.value) });
        }
        return out;
    }

    /** 设置控件并触发事件，让主插件自己的处理逻辑跑起来 */
    function setControl(id, value) {
        var node = $(id);
        if (!node) return false;
        node.value = String(value);
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    // ---------- 预设 ----------

    var presetCache = [];
    var presetLoaded = false;

    async function loadPresets() {
        if (presetLoaded) return presetCache;
        try {
            var fs = require('uxp').storage.localFileSystem;
            var pluginFolder = await fs.getPluginFolder();
            var assets = await pluginFolder.getEntry('assets');
            var presets = await assets.getEntry('presets');
            var file = await presets.getEntry('yushe.json');
            var parsed = JSON.parse(String(await file.read() || '[]'));
            presetCache = Array.isArray(parsed) ? parsed.filter(function (item) {
                return item && item.name && item.prompt;
            }).map(function (item) {
                return {
                    name: String(item.name),
                    prompt: String(item.prompt),
                    category: String(item.category || '未分类')
                };
            }) : [];
        } catch (error) {
            presetCache = [];
            console.warn('[圆环桥接] 预设加载失败：' + (error && error.message ? error.message : error));
        }
        presetLoaded = true;
        return presetCache;
    }

    function groupPresets() {
        var buckets = {};
        var order = [];
        presetCache.forEach(function (preset) {
            var category = preset.category || '未分类';
            if (!buckets[category]) {
                buckets[category] = [];
                order.push(category);
            }
            if (buckets[category].length >= 8) return;
            buckets[category].push({
                name: preset.name,
                prompt: String(preset.prompt).slice(0, 40)
            });
        });
        return order.map(function (category) {
            return { category: category, items: buckets[category] };
        });
    }

    // ---------- 文档状态 ----------

    function describeDocument() {
        try {
            var ps = require('photoshop');
            var doc = ps.app.activeDocument;
            if (!doc) return { open: false };
            var bounds = doc.selection && doc.selection.bounds;
            var number = function (value) {
                if (value === null || value === undefined) return NaN;
                if (typeof value === 'number') return value;
                if (typeof value === 'object' && typeof value._value === 'number') return value._value;
                return Number(value);
            };
            var hasSelection = false;
            var width = 0;
            var height = 0;
            if (bounds) {
                var left = number(bounds.left);
                var top = number(bounds.top);
                var right = number(bounds.right);
                var bottom = number(bounds.bottom);
                if (isFinite(left) && isFinite(top) && isFinite(right) && isFinite(bottom)
                    && right > left && bottom > top) {
                    hasSelection = true;
                    width = Math.round(right - left);
                    height = Math.round(bottom - top);
                }
            }
            return {
                open: true,
                name: String(doc.name || ''),
                hasSelection: hasSelection,
                selectionWidth: width,
                selectionHeight: height
            };
        } catch (error) {
            return { open: false };
        }
    }

    // ---------- 状态上报 ----------

    // ---------- 槽位表 ----------
    //
    // 圆环有六个固定位置（槽位）。槽位 id 是圆环侧的稳定标识，**不要改**。
    // 每个槽位有两件事可以配置：叫什么名字、点了干什么。
    //
    // 默认动作 = 槽位自己的 id，也就是说「不配置时行为和改造前完全一样」。

    var SLOT_IDS = ['generate', 'params', 'presets', 'chat', 'readSelection', 'close'];

    // 每个槽位的默认动作。
    // 注意 chat 槽位对应的是 chatMenu 指令（不是 'chat'），
    // 后缀不一致是历史原因，别顺手「统一」掉 —— 那是协议，两边都得改。
    var DEFAULT_ACTIONS = {
        generate: 'generate',
        params: 'params',
        presets: 'presets',
        // 对话从「切到面板的对话页」升级成了圆环上直接展开的子菜单：
        // 模型 / 快捷提问 / 打字提问 / 看回复。老助手不认子菜单，
        // 所以在 resolveSlotAction 里给它留了 openChat 那条老路。
        chat: 'chatMenu',
        readSelection: 'readSelection',
        close: 'close'
    };

    var DEFAULT_LABELS = {
        generate: '生成',
        params: '参数',
        presets: '预设',
        chat: '对话',
        readSelection: '读选区',
        close: '关闭'
    };

    /**
     * 可以指派给槽位的动作。
     * value 就是圆环发过来的 action 字符串 —— 改这里要同时确认 handleCommand 认得它。
     * group 只用于设置页的下拉分组。
     */
    var ACTIONS = [
        { value: 'generate', label: '生成', group: '生图', hint: '按当前面板参数出图' },
        { value: 'params', label: '参数菜单', group: '生图', hint: '展开：模型 / 画质 / 比例 / 数量' },
        { value: 'presets', label: '预设菜单', group: '生图', hint: '展开：分类 → 预设' },
        { value: 'readSelection', label: '读取选区', group: '生图', hint: '把当前选区读进面板' },
        { value: 'chatMenu', label: '对话菜单', group: '对话', hint: '展开：模型 / 快捷提问 / 打字提问' },
        { value: 'openChat', label: '打开对话页', group: '对话', hint: '只切到面板的对话页，不展开菜单' },
        { value: 'chatNew', label: '新对话', group: '对话', hint: '清空聊天记录' },
        { value: 'tab:img2img', label: '切到「生成」', group: '面板' },
        { value: 'tab:apps', label: '切到「快速」', group: '面板' },
        { value: 'tab:toolbox', label: '切到「工具箱」', group: '面板' },
        { value: 'tab:runninghub', label: '切到「应用」', group: '面板' },
        { value: 'tab:gallery', label: '切到「画廊」', group: '面板' },
        { value: 'tab:generationCenter', label: '切到「生成中心」', group: '面板' },
        { value: 'tab:logs', label: '切到「记录」', group: '面板' },
        { value: 'tab:settings', label: '切到「设置」', group: '面板' },
        { value: 'clearPrompt', label: '清空提示词', group: '操作', hint: '清空提示词输入框，不动预设' },
        { value: 'close', label: '关闭圆环', group: '操作', hint: '只收起圆环，不退出助手' }
    ];

    /// 从插件配置里读圆环设置。配置坏了就返回空对象 —— 不能因为读配置失败让桥接挂掉。
    function ringSettings() {
        try {
            var raw = localStorage.getItem('huanmeng_config');
            var config = raw ? JSON.parse(raw) : null;
            return (config && config.settings && config.settings.ring) || {};
        } catch (error) {
            return {};
        }
    }

    /// 组装要下发给圆环的槽位表。
    /// 只发 id / action / label 三项 —— 显隐和排序由圆环自己的偏好设置管，
    /// 两边都管会互相打架。
    function buildSectors() {
        var saved = ringSettings().sectors || {};
        return SLOT_IDS.map(function (id) {
            var entry = saved[id] || {};
            return {
                id: id,
                action: entry.action || DEFAULT_ACTIONS[id],
                label: entry.label || DEFAULT_LABELS[id]
            };
        });
    }

    /// 兼容旧版助手：老版本只认扁平的 labels 对象
    function buildLabels() {
        var labels = {};
        buildSectors().forEach(function (sector) { labels[sector.id] = sector.label; });
        return labels;
    }

    /// 插件支持的动作清单，下发给助手填偏好设置里的下拉框。
    /// **动作的唯一定义在插件这边**，助手不该自己再维护一份 —— 那样迟早对不上。
    /// 助手没连上时它会用自己的一份兜底列表。
    function buildActions() {
        return ACTIONS.map(function (action) {
            return { value: action.value, label: action.label, hint: action.hint || '' };
        });
    }

    // ---------- 对话 ----------

    /**
     * 内置的快捷提问。用户没在设置里写就发这一套。
     * 标题要短 —— 圆环扇区里只放得下四五个字。
     */
    var DEFAULT_CHAT_QUESTIONS = [
        { label: '调色思路', prompt: '给我一个适合这张照片的调色思路，按步骤说明每一步的目的和大致参数范围。' },
        { label: '光影诊断', prompt: '分析这张照片的光影问题，指出需要调整的局部区域和调整方向。' },
        { label: '人像精修', prompt: '针对这张人像列出精修步骤（磨皮、液化、肤色统一、眼神光），说明每一步的力度。' },
        { label: '构图建议', prompt: '从构图角度评价这张照片，指出可以裁剪或调整的地方。' },
        { label: '转黑白', prompt: '如果要把这张照片转成黑白，说明通道混合器各通道的配比和对比度设置建议。' },
        { label: '写提示词', prompt: '根据我接下来描述的画面，写一段用于 AI 生图的中文提示词。' }
    ];

    /**
     * 解析设置页那多行文本。一行一条，格式：
     *     标题=提示词        （也接受 标题|提示词）
     *     只有提示词         （标题自动取前 5 个字）
     * 空行和 # 开头的行忽略。
     */
    function parseChatQuestions(text) {
        var lines = String(text == null ? '' : text).split('\n');
        var out = [];
        lines.forEach(function (line) {
            var raw = String(line).trim();
            if (!raw || raw.charAt(0) === '#') return;
            var cut = -1;
            ['=', '|', '｜'].forEach(function (mark) {
                var at = raw.indexOf(mark);
                if (at > 0 && (cut < 0 || at < cut)) cut = at;
            });
            var label = cut > 0 ? raw.slice(0, cut).trim() : '';
            var prompt = cut > 0 ? raw.slice(cut + 1).trim() : raw;
            if (!prompt) return;
            if (!label) label = prompt.length > 5 ? prompt.slice(0, 5) : prompt;
            out.push({ label: label, prompt: prompt });
        });
        return out;
    }

    /// 一次推给圆环多少条聊天记录。显示层不需要完整历史 ——
    /// 模型要用的那些上下文在插件内部的 messages 里，和这个无关。
    var HISTORY_LIMIT = 40;

    /// 圆环上列出来的快捷提问：用户配了就用用户的，没配就用内置的
    function chatQuestions() {
        var custom = parseChatQuestions(ringSettings().chatQuestions);
        return custom.length ? custom : DEFAULT_CHAT_QUESTIONS;
    }

    function chatAPI() {
        return (typeof window !== 'undefined' && window.HuanmengChat) || null;
    }

    /// 圆环侧的气泡要显示"正在想/回复/出错"，这三种是瞬时事件，
    /// 塞进 state 里不合适（state 是给菜单用的快照），单开一种消息类型。
    function pushChat(action, payload) {
        send({ type: 'chat', action: action, payload: payload || {} });
    }

    /**
     * 圆环上要显示的聊天记录。
     *
     * **以面板那份 chatHistory 为准**，圆环不自己攒 —— 两边各攒一份迟早会分叉，
     * 用户会看到「圆环里问的、面板里没有」这种事。
     *
     * 只发最近 limit 条：整段对话可能很长，而 state 是每几秒推一次的，
     * 真正需要久远上下文的是模型（那部分在插件内部的 messages 里），不是这个显示层。
     * 单条也截一下，免得一次几万字的回复把消息撑爆。
     */
    function buildChatHistory(limit, extraUserText) {
        var out = [];
        var api = chatAPI();
        // 聊天记录活在面板里（index.js），桥接这边看不到那个变量 ——
        // 只能通过 HuanmengChat.history() 拿。面板没加载出来就没有记录可显示。
        if (api && typeof api.history === 'function') {
            try {
                var list = api.history(limit) || [];
                for (var i = 0; i < list.length; i += 1) {
                    var item = list[i];
                    if (!item || !item.text) continue;
                    out.push({ role: item.role === 'user' ? 'user' : 'assistant', text: clip(item.text, 8000) });
                }
            } catch (error) {
                out = [];
            }
        }
        // 「正在回复」阶段那条问题还没进聊天记录（面板是发出请求之后才记的），
        // 由调用方补进来，不然用户看不到自己刚问的那句
        if (extraUserText) out.push({ role: 'user', text: String(extraUserText) });
        return out;
    }

    function clip(text, limit) {
        var value = String(text == null ? '' : text);
        return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
    }

    function buildChatState() {
        var api = chatAPI();
        var live = api && typeof api.state === 'function' ? api.state() : null;
        return {
            model: live ? live.model : '',
            models: live ? live.models : [],
            questions: chatQuestions(),
            busy: live ? !!live.busy : false,
            hasReply: !!(live && live.lastReply),
            // 只发改短的一段：state 每几秒推一次，整篇回复塞进去纯属浪费。
            // 完整回复走 pushChat('reply')，圆环那边留着的才是全文。
            lastQuestion: live ? clip(live.lastQuestion, 40) : '',
            lastReply: live ? clip(live.lastReply, 120) : ''
        };
    }

    function buildState() {
        return {
            document: describeDocument(),
            params: {
                model: controlValue('imgModel'),
                resolution: controlValue('imgResolution'),
                count: Number(controlValue('imageCount')) || 1
            },
            options: {
                model: controlOptions('imgModel'),
                resolution: controlOptions('imgResolution'),
                count: [1, 2, 3, 4]
            },
            presets: groupPresets(),
            chat: buildChatState(),
            // 新版助手读这个：每个槽位叫什么、点了干什么
            sectors: buildSectors(),
            // 助手偏好设置里的动作下拉框用这个填
            actions: buildActions(),
            // 旧版助手只认这个扁平表。留着不影响新版，删了老助手会退回默认名。
            labels: buildLabels()
        };
    }

    function send(payload) {
        if (!connected || !socket || socket.readyState !== 1) return false;
        try {
            socket.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            return false;
        }
    }

    function pushState(immediate) {
        if (!connected) return;
        var now = Date.now();
        var wait = immediate ? 0 : STATE_THROTTLE_MS - (now - lastStateAt);
        if (wait <= 0) {
            lastStateAt = now;
            send({ type: 'state', payload: buildState() });
            return;
        }
        if (stateTimer) return;
        stateTimer = setTimeout(function () {
            stateTimer = null;
            lastStateAt = Date.now();
            send({ type: 'state', payload: buildState() });
        }, wait);
    }

    function progress(state, message, image) {
        var payload = { type: 'progress', state: state, message: message || '' };
        if (image) payload.thumbnail = image;
        send(payload);
    }

    // ---------- 指令执行 ----------

    function setPromptText(text) {
        var node = $('imgPrompt');
        if (!node) return false;
        node.value = String(text || '');
        node.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    function gallery() {
        return window.HuanmengGalleryStore || null;
    }

    /**
     * 跑一次生成。
     * 完成检测盯的是画廊：点渲染前记下已有 ID，轮询到新 ID 就是这次的结果。
     * 用主插件自己暴露的 window.HuanmengGalleryStore，不猜私有状态。
     */
    function taskCenter() {
        return (typeof window !== 'undefined' && window.HuanmengTaskCenter) || null;
    }

    /**
     * 找这次生成对应的画廊条目，只为了取缩略图。
     *
     * **必须按提示词认，不能随便抓最新的一条** —— 并发下同时有好几个任务在跑，
     * 抓最新会把别人的图当成自己的展示出来。
     * 认不出来就干脆不给缩略图：提示里少一张小图，好过显示一张错的。
     */
    async function thumbnailForPrompt(store, beforeGallery, promptText) {
        try {
            var items = store.list();
            for (var i = 0; i < items.length; i += 1) {
                if (beforeGallery[items[i].id]) continue;
                if (promptText && items[i].prompt && items[i].prompt !== promptText) continue;
                return (await store.getThumbnail(items[i].id)) || '';
            }
            return '';
        } catch (error) {
            return '';
        }
    }

    /**
     * 跑一次生成。
     *
     * 完成判定走**任务中心**，不再看画廊 —— 并发下「画廊里出现新条目」
     * 认不出那是谁的结果。老版本面板没有任务中心，退回原来的画廊轮询。
     */
    async function runGenerate(payload) {
        var store = gallery();
        if (!store) throw new Error('画廊存储不可用');

        if (payload.prompt) setPromptText(payload.prompt);
        // 走面板自己的写入接口 —— 下拉是自绘的，直接改原生 select 的话
        // 可见文字不会更新（和「参数菜单」是同一个坑）
        setParamValue('model', payload.model);
        setParamValue('resolution', payload.resolution);
        setParamValue('count', payload.count);
        await sleep(120);

        var button = $('btnImg2Img');
        if (!button || typeof button.onclick !== 'function') {
            throw new Error('找不到渲染按钮，面板可能还没初始化完');
        }

        var center = taskCenter();
        var beforeTasks = {};
        if (center) center.list().forEach(function (task) { beforeTasks[task.id] = true; });

        var beforeGallery = {};
        store.list().forEach(function (item) { beforeGallery[item.id] = true; });

        var promptText = payload.prompt || controlValue('imgPrompt');

        progress('running', '开始生成…');
        button.onclick();

        var deadline = Date.now() + 300000;

        // 老面板：没有任务中心，只能沿用「画廊出现新条目」那套
        if (!center) return await waitByGallery(store, beforeGallery, deadline);

        // 第一步：认出「哪个任务是这次点出来的」。
        // 并发时可能有好几个任务同时在跑，光看「有任务完成了」会认到别人的。
        var myTaskId = null;
        var discoverUntil = Date.now() + 15000;
        while (Date.now() < discoverUntil && !myTaskId) {
            await sleep(300);
            var fresh = center.list().filter(function (task) { return !beforeTasks[task.id]; });
            if (fresh.length) myTaskId = fresh[0].id;
        }
        if (!myTaskId) throw new Error('点了渲染但没看到新任务，面板可能拒绝了这个请求');

        // 第二步：盯住自己那一个的状态
        var lastBeat = Date.now();
        while (Date.now() < deadline) {
            await sleep(1000);

            var mine = null;
            var tasks = center.list();
            for (var i = 0; i < tasks.length; i += 1) {
                if (tasks[i].id === myTaskId) { mine = tasks[i]; break; }
            }
            if (!mine) throw new Error('任务记录不见了（面板可能重载过）');

            if (mine.state === 'completed' || mine.state === 'waiting_return') {
                progress('success', '生成完成', await thumbnailForPrompt(store, beforeGallery, promptText));
                return mine;
            }
            if (mine.state === 'failed') throw new Error(mine.detail || '生成失败');
            if (mine.state === 'cancelled') throw new Error(mine.detail || '任务已取消');

            if (Date.now() - lastBeat > 8000) {
                lastBeat = Date.now();
                progress('running', mine.detail || '等待模型返回…');
            }
        }
        throw new Error('等待生成结果超时（5 分钟）');
    }

    /// 老版本面板的降级路径：没有任务中心，只能看画廊里有没有新条目
    async function waitByGallery(store, beforeGallery, deadline) {
        var lastBeat = 0;
        while (Date.now() < deadline) {
            await sleep(1500);
            var items = store.list();
            for (var i = 0; i < items.length; i += 1) {
                if (beforeGallery[items[i].id]) continue;
                var thumb = '';
                try { thumb = await store.getThumbnail(items[i].id) || ''; } catch (error) {}
                progress('success', '生成完成', thumb);
                return items[i];
            }
            if (Date.now() - lastBeat > 10000) {
                lastBeat = Date.now();
                progress('running', '等待模型返回…');
            }
        }
        throw new Error('等待生成结果超时（5 分钟）');
    }

    /// 写一个参数。优先走面板自己的接口，没有就退回直接改 DOM（老面板）。
    function setParamValue(key, value) {
        if (value == null || value === '') return false;
        if (typeof window.applyRingParam === 'function') {
            return window.applyRingParam(key, value);
        }
        var map = { model: 'imgModel', resolution: 'imgResolution', count: 'imageCount' };
        return map[key] ? setControl(map[key], value) : false;
    }

    function applyParam(payload) {
        var failed = [];
        var done = [];

        Object.keys(payload).forEach(function (key) {
            // 下拉是自绘的，直接改原生 <select> 的 value 只会改到隐藏的那个，
            // 可见的触发器文字不动 —— 看起来就是「没同步」。
            if (setParamValue(key, payload[key])) done.push(key);
            else failed.push(key);
        });

        // 失败要说出来。以前是静默什么都不做，用户只能看到「改了没反应」，
        // 根本不知道是值不在选项里还是链路断了。
        if (failed.length) {
            progress('failure', '面板里没有这些选项：' + failed.join('、'));
        } else if (done.length) {
            progress('success', '已同步：' + done.join('、'));
        }

        // 无论成功失败都重推一次状态，让圆环上的显示和面板实际值对齐
        pushState(true);
    }

    function applyPresetByName(name) {
        for (var i = 0; i < presetCache.length; i += 1) {
            if (presetCache[i].name === name) {
                setPromptText(presetCache[i].prompt);
                // 预设下拉也跟着选中，面板上看到的和圆环选的一致
                setControl('promptPreset', presetCache[i].prompt);
                return true;
            }
        }
        return false;
    }

    /**
     * 把「哪个槽位被点了」翻译成「用户想让它干什么」。
     *
     * 为什么需要这一层：圆环点第 N 个槽位时，发过来的 action 就是那个槽位的 id
     * （generate / chat / readSelection …）。而用户可以把这个槽位改成别的功能。
     * 翻译放在插件侧做，好处是**不用更新圆环助手就能改按钮功能** ——
     * 助手只管把「几号槽位被点了」如实报上来。
     *
     * 只有当 action 恰好是槽位 id 时才翻译；其它值（tab:xxx、setParam…）原样放行。
     *
     * **新版助手发来的指令带 resolved:true，直接跳过这层翻译** ——
     * 它发过来的已经是解析好的动作，其中有些恰好和槽位 id 同名（generate / chat / close…），
     * 再解析一次会拿插件自己的配置覆盖掉用户在助手偏好设置里做的选择
     * （尤其是关掉「采用插件下发的扇区动作」之后）。
     */
    function resolveSlotAction(action, alreadyResolved) {
        if (alreadyResolved) return action;
        if (SLOT_IDS.indexOf(action) < 0) return action;
        // 老助手只会发槽位 id，它不认识「展开子菜单」这回事 ——
        // 对话槽位的默认动作已经换成 chatMenu 了，发给老助手只会得到
        // 一句「需要在圆环上展开」。这里给它保留改造前的行为。
        if (action === 'chat') return 'openChat';
        var entry = (ringSettings().sectors || {})[action] || {};
        return entry.action || DEFAULT_ACTIONS[action] || action;
    }

    async function handleCommand(message) {
        if (message.id) {
            if (message.id === lastCommandId) return;
            lastCommandId = message.id;
        }

        var action = resolveSlotAction(message.action, message.resolved === true);

        switch (action) {
        case 'generate':
            await runGenerate(message.payload || {});
            break;
        case 'setParam':
            applyParam(message.payload || {});
            break;
        case 'applyPreset':
            if (applyPresetByName(String((message.payload || {}).name || ''))) {
                progress('success', '已套用预设');
            } else {
                progress('failure', '找不到预设：' + (message.payload || {}).name);
            }
            break;
        case 'readSelection':
            await runReadSelection();
            break;
        case 'openChat':
            // 以前这里只弹一句「请去面板里用对话」，等于什么都没做。
            // 现在真的把面板切到对话页 —— 圆环上点「对话」就该看到对话。
            switchToTab('chat');
            break;
        case 'chatAsk':
            await runChatAsk((message.payload || {}).prompt);
            break;
        case 'chatNew':
            runChatNew();
            break;
        case 'chatModel':
            applyChatModel((message.payload || {}).value);
            break;
        case 'chatHistory':
            // 圆环想显示对话记录（它自己那份可能是空的，比如助手刚重启过）
            pushChat('history', { history: buildChatHistory(HISTORY_LIMIT) });
            break;
        case 'exportPresets':
            pushPresets();
            break;
        case 'exportConfig':
            // 助手要独立干活了，把它需要的接口配置给它一份 ——
            // 省得用户在助手那边把密钥再填一遍。
            // 走的是本机回环连接，和面板把密钥存在 localStorage 是同一信任边界。
            pushPluginConfig();
            break;
        case 'clearPrompt':
            setPromptText('');
            progress('success', '已清空提示词');
            pushState(true);
            break;
        case 'params':
        case 'presets':
        case 'chatMenu':
            // 这几个动作要靠圆环自己展开子菜单，插件这边没有对应的行为。
            // 多半是用户把它们指派给了别的位置 —— 说清楚，别静默什么都不做。
            var menuName = { params: '参数菜单', presets: '预设菜单', chatMenu: '对话菜单' }[action];
            progress('failure', '「' + menuName + '」需要在圆环上展开，不能直接执行');
            break;
        case 'close':
            // 圆环本地就把自己关了，正常不会发到这里
            break;
        case 'ping':
            progress('success', '主插件在线');
            break;
        default:
            // 切页动作统一是 tab:<tabId>，写成通用分支 ——
            // 以后加新页面不用改这里，设置页的 ACTIONS 表里加一条就行。
            if (action.indexOf('tab:') === 0) {
                switchToTab(action.slice(4));
            } else {
                progress('failure', '未知指令：' + action);
            }
        }
    }

    var TAB_NAMES = {
        img2img: '生成',
        apps: '快速',
        toolbox: '工具箱',
        runninghub: '应用',
        chat: '对话',
        settings: '设置',
        gallery: '画廊',
        generationCenter: '生成中心',
        logs: '记录',
        about: '关于'
    };

    function switchToTab(tabId) {
        // window.switchTab 是面板自己暴露的全局钩子（index.js 里挂的）。
        // 不自己去点 DOM 里的侧栏按钮 —— 那是绕过面板的状态管理，
        // 侧栏高亮和实际页面会对不上。
        if (typeof window.switchTab !== 'function') {
            progress('failure', '面板还没初始化完，稍后再试');
            return;
        }
        var known = Object.prototype.hasOwnProperty.call(TAB_NAMES, tabId);
        try {
            window.switchTab(tabId);
            progress('success', '已切到「' + (known ? TAB_NAMES[tabId] : tabId) + '」');
        } catch (error) {
            progress('failure', '切页失败：' + (error && error.message ? error.message : tabId));
        }
    }

    /**
     * 把面板的接口配置推给助手，供它独立工作时使用。
     *
     * 只发助手真的会用到的键 —— 不是把整份 settings 倒出去：
     * 面板里还有一堆界面偏好、渠道地址，助手拿了没用，还徒增泄漏面。
     */
    function pushPluginConfig() {
        var settings = null;
        try {
            var raw = localStorage.getItem('huanmeng_config');
            settings = raw ? (JSON.parse(raw).settings || null) : null;
        } catch (error) {
            settings = null;
        }
        if (!settings) {
            progress('failure', '读不到面板配置');
            return;
        }

        send({
            type: 'config',
            action: 'export',
            payload: {
                // 图像和对话共用同一把 GRS 密钥（面板里就是这么用的）
                grsApiKey: String(settings.imgApiKey || settings.chatApiKey || ''),
                grsRegion: settings.grsRegion === 'overseas' ? 'overseas' : 'domestic',
                imgModel: controlValue('imgModel') || String(settings.imgModel || ''),
                imageSize: normalizeImageResolution(controlValue('imgResolution')),
                chatModel: controlValue('chatModel') || String(settings.chatModel || ''),
                // 给的是**文字系统提示词**（对话用的那套）。
                // 别拿 imageSystemPromptPositive —— 那是给「修图」场景写的
                // （里面全是「保持主体身份、输入图…」），拿来问模型答非所问。
                // 独立出图那条路也不该用它：纯文生图没有输入图。
                systemPrompt: String(settings.textSystemPromptPositive || ''),
                // 对话模型清单：助手那边没有自己的型号表，只能从面板的下拉里拿
                chatModels: controlOptions('chatModel').map(function (option) {
                    return option.value;
                }),
                // 快捷提问：[[标题, 提示词], …] —— 就是这个数组的形状，
                // 助手直接照抄进配置，不用再解析一遍文本
                chatQuestions: chatQuestions().map(function (item) {
                    return [item.label, item.prompt];
                })
            }
        });
        progress('success', '配置已发送给助手');
    }

    /**
     * 把整份预设推给助手。
     *
     * 单独一条消息，不塞进 exportConfig —— 预设可能有几十上百条，
     * 混在配置里会让那条消息变得很大，而且两者的更新频率不一样
     * （用户可能只想更新预设）。
     */
    function pushPresets() {
        var items = presetCache.map(function (preset) {
            return { category: preset.category || '未分类', name: preset.name, prompt: preset.prompt };
        });
        if (!items.length) {
            progress('failure', '面板里没有预设可导出');
            return;
        }
        send({ type: 'config', action: 'presets', payload: { items: items } });
        progress('success', '已把 ' + items.length + ' 条预设发给助手');
    }

    /// 面板的分辨率值是 1K/2K/4K，助手那边的字段叫 imageSize
    function normalizeImageResolution(value) {
        var text = String(value || '').trim().toUpperCase();
        return ['1K', '2K', '4K'].indexOf(text) >= 0 ? text : '1K';
    }

    /**
     * 从圆环问一句。真正的请求全走面板自己的 chat()，
     * 这里只负责把三种结果（在想 / 回复 / 出错）转成圆环能显示的消息。
     */
    async function runChatAsk(rawPrompt) {
        var prompt = String(rawPrompt == null ? '' : rawPrompt).trim();
        if (!prompt) {
            progress('failure', '问题是空的');
            return;
        }

        var api = chatAPI();
        if (!api || typeof api.ask !== 'function') {
            progress('failure', '面板还没初始化完，稍后再试');
            return;
        }

        progress('running', '正在问：' + clip(prompt, 18));
        // 圆环先把气泡弹出来显示「正在回复…」，用户才知道真的发出去了 ——
        // 等接口返回可能要十几秒，什么都不显示会被当成没点上
        pushChat('thinking', {
            question: prompt,
            history: buildChatHistory(HISTORY_LIMIT, prompt)
        });

        var result = null;
        try {
            result = await api.ask(prompt);
        } catch (error) {
            result = { ok: false, error: (error && error.message) || '提问失败' };
        }

        if (result && result.ok) {
            pushChat('reply', {
                question: prompt,
                text: String(result.reply || ''),
                history: buildChatHistory(HISTORY_LIMIT)
            });
            progress('success', '已收到回复');
        } else {
            var reason = (result && result.error) || '提问失败';
            pushChat('error', {
                question: prompt,
                message: reason,
                history: buildChatHistory(HISTORY_LIMIT)
            });
            progress('failure', reason);
        }
        pushState(true);
    }

    function runChatNew() {
        var api = chatAPI();
        if (!api || typeof api.newChat !== 'function') {
            progress('failure', '面板还没初始化完，稍后再试');
            return;
        }
        try {
            api.newChat();
            progress('success', '已清空聊天记录');
        } catch (error) {
            progress('failure', '清空失败：' + ((error && error.message) || error));
        }
        pushState(true);
    }

    function applyChatModel(value) {
        if (value == null || value === '') return;
        if (typeof window.applyRingChatModel === 'function' && window.applyRingChatModel(value)) {
            progress('success', '对话模型已切到 ' + value);
        } else {
            progress('failure', '面板里没有这个对话模型：' + value);
        }
        pushState(true);
    }

    async function runReadSelection() {
        var button = $('btnImg2ImgReadSelection') || $('btnAddReferenceImage');
        if (!button || typeof button.onclick !== 'function') {
            progress('failure', '找不到「读取选区」按钮');
            return;
        }
        progress('running', '正在读取选区…');
        button.onclick();
        await sleep(2500);
        pushState(true);
        progress('success', '已读取选区作为参考图');
    }

    // ---------- 连接 ----------

    function open() {
        if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
        try {
            socket = new WebSocket(URL);
        } catch (error) {
            scheduleReconnect();
            return;
        }

        socket.addEventListener('open', function () {
            connected = true;
            reconnectDelay = RECONNECT_BASE_MS;
            attempts = 0;
            console.log('[圆环桥接] 已连接助手');
            pushState(true);
        });

        socket.addEventListener('message', function (event) {
            var message = null;
            try { message = JSON.parse(String(event.data)); } catch (error) { return; }
            if (!message || message.type === 'hello') return;
            if (message.type !== 'command') return;
            Promise.resolve().then(function () {
                return handleCommand(message);
            }).catch(function (error) {
                var text = error && error.message ? error.message : String(error);
                console.error('[圆环桥接] 指令失败：' + text);
                progress('failure', text);
            });
        });

        socket.addEventListener('error', function () { /* close 里统一处理 */ });

        socket.addEventListener('close', function () {
            connected = false;
            socket = null;
            scheduleReconnect();
        });
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        attempts += 1;
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            // 退避翻倍但封顶，连上后在 open 里重置
            reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
            open();
        }, reconnectDelay);
    }

    // ---------- 启动 ----------

    async function bootstrap() {
        await loadPresets();
        open();

        // 面板里任何参数变化都同步给圆环，圆环上的 ✓ 才不会停在旧值
        document.addEventListener('change', function (event) {
            var target = event.target;
            if (!target || !target.id) return;
            if (/^(imgModel|imgResolution|imageCount|imgPrompt)$/.test(target.id)) {
                pushState();
            }
        });
        document.addEventListener('input', function (event) {
            var target = event.target;
            if (target && target.id === 'imgPrompt') pushState();
        });

        // 选区变化、以及「用户在面板里自己发了条消息」都不会触发事件，
        // 靠定时刷新兜底 —— 圆环上的「看回复」最多晚 4 秒亮起来。
        setInterval(function () {
            if (connected) pushState();
        }, 4000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }

    return {
        URL: URL,
        open: open,
        isConnected: function () { return connected; },
        pushState: pushState,
        progress: progress,
        buildState: buildState,
        loadPresets: loadPresets,
        _handleCommand: handleCommand,

        // ---- 给设置页用 ----
        // 槽位和动作的唯一定义在 ring-bridge 里，设置页从这里取，
        // 避免「加了个动作但下拉框里没有」这种两处维护的经典问题。
        slots: function () { return SLOT_IDS.slice(); },
        actions: function () {
            return ACTIONS.map(function (action) {
                return { value: action.value, label: action.label, group: action.group, hint: action.hint || '' };
            });
        },
        defaultLabels: function () { return Object.assign({}, DEFAULT_LABELS); },
        /// 设置页里那个多行文本框和这里共用同一份解析规则，
        /// 免得「设置页说 6 条、圆环上只有 4 条」这种对不上的事
        parseChatQuestions: parseChatQuestions,
        defaultChatQuestions: function () { return DEFAULT_CHAT_QUESTIONS.slice(); },
        /// 槽位 → 默认动作。设置页的「恢复默认」和下拉初值都用它，
        /// 不能拿槽位 id 当默认动作 —— chat 槽位的默认动作是 openChat。
        defaultActions: function () { return Object.assign({}, DEFAULT_ACTIONS); },
        sectors: buildSectors,
        /// 设置改了以后立刻重推一次状态，圆环不用等下一次轮询
        notifyConfigChanged: function () { pushState(true); }
    };
})();
