/*
 * boot/app.js — 应用引导
 *
 * 职责：
 *   1. 初始化主题、语言、存储与外壳；
 *   2. 建立全局状态 App.state 并加载持久化设置；
 *   3. 装载各功能模块（任务队列 / 画廊 / 批处理 / 预设）；
 *   4. 启动路由并渲染首个页面；
 *   5. 把关键事件接到状态条、任务托盘与日志。
 * 边界：不实现任何具体业务算法，只做装配与生命周期管理。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.App) return;

    var util = DreamAI.util;
    var bus = DreamAI.bus;
    var logbus = DreamAI.logbus;

    /* ============================================================
     * 设置默认值（形状见 docs/INTERNALS.md 第 4 节）
     * ============================================================ */
    var SETTINGS_DEFAULTS = {
        language: '',
        theme: '',
        accent: '',
        uiScale: 1,
        activeChannelId: 'openai',
        activeChatChannelId: 'openai',
        channels: {
            native: { model: 'photoshop-generative' },
            openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '' },
            xai: { baseUrl: 'https://api.x.ai/v1', apiKey: '', model: '' },
            grok: { baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '', model: '' },
            custom: { baseUrl: '', apiKey: '', model: '' }
        },
        modelCache: {},
        systemPrompt: { positive: '', negative: '' },
        chatSystemPrompt: { positive: '', negative: '' },
        behavior: {
            autoReturn: true,
            colorMatchOnReturn: true,
            colorMatchMethod: 'meanStd',
            returnFeather: 0,
            returnBlendMode: 'normal',
            returnLayerPrefix: 'Dream AI',
            pollInterval: 3000,
            requestTimeout: 300000,
            maxConcurrent: 1,
            referenceMax: 4,
            sampleMaxEdge: 1536,
            promptMaxLength: 5000
        },
        gallery: { mode: 'count', maxCount: 30, maxDays: 30 },
        advanced: { debugLog: false }
    };

    var WORKBENCH_DEFAULTS = {
        mode: 'txt2img',
        prompt: '',
        negativePrompt: '',
        providerId: '',
        modelId: '',
        size: '1024x1024',
        count: 1,
        quality: 'standard',
        style: '',
        seed: null,
        steps: null,
        cfg: null,
        useSelection: true,
        colorMatchOnReturn: true,
        autoReturn: true,
        blendScreen: false,
        returnFeather: 0
    };

    var state = {
        selection: null,
        references: [],
        settings: util.deepClone(SETTINGS_DEFAULTS),
        workbench: util.deepClone(WORKBENCH_DEFAULTS),
        activePageId: null,
        ready: false,
        hostMode: 'browser'
    };

    var readyResolve = null;
    var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

    /* ============================================================
     * 状态读写
     * ============================================================ */

    function get(path, fallback) {
        return util.getPath(state, path, fallback);
    }

    function set(path, value) {
        util.setPath(state, path, value);
        bus.emit('state:change', { path: path, value: value });
        return value;
    }

    function patch(object) {
        if (!util.isPlainObject(object)) return state;
        state = util.deepMerge(state, object);
        bus.emit('state:change', { path: null, value: state });
        return state;
    }

    function saveSettings(patchObject, options) {
        var next = util.deepMerge(state.settings, patchObject || {});
        state.settings = util.deepMerge(SETTINGS_DEFAULTS, next);
        DreamAI.Store.write('settings', state.settings, SETTINGS_DEFAULTS);
        if (!(options && options.silent)) {
            bus.emit('settings:change', { settings: state.settings });
        }
        return state.settings;
    }

    function loadSettings() {
        state.settings = DreamAI.Store.read('settings', SETTINGS_DEFAULTS);
        // 渠道对象做一次补全，避免旧版本存档缺字段
        for (var id in SETTINGS_DEFAULTS.channels) {
            if (!Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS.channels, id)) continue;
            if (!util.isPlainObject(state.settings.channels[id])) {
                state.settings.channels[id] = util.deepClone(SETTINGS_DEFAULTS.channels[id]);
            }
        }
        return state.settings;
    }

    function saveWorkbench(patchObject) {
        state.workbench = util.deepMerge(state.workbench, patchObject || {});
        DreamAI.Store.write('workbench', state.workbench, WORKBENCH_DEFAULTS);
        return state.workbench;
    }

    function loadWorkbench() {
        state.workbench = DreamAI.Store.read('workbench', WORKBENCH_DEFAULTS);
        return state.workbench;
    }

    /*
     * 参考图的存储策略。
     *
     * 原来的做法是把 data URL 直接塞进 localStorage，问题有两个：
     *   1. UXP 的 localStorage 只有约 5MB，一张 1024×1024 PNG 就 1.4MB，
     *      四张必然超限；setItem 抛错时旧值原样保留，表现为"重载后槽位空了"；
     *   2. 图片本体与界面状态混在一个键里，清缓存时一起没了。
     *
     * 现在改成：图片本体交给 DreamAI.Gallery（IndexedDB → UXP 文件系统 →
     * localStorage 三级降级，容量远大于界面状态），localStorage 里只留索引
     * （id + 元数据）。启动时按 id 回填，取不回来就丢掉这一条并记日志。
     */
    function serializeReference(entry) {
        return {
            id: entry.id,
            source: entry.source || '',
            name: entry.name || '',
            width: util.toNumber(entry.width, 0),
            height: util.toNumber(entry.height, 0),
            addedAt: util.toNumber(entry.addedAt, Date.now())
        };
    }

    function persistReferences(items) {
        var index = [];
        for (var i = 0; i < items.length; i++) index.push(serializeReference(items[i]));
        var written = DreamAI.Store.write('references', { items: index });
        if (written === false) {
            logbus.warn('参考图索引写入失败（存储超额）', { domain: 'app' });
        }
    }

    /** 把参考图本体写进画廊，返回可用于回填的 id */
    function archiveReferenceData(entry) {
        if (!DreamAI.Gallery || typeof DreamAI.Gallery.add !== 'function') return null;
        if (!util.isDataUrl(entry.dataUrl)) return null;
        try {
            var pending = DreamAI.Gallery.add(entry.dataUrl, {
                prompt: 'reference',
                providerId: 'reference',
                modelId: entry.source || 'reference',
                mode: 'reference',
                width: util.toNumber(entry.width, 0),
                height: util.toNumber(entry.height, 0)
            });
            if (pending && typeof pending.then === 'function') {
                // 画廊是异步落盘；这里只关心它自己生成的 id
                return pending;
            }
            return pending && pending.id ? pending.id : null;
        } catch (error) {
            logbus.warn('参考图入画廊失败：' + (error && error.message ? error.message : String(error)), { domain: 'app' });
            return null;
        }
    }

    function setReferences(list) {
        var max = util.toNumber(get('settings.behavior.referenceMax', 4), 4);
        state.references = (Array.isArray(list) ? list : []).slice(0, max);
        persistReferences(state.references);
        bus.emit('references:change', { references: state.references });
        return state.references;
    }

    /**
     * 恢复参考图：索引里只有 id，图片本体在画廊里按 id 取回。
     * 取不回来的条目直接剔除（它已经没有可用图像了），并记一条日志。
     */
    function hydrateReferences() {
        var stored = DreamAI.Store.read('references', { items: [] });
        var index = Array.isArray(stored.items) ? stored.items : [];
        if (!index.length) {
            state.references = [];
            return Promise.resolve(state.references);
        }
        var canHydrate = DreamAI.Gallery && typeof DreamAI.Gallery.getDataUrl === 'function';
        if (!canHydrate) {
            // 画廊不可用时，索引里没有图片本体，无法恢复
            state.references = [];
            return Promise.resolve(state.references);
        }
        return Promise.all(index.map(function (entry) {
            return Promise.resolve(DreamAI.Gallery.getDataUrl(entry.id)).then(function (dataUrl) {
                if (!dataUrl) return null;
                return {
                    id: entry.id,
                    dataUrl: dataUrl,
                    source: entry.source || 'upload',
                    name: entry.name || '',
                    width: util.toNumber(entry.width, 0),
                    height: util.toNumber(entry.height, 0),
                    addedAt: util.toNumber(entry.addedAt, Date.now())
                };
            }, function () { return null; });
        })).then(function (list) {
            var kept = list.filter(Boolean);
            if (kept.length !== index.length) {
                logbus.warn('有 ' + (index.length - kept.length) + ' 张参考图已无法恢复，已从列表移除', { domain: 'app' });
            }
            state.references = kept;
            persistReferences(state.references);
            bus.emit('references:change', { references: state.references });
            return state.references;
        });
    }

    function addReference(entry) {
        var max = util.toNumber(get('settings.behavior.referenceMax', 4), 4);
        if (!entry || !util.isDataUrl(entry.dataUrl)) {
            // 没有有效图片就不占位：宁可不加，也不要留一个永远空着的槽
            logbus.warn('参考图缺少有效图像数据，已忽略', { domain: 'app' });
            return false;
        }
        if (state.references.length >= max) {
            DreamAI.Shell && DreamAI.Shell.toast(DreamAI.I18n.t('reference.tooMany', { max: max }), { tone: 'warn' });
            return false;
        }
        state.references = state.references.concat([entry]);
        bus.emit('references:change', { references: state.references });

        /*
         * 图片本体异步交给画廊。画廊会自己生成 id，所以落盘索引要等它返回后
         * 用画廊的 id 覆盖条目上的临时 id —— 否则回填时按 id 找不到图。
         */
        var pending = archiveReferenceData(entry);
        if (pending && typeof pending.then === 'function') {
            pending.then(function (item) {
                if (item && item.id) {
                    for (var i = 0; i < state.references.length; i++) {
                        if (state.references[i] === entry) {
                            entry.id = item.id;
                            break;
                        }
                    }
                }
                persistReferences(state.references);
            }, function () {
                // 画廊不可用：保留在内存里可用，但不落盘（下次启动会被剔除）
                logbus.warn('参考图未能写入画廊，本次会话可用但不会被持久化', { domain: 'app' });
                persistReferences(state.references);
            });
        } else {
            persistReferences(state.references);
        }
        return true;
    }

    function removeReference(id) {
        var removed = null;
        state.references = state.references.filter(function (item) {
            if (item.id === id) { removed = item; return false; }
            return true;
        });
        persistReferences(state.references);
        bus.emit('references:change', { references: state.references });
        // 同步清掉画廊里的副本，避免参考图在被移除后仍然占着存储
        if (removed && DreamAI.Gallery && typeof DreamAI.Gallery.remove === 'function' && removed.id) {
            try {
                var cleanup = DreamAI.Gallery.remove(removed.id);
                if (cleanup && typeof cleanup.then === 'function') cleanup.then(function () {}, function () {});
            } catch (error) { /* 清理失败不影响主流程 */ }
        }
    }

    function applyUiScale(scale) {
        var value = util.clamp(scale, 0.8, 1.6, 1);
        if (global.document && global.document.body) {
            global.document.body.style.setProperty('--ui-scale', String(value));
        }
        return value;
    }

    /* ============================================================
     * 应用设置的副作用（语言 / 主题 / 缩放）
     * ============================================================ */

    function applySettingsSideEffects(firstRun) {
        var settings = state.settings;
        var lang = DreamAI.I18n.normalizeLang(settings.language);
        if (lang && lang !== DreamAI.I18n.getLang()) DreamAI.I18n.setLang(lang, { silent: true });
        if (lang) settings.language = lang;

        var theme = DreamAI.Theme.normalize(settings.theme);
        if (theme && theme !== DreamAI.Theme.get()) DreamAI.Theme.set(theme, { silent: true });
        if (theme) settings.theme = theme;

        var accent = DreamAI.Theme.normalizeAccent(settings.accent);
        if (accent && accent !== DreamAI.Theme.getAccent()) DreamAI.Theme.setAccent(accent, { silent: true });
        if (accent) settings.accent = accent;

        applyUiScale(settings.uiScale);

        if (!firstRun) DreamAI.Store.write('settings', settings, SETTINGS_DEFAULTS);
    }

    /* ============================================================
     * 事件接线
     * ============================================================ */

    function wireEvents() {
        // 语言 / 主题变化写回设置
        DreamAI.I18n.onChange(function (lang) {
            if (state.settings.language !== lang) saveSettings({ language: lang }, { silent: true });
        });
        bus.on('theme:change', function (payload) {
            if (state.settings.theme !== payload.theme) saveSettings({ theme: payload.theme }, { silent: true });
        });

        // 选区
        bus.on('selection:change', function (payload) {
            state.selection = payload ? payload.sample : null;
        });

        // 任务：状态条、托盘、日志
        bus.on('task:created', function (payload) {
            logbus.info('任务已创建：' + summarizeTask(payload.task), { domain: 'task', taskId: payload.task && payload.task.id });
            refreshTaskUi();
        });
        bus.on('task:update', function (payload) {
            updateStatusFromTask(payload.task);
            refreshTaskUi();
        });
        bus.on('task:finished', function (payload) {
            var task = payload.task;
            if (task.state === 'done') {
                logbus.success('任务完成：' + summarizeTask(task), { domain: 'task', taskId: task.id });
                DreamAI.Shell.toast('state.done', { tone: 'ok' });
                DreamAI.Shell.status('state.done', { key: 'state.done', tone: 'ok', progress: null });
            } else if (task.state === 'failed') {
                logbus.error('任务失败：' + (task.error || ''), { domain: 'task', taskId: task.id });
                DreamAI.Shell.toast(task.error || 'state.failed', { tone: 'error' });
                DreamAI.Shell.status('state.failed', { key: 'state.failed', tone: 'error', progress: null });
            } else if (task.state === 'canceled') {
                DreamAI.Shell.status('state.canceled', { key: 'state.canceled', tone: 'warn', progress: null });
            }
            refreshTaskUi();
        });
        bus.on('result:ready', function (payload) {
            logbus.info('收到生成结果 ' + ((payload.images && payload.images.length) || 0) + ' 张', { domain: 'task' });
            DreamAI.Router.refreshActive();
        });

        // 回写结果
        bus.on('return:done', function (payload) {
            DreamAI.Shell.toast(DreamAI.I18n.t('return.done', { name: (payload && payload.layerName) || '' }), { tone: 'ok' });
        });
        bus.on('return:failed', function (payload) {
            DreamAI.Shell.toast(DreamAI.I18n.t('return.failed', { reason: (payload && payload.reason) || '' }), { tone: 'error' });
        });

        // Photoshop 串行锁：排队时给出可见反馈
        bus.on('pslock:change', function (payload) {
            if (payload && payload.pending > 0) {
                DreamAI.Shell.status('return.lock', { key: 'return.lock', tone: 'warn' });
            }
        });

        // 画廊变化时刷新对应页面
        bus.on('gallery:change', function () {
            var instance = DreamAI.Router.getInstance('gallery');
            if (instance && typeof instance.api.refresh === 'function') instance.api.refresh();
        });

        // 页面切换
        bus.on('page:change', function (payload) {
            state.activePageId = payload.id;
        });

        // 全局错误兜底
        if (global.addEventListener) {
            global.addEventListener('unhandledrejection', function (event) {
                var reason = event && event.reason;
                logbus.error('未处理的异步错误：' + (reason && reason.message ? reason.message : String(reason)), { domain: 'app' });
            });
            global.addEventListener('error', function (event) {
                logbus.error('运行错误：' + (event && event.message ? event.message : 'unknown'), { domain: 'app' });
            });
        }
    }

    function summarizeTask(task) {
        if (!task) return '';
        var parts = [];
        if (task.providerId) parts.push(task.providerId);
        if (task.modelId) parts.push(task.modelId);
        if (task.mode) parts.push(task.mode);
        if (task.prompt) parts.push(util.truncate(task.prompt, 40));
        return parts.join(' / ');
    }

    function updateStatusFromTask(task) {
        if (!task) return;
        var key = 'state.' + (task.state === 'running' ? 'polling' : task.state);
        var tone = task.state === 'failed' ? 'error' : task.state === 'queued' ? 'warn' : 'busy';
        DreamAI.Shell.status(key, {
            key: DreamAI.I18n.has(key) ? key : null,
            text: summarizeTask(task),
            tone: tone,
            progress: task.progress >= 0 ? task.progress : null
        });
    }

    function refreshTaskUi() {
        var queue = DreamAI.TaskQueue;
        if (!queue) return;
        DreamAI.Shell.setTaskBadge(queue.runningCount());
        DreamAI.Shell.renderTasks(queue.list(), {
            onCancel: function (id) { queue.cancel(id); },
            onRetry: function (task) { queue.retry ? queue.retry(task.id) : null; },
            onReturn: function (task) { retryReturn(task); },
            onDownload: function (task) { downloadTaskImages(task); }
        });
    }

    function retryReturn(task) {
        if (!task || !task.images || !task.images.length) return;
        if (!DreamAI.PhotoReturn || !DreamAI.PhotoReturn.isAvailable()) {
            DreamAI.Shell.toast('return.disabled', { tone: 'warn' });
            return;
        }
        var options = util.deepMerge({
            bounds: state.selection ? state.selection.bounds : null,
            documentId: state.selection ? state.selection.documentId : undefined,
            layerName: null,
            blendMode: get('settings.behavior.returnBlendMode', 'normal'),
            feather: get('settings.behavior.returnFeather', 0),
            colorMatch: get('settings.behavior.colorMatchOnReturn', true),
            colorMatchMethod: get('settings.behavior.colorMatchMethod', 'meanStd'),
            colorMatchReference: state.selection ? state.selection.dataUrl : null
        }, task.meta && task.meta.returnOptions ? task.meta.returnOptions : {});
        DreamAI.PhotoReturn.place(task.images[0].dataUrl, options).then(function (result) {
            task.meta = task.meta || {};
            task.meta.returned = result.layerName;
            refreshTaskUi();
        }, function (error) {
            DreamAI.Shell.toast(DreamAI.I18n.t('return.failed', { reason: error && error.message ? error.message : String(error) }), { tone: 'error' });
        });
    }

    function downloadTaskImages(task) {
        if (!task || !task.images || !task.images.length) return;
        var image = task.images[0];
        var name = 'dream-ai-' + task.id + '.png';
        if (DreamAI.Gallery && DreamAI.Gallery.download) {
            DreamAI.Gallery.download(image.dataUrl, name);
            return;
        }
        try {
            var anchor = global.document.createElement('a');
            anchor.href = image.dataUrl;
            anchor.download = name;
            anchor.click();
        } catch (error) {
            logbus.warn('浏览器环境不支持直接下载，请从画廊中另存', { domain: 'app' });
        }
    }

    /* ============================================================
     * 启动
     * ============================================================ */

    function boot() {
        state.hostMode = DreamAI.host.isUxp ? 'uxp' : 'browser';

        // 1. 主题与语言：先于任何渲染，避免闪烁
        loadSettings();
        DreamAI.Theme.init();
        if (state.settings.theme) DreamAI.Theme.set(state.settings.theme, { silent: true });
        DreamAI.I18n.init();
        if (state.settings.language) DreamAI.I18n.setLang(state.settings.language, { silent: true });
        applySettingsSideEffects(true);

        // 2. 外壳
        DreamAI.Shell.init();

        // 3. 状态
        loadWorkbench();
        if (!state.settings.activeChannelId) state.settings.activeChannelId = 'openai';
        if (!state.workbench.providerId) state.workbench.providerId = state.settings.activeChannelId;

        // 4. 功能模块（存在即初始化）
        initModule('Gallery');
        initModule('TaskQueue');
        initModule('Batch');

        wireEvents();

        // 5. 路由
        var shellNodes = DreamAI.Shell.nodes();
        DreamAI.Router.init(shellNodes.nav, shellNodes.stage, { titleNode: shellNodes.pageTitle });
        state.activePageId = DreamAI.Router.getActive();

        // 6. 收尾
        DreamAI.Shell.showShell();
        DreamAI.Shell.status('app.ready', { key: 'app.ready', tone: 'idle' });
        logbus.info('Dream AI 已启动（宿主：' + state.hostMode + '，语言：' + DreamAI.I18n.getLang() + '）', { domain: 'app' });

        if (!DreamAI.host.hasPhotoshop) {
            logbus.warn('当前不在 Photoshop 宿主内，Photoshop 相关功能不可用', { domain: 'app' });
        }

        // 参考图可能只存了索引（大图不落 localStorage），这里按需回填
        hydrateReferences();

        state.ready = true;
        bus.emit('app:ready', { host: state.hostMode });
        readyResolve(state);
        return state;
    }

    function initModule(name) {
        var module = DreamAI[name];
        if (!module) return false;
        if (typeof module.init === 'function') {
            try {
                module.init();
                return true;
            } catch (error) {
                logbus.error('模块 ' + name + ' 初始化失败：' + (error && error.message ? error.message : String(error)), { domain: 'app' });
                return false;
            }
        }
        return true;
    }

    DreamAI.App = {
        SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
        WORKBENCH_DEFAULTS: WORKBENCH_DEFAULTS,
        state: state,
        ready: readyPromise,
        boot: boot,
        get: get,
        set: set,
        patch: patch,
        get settings() { return state.settings; },
        get workbench() { return state.workbench; },
        get selection() { return state.selection; },
        get references() { return state.references; },
        get activeTaskId() {
            return DreamAI.TaskQueue && DreamAI.TaskQueue.activeId ? DreamAI.TaskQueue.activeId() : null;
        },
        saveSettings: saveSettings,
        saveWorkbench: saveWorkbench,
        loadSettings: loadSettings,
        setReferences: setReferences,
        hydrateReferences: hydrateReferences,
        addReference: addReference,
        removeReference: removeReference,
        applyUiScale: applyUiScale,
        refreshTaskUi: refreshTaskUi,
        summarizeTask: summarizeTask
    };

    // 宿主就绪后启动；UXP 下 document 已存在，浏览器下等 DOMContentLoaded
    if (global.document) {
        if (global.document.readyState === 'loading') {
            global.document.addEventListener('DOMContentLoaded', function () {
                try { boot(); } catch (error) { reportBootFailure(error); }
            });
        } else {
            try { boot(); } catch (error) { reportBootFailure(error); }
        }
    }

    function reportBootFailure(error) {
        if (global.console) global.console.error('[app] 启动失败', error);
        var veil = global.document && global.document.getElementById('bootVeil');
        if (veil) {
            util.clear(veil);
            veil.appendChild(util.el('div', { class: 'boot-caption', text: '启动失败：' + (error && error.message ? error.message : String(error)) }));
        }
    }
})(typeof window !== 'undefined' ? window : this);
