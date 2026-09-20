/*
 * core/theme.js — 亮/暗主题
 *
 * 职责：把主题写到 <body data-theme>，持久化选择，广播 theme:change。
 * 规则：默认亮色；「跟随系统」由调用方解析后传入具体值（UXP 对媒体查询支持不一致）。
 * 边界：不碰任何组件内部样式，所有颜色都由 tokens.css 的变量派生。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.Theme) return;

    var STORAGE_KEY = 'dream-ai:theme';
    var ACCENT_KEY = 'dream-ai:accent';
    var THEMES = ['light', 'dark'];
    var ACCENTS = ['morandi', 'zhuang'];
    var current = 'light';
    var currentAccent = 'morandi';

    function normalizeAccent(value) {
        var accent = String(value || '').toLowerCase();
        return ACCENTS.indexOf(accent) === -1 ? null : accent;
    }

    /** 强调色方案：morandi（默认低饱和）/ zhuang（参考配色的青蓝） */
    function setAccent(accent, options) {
        var next = normalizeAccent(accent) || currentAccent;
        currentAccent = next;
        if (global.document && global.document.body) {
            global.document.body.setAttribute('data-accent', currentAccent);
        }
        try {
            global.localStorage && global.localStorage.setItem(ACCENT_KEY, currentAccent);
        } catch (error) { /* 忽略 */ }
        if (!(options && options.silent)) {
            if (DreamAI.bus) DreamAI.bus.emit('accent:change', { accent: currentAccent });
        }
        return currentAccent;
    }

    function readStoredAccent() {
        try {
            return normalizeAccent(global.localStorage && global.localStorage.getItem(ACCENT_KEY));
        } catch (error) {
            return null;
        }
    }

    function normalize(theme) {
        var value = String(theme || '').toLowerCase();
        return THEMES.indexOf(value) === -1 ? null : value;
    }

    function readStored() {
        try {
            return normalize(global.localStorage && global.localStorage.getItem(STORAGE_KEY));
        } catch (error) {
            return null;
        }
    }

    /** 从宿主推断默认主题：PS 深色界面下多数用户偏好暗色面板 */
    function detectHostTheme() {
        try {
            if (DreamAI.host && DreamAI.host.isUxp && global.matchMedia) {
                if (global.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
            }
            if (DreamAI.host && DreamAI.host.isUxp) return 'dark';
        } catch (error) { /* 忽略 */ }
        return 'light';
    }

    function apply(theme) {
        var next = normalize(theme) || current;
        current = next;
        if (global.document && global.document.body) {
            global.document.body.setAttribute('data-theme', current);
        }
        if (global.document && global.document.documentElement) {
            global.document.documentElement.setAttribute('data-color-scheme', current);
        }
        return current;
    }

    function set(theme, options) {
        var next = normalize(theme);
        if (!next) return current;
        apply(next);
        try {
            global.localStorage && global.localStorage.setItem(STORAGE_KEY, current);
        } catch (error) { /* 忽略 */ }
        if (!(options && options.silent)) {
            if (DreamAI.bus) DreamAI.bus.emit('theme:change', { theme: current });
        }
        return current;
    }

    function toggle() {
        return set(current === 'dark' ? 'light' : 'dark');
    }

    function init() {
        apply(readStored() || detectHostTheme());
        setAccent(readStoredAccent() || 'morandi', { silent: true });
        return current;
    }

    DreamAI.Theme = {
        THEMES: THEMES.slice(),
        ACCENTS: ACCENTS.slice(),
        init: init,
        get: function () { return current; },
        set: set,
        toggle: toggle,
        normalize: normalize,
        getAccent: function () { return currentAccent; },
        setAccent: setAccent,
        normalizeAccent: normalizeAccent
    };
})(typeof window !== 'undefined' ? window : this);
