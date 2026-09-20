/*
 * ui/shell.js — 外壳界面：状态条、轻提示、模态、抽屉、任务托盘
 *
 * 职责：把 index.html 里的固定骨架接上逻辑，向上提供简洁 API。
 * 边界：不处理业务请求；任务列表数据由 task-queue 推送。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.Shell) return;

    var util = DreamAI.util;
    var el = util.el;
    var W = null;
    var nodes = {};
    var toastTimer = null;
    var statusTimer = null;
    var lastStatusKey = null;

    function t(key, params) {
        return DreamAI.I18n.t(key, params);
    }

    function cache() {
        var doc = global.document;
        nodes.shell = doc.getElementById('appShell');
        nodes.veil = doc.getElementById('bootVeil');
        nodes.nav = doc.getElementById('appNav');
        nodes.pageTitle = doc.getElementById('topbarPage');
        nodes.stage = doc.getElementById('appStage');
        nodes.statusMessage = doc.getElementById('statusMessage');
        nodes.statusProgress = doc.getElementById('statusProgress');
        nodes.statusProgressBar = doc.getElementById('statusProgressBar');
        nodes.statusMeta = doc.getElementById('statusMeta');
        nodes.statusDot = doc.getElementById('statusDot');
        nodes.activityDot = doc.getElementById('activityDot');
        nodes.btnActivityLog = doc.getElementById('btnActivityLog');
        nodes.taskDrawer = doc.getElementById('taskDrawer');
        nodes.taskDrawerBody = doc.getElementById('taskDrawerBody');
        nodes.logDrawer = doc.getElementById('logDrawer');
        nodes.logDrawerBody = doc.getElementById('logDrawerBody');
        nodes.modalLayer = doc.getElementById('modalLayer');
        nodes.modalTitle = doc.getElementById('modalTitle');
        nodes.modalBody = doc.getElementById('modalBody');
        nodes.modalFoot = doc.getElementById('modalFoot');
        nodes.toastStack = doc.getElementById('toastStack');
        nodes.taskBadge = doc.getElementById('taskBadge');
        nodes.langChipText = doc.getElementById('langChipText');
        nodes.themeGlyph = doc.getElementById('themeGlyph');
        nodes.btnTaskTray = doc.getElementById('btnTaskTray');
        nodes.btnLangToggle = doc.getElementById('btnLangToggle');
        nodes.btnThemeToggle = doc.getElementById('btnThemeToggle');
        nodes.btnOpenSettings = doc.getElementById('btnOpenSettings');
        nodes.btnCloseTaskDrawer = doc.getElementById('btnCloseTaskDrawer');
        nodes.btnCloseLogDrawer = doc.getElementById('btnCloseLogDrawer');
        nodes.btnCloseModal = doc.getElementById('btnCloseModal');
        nodes.btnCopyLogs = doc.getElementById('btnCopyLogs');
        nodes.btnClearLogs = doc.getElementById('btnClearLogs');
    }

    /* ---------- 状态条 ---------- */

    /**
     * 更新状态条。
     * @param {string} text 已本地化文案或 i18n 键
     * @param {{tone?:'idle'|'busy'|'ok'|'warn'|'error', progress?:number, meta?:string, key?:string}} [options]
     */
    function status(text, options) {
        var opts = options || {};
        if (!nodes.statusMessage) return;
        var isKey = opts.key || (DreamAI.I18n.has(text) ? text : null);
        if (isKey) {
            nodes.statusMessage.textContent = t(isKey);
            nodes.statusMessage.setAttribute('data-i18n', isKey);
        } else {
            nodes.statusMessage.removeAttribute('data-i18n');
            nodes.statusMessage.textContent = String(text == null ? '' : text);
        }
        lastStatusKey = isKey;
        var tone = opts.tone || 'idle';
        if (nodes.activityDot) nodes.activityDot.setAttribute('data-state', tone);
        if (nodes.statusDot) nodes.statusDot.setAttribute('data-state', tone);
        if (opts.meta !== undefined && nodes.statusMeta) nodes.statusMeta.textContent = String(opts.meta);
        setProgress(opts.progress);

        if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
        if (opts.autoClear) {
            statusTimer = setTimeout(function () {
                status('app.ready', { key: 'app.ready', tone: 'idle', progress: null });
            }, util.toNumber(opts.autoClear, 2500));
        }
    }

    /** progress 传 null 隐藏进度条；0-100 显示确定进度 */
    function setProgress(progress) {
        if (!nodes.statusProgress) return;
        if (progress === null || progress === undefined) {
            nodes.statusProgress.setAttribute('hidden', '');
            return;
        }
        nodes.statusProgress.removeAttribute('hidden');
        var value = util.clamp(progress, 0, 100);
        nodes.statusProgressBar.style.width = value + '%';
    }

    /* ---------- 轻提示 ---------- */

    /**
     * @param {string} textOrKey
     * @param {{tone?:'info'|'ok'|'warn'|'error', duration?:number, glyph?:string}} [options]
     */
    function toast(textOrKey, options) {
        var opts = options || {};
        if (!nodes.toastStack) return;
        var isKey = DreamAI.I18n.has(textOrKey);
        var glyph = opts.glyph || (opts.tone === 'ok' ? '✓' : opts.tone === 'warn' ? '!' : opts.tone === 'error' ? '×' : '·');
        var node = el('div', { class: 'toast', dataset: { tone: opts.tone || 'info' } }, [
            el('span', { class: 'toast-glyph', text: glyph, 'aria-hidden': 'true' }),
            el('span', { class: 'truncate', text: isKey ? t(textOrKey) : String(textOrKey == null ? '' : textOrKey) })
        ]);
        nodes.toastStack.appendChild(node);
        while (nodes.toastStack.children.length > 3) {
            nodes.toastStack.removeChild(nodes.toastStack.firstChild);
        }
        var duration = util.toNumber(opts.duration, opts.tone === 'error' ? 5200 : 2600);
        setTimeout(function () {
            if (node.parentNode) node.parentNode.removeChild(node);
        }, duration);
    }

    /* ---------- 模态 ---------- */

    /**
     * 打开模态。
     * @param {{titleKey?:string, title?:string, body:Node|Node[], actions?:Array}} options
     *        actions: `[{ labelKey, variant, onClick(close), keepOpen }]`
     * @returns {{ close:Function, body:HTMLElement }}
     */
    function modal(options) {
        var opts = options || {};
        if (!nodes.modalLayer) return { close: function () {}, body: null };
        util.clear(nodes.modalTitle);
        util.clear(nodes.modalBody);
        util.clear(nodes.modalFoot);

        var titleKey = opts.titleKey || null;
        nodes.modalTitle.textContent = titleKey ? t(titleKey) : String(opts.title || '');
        if (titleKey) nodes.modalTitle.setAttribute('data-i18n', titleKey);

        var body = nodes.modalBody;
        appendChildren(body, opts.body);

        function close() {
            nodes.modalLayer.setAttribute('hidden', '');
            util.clear(nodes.modalBody);
            util.clear(nodes.modalFoot);
            if (typeof opts.onClose === 'function') opts.onClose();
        }

        var actions = opts.actions || [];
        for (var i = 0; i < actions.length; i++) {
            (function (action) {
                var btn = W.button(action.labelKey || action.label, {
                    variant: action.variant || 'plain',
                    onClick: function () {
                        var result = typeof action.onClick === 'function' ? action.onClick(close) : undefined;
                        if (action.keepOpen !== true && result !== false) close();
                    }
                });
                nodes.modalFoot.appendChild(btn);
            })(actions[i]);
        }
        if (!actions.length) {
            nodes.modalFoot.appendChild(W.button('app.close', { variant: 'plain', onClick: close }));
        }

        nodes.modalLayer.removeAttribute('hidden');
        return { close: close, body: body };
    }

    function confirmDialog(messageKey, options) {
        var opts = options || {};
        return new Promise(function (resolve) {
            modal({
                titleKey: opts.titleKey || 'app.confirm',
                body: el('div', { class: 'field-hint', text: DreamAI.I18n.has(messageKey) ? t(messageKey, opts.params) : String(messageKey) }),
                actions: [
                    { labelKey: 'app.cancel', variant: 'quiet', onClick: function () { resolve(false); } },
                    { labelKey: opts.confirmKey || 'app.confirm', variant: opts.danger ? 'danger' : 'primary', onClick: function () { resolve(true); } }
                ],
                onClose: function () { resolve(false); }
            });
        });
    }

    function promptDialog(titleKey, options) {
        var opts = options || {};
        return new Promise(function (resolve) {
            var field = W.input({
                value: opts.value || '',
                placeholderKey: opts.placeholderKey,
                onChange: function () {}
            });
            var handle = modal({
                titleKey: titleKey,
                body: [field],
                actions: [
                    { labelKey: 'app.cancel', variant: 'quiet', onClick: function () { resolve(null); } },
                    {
                        labelKey: opts.confirmKey || 'app.confirm',
                        variant: 'primary',
                        onClick: function () { resolve(field.value || null); }
                    }
                ],
                onClose: function () { resolve(null); }
            });
            void handle;
        });
    }

    function appendChildren(node, children) {
        if (!children) return;
        if (Array.isArray(children)) {
            for (var i = 0; i < children.length; i++) appendChildren(node, children[i]);
            return;
        }
        if (children.nodeType) node.appendChild(children);
        else node.appendChild(el('div', { text: String(children) }));
    }

    function closeModal() {
        if (nodes.modalLayer) nodes.modalLayer.setAttribute('hidden', '');
    }

    /* ---------- 抽屉 ---------- */

    function toggleDrawer(name, force) {
        var drawer = name === 'tasks' ? nodes.taskDrawer : nodes.logDrawer;
        if (!drawer) return;
        var open = force === undefined ? drawer.hasAttribute('hidden') : !!force;
        if (open) {
            // 同时只开一个
            closeDrawers();
            drawer.removeAttribute('hidden');
            if (name === 'logs') renderLogs();
        } else {
            drawer.setAttribute('hidden', '');
        }
    }

    function closeDrawers() {
        if (nodes.taskDrawer) nodes.taskDrawer.setAttribute('hidden', '');
        if (nodes.logDrawer) nodes.logDrawer.setAttribute('hidden', '');
    }

    /** 渲染任务抽屉内容 */
    function renderTasks(tasks, handlers) {
        if (!nodes.taskDrawerBody) return;
        var body = nodes.taskDrawerBody;
        var scrollTop = body.scrollTop;
        util.clear(body);
        var list = Array.isArray(tasks) ? tasks.slice() : [];
        if (!list.length) {
            body.appendChild(W.empty('◌', 'tasks.empty'));
            return;
        }
        for (var i = 0; i < list.length; i++) {
            body.appendChild(taskRow(list[i], handlers));
        }
        body.scrollTop = scrollTop;
    }

    function taskRow(task, handlers) {
        var tone = task.state === 'done' ? 'ok'
            : task.state === 'failed' ? 'error'
                : task.state === 'canceled' ? 'idle'
                    : task.state === 'queued' ? 'info' : 'running';
        var stateKey = 'state.' + (task.state === 'done' ? 'done' : task.state);
        var head = el('div', { class: 'inline', style: { justifyContent: 'space-between' } }, [
            el('span', { class: 'strong truncate', text: task.title || task.prompt || task.id }),
            W.pill(stateKey, tone)
        ]);
        var children = [head];
        if (task.progress !== undefined && task.progress >= 0 && task.state !== 'done' && task.state !== 'failed') {
            children.push(el('div', { class: 'progress' }, [
                el('span', { class: 'progress-bar', style: { width: util.clamp(task.progress, 0, 100) + '%' } })
            ]));
        }
        var metaParts = [];
        if (task.modelId) metaParts.push(task.modelId);
        if (task.startedAt && task.finishedAt) {
            metaParts.push(t('tasks.duration') + ' ' + util.formatDuration((task.finishedAt - task.startedAt) / 1000));
        }
        if (task.meta && task.meta.returned) metaParts.push(t('return.asLayer') + ': ' + task.meta.returned);
        if (metaParts.length) {
            children.push(el('div', { class: 'field-hint truncate', text: metaParts.join(' · ') }));
        }
        if (task.error) {
            children.push(el('div', { class: 'field-error', text: String(task.error) }));
        }
        if (task.images && task.images.length) {
            children.push(el('div', { class: 'inline' }, [
                el('img', {
                    src: task.images[0].dataUrl,
                    alt: '',
                    style: { width: '48px', height: '48px', objectFit: 'cover', borderRadius: 'var(--radius-sm)' }
                }),
                el('span', { class: 'field-hint', text: '×' + task.images.length })
            ]));
        }
        var actions = [];
        if (task.state === 'running' || task.state === 'queued') {
            actions.push(W.miniButton('app.stop', {
                onClick: function () { handlers && handlers.onCancel && handlers.onCancel(task.id); }
            }));
        }
        if (task.state === 'done' && task.images && task.images.length) {
            actions.push(W.miniButton('gallery.saveToPs', {
                onClick: function () { handlers && handlers.onReturn && handlers.onReturn(task); }
            }));
            actions.push(W.miniButton('gallery.download', {
                onClick: function () { handlers && handlers.onDownload && handlers.onDownload(task); }
            }));
        }
        if (task.state === 'failed' || task.state === 'canceled' || task.state === 'timeout') {
            actions.push(W.miniButton('app.retry', {
                onClick: function () { handlers && handlers.onRetry && handlers.onRetry(task); }
            }));
        }
        if (actions.length) children.push(el('div', { class: 'btn-row' }, actions));

        return el('div', {
            class: 'card',
            style: { padding: '10px', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '6px' }
        }, children);
    }

    function setTaskBadge(count) {
        if (!nodes.taskBadge) return;
        var value = util.toNumber(count, 0);
        if (value > 0) {
            nodes.taskBadge.textContent = String(value);
            nodes.taskBadge.removeAttribute('hidden');
        } else {
            nodes.taskBadge.setAttribute('hidden', '');
        }
    }

    /* ---------- 日志抽屉 ---------- */

    function renderLogs() {
        if (!nodes.logDrawerBody) return;
        var entries = DreamAI.logbus.list().slice().reverse();
        var body = nodes.logDrawerBody;
        util.clear(body);
        if (!entries.length) {
            body.appendChild(W.empty('≡', 'logs.empty'));
            return;
        }
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var time = new Date(entry.at);
            var stamp = pad(time.getHours()) + ':' + pad(time.getMinutes()) + ':' + pad(time.getSeconds());
            body.appendChild(el('div', {
                class: 'stack',
                style: {
                    gap: '2px',
                    padding: '6px 8px',
                    borderRadius: 'var(--radius-sm)',
                    background: entry.level === 'error' ? 'var(--danger-soft)'
                        : entry.level === 'warn' ? 'var(--warning-soft)'
                            : 'var(--bg-surface-soft)'
                }
            }, [
                el('div', { class: 'inline', style: { justifyContent: 'space-between' } }, [
                    el('span', { class: 'field-hint mono', text: stamp + ' · ' + entry.domain }),
                    el('span', {
                        class: 'field-hint',
                        text: entry.level,
                        style: { color: entry.level === 'error' ? 'var(--danger)' : entry.level === 'warn' ? 'var(--warning)' : 'var(--text-muted)' }
                    })
                ]),
                el('div', { class: 'field-hint', text: entry.message, style: { color: 'var(--text-main)', wordBreak: 'break-word' } })
            ]));
        }
    }

    function pad(value) {
        return value < 10 ? '0' + value : String(value);
    }

    /* ---------- 事件接线 ---------- */

    function wire() {
        if (nodes.btnLangToggle) {
            nodes.btnLangToggle.addEventListener('click', function () {
                DreamAI.I18n.toggle();
            });
        }
        if (nodes.btnThemeToggle) {
            nodes.btnThemeToggle.addEventListener('click', function () {
                DreamAI.Theme.toggle();
            });
        }
        if (nodes.btnOpenSettings) {
            nodes.btnOpenSettings.addEventListener('click', function () {
                DreamAI.Router.activate('settings');
            });
        }
        if (nodes.btnTaskTray) {
            nodes.btnTaskTray.addEventListener('click', function () { toggleDrawer('tasks'); });
        }
        if (nodes.btnActivityLog) {
            nodes.btnActivityLog.addEventListener('click', function () {
                // 打开日志页面而不是抽屉：抽屉是覆盖层，宿主里若被裁切就完全看不到日志
                if (DreamAI.Router && DreamAI.Router.getInstance('logs')) DreamAI.Router.activate('logs');
                else if (DreamAI.Router) DreamAI.Router.activate('logs');
                else toggleDrawer('logs');
            });
        }
        if (nodes.btnCloseTaskDrawer) nodes.btnCloseTaskDrawer.addEventListener('click', function () { toggleDrawer('tasks', false); });
        if (nodes.btnCloseLogDrawer) nodes.btnCloseLogDrawer.addEventListener('click', function () { toggleDrawer('logs', false); });
        if (nodes.btnCloseModal) nodes.btnCloseModal.addEventListener('click', closeModal);
        if (nodes.modalLayer) {
            nodes.modalLayer.addEventListener('click', function (event) {
                if (event.target === nodes.modalLayer) closeModal();
            });
        }
        if (nodes.btnClearLogs) {
            nodes.btnClearLogs.addEventListener('click', function () {
                DreamAI.logbus.clear();
                renderLogs();
                toast('logs.cleared', { tone: 'ok' });
            });
        }
        if (nodes.btnCopyLogs) {
            nodes.btnCopyLogs.addEventListener('click', function () {
                var text = DreamAI.logbus.toText();
                copyText(text).then(function (ok) {
                    toast(ok ? 'logs.copied' : 'logs.copyFailed', { tone: ok ? 'ok' : 'warn' });
                });
            });
        }
        if (global.document && global.document.addEventListener) {
            global.document.addEventListener('keydown', function (event) {
                if (event.key !== 'Escape') return;
                if (nodes.modalLayer && !nodes.modalLayer.hasAttribute('hidden')) { closeModal(); return; }
                closeDrawers();
                if (DreamAI.Widgets) DreamAI.Widgets.closeOpenSelect();
            });
        }

        // 语言与主题变化时刷新小控件
        DreamAI.I18n.onChange(function () {
            if (nodes.langChipText) nodes.langChipText.textContent = DreamAI.I18n.langBadge();
        });
        DreamAI.bus.on('theme:change', function (payload) {
            if (nodes.themeGlyph) nodes.themeGlyph.textContent = payload.theme === 'dark' ? '☀' : '◐';
        });
        DreamAI.bus.on('log:entry', function () {
            if (nodes.logDrawer && !nodes.logDrawer.hasAttribute('hidden')) renderLogs();
        });
        DreamAI.bus.on('status:message', function (payload) {
            if (payload) status(payload.text, payload);
        });
    }

    /** 复制文本：UXP 用 clipboard 模块，浏览器用 navigator.clipboard，最后兜底 execCommand */
    function copyText(text) {
        var value = String(text == null ? '' : text);
        try {
            if (DreamAI.host.modules.uxp && DreamAI.host.modules.uxp.clipboard) {
                DreamAI.host.modules.uxp.clipboard.copyText(value);
                return Promise.resolve(true);
            }
        } catch (error) { /* 继续尝试其他方式 */ }
        try {
            if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
                return global.navigator.clipboard.writeText(value).then(function () { return true; }, function () { return false; });
            }
        } catch (error) { /* 继续 */ }
        return Promise.resolve(false);
    }

    function showShell() {
        if (nodes.shell) nodes.shell.removeAttribute('hidden');
        if (nodes.veil) nodes.veil.setAttribute('hidden', '');
    }

    function init() {
        W = DreamAI.Widgets;
        cache();
        wire();
        if (nodes.langChipText) nodes.langChipText.textContent = DreamAI.I18n.langBadge();
        if (nodes.themeGlyph) nodes.themeGlyph.textContent = DreamAI.Theme.get() === 'dark' ? '☀' : '◐';
        status('app.ready', { key: 'app.ready', tone: 'idle' });
    }

    DreamAI.Shell = {
        init: init,
        showShell: showShell,
        nodes: function () { return nodes; },
        status: status,
        setProgress: setProgress,
        toast: toast,
        modal: modal,
        closeModal: closeModal,
        confirm: confirmDialog,
        prompt: promptDialog,
        toggleDrawer: toggleDrawer,
        closeDrawers: closeDrawers,
        renderTasks: renderTasks,
        renderLogs: renderLogs,
        setTaskBadge: setTaskBadge,
        copyText: copyText
    };
})(typeof window !== 'undefined' ? window : this);
