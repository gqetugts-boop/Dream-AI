/*
 * ui/router.js — 页面注册与切换
 *
 * 职责：
 *   - 收集各页面模块通过 register() 注册的页面描述；
 *   - 在左侧栏渲染竖排导航（图标在上、文字在下，按分组用分隔线区分）；
 *   - 首次激活时才构建页面并挂载到舞台，切换时调用 unmount；
 *   - 把当前页名称同步到顶栏标题，语言切换后刷新导航文案。
 * 边界：不认识任何具体页面业务；不读写 Store（除最后停留页）。
 *
 * 导航分层：
 *   create / engine / asset 三组进侧栏滚动区；system 组（设置、关于）不进侧栏，
 *   由顶栏的设置按钮直接跳转，这样侧栏在竖排窄面板下不会被挤成两屏。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.Router) return;

    var util = DreamAI.util;
    var LAST_PAGE_KEY = 'ui:lastPage';
    var GROUP_ORDER = ['create', 'engine', 'asset', 'system'];
    var SIDEBAR_GROUPS = ['create', 'engine', 'asset'];
    var GROUP_LABEL = {
        create: 'nav.groupCreate',
        engine: 'nav.groupEngine',
        asset: 'nav.groupAsset',
        system: 'nav.groupSystem'
    };

    var registry = [];
    var instances = {};
    var activeId = null;
    var navEl = null;
    var stageEl = null;
    var pageTitleEl = null;
    var listeners = [];

    /**
     * @param {{id:string, group:string, labelKey:string, glyph?:string, order?:number, build:Function}} descriptor
     */
    function register(descriptor) {
        if (!descriptor || !descriptor.id || typeof descriptor.build !== 'function') {
            throw new Error('[router] page descriptor requires id and build()');
        }
        for (var i = 0; i < registry.length; i++) {
            if (registry[i].id === descriptor.id) {
                registry[i] = descriptor;
                return descriptor;
            }
        }
        registry.push(descriptor);
        return descriptor;
    }

    function byGroup() {
        var groups = {};
        var i;
        for (i = 0; i < GROUP_ORDER.length; i++) groups[GROUP_ORDER[i]] = [];
        for (i = 0; i < registry.length; i++) {
            var page = registry[i];
            var key = GROUP_ORDER.indexOf(page.group) === -1 ? 'system' : page.group;
            groups[key].push(page);
        }
        for (i = 0; i < GROUP_ORDER.length; i++) {
            groups[GROUP_ORDER[i]].sort(function (a, b) {
                var orderA = a.order === undefined ? 100 : a.order;
                var orderB = b.order === undefined ? 100 : b.order;
                if (orderA !== orderB) return orderA - orderB;
                return String(a.id).localeCompare(String(b.id));
            });
        }
        return groups;
    }

    function renderNav() {
        if (!navEl) return;
        util.clear(navEl);
        var groups = byGroup();
        for (var g = 0; g < SIDEBAR_GROUPS.length; g++) {
            var pages = groups[SIDEBAR_GROUPS[g]];
            if (!pages.length) continue;
            var groupNode = util.el('div', { class: 'sidebar-group', dataset: { group: SIDEBAR_GROUPS[g] } });
            for (var i = 0; i < pages.length; i++) {
                groupNode.appendChild(buildNavTab(pages[i]));
            }
            navEl.appendChild(groupNode);
        }
    }

    function buildNavTab(page) {
        var label = DreamAI.I18n.t(page.labelKey);
        // 标签只保留短词，避免在 68px 宽栏里被截成省略号：
        // 先取词条，再在渲染时按容器宽度自然换行。
        return util.el('button', {
            type: 'button',
            class: 'sidebar-tab',
            role: 'tab',
            dataset: { page: page.id },
            'aria-selected': String(page.id === activeId),
            title: label,
            'aria-label': label,
            onclick: function () { activate(page.id); }
        }, [
            util.el('span', { class: 'sidebar-tab-glyph', text: page.glyph || '·', 'aria-hidden': 'true' }),
            util.el('span', { class: 'sidebar-tab-label', text: label, 'data-i18n': page.labelKey })
        ]);
    }

    function syncNav() {
        if (navEl) {
            var tabs = navEl.querySelectorAll('.sidebar-tab');
            for (var i = 0; i < tabs.length; i++) {
                tabs[i].setAttribute('aria-selected', String(tabs[i].getAttribute('data-page') === activeId));
            }
        }
        syncTitle();
    }

    function syncTitle() {
        if (!pageTitleEl) return;
        var descriptor = getDescriptor(activeId);
        if (!descriptor) return;
        pageTitleEl.textContent = DreamAI.I18n.t(descriptor.labelKey);
        pageTitleEl.setAttribute('data-i18n', descriptor.labelKey);
        var instance = instances[activeId];
        if (instance && instance.node) instance.node.setAttribute('aria-label', DreamAI.I18n.t(descriptor.labelKey));
    }

    function getDescriptor(id) {
        for (var i = 0; i < registry.length; i++) {
            if (registry[i].id === id) return registry[i];
        }
        return null;
    }

    /** 懒加载：首次激活才 build，保证启动速度 */
    function ensureInstance(id) {
        if (instances[id]) return instances[id];
        var descriptor = getDescriptor(id);
        if (!descriptor) return null;
        var built = descriptor.build(DreamAI.Widgets) || {};
        var node = built.el;
        if (!node) throw new Error('[router] page ' + id + ' build() did not return { el }');
        node.setAttribute('data-page', id);
        instances[id] = {
            descriptor: descriptor,
            node: node,
            api: built,
            mounted: false
        };
        stageEl.appendChild(node);
        return instances[id];
    }

    function activate(id, options) {
        var descriptor = getDescriptor(id);
        if (!descriptor) return false;
        var previous = activeId ? instances[activeId] : null;
        if (previous && previous.mounted) {
            try {
                if (typeof previous.api.unmount === 'function') previous.api.unmount();
            } catch (error) {
                DreamAI.logbus.warn('[router] unmount failed for ' + activeId, { error: String(error && error.message) });
            }
            previous.mounted = false;
            previous.node.setAttribute('hidden', '');
        }

        activeId = id;
        var instance = ensureInstance(id);
        if (instance) {
            instance.node.removeAttribute('hidden');
            if (!instance.mounted) {
                try {
                    if (typeof instance.api.mount === 'function') instance.api.mount();
                } catch (error) {
                    DreamAI.logbus.error('[router] mount failed for ' + id, error);
                }
                instance.mounted = true;
            }
        }
        syncNav();
        if (stageEl) stageEl.scrollTop = 0;
        try {
            global.localStorage && global.localStorage.setItem(DreamAI.Store.PREFIX + LAST_PAGE_KEY, id);
        } catch (error) { /* 忽略 */ }

        if (!(options && options.silent)) {
            DreamAI.bus.emit('page:change', { id: id, previous: previous ? previous.descriptor.id : null });
        }
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](id); } catch (error) { /* 忽略 */ }
        }
        return true;
    }

    function refreshActive() {
        var instance = activeId ? instances[activeId] : null;
        if (!instance) return;
        try {
            if (typeof instance.api.refresh === 'function') instance.api.refresh();
        } catch (error) {
            DreamAI.logbus.warn('[router] refresh failed for ' + activeId, { error: String(error && error.message) });
        }
    }

    /** 重建所有已构建的页面（语言/主题大改后使用） */
    function reset() {
        for (var id in instances) {
            if (!Object.prototype.hasOwnProperty.call(instances, id)) continue;
            var instance = instances[id];
            if (instance.node.parentNode) instance.node.parentNode.removeChild(instance.node);
        }
        instances = {};
        activeId = null;
    }

    function readLastPage() {
        try {
            var value = global.localStorage && global.localStorage.getItem(DreamAI.Store.PREFIX + LAST_PAGE_KEY);
            return value && getDescriptor(value) ? value : null;
        } catch (error) {
            return null;
        }
    }

    function sortedFirst() {
        var groups = byGroup();
        for (var i = 0; i < SIDEBAR_GROUPS.length; i++) {
            if (groups[SIDEBAR_GROUPS[i]].length) return groups[SIDEBAR_GROUPS[i]][0].id;
        }
        return registry[0] ? registry[0].id : null;
    }

    function init(navNode, stageNode, options) {
        navEl = navNode;
        stageEl = stageNode;
        pageTitleEl = (options && options.titleNode) || global.document.getElementById('topbarPage');
        renderNav();
        DreamAI.I18n.onChange(function () {
            renderNav();
            syncNav();
        });
        var start = (options && options.page) || readLastPage() || (registry.length ? sortedFirst() : null);
        if (start) activate(start, { silent: true });
        return start;
    }

    function onChange(handler) {
        if (typeof handler !== 'function') return function () {};
        listeners.push(handler);
        return function () {
            var index = listeners.indexOf(handler);
            if (index !== -1) listeners.splice(index, 1);
        };
    }

    DreamAI.Router = {
        GROUP_LABEL: GROUP_LABEL,
        SIDEBAR_GROUPS: SIDEBAR_GROUPS.slice(),
        register: register,
        init: init,
        activate: activate,
        refreshActive: refreshActive,
        reset: reset,
        onChange: onChange,
        getActive: function () { return activeId; },
        getInstance: function (id) { return instances[id] || null; },
        list: function () { return registry.slice(); }
    };
})(typeof window !== 'undefined' ? window : this);
