/*
 * i18n/i18n.js — 双语运行时
 *
 * 职责：
 *   - 管理当前语言（zh-CN / en-US），持久化到 localStorage；
 *   - 提供 t() / ta() / apply() 三个查询与渲染入口；
 *   - 聚合各功能模块通过 DreamAI.I18n.add(lang, dict) 追加的词条；
 *   - 语言切换后广播 lang:change，并重扫 data-i18n* 属性。
 * 边界：不直接操作业务状态，不知道任何具体业务键的含义。
 *
 * 词条键约定：<域>.<名称>，全小写驼峰，例如 ws.render、tools.glow.title。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.I18n) return;

    function isPlain(value) {
        if (DreamAI.util && DreamAI.util.isPlainObject) return DreamAI.util.isPlainObject(value);
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    var STORAGE_KEY = 'dream-ai:lang';
    var SUPPORTED = ['zh-CN', 'en-US'];
    var FALLBACK = 'zh-CN';

    /** @type {Object<string, Object<string,string>>} 语言 → 词条 */
    var dictionaries = { 'zh-CN': {}, 'en-US': {} };
    var current = FALLBACK;
    var listeners = [];

    function normalizeLang(input) {
        var raw = String(input || '').trim();
        if (!raw) return null;
        var lower = raw.toLowerCase();
        for (var i = 0; i < SUPPORTED.length; i++) {
            if (SUPPORTED[i].toLowerCase() === lower) return SUPPORTED[i];
        }
        // "zh" / "zh-Hans" / "en-GB" 这类前缀也接受
        if (lower.indexOf('zh') === 0) return 'zh-CN';
        if (lower.indexOf('en') === 0) return 'en-US';
        return null;
    }

    function readStoredLang() {
        try {
            var value = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
            return normalizeLang(value);
        } catch (error) {
            return null;
        }
    }

    function detectHostLang() {
        try {
            if (DreamAI.host && DreamAI.host.isUxp && global.navigator) {
                var detected = normalizeLang(global.navigator.language);
                if (detected) return detected;
            }
            if (global.navigator) {
                var nav = normalizeLang(global.navigator.language || global.navigator.userLanguage);
                if (nav) return nav;
            }
        } catch (error) { /* 忽略 */ }
        return null;
    }

    /** 合并一批词条；同名键后写入者覆盖，便于功能模块微调公共措辞外的自有键 */
    function add(lang, dictionary) {
        var target = normalizeLang(lang) || FALLBACK;
        if (!dictionary || typeof dictionary !== 'object') return;
        var bucket = dictionaries[target];
        for (var key in dictionary) {
            if (!Object.prototype.hasOwnProperty.call(dictionary, key)) continue;
            bucket[key] = dictionary[key];
        }
    }

    function has(key, lang) {
        var target = normalizeLang(lang) || current;
        if (Object.prototype.hasOwnProperty.call(dictionaries[target], key)) return true;
        return Object.prototype.hasOwnProperty.call(dictionaries[FALLBACK], key);
    }

    function interpolate(template, params) {
        if (!params) return template;
        return String(template).replace(/\{(\w+)\}/g, function (match, name) {
            if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
            var value = params[name];
            return value === undefined || value === null ? '' : String(value);
        });
    }

    /**
     * 查询词条。
     * @param {string} key 词条键
     * @param {Object} [params] 插值参数，对应词条里的 {name}
     * @returns {string} 命中词条；未命中时返回键名（便于发现漏翻）
     */
    function t(key, params) {
        var name = String(key == null ? '' : key);
        if (!name) return '';
        var bucket = dictionaries[current] || {};
        var text = bucket[name];
        if (text === undefined || text === null) text = dictionaries[FALLBACK][name];
        if (text === undefined || text === null) return name;
        return interpolate(text, params);
    }

    /** 取整个数组词条（下拉选项、标签集合等）；未命中返回空数组 */
    function ta(key) {
        var value = dictionaries[current] ? dictionaries[current][key] : undefined;
        if (value === undefined) value = dictionaries[FALLBACK][key];
        if (Array.isArray(value)) return value.slice();
        return [];
    }

    /**
     * 取对象词条（键值映射，例如选项 → 标签）。
     * @returns {Object} 未命中返回空对象
     */
    function to(key) {
        var value = dictionaries[current] ? dictionaries[current][key] : undefined;
        if (value === undefined) value = dictionaries[FALLBACK][key];
        if (isPlain(value)) {
            var out = {};
            for (var k in value) if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = value[k];
            return out;
        }
        return {};
    }

    var ATTR_MAP = [
        ['data-i18n', 'text'],
        ['data-i18n-title', 'title'],
        ['data-i18n-placeholder', 'placeholder'],
        ['data-i18n-label', 'label'],
        ['data-i18n-aria', 'aria-label']
    ];

    /**
     * 渲染一个子树里所有 data-i18n* 标注。
     * 词条缺失时保留原文本，方便先在 HTML 里写默认文案。
     */
    function apply(root) {
        var scope = root || global.document;
        if (!scope || !scope.querySelectorAll) return;
        for (var i = 0; i < ATTR_MAP.length; i++) {
            var attr = ATTR_MAP[i][0];
            var target = ATTR_MAP[i][1];
            var nodes = scope.querySelectorAll('[' + attr + ']');
            for (var j = 0; j < nodes.length; j++) {
                var node = nodes[j];
                var key = node.getAttribute(attr);
                if (!key || !has(key)) continue;
                var text = t(key);
                if (target === 'text') node.textContent = text;
                else node.setAttribute(target, text);
            }
        }
    }

    function getLang() { return current; }

    /** 供 UI 显示的语言缩写：zh-CN → 中, en-US → EN */
    function langBadge(lang) {
        return (normalizeLang(lang) || current) === 'zh-CN' ? '中' : 'EN';
    }

    function onChange(handler) {
        if (typeof handler !== 'function') return function () {};
        listeners.push(handler);
        return function () {
            var index = listeners.indexOf(handler);
            if (index !== -1) listeners.splice(index, 1);
        };
    }

    function setLang(lang, options) {
        var next = normalizeLang(lang);
        if (!next || next === current) {
            apply(global.document);
            return current;
        }
        current = next;
        try { global.localStorage && global.localStorage.setItem(STORAGE_KEY, current); } catch (error) { /* 忽略 */ }
        if (global.document && global.document.documentElement) {
            global.document.documentElement.setAttribute('lang', current);
        }
        if (global.document && global.document.body) {
            global.document.body.setAttribute('data-lang', current);
        }
        apply(global.document);
        for (var i = 0; i < listeners.length; i++) {
            try {
                listeners[i](current, options || {});
            } catch (error) {
                if (global.console) global.console.warn('[i18n] listener failed', error);
            }
        }
        if (DreamAI.bus) DreamAI.bus.emit('lang:change', { lang: current, options: options || {} });
        return current;
    }

    function toggle() {
        return setLang(current === 'zh-CN' ? 'en-US' : 'zh-CN');
    }

    /** 并入启动早期由各词条文件排入的待处理词条 */
    function flushQueue() {
        var queue = DreamAI.__i18nQueue;
        if (!Array.isArray(queue)) return 0;
        var count = 0;
        for (var i = 0; i < queue.length; i++) {
            add(queue[i].lang, queue[i].dictionary);
            count++;
        }
        DreamAI.__i18nQueue = [];
        return count;
    }

    function init() {
        flushQueue();
        var initial = readStoredLang() || detectHostLang() || FALLBACK;
        current = initial;
        if (global.document && global.document.body) global.document.body.setAttribute('data-lang', current);
        apply(global.document);
        return current;
    }

    DreamAI.I18n = {
        SUPPORTED: SUPPORTED.slice(),
        FALLBACK: FALLBACK,
        add: add,
        init: init,
        flushQueue: flushQueue,
        getLang: getLang,
        setLang: setLang,
        toggle: toggle,
        normalizeLang: normalizeLang,
        langBadge: langBadge,
        has: has,
        t: t,
        ta: ta,
        to: to,
        apply: apply,
        onChange: onChange,
        /** 便于测试与调试 */
        dictionaries: dictionaries
    };
})(typeof window !== 'undefined' ? window : this);
