'use strict';

// 圆环对话（ring-bridge.js 的 chat 部分）离线验证。
//
// 为什么值得单独测：圆环上点「快捷提问」→ 气泡显示回复，这条链路上
// 有三个地方会**静默失效** ——
//   · 快捷提问解析错 → 圆环里列出的是半截字符串
//   · chat 状态没进 state → 圆环的子菜单永远空着
//   · chatAsk 指令没接上 → 点了没反应，连报错都没有
// 这些都不会抛异常，只能靠跑一遍断言。
//
// ring-bridge.js 是个挂在 window 上的 IIFE，依赖 UXP 的 require、WebSocket。
// 这里给最小替身，把它的消息收发录下来检查。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'features', 'ring-bridge', 'ring-bridge.js'), 'utf8');

// ---------- 最小环境 ----------

function makeSandbox(options) {
    const opts = options || {};
    const sent = [];
    const listeners = {};

    const elements = {};
    function makeSelect(id, values) {
        elements[id] = {
            id: id,
            value: values.length ? values[0] : '',
            options: values.map(function (v) { return { value: v, text: v.toUpperCase() }; })
        };
    }
    makeSelect('imgModel', ['nano-banana-fast', 'grs-image']);
    makeSelect('imgResolution', ['1K', '2K']);
    makeSelect('imageCount', ['1', '2']);
    makeSelect('chatModel', ['grs/gpt-5.4', 'grs/gpt-5.4-mini']);

    const document = {
        readyState: 'complete',
        body: { appendChild: function () {} },
        getElementById: function (id) { return elements[id] || null; },
        addEventListener: function (type, handler) { (listeners[type] = listeners[type] || []).push(handler); }
    };

    const store = new Map();
    if (opts.config) store.set('huanmeng_config', JSON.stringify(opts.config));

    const sandbox = {
        console: { log: function () {}, warn: function () {}, error: function () {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: function () { return 0; },   // 状态轮询在测试里不需要
        clearInterval: function () {},
        Date: Date,
        JSON: JSON,
        Math: Math,
        Object: Object,
        Array: Array,
        Promise: Promise,
        String: String,
        Number: Number,
        Error: Error,
        localStorage: {
            getItem: function (key) { return store.has(key) ? store.get(key) : null; },
            setItem: function (key, value) { store.set(key, String(value)); }
        },
        document: document,
        WebSocket: function (url) {
            this.url = url;
            this.readyState = 1;      // 直接当作已连接
            this.listeners = {};
            this.send = function (data) { sent.push(JSON.parse(data)); };
            this.addEventListener = function (type, handler) {
                this.listeners[type] = this.listeners[type] || [];
                this.listeners[type].push(handler);
                // 构造完就触发 open：模拟「助手已经在跑」
                if (type === 'open') {
                    const self = this;
                    Promise.resolve().then(function () { handler({}); self.readyState = 1; });
                }
            };
        },
        require: function (name) { throw new Error('no ' + name + ' in test'); }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox, { filename: 'ring-bridge.js' });
    return { sandbox: sandbox, sent: sent, elements: elements };
}

function lastOf(sent, type) {
    for (let i = sent.length - 1; i >= 0; i -= 1) {
        if (sent[i].type === type) return sent[i];
    }
    return null;
}

function allOf(sent, type) {
    return sent.filter(function (m) { return m.type === type; });
}

async function flush() {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

(async function run() {
    // ---------- 1. 快捷提问的解析 ----------
    {
        const box = makeSandbox({});
        const parse = box.sandbox.window.HuanmengRingBridge.parseChatQuestions;

        assert.equal(parse('').length, 0, '空文本应当解析出 0 条');
        assert.equal(parse(null).length, 0, 'null 不能抛异常');

        const custom = parse([
            '调色=给我一个调色思路',       // 等号
            '构图|从构图角度评价一下',      // 竖线
            '锐化建议',                    // 只有提示词
            '# 这是注释',
            '',                            // 空行
            '   ',                         // 全空白
            '= 只有等号没有标题'            // 等号在开头 → 当整句处理
        ].join('\n'));

        assert.equal(custom.length, 4, '应当只剩 4 条有效提问，实际 ' + custom.length);
        assert.equal(custom[0].label, '调色');
        assert.equal(custom[0].prompt, '给我一个调色思路');
        assert.equal(custom[1].label, '构图');
        assert.equal(custom[1].prompt, '从构图角度评价一下');
        assert.equal(custom[2].label, '锐化建议', '没写标题时用提示词前几个字当标题');
        assert.equal(custom[2].prompt, '锐化建议');
        assert.equal(custom[3].prompt, '= 只有等号没有标题', '开头的等号不能把标题切成空');
        assert.ok(custom[3].label.length > 0, '标题不能为空 —— 圆环扇区里会是一片空白');
    }

    // ---------- 2. 默认提问 ----------
    {
        const box = makeSandbox({});
        const bridge = box.sandbox.window.HuanmengRingBridge;
        const defaults = bridge.defaultChatQuestions();
        assert.ok(defaults.length >= 4, '内置提问至少有 4 条，实际 ' + defaults.length);
        defaults.forEach(function (item) {
            assert.ok(item.label && item.label.length <= 6,
                '标题要短到能塞进扇区：' + item.label);
            assert.ok(item.prompt && item.prompt.length > item.label.length,
                '提示词应当比标题长：' + item.prompt);
        });
    }

    // ---------- 3. state 里的 chat 块 ----------
    await (async function () {
        const box = makeSandbox({});
        await flush();
        const bridge = box.sandbox.window.HuanmengRingBridge;

        // 面板的对话接口（index.js 里的 window.HuanmengChat）
        box.sandbox.window.HuanmengChat = {
            state: function () {
                return {
                    model: 'grs/gpt-5.4',
                    models: [{ value: 'grs/gpt-5.4', text: 'GPT-5.4' }, { value: 'grs/gpt-5.4-mini', text: 'mini' }],
                    busy: false,
                    lastQuestion: '这张图怎么调',
                    lastReply: '先压高光…',
                    historyCount: 2
                };
            }
        };

        const state = bridge.buildState();
        assert.ok(state.chat, 'state 里必须有 chat 块，否则圆环的对话菜单是空的');
        assert.equal(state.chat.model, 'grs/gpt-5.4');
        assert.equal(state.chat.models.length, 2);
        assert.equal(state.chat.questions.length, 6, '没配置时用内置的六条');
        assert.equal(state.chat.hasReply, true);
        assert.equal(state.chat.busy, false);
        assert.ok(state.chat.lastReply.indexOf('压高光') >= 0);

        // 面板没加载出来（例如插件刚启动）时不能抛异常，圆环只该看到空菜单
        delete box.sandbox.window.HuanmengChat;
        const bare = bridge.buildState();
        assert.equal(bare.chat.models.length, 0);
        assert.equal(bare.chat.hasReply, false);
        assert.equal(bare.chat.questions.length, 6, '提问来自插件配置，和面板在不在无关');
    })();

    // ---------- 4. 用户自定义提问进 state ----------
    await (async function () {
        const box = makeSandbox({
            config: { settings: { ring: { chatQuestions: '磨皮=给我一套磨皮参数\n抠图=怎么把主体抠干净' } } }
        });
        await flush();
        const state = box.sandbox.window.HuanmengRingBridge.buildState();
        assert.equal(state.chat.questions.length, 2, '配置了就用配置的，不能被内置那套盖住');
        assert.equal(state.chat.questions[0].label, '磨皮');
        assert.equal(state.chat.questions[1].prompt, '怎么把主体抠干净');
    })();

    // ---------- 5. chatAsk 指令走通 ----------
    await (async function () {
        const box = makeSandbox({});
        await flush();
        const bridge = box.sandbox.window.HuanmengRingBridge;
        let asked = '';
        // 面板那边的聊天记录：第一轮已经问过一句了
        const panelHistory = [
            { role: 'user', text: '你好' },
            { role: 'assistant', text: '你好，有什么可以帮你的？' }
        ];
        box.sandbox.window.HuanmengChat = {
            state: function () {
                return { model: '', models: [], busy: false, lastQuestion: '', lastReply: '', historyCount: 0 };
            },
            history: function (limit) {
                const start = typeof limit === 'number' && limit > 0
                    ? Math.max(0, panelHistory.length - limit) : 0;
                return panelHistory.slice(start);
            },
            ask: async function (text) { asked = text; return { ok: true, reply: '建议先压高光' }; },
            newChat: function () {}
        };

        box.sent.length = 0;
        await bridge._handleCommand({ action: 'chatAsk', resolved: true, payload: { prompt: '这张图怎么调' } });

        assert.equal(asked, '这张图怎么调', '问出去的内容必须原样传给面板');

        const chat = allOf(box.sent, 'chat');
        assert.equal(chat.length, 2, '应当先 thinking 再 reply，实际 ' + chat.length);
        assert.equal(chat[0].action, 'thinking');
        assert.equal(chat[0].payload.question, '这张图怎么调');
        assert.equal(chat[1].action, 'reply');
        assert.equal(chat[1].payload.text, '建议先压高光');

        // 圆环要显示的是**完整的来回**，不是只有最后一问一答 ——
        // 这就是「长对话」：气泡里能一直往上翻
        assert.ok(Array.isArray(chat[1].payload.history), 'reply 要带上完整记录');
        assert.equal(chat[1].payload.history.length, 2, '面板里已有的两条要在里面');
        assert.equal(chat[1].payload.history[0].text, '你好');

        // 「正在回复」阶段面板还没把这句记进聊天记录，必须由桥接补上 ——
        // 否则用户看不到自己刚问的那句，会以为没发出去
        assert.equal(chat[0].payload.history.length, 3, 'thinking 的记录里要包含刚问的这句');
        assert.equal(chat[0].payload.history[2].role, 'user');
        assert.equal(chat[0].payload.history[2].text, '这张图怎么调');

        const phases = allOf(box.sent, 'progress').map(function (m) { return m.state; });
        assert.ok(phases.indexOf('running') >= 0, '开始要报 running，用户才知道点上了');
        assert.ok(phases.indexOf('success') >= 0, '成功要有反馈');
        assert.ok(lastOf(box.sent, 'state'), '结束后要重推 state，让「看回复」亮起来');
    })();

    // ---------- 6. 提问失败 ----------
    await (async function () {
        const box = makeSandbox({});
        await flush();
        const bridge = box.sandbox.window.HuanmengRingBridge;
        box.sandbox.window.HuanmengChat = {
            state: function () {
                return { model: '', models: [], busy: false, lastQuestion: '', lastReply: '', historyCount: 0 };
            },
            ask: async function () { return { ok: false, error: '请先在设置中配置API密钥' }; },
            newChat: function () {}
        };

        box.sent.length = 0;
        await bridge._handleCommand({ action: 'chatAsk', resolved: true, payload: { prompt: '你好' } });

        const chat = allOf(box.sent, 'chat');
        assert.equal(chat.length, 2);
        assert.equal(chat[1].action, 'error');
        assert.ok(chat[1].payload.message.indexOf('API密钥') >= 0,
            '失败原因要原样带到圆环，不能吞掉');
        const failed = allOf(box.sent, 'progress').filter(function (m) { return m.state === 'failure'; });
        assert.equal(failed.length, 1, '失败要有一个 failure 反馈');
    })();

    // ---------- 7. 空问题 ----------
    await (async function () {
        const box = makeSandbox({});
        await flush();
        const bridge = box.sandbox.window.HuanmengRingBridge;
        let called = false;
        box.sandbox.window.HuanmengChat = {
            state: function () { return {}; },
            ask: async function () { called = true; return { ok: true, reply: '' }; }
        };

        box.sent.length = 0;
        await bridge._handleCommand({ action: 'chatAsk', resolved: true, payload: { prompt: '   ' } });
        assert.equal(called, false, '空问题不该发出去');
        assert.equal(allOf(box.sent, 'chat').length, 0);
    })();

    // ---------- 8. 切对话模型 ----------
    await (async function () {
        const box = makeSandbox({});
        await flush();
        const bridge = box.sandbox.window.HuanmengRingBridge;
        let applied = null;
        box.sandbox.window.applyRingChatModel = function (value) { applied = value; return true; };

        box.sent.length = 0;
        await bridge._handleCommand({ action: 'chatModel', resolved: true, payload: { value: 'grs/gpt-5.4-mini' } });
        assert.equal(applied, 'grs/gpt-5.4-mini');

        const ok = allOf(box.sent, 'progress').filter(function (m) { return m.state === 'success'; });
        assert.equal(ok.length, 1);

        // 面板里没有这个模型 → 必须报错，不能静默什么都不做
        box.sandbox.window.applyRingChatModel = function () { return false; };
        box.sent.length = 0;
        await bridge._handleCommand({ action: 'chatModel', resolved: true, payload: { value: '不存在' } });
        const bad = allOf(box.sent, 'progress').filter(function (m) { return m.state === 'failure'; });
        assert.equal(bad.length, 1, '切不动的模型要明确报错');
    })();

    // ---------- 9. 新对话 ----------
    await (async function () {
        const box = makeSandbox({});
        await flush();
        const bridge = box.sandbox.window.HuanmengRingBridge;
        let cleared = false;
        box.sandbox.window.HuanmengChat = {
            state: function () { return {}; },
            newChat: function () { cleared = true; return true; }
        };

        await bridge._handleCommand({ action: 'chatNew', resolved: true, payload: {} });
        assert.equal(cleared, true, '新对话要真的清空面板的聊天记录');
    })();

    // ---------- 10. 兼容旧版助手 ----------
    await (async function () {
        const box = makeSandbox({});
        await flush();
        const bridge = box.sandbox.window.HuanmengRingBridge;
        let tab = '';
        box.sandbox.window.switchTab = function (id) { tab = id; };

        // 老助手只发槽位 id、不带 resolved。chat 槽位的默认动作已经换成
        // chatMenu（子菜单），但老助手压根不认识子菜单，必须退回「切到对话页」
        await bridge._handleCommand({ action: 'chat' });
        assert.equal(tab, 'chat', '老助手发 chat 时应当切到对话页，而不是回一句「需要在圆环上展开」');
    })();

    // ---------- 10.5 导出配置给助手（独立模式要用）----------
    //
    // 助手不带插件的时候得自己调接口，所以需要自己有一份密钥和模型。
    // 让用户填两遍太蠢 —— 这条指令就是「一键导入」的数据通路。
    await (async function () {
        const box = makeSandbox({
            config: {
                settings: {
                    imgApiKey: 'sk-test-key-1234',
                    grsRegion: 'domestic',
                    imgModel: 'nano-banana-fast',
                    chatModel: 'grs/gpt-5.5',
                    imageSystemPromptPositive: '这是生图用的提示词，不该给对话用',
                    textSystemPromptPositive: '这是对话用的提示词'
                }
            }
        });
        await flush();
        box.elements.imgModel.value = 'nano-banana-fast';
        box.elements.chatModel.value = 'grs/gpt-5.5';
        box.elements.imgResolution.value = '2K';

        box.sent.length = 0;
        await box.sandbox.window.HuanmengRingBridge._handleCommand({
            action: 'exportConfig', resolved: true
        });

        const exported = box.sent.filter(function (m) { return m.type === 'config'; });
        assert.equal(exported.length, 1, '应当推一条 config 消息');

        const p = exported[0].payload;
        assert.equal(exported[0].action, 'export');
        assert.equal(p.grsApiKey, 'sk-test-key-1234', '密钥要原样给过去');
        assert.equal(p.grsRegion, 'domestic');
        assert.equal(p.imgModel, 'nano-banana-fast');
        assert.equal(p.imageSize, '2K', '分辨率要映射成助手那边的 1K/2K/4K');
        assert.equal(p.chatModel, 'grs/gpt-5.5');
        assert.equal(p.systemPrompt, '这是对话用的提示词',
            '必须给「文字」系统提示词，不能给生图那套（那是修图场景的，答非所问）');

        // 面板配置读不出来时要明确报错，不能静默发一条空配置过去
        const box2 = makeSandbox({});
        await flush();
        box2.sent.length = 0;
        await box2.sandbox.window.HuanmengRingBridge._handleCommand({
            action: 'exportConfig', resolved: true
        });
        const failed = box2.sent.filter(function (m) {
            return m.type === 'progress' && m.state === 'failure';
        });
        assert.equal(failed.length, 1, '读不到配置要报错');
    })();

    // ---------- 11. 动作表 ----------
    {
        const box = makeSandbox({});
        const bridge = box.sandbox.window.HuanmengRingBridge;
        const actions = bridge.actions().map(function (a) { return a.value; });
        assert.ok(actions.indexOf('chatMenu') >= 0, '动作表要有 chatMenu，否则设置页下拉里选不到');
        assert.ok(actions.indexOf('chatNew') >= 0);
        assert.ok(actions.indexOf('openChat') >= 0, '原来的「切到对话页」要保留');
        assert.equal(bridge.defaultActions().chat, 'chatMenu',
            '对话槽位的默认动作是展开子菜单');
        assert.ok(actions.indexOf('chatAsk') < 0,
            'chatAsk 需要参数，不能出现在可指派的动作表里');
    }

    console.log('ring chat: ok');
})().catch(function (error) {
    console.error(error);
    process.exit(1);
});
