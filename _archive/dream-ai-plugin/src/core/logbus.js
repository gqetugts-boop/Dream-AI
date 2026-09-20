/*
 * core/logbus.js — 环形日志缓冲
 *
 * 职责：记录插件内部事件（含级别、时间、域、上下文），供活动日志抽屉与导出使用。
 * 边界：只做内存缓冲 + 转发 bus 事件；持久化交给调用方决定。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.logbus) return;

    var util = DreamAI.util;
    var MAX_ENTRIES = 400;
    var entries = [];
    var seq = 0;
    var LEVELS = ['debug', 'info', 'success', 'warn', 'error'];

    /**
     * 写一条日志。
     * @param {string} level debug|info|success|warn|error
     * @param {string} message 已本地化的文案
     * @param {Object} [meta] 附加上下文（provider、taskId、耗时等）
     */
    function push(level, message, meta) {
        var normalized = LEVELS.indexOf(level) === -1 ? 'info' : level;
        var entry = {
            seq: ++seq,
            at: Date.now(),
            level: normalized,
            domain: (meta && meta.domain) || 'app',
            message: String(message == null ? '' : message),
            meta: meta || null
        };
        entries.push(entry);
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
        if (DreamAI.bus) DreamAI.bus.emit('log:entry', entry);
        return entry;
    }

    function debug(message, meta) { return push('debug', message, meta); }
    function info(message, meta) { return push('info', message, meta); }
    function success(message, meta) { return push('success', message, meta); }
    function warn(message, meta) { return push('warn', message, meta); }

    function error(message, meta) {
        var payload = util.isPlainObject(meta) ? util.deepClone(meta) : {};
        if (meta instanceof Error) {
            payload.message = meta.message;
            payload.stack = meta.stack;
        }
        return push('error', message, payload);
    }

    /** @returns {Array} 日志副本，按时间正序 */
    function list() {
        return entries.map(function (item) { return util.deepClone(item); });
    }

    function filter(criteria) {
        var options = criteria || {};
        return list().filter(function (entry) {
            if (options.level && options.level !== 'all' && entry.level !== options.level) return false;
            if (options.domain && entry.domain !== options.domain) return false;
            if (options.keyword) {
                var needle = String(options.keyword).toLowerCase();
                var haystack = (entry.message + ' ' + (entry.meta ? JSON.stringify(entry.meta) : '')).toLowerCase();
                if (haystack.indexOf(needle) === -1) return false;
            }
            return true;
        });
    }

    function clear() {
        var count = entries.length;
        entries = [];
        return count;
    }

    /** 导出为纯文本，便于复制给他人排查 */
    function toText() {
        return list().map(function (entry) {
            var stamp = new Date(entry.at).toISOString();
            var extra = entry.meta ? ' ' + JSON.stringify(entry.meta) : '';
            return '[' + stamp + '] [' + entry.level.toUpperCase() + '] [' + entry.domain + '] ' + entry.message + extra;
        }).join('\n');
    }

    /** 导出为 JSON 字符串（画廊/日志备份用） */
    function toJson() {
        return JSON.stringify(list(), null, 2);
    }

    DreamAI.logbus = {
        LEVELS: LEVELS.slice(),
        push: push,
        debug: debug,
        info: info,
        success: success,
        warn: warn,
        error: error,
        list: list,
        filter: filter,
        clear: clear,
        toText: toText,
        toJson: toJson,
        get size() { return entries.length; },
        get limit() { return MAX_ENTRIES; }
    };
})(typeof window !== 'undefined' ? window : this);
