/*
 * core/store.js — 命名空间化持久化
 *
 * 职责：把插件状态按 "域" 存进 localStorage，键统一加 dream-ai: 前缀；
 * 提供带默认值的读取、浅合并写入、订阅变更。
 * 边界：不做业务校验；不做网络；不直接渲染界面。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.Store) return;

    var util = DreamAI.util;
    var PREFIX = 'dream-ai:';
    var memoryFallback = {};
    var listeners = [];
    var available = (function () {
        try {
            if (!global.localStorage) return false;
            var probe = PREFIX + '__probe';
            global.localStorage.setItem(probe, '1');
            global.localStorage.removeItem(probe);
            return true;
        } catch (error) {
            return false;
        }
    })();

    function qualified(domain) {
        var name = String(domain || '').trim();
        return PREFIX + (name || 'global');
    }

    function rawGet(key) {
        if (!available) return Object.prototype.hasOwnProperty.call(memoryFallback, key) ? memoryFallback[key] : null;
        try {
            return global.localStorage.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function rawSet(key, value) {
        if (!available) { memoryFallback[key] = value; return true; }
        try {
            global.localStorage.setItem(key, value);
            return true;
        } catch (error) {
            if (global.console) global.console.warn('[store] write failed for ' + key, error);
            return false;
        }
    }

    function rawRemove(key) {
        if (!available) { delete memoryFallback[key]; return; }
        try { global.localStorage.removeItem(key); } catch (error) { /* 忽略 */ }
    }

    /**
     * 读取一个域的数据，与 defaults 深合并（缺字段补默认值，废弃字段保留）。
     * @param {string} domain 域名称，例如 'settings'
     * @param {Object} [defaults]
     * @returns {Object}
     */
    function read(domain, defaults) {
        var key = qualified(domain);
        var text = rawGet(key);
        var parsed = null;
        if (text) {
            try { parsed = JSON.parse(text); } catch (error) {
                if (global.console) global.console.warn('[store] corrupted payload at ' + key + ', falling back to defaults');
                parsed = null;
            }
        }
        if (!util.isPlainObject(parsed)) {
            return util.isPlainObject(defaults) ? util.deepClone(defaults) : {};
        }
        return util.isPlainObject(defaults) ? util.deepMerge(defaults, parsed) : parsed;
    }

    /**
     * 写入一个域。patch 为对象时与现有数据深合并，否则整体覆盖。
     * @param {string} domain
     * @param {Object} patch
     * @param {Object} [defaults] 合并基线
     */
    function write(domain, patch, defaults) {
        var next = util.isPlainObject(patch)
            ? util.deepMerge(read(domain, defaults), patch)
            : patch;
        rawSet(qualified(domain), JSON.stringify(next));
        emit(domain, next);
        return next;
    }

    function writeAll(domain, value) {
        rawSet(qualified(domain), JSON.stringify(value));
        emit(domain, value);
        return value;
    }

    function remove(domain) {
        rawRemove(qualified(domain));
        emit(domain, null);
    }

    function keys() {
        var out = [];
        if (!available) {
            for (var k in memoryFallback) if (Object.prototype.hasOwnProperty.call(memoryFallback, k)) out.push(k);
            return out;
        }
        try {
            for (var i = 0; i < global.localStorage.length; i++) {
                var key = global.localStorage.key(i);
                if (key && key.indexOf(PREFIX) === 0) out.push(key);
            }
        } catch (error) { /* 忽略 */ }
        return out;
    }

    /** 依赖方订阅某个域的写入；返回取消订阅函数 */
    function subscribe(domain, handler) {
        if (typeof handler !== 'function') return function () {};
        var entry = { domain: String(domain || ''), handler: handler };
        listeners.push(entry);
        return function () {
            var index = listeners.indexOf(entry);
            if (index !== -1) listeners.splice(index, 1);
        };
    }

    function emit(domain, value) {
        for (var i = 0; i < listeners.length; i++) {
            if (listeners[i].domain !== domain) continue;
            try {
                listeners[i].handler(value, domain);
            } catch (error) {
                if (global.console) global.console.warn('[store] subscriber failed for ' + domain, error);
            }
        }
        if (DreamAI.bus) DreamAI.bus.emit('store:change', { domain: domain, value: value });
    }

    function clearAll() {
        var list = keys();
        for (var i = 0; i < list.length; i++) rawRemove(list[i]);
    }

    DreamAI.Store = {
        PREFIX: PREFIX,
        available: available,
        read: read,
        write: write,
        writeAll: writeAll,
        remove: remove,
        keys: keys,
        subscribe: subscribe,
        clearAll: clearAll
    };
})(typeof window !== 'undefined' ? window : this);
