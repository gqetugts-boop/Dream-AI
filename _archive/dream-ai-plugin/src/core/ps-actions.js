/*
 * core/ps-actions.js — 常用 Photoshop 操作的按钮组件
 *
 * 职责：把 deselect / duplicate / invert / fill / transform / merge / flatten
 *       这些单步操作封装成可复用的按钮组，工具箱与其他页面共用同一份定义，
 *       避免每个页面各写一遍按钮文案与错误处理。
 * 边界：只调用 DreamAI.PhotoIO 暴露的方法，不直接使用 batchPlay。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.PsActions) return;

    var util = DreamAI.util;

    /** 可用操作清单：key 为词条键，method 为 PhotoIO 上的方法名 */
    var ACTIONS = [
        { key: 'tools.psDeselect', method: 'deselect', glyph: '▢' },
        { key: 'tools.psDuplicate', method: 'duplicateLayer', glyph: '⧉' },
        { key: 'tools.psInvertSelection', method: 'invertSelection', glyph: '◑' },
        { key: 'tools.psFillSelection', method: 'fillSelectionWithForeground', glyph: '◧' },
        { key: 'tools.psFreeTransform', method: 'freeTransform', glyph: '⤢' },
        { key: 'tools.psMergeVisible', method: 'mergeVisible', glyph: '≣' },
        { key: 'tools.psFlatten', method: 'flattenImage', glyph: '▤' }
    ];

    /**
     * 执行一个操作，统一处理提示与日志。
     * @param {string} method PhotoIO 上的方法名
     * @param {string} labelKey 用于成功提示的词条键
     * @returns {Promise<void>}
     */
    function run(method, labelKey) {
        var api = DreamAI.PhotoIO;
        if (!api || !api.isAvailable()) {
            DreamAI.Shell.toast('selection.browserOnly', { tone: 'warn' });
            return Promise.resolve();
        }
        if (typeof api[method] !== 'function') {
            DreamAI.Shell.toast('app.notConfigured', { tone: 'warn' });
            return Promise.resolve();
        }
        DreamAI.Shell.status('app.busy', { key: 'app.busy', tone: 'busy' });
        return Promise.resolve(api[method]()).then(function () {
            var name = labelKey && DreamAI.I18n.has(labelKey) ? DreamAI.I18n.t(labelKey) : method;
            DreamAI.Shell.toast(DreamAI.I18n.t('tools.psActionDone', { name: name }), { tone: 'ok' });
            DreamAI.Shell.status('app.ready', { key: 'app.ready', tone: 'idle' });
        }, function (error) {
            var reason = error && error.message ? error.message : String(error);
            DreamAI.Shell.toast(DreamAI.I18n.t('tools.actionFail', { reason: reason }), { tone: 'error' });
            DreamAI.Shell.status('app.ready', { key: 'app.ready', tone: 'idle' });
            DreamAI.logbus.warn('Photoshop 操作失败：' + method + ' — ' + reason, { domain: 'ps-actions' });
        });
    }

    /**
     * 生成操作按钮网格。
     * @param {Object} W 控件工厂（DreamAI.Widgets）
     * @param {{columns?:number, only?:string[], block?:boolean}} [options]
     * @returns {HTMLElement}
     */
    function buildGrid(W, options) {
        var opts = options || {};
        var allowed = Array.isArray(opts.only) ? opts.only : null;
        var buttons = [];
        for (var i = 0; i < ACTIONS.length; i++) {
            var action = ACTIONS[i];
            if (allowed && allowed.indexOf(action.method) === -1) continue;
            buttons.push(buildButton(W, action));
        }
        return W.grid(buttons, opts.columns || 2);
    }

    /** 单个操作按钮 */
    function buildButton(W, action) {
        return W.button(action.key, {
            variant: 'ghost',
            glyph: action.glyph,
            block: true,
            onClick: function () { run(action.method, action.key); }
        });
    }

    /**
     * 前景色取样：返回 hex，供特效面板等场景复用。
     * @returns {Promise<{r:number,g:number,b:number,hex:string}|null>}
     */
    function sampleForeground() {
        var api = DreamAI.PhotoIO;
        if (!api || !api.isAvailable()) {
            DreamAI.Shell.toast('selection.browserOnly', { tone: 'warn' });
            return Promise.resolve(null);
        }
        return Promise.resolve(api.getForegroundColor()).then(function (color) {
            DreamAI.Shell.toast(DreamAI.I18n.t('vfx.picked', { hex: color.hex }), { tone: 'ok' });
            return color;
        }, function (error) {
            DreamAI.Shell.toast(error && error.message ? error.message : String(error), { tone: 'warn' });
            return null;
        });
    }

    DreamAI.PsActions = {
        ACTIONS: ACTIONS,
        run: run,
        buildGrid: buildGrid,
        buildButton: buildButton,
        sampleForeground: sampleForeground
    };
})(typeof window !== 'undefined' ? window : this);
