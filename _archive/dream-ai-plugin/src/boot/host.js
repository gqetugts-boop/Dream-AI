/*
 * boot/host.js — 宿主环境探测
 *
 * 职责：判断当前运行在 Adobe UXP（Photoshop）内，还是普通浏览器预览页，
 * 并把宿主模块暴露到统一的 DreamAI.host 上。
 * 边界：不访问网络、不操作文档、不读写插件状态。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};

    var modules = { photoshop: null, uxp: null, fs: null, os: null };
    var inUxp = false;

    /*
     * 取宿主模块加载器。
     *
     * 只判断 `typeof require` 是不够的：UXP 把 require 挂在全局对象上，
     * 而某些加载方式（ESM 包装、沙箱、测试替身）下它是 undefined，
     * 一旦探测失败就会**静默降级成"浏览器预览"**，所有 Photoshop 功能集体失效
     * 却不报错。这里依次尝试三种取法，任何一条成功就继续。
     */
    function getRequire() {
        try { if (typeof require === 'function') return require; } catch (error) { /* 继续 */ }
        try { if (global && typeof global.require === 'function') return global.require; } catch (error) { /* 继续 */ }
        try {
            if (typeof globalThis !== 'undefined' && typeof globalThis.require === 'function') return globalThis.require;
        } catch (error) { /* 继续 */ }
        return null;
    }

    try {
        var loader = getRequire();
        if (loader) {
            try { modules.uxp = loader('uxp') || null; } catch (error) { modules.uxp = null; }
            try { modules.photoshop = loader('photoshop') || null; } catch (error) { modules.photoshop = null; }
        }
        if (modules.uxp) {
            try { inUxp = !!(modules.uxp.host && modules.uxp.host.name); } catch (e) { inUxp = true; }
            try { modules.fs = modules.uxp.storage.localFileSystem; } catch (e) { modules.fs = null; }
            try { modules.os = modules.uxp.os; } catch (e) { modules.os = null; }
        }
    } catch (error) {
        // 浏览器预览：require 不存在或调用失败，保持 null
        modules.photoshop = null;
        inUxp = false;
    }

    var hostInfo = {
        name: inUxp ? 'uxp' : 'browser',
        appName: '',
        appVersion: '',
        pluginVersion: '1.0.0'
    };

    if (inUxp && modules.uxp && modules.uxp.host) {
        try {
            hostInfo.appName = modules.uxp.host.name || '';
            hostInfo.appVersion = modules.uxp.host.version || '';
        } catch (e) { /* 忽略版本读取失败 */ }
    }

    // 宿主模块解析失败时给一条可见日志：这是最容易"静默失效"的地方
    if (!modules.uxp && DreamAI.logbus) {
        DreamAI.logbus.debug('未检测到 UXP 宿主模块，按浏览器预览模式运行', { domain: 'host' });
    } else if (modules.uxp && !modules.photoshop && DreamAI.logbus) {
        DreamAI.logbus.warn('检测到 UXP 但未取到 photoshop 模块，Photoshop 功能不可用', { domain: 'host' });
    }

    DreamAI.host = {
        /** 是否运行在 Adobe UXP 宿主内 */
        isUxp: inUxp,
        /** 是否具备可用的 Photoshop API（UXP 且 photoshop 模块存在） */
        hasPhotoshop: !!(inUxp && modules.photoshop),
        info: hostInfo,
        modules: modules,
        /** 便捷读取：UXP 的 photoshop 模块（浏览器下为 null） */
        get ps() { return modules.photoshop; }
    };
})(typeof window !== 'undefined' ? window : this);
