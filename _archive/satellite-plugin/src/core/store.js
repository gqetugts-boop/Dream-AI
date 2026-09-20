// ============================================================
//  store.js — 插件本地配置与运行时状态
//
//  存储键前缀 huanmeng_sat_，与主插件的 huanmeng_* 互不干扰。
//  UXP 的 localStorage 按插件隔离，读不到主插件的配置，
//  所以跨插件共享走 shared-config.js 的文件通道。
// ============================================================

window.SatStore = (function () {
    var STORAGE_KEY = 'huanmeng_sat_config';
    var MAX_CHAT_MESSAGES = 60;

    var DEFAULT_CONFIG = {
        sharedConfigPath: '',
        shape: 'circle',
        radiusScale: 'normal',
        channel: 'grs',
        imageModel: '',
        chatModel: '',
        aspectRatio: '1:1',
        imageResolution: 'auto',
        imageCount: 1,
        referenceImages: [],
        overrides: {
            grsUrl: '',
            grsKey: '',
            newApiUrl: '',
            newApiKey: '',
            xaiUrl: '',
            xaiKey: ''
        },
        chatHistory: [],
        lastPrompt: ''
    };

    var state = {
        config: null,
        shared: null,
        sharedStatus: { loaded: false, message: '未读取', path: '' },
        lastResult: null,
        busy: false
    };

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function mergeDefaults(raw) {
        var config = clone(DEFAULT_CONFIG);
        if (!raw || typeof raw !== 'object') return config;
        Object.keys(config).forEach(function (key) {
            if (raw[key] === undefined || raw[key] === null) return;
            if (key === 'overrides') {
                Object.keys(config.overrides).forEach(function (inner) {
                    if (typeof raw.overrides[inner] === 'string') config.overrides[inner] = raw.overrides[inner];
                });
                return;
            }
            config[key] = raw[key];
        });
        if (!Array.isArray(config.chatHistory)) config.chatHistory = [];
        if (!Array.isArray(config.referenceImages)) config.referenceImages = [];
        return config;
    }

    function load() {
        var raw = null;
        try {
            var content = localStorage.getItem(STORAGE_KEY);
            if (content) raw = JSON.parse(content);
        } catch (error) {
            console.error('[卫星] 读取本地配置失败：' + error.message);
        }
        state.config = mergeDefaults(raw);
        return state.config;
    }

    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
            return true;
        } catch (error) {
            console.error('[卫星] 保存本地配置失败：' + error.message);
            return false;
        }
    }

    function get() {
        if (!state.config) load();
        return state.config;
    }

    function patch(changes, options) {
        var config = get();
        Object.keys(changes || {}).forEach(function (key) {
            config[key] = changes[key];
        });
        if (!options || options.persist !== false) save();
        return config;
    }

    function patchOverride(changes) {
        var config = get();
        Object.keys(changes || {}).forEach(function (key) {
            config.overrides[key] = changes[key];
        });
        save();
        return config.overrides;
    }

    function setShared(payload, statusMessage) {
        state.shared = payload || null;
        state.sharedStatus = {
            loaded: !!payload,
            message: statusMessage || (payload ? '已读取' : '未读取'),
            path: payload && payload.__path ? payload.__path : ''
        };
        return state.shared;
    }

    function shared() {
        return state.shared;
    }

    function sharedStatus() {
        return state.sharedStatus;
    }

    /**
     * 共享配置 + 本地覆盖合并后的实际渠道参数。
     * 本地覆盖永远优先，保证共享文件读不到时插件仍然可用。
     */
    function channels() {
        var config = get();
        var file = state.shared || {};
        var fileChannels = file.channels || {};
        var overrides = config.overrides || {};

        function pick(fileKey, overrideKey, fallbackUrl) {
            var fromFile = fileChannels[fileKey] || {};
            return {
                baseUrl: overrides[overrideKey] || fromFile.baseUrl || fallbackUrl || '',
                apiKey: overrides[overrideKey.replace(/Url$/, 'Key')] || fromFile.apiKey || ''
            };
        }

        var result = {
            grs: pick('grs', 'grsUrl', 'https://grsaiapi.com'),
            newapi: pick('newapi', 'newApiUrl', 'http://127.0.0.1:3000'),
            xai: pick('xai', 'xaiUrl', 'https://api.x.ai'),
            grok2api: pick('grok2api', 'grok2apiUrl', 'http://127.0.0.1:8000'),
            sub2api: pick('sub2api', 'sub2apiUrl', 'http://127.0.0.1:8080'),
            firefly: pick('firefly', 'fireflyUrl', 'http://127.0.0.1:8787'),
            volcengine: pick('volcengine', 'volcengineUrl', 'https://ark.cn-beijing.volces.com/api/v3'),
            gemini: pick('gemini', 'geminiUrl', '')
        };
        // 本地覆盖里的 key 命名不完全遵循 Url -> Key 的规律，逐个补齐
        var keyMap = {
            grs: 'grsKey', newapi: 'newApiKey', xai: 'xaiKey',
            grok2api: 'grok2apiKey', sub2api: 'sub2apiKey',
            firefly: 'fireflyKey', volcengine: 'volcengineKey', gemini: 'geminiKey'
        };
        Object.keys(keyMap).forEach(function (name) {
            if (overrides[keyMap[name]]) result[name].apiKey = overrides[keyMap[name]];
        });

        if (file.models && file.models.image && !config.imageModel) config.imageModel = file.models.image;
        if (file.models && file.models.chat && !config.chatModel) config.chatModel = file.models.chat;
        return result;
    }

    function setResult(result) {
        state.lastResult = result;
        return state.lastResult;
    }

    function lastResult() {
        return state.lastResult;
    }

    function setBusy(flag) {
        state.busy = !!flag;
        return state.busy;
    }

    function isBusy() {
        return state.busy;
    }

    function pushChat(message) {
        var config = get();
        config.chatHistory.push(message);
        while (config.chatHistory.length > MAX_CHAT_MESSAGES) config.chatHistory.shift();
        save();
        return config.chatHistory;
    }

    function chatHistory() {
        return get().chatHistory;
    }

    function clearChat() {
        return patch({ chatHistory: [] });
    }

    function addReference(image) {
        var config = get();
        if (config.referenceImages.length >= 4) return config.referenceImages;
        config.referenceImages.push(image);
        save();
        return config.referenceImages;
    }

    function clearReferences() {
        return patch({ referenceImages: [] });
    }

    return {
        STORAGE_KEY: STORAGE_KEY,
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        load: load,
        save: save,
        get: get,
        patch: patch,
        patchOverride: patchOverride,
        setShared: setShared,
        shared: shared,
        sharedStatus: sharedStatus,
        channels: channels,
        setResult: setResult,
        lastResult: lastResult,
        setBusy: setBusy,
        isBusy: isBusy,
        pushChat: pushChat,
        chatHistory: chatHistory,
        clearChat: clearChat,
        addReference: addReference,
        clearReferences: clearReferences
    };
})();
