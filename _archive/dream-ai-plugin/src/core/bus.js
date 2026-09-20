/*
 * core/bus.js — 极简事件总线
 *
 * 职责：模块间松耦合通信（任务状态、选区变化、语言/主题切换、结果就绪）。
 * 边界：同步派发，不排队、不重试；异常只记录不抛出，避免一个订阅者拖垮全链路。
 *
 * 约定事件名：
 *   selection:change   选区更新 { sample }
 *   task:created       新任务 { task }
 *   task:update        任务状态变化 { task }
 *   task:finished      任务结束 { task }
 *   result:ready       有可回写结果 { task, images }
 *   lang:change        语言切换 { lang }
 *   theme:change       主题切换 { theme }
 *   store:change       持久化变化 { domain, value }
 *   status:message     状态条文案 { text, tone }
 *   log:entry          新日志 { entry }
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.bus) return;

    var map = {};

    function on(event, handler) {
        if (typeof handler !== 'function') return function () {};
        var name = String(event || '');
        if (!map[name]) map[name] = [];
        map[name].push(handler);
        return function () { off(name, handler); };
    }

    function once(event, handler) {
        var dispose = on(event, function (payload) {
            dispose();
            handler(payload);
        });
        return dispose;
    }

    function off(event, handler) {
        var list = map[String(event || '')];
        if (!list) return;
        if (!handler) { delete map[String(event || '')]; return; }
        var index = list.indexOf(handler);
        if (index !== -1) list.splice(index, 1);
    }

    function emit(event, payload) {
        var name = String(event || '');
        var list = map[name];
        if (!list || !list.length) return 0;
        var snapshot = list.slice();
        var delivered = 0;
        for (var i = 0; i < snapshot.length; i++) {
            try {
                snapshot[i](payload, name);
                delivered++;
            } catch (error) {
                if (global.console) global.console.warn('[bus] handler failed for ' + name, error);
            }
        }
        return delivered;
    }

    DreamAI.bus = {
        on: on,
        once: once,
        off: off,
        emit: emit,
        /** 调试辅助：列出已订阅的事件名与数量 */
        inspect: function () {
            var out = {};
            for (var name in map) {
                if (Object.prototype.hasOwnProperty.call(map, name)) out[name] = map[name].length;
            }
            return out;
        }
    };
})(typeof window !== 'undefined' ? window : this);
