/*
 * features/task-queue.js — 生成任务队列
 *
 * 职责：
 *   - 接收生图/编辑任务（spec），按 settings.behavior.maxConcurrent 控制并发执行；
 *   - 统一处理超时、取消、进度、错误本地化、结果归档（Gallery）与自动回写（PhotoReturn）；
 *   - 广播 task:created / task:update / task:finished / result:ready，并向状态条上报活动任务进度；
 *   - 把任务历史（仅元数据 + 小体积首图）持久化到 Store 域 taskHistory（最多 80 条）。
 * 输入：spec（形状见 docs/INTERNALS.md 第 3 节）；provider 由 DreamAI.Providers 解析。
 * 输出：任务对象（立刻返回）、Promise 化的执行结果、已本地化的错误文案。
 * 边界：不渲染界面、不直接读写 Photoshop 文档（回写一律经 DreamAI.PhotoReturn）；
 *       纯 ES5，可在没有 Photoshop 宿主的 Node 下加载（宿主能力全部特性检测）。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.TaskQueue) return;

    /* 测试环境可置 true 让保活定时器不阻止进程退出 */
    var KEEP_ALIVE_UNREF = false;

    var util = DreamAI.util || {};

    /* ============================================================
     * 基础工具（util 缺失时兜底）
     * ============================================================ */

    function t(key, params) {
        return DreamAI.I18n ? DreamAI.I18n.t(key, params) : key;
    }

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function isPlain(value) {
        if (typeof util.isPlainObject === 'function') return util.isPlainObject(value);
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function toNumber(value, fallback) {
        if (typeof util.toNumber === 'function') return util.toNumber(value, fallback);
        var n = Number(value);
        return isFinite(n) ? n : fallback;
    }

    function clamp(value, min, max, fallback) {
        if (typeof util.clamp === 'function') return util.clamp(value, min, max, fallback);
        var n = toNumber(value, fallback === undefined ? min : fallback);
        if (n < min) return min;
        if (n > max) return max;
        return n;
    }

    function clone(value) {
        if (typeof util.deepClone === 'function') return util.deepClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function uid(prefix) {
        if (typeof util.uid === 'function') return util.uid(prefix);
        return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function truncate(text, max) {
        if (typeof util.truncate === 'function') return util.truncate(text, max);
        var s = String(text == null ? '' : text);
        return s.length <= max ? s : s.slice(0, max - 1) + '…';
    }

    function makeError(key, params) {
        var error = new Error(t(key, params));
        error.localized = true;
        error.key = key;
        return error;
    }

    /* ============================================================
     * 常量
     * ============================================================ */

    /** 任务状态枚举（与 docs/INTERNALS.md 第 3 节一致） */
    var STATES = ['queued', 'running', 'uploading', 'polling', 'returning', 'done', 'failed', 'canceled', 'timeout', 'skipped'];
    var TERMINAL_STATES = ['done', 'failed', 'canceled', 'timeout', 'skipped'];
    /** 执行函数允许自行切换的非终态 */
    var RUNNING_STATES = ['running', 'uploading', 'polling', 'returning'];

    var MIN_TIMEOUT_MS = 5000;
    var DEFAULT_TIMEOUT_MS = 300000;
    var DEFAULT_MAX_CONCURRENT = 1;
    var MAX_CONCURRENT_LIMIT = 10;
    var MAX_COUNT = 10;

    var HISTORY_DOMAIN = 'taskHistory';
    var HISTORY_LIMIT = 80;
    /** 持久化时允许内联的首图体积上限（200 KB） */
    var INLINE_IMAGE_LIMIT = 200 * 1024;
    var META_STRING_LIMIT = 4096;
    /** 历史记录里保存的提示词上限：避免 80 条长提示词把 localStorage 撑爆 */
    var HISTORY_PROMPT_LIMIT = 1200;

    /* ============================================================
     * 状态
     * ============================================================ */

    /** @type {Array} 全部任务，新到旧（对外 list() 直接返回该数组的副本） */
    var tasks = [];
    /** @type {Array} 等待执行的任务，先进先出 */
    var pending = [];
    /** @type {Array} 正在执行的任务 */
    var running = [];
    var listeners = [];
    var initialized = false;
    var pumpScheduled = false;

    /* ============================================================
     * 设置读取
     * ============================================================ */

    function readSettings() {
        if (DreamAI.App && isPlain(DreamAI.App.settings)) return DreamAI.App.settings;
        if (DreamAI.Store && typeof DreamAI.Store.read === 'function') {
            var stored = DreamAI.Store.read('settings');
            if (isPlain(stored)) return stored;
        }
        return {};
    }

    function readBehavior() {
        var settings = readSettings();
        return isPlain(settings.behavior) ? settings.behavior : {};
    }

    function maxConcurrent() {
        var value = Math.round(toNumber(readBehavior().maxConcurrent, DEFAULT_MAX_CONCURRENT));
        return Math.round(clamp(value, 1, MAX_CONCURRENT_LIMIT, DEFAULT_MAX_CONCURRENT));
    }

    function resolveTimeout(spec) {
        var behavior = readBehavior();
        var requested = toNumber(spec && spec.timeout, 0);
        if (!(requested > 0)) requested = toNumber(behavior.requestTimeout, DEFAULT_TIMEOUT_MS);
        if (!(requested > 0)) requested = DEFAULT_TIMEOUT_MS;
        return Math.max(MIN_TIMEOUT_MS, Math.round(requested));
    }

    /* ============================================================
     * 日志与状态条
     * ============================================================ */

    function logTask(task, level, message, meta) {
        var bus = DreamAI.logbus;
        if (!bus) return;
        var payload = isPlain(meta) ? clone(meta) : {};
        payload.domain = 'task';
        if (task) {
            payload.taskId = task.id;
            if (task.providerId) payload.provider = task.providerId;
            if (task.modelId) payload.model = task.modelId;
            if (task.startedAt) payload.elapsedMs = (task.finishedAt || Date.now()) - task.startedAt;
        }
        var name = String(level || 'info').toLowerCase();
        var fn = typeof bus[name] === 'function' ? bus[name] : bus.info;
        fn.call(bus, message, payload);
    }

    /** 只有当前活动任务才允许改写状态条（单任务 UI 约定） */
    function reportStatus(task, text, tone, progress, force) {
        if (!DreamAI.bus) return;
        if (!force && (!task || task.id !== activeId())) return;
        DreamAI.bus.emit('status:message', {
            text: String(text == null ? '' : text),
            tone: tone || 'busy',
            progress: progress === undefined ? null : progress
        });
    }

    function notify() {
        var snapshot = list();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](snapshot); } catch (error) { /* 订阅者异常不影响主流程 */ }
        }
    }

    /* ============================================================
     * 任务构造
     * ============================================================ */

    function normalizeMode(mode) {
        var value = String(mode == null ? '' : mode).trim();
        if (value === 'img2img' || value === 'edit' || value === 'local' || value === 'txt2img') return value;
        return 'txt2img';
    }

    function clampCount(value) {
        var n = Math.round(toNumber(value, 1));
        return Math.round(clamp(n, 1, MAX_COUNT, 1));
    }

    function normalizeInputs(list) {
        var out = [];
        if (!Array.isArray(list)) return out;
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!item) continue;
            if (typeof item === 'string') {
                if (item) out.push({ dataUrl: item, role: i === 0 ? 'init' : 'reference' });
                continue;
            }
            var dataUrl = item.dataUrl || item.data || item.url;
            if (!dataUrl) continue;
            out.push({
                dataUrl: String(dataUrl),
                role: String(item.role || (i === 0 ? 'init' : 'reference')),
                width: toNumber(item.width, 0) || undefined,
                height: toNumber(item.height, 0) || undefined
            });
        }
        return out;
    }

    /**
     * 捕获「任务开始那一刻」的选区。
     * 选区在任务运行期间可能变化，所以必须在 enqueue 时固化下来（回写要用）。
     */
    function captureSelection() {
        var App = DreamAI.App;
        if (!App) return null;
        var selection = null;
        if (App.state && App.state.selection) selection = App.state.selection;
        else if (typeof App.get === 'function') selection = App.get('selection', null);
        if (!selection && App.selection) selection = App.selection;
        if (!selection || !isPlain(selection)) return null;
        return {
            dataUrl: selection.dataUrl ? String(selection.dataUrl) : '',
            width: Math.round(toNumber(selection.width, 0)),
            height: Math.round(toNumber(selection.height, 0)),
            bounds: selection.bounds ? clone(selection.bounds) : null,
            documentId: selection.documentId === undefined ? null : selection.documentId,
            documentName: selection.documentName ? String(selection.documentName) : ''
        };
    }

    function readReferences() {
        var App = DreamAI.App;
        if (!App) return [];
        var list = null;
        if (App.state && Array.isArray(App.state.references)) list = App.state.references;
        else if (typeof App.get === 'function') list = App.get('references', []);
        if (!Array.isArray(list)) list = Array.isArray(App.references) ? App.references : [];
        return list.slice();
    }

    function resolveTitle(spec) {
        var explicit = String(spec.title == null ? '' : spec.title).trim();
        if (explicit) return explicit;
        var prompt = String(spec.prompt == null ? '' : spec.prompt).trim();
        if (prompt) return truncate(prompt, 48);
        return t('task.defaultTitle');
    }

    /** spec 以不可枚举属性的形式挂在任务上，方便 retry 原样重放且不污染序列化 */
    function defineSpec(task, spec) {
        var copy = {};
        for (var key in spec) {
            if (hasOwn(spec, key)) copy[key] = spec[key];
        }
        try {
            Object.defineProperty(task, '__spec', { value: copy, enumerable: false, writable: true, configurable: true });
            Object.defineProperty(task, 'spec', { value: copy, enumerable: false, writable: true, configurable: true });
        } catch (error) {
            task.__spec = copy;
            task.spec = copy;
        }
        return copy;
    }

    function specOf(task) {
        if (task && isPlain(task.__spec)) return task.__spec;
        // 从持久化历史恢复的任务没有 spec，用任务字段重建一份最小可用 spec
        return {
            title: task ? task.title : '',
            providerId: task ? task.providerId : '',
            modelId: task ? task.modelId : '',
            mode: task ? task.mode : 'txt2img',
            prompt: task ? task.prompt : '',
            negativePrompt: task && task.meta ? String(task.meta.negativePrompt || '') : '',
            size: task && task.meta ? String(task.meta.size || '') : '',
            count: task && task.meta ? clampCount(task.meta.count) : 1,
            images: [],
            autoReturn: false
        };
    }

    /* ============================================================
     * 查询
     * ============================================================ */

    function list() {
        return tasks.slice();
    }

    function get(taskId) {
        var key = String(taskId == null ? '' : taskId);
        if (!key) return null;
        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i].id === key) return tasks[i];
        }
        return null;
    }

    function isTerminal(state) {
        return TERMINAL_STATES.indexOf(String(state)) !== -1;
    }

    function runningCount() {
        return running.length;
    }

    /** 单任务 UI 的「活动任务」：最早开始且仍在运行的那个 */
    function activeId() {
        return running.length ? running[0].id : null;
    }

    function subscribe(handler) {
        if (typeof handler !== 'function') return function () {};
        listeners.push(handler);
        return function () {
            var index = listeners.indexOf(handler);
            if (index !== -1) listeners.splice(index, 1);
        };
    }

    /* ============================================================
     * 状态迁移
     * ============================================================ */

    /** 更新非终态（执行函数可通过 helpers.setState 调用；终态走 finalize） */
    function setState(task, state) {
        var name = String(state == null ? '' : state);
        if (isTerminal(name)) {
            finalize(task, name, name === 'skipped' ? null : (task.error || null));
            return task;
        }
        if (RUNNING_STATES.indexOf(name) === -1 && name !== 'queued') return task;
        if (task.settled || task.state === name) return task;
        task.state = name;
        emitUpdate(task);
        return task;
    }

    function setProgress(task, percent, detail) {
        if (!task || task.settled) return;
        var value = toNumber(percent, -1);
        if (value < 0) value = -1;
        if (value > 100) value = 100;
        task.progress = Math.round(value);
        if (detail !== undefined && detail !== null) {
            task.meta = task.meta || {};
            task.meta.detail = String(detail);
        }
        emitUpdate(task);
    }

    function emitUpdate(task) {
        if (DreamAI.bus) DreamAI.bus.emit('task:update', { task: task });
        var percent = task.progress >= 0 ? Math.round(task.progress) : null;
        var text = task.progress >= 0
            ? t('task.progress', { percent: percent })
            : t('task.progressUnknown');
        reportStatus(task, text, 'busy', percent);
        notify();
    }

    /* ============================================================
     * 取消
     * ============================================================ */

    function removeFrom(arr, item) {
        var index = arr.indexOf(item);
        if (index !== -1) arr.splice(index, 1);
    }

    /** 依次执行任务记录里登记的停止回调（AbortController 等） */
    function runStops(task) {
        var stops = task && task.stops;
        if (!Array.isArray(stops)) return;
        for (var i = 0; i < stops.length; i++) {
            try {
                if (typeof stops[i] === 'function') stops[i]();
            } catch (error) { /* 停止失败不影响主流程 */ }
        }
    }

    function cancel(taskId) {
        var task = get(taskId);
        if (!task || isTerminal(task.state) || task.settled) return false;

        var index = pending.indexOf(task);
        if (index !== -1) {
            // 排队中的任务直接摘掉
            pending.splice(index, 1);
            finalize(task, 'canceled', t('task.canceled'));
            return true;
        }
        if (running.indexOf(task) !== -1) {
            task.cancelRequested = true;
            runStops(task);
            finalize(task, 'canceled', t('task.canceled'));
            return true;
        }
        return false;
    }

    /* ============================================================
     * 调度
     * ============================================================ */

    /*
     * 心跳定时器：任务在跑的时候保持事件循环存活。
     *
     * 为什么需要它：队列本身只依赖 Promise，如果某个执行器在等外部事件
     * （网络回调、宿主消息），而宿主环境里恰好没有任何定时器在跑，进程/宿主
     * 会认为"无事可做"。Node 下这会直接让进程退出，把正在跑的任务丢掉。
     * 这里只在 running 非空时开一个轻量 interval，队列空了立刻清掉，不产生
     * 额外开销。
     */
    var keepAlive = null;

    function syncKeepAlive() {
        if (running.length > 0) {
            if (keepAlive) return;
            if (typeof global.setInterval !== 'function') return;
            keepAlive = global.setInterval(function () { /* 仅用于保活 */ }, 250);
            if (keepAlive && typeof keepAlive.unref === 'function' && KEEP_ALIVE_UNREF) keepAlive.unref();
        } else if (keepAlive) {
            global.clearInterval(keepAlive);
            keepAlive = null;
        }
    }

    /**
     * 延后一个微任务再驱动 pump：
     * enqueue 必须同步返回状态为 queued 的任务对象，不能在这里就把任务跑起来。
     */
    function schedulePump() {
        if (pumpScheduled) return;
        pumpScheduled = true;
        Promise.resolve().then(function () {
            pumpScheduled = false;
            try {
                pump();
            } catch (error) {
                logTask(null, 'error', t('error.upstreamFailed', {
                    reason: error && error.message ? error.message : String(error)
                }));
            }
        });
    }

    function pump() {
        var limit = maxConcurrent();
        while (pending.length && running.length < limit) {
            var task = pending.shift();
            if (!task || task.settled || task.state !== 'queued') continue;
            startTask(task);
        }
        syncKeepAlive();
    }

    function createController() {
        if (typeof global.AbortController !== 'function') return null;
        try { return new global.AbortController(); } catch (error) { return null; }
    }

    /** 执行函数拿到的 helper 集合 */
    function buildHelpers(task, options) {
        return {
            id: task.id,
            setProgress: function (percent, detail) { setProgress(task, percent, detail); },
            setState: function (state) { setState(task, state); },
            log: function (level, message, meta) { logTask(task, level, message, meta); },
            signal: options.signal || null,
            selection: task.meta ? task.meta.selection : null,
            references: readReferences()
        };
    }

    /* ============================================================
     * 执行
     * ============================================================ */

    function wantsEdit(spec, images) {
        var mode = normalizeMode(spec.mode);
        if (mode === 'edit') return true;
        return images.length > 0 && (mode === 'img2img');
    }

    function buildRequest(task, spec, images) {
        return {
            prompt: task.prompt,
            negativePrompt: String(spec.negativePrompt == null ? '' : spec.negativePrompt),
            mode: normalizeMode(spec.mode),
            size: String(spec.size == null ? '' : spec.size),
            count: clampCount(spec.count),
            seed: spec.seed === undefined ? null : spec.seed,
            quality: spec.quality === undefined ? null : spec.quality,
            style: spec.style === undefined ? null : spec.style,
            images: images,
            extra: isPlain(spec.extra) ? spec.extra : {}
        };
    }

    /** 走 DreamAI.Providers：按模式选 generate / edit */
    function runProvider(task, spec, options) {
        var Providers = DreamAI.Providers;
        if (!Providers || typeof Providers.createContext !== 'function') {
            return Promise.reject(makeError('error.noProvider'));
        }
        var images = normalizeInputs(spec.images);
        var ctx = null;
        try {
            ctx = Providers.createContext(spec.providerId, {
                signal: options.signal || undefined,
                timeout: options.timeout,
                modelId: spec.modelId ? String(spec.modelId) : undefined,
                onProgress: function (percent) { setProgress(task, percent); }
            });
        } catch (error) {
            return Promise.reject(error);
        }
        var descriptor = ctx && ctx.descriptor ? ctx.descriptor : {};
        var supports = isPlain(descriptor.supports) ? descriptor.supports : {};
        var useEdit = wantsEdit(spec, images);
        if (useEdit && !images.length) return Promise.reject(makeError('error.editNeedsImage'));

        var method = useEdit && typeof descriptor.edit === 'function' && supports.edit !== false
            ? descriptor.edit
            : descriptor.generate;
        if (typeof method !== 'function') return Promise.reject(makeError('error.unsupportedMode'));

        var request = buildRequest(task, spec, images);
        logTask(task, 'info', t('task.logRequesting', {
            provider: task.providerId || descriptor.id || '',
            prompt: truncate(task.prompt, 60)
        }));
        return Promise.resolve().then(function () {
            return method.call(descriptor, ctx, request);
        });
    }

    function runExecution(task, spec, options) {
        var prompt = String(spec.prompt == null ? '' : spec.prompt).trim();
        var images = normalizeInputs(spec.images);
        if (!prompt && !images.length) return Promise.reject(makeError('task.promptRequired'));

        if (typeof spec.executor === 'function') {
            return Promise.resolve().then(function () {
                return spec.executor(task, buildHelpers(task, options));
            });
        }
        return runProvider(task, spec, options);
    }

    /** 把上游结果整理成 { dataUrl, width, height } 列表 */
    function normalizeImages(result) {
        var list = [];
        if (Array.isArray(result)) list = result;
        else if (isPlain(result) && Array.isArray(result.images)) list = result.images;
        else if (isPlain(result) && result.dataUrl) list = [result];
        else if (typeof result === 'string') list = [result];

        var out = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!item) continue;
            var dataUrl = typeof item === 'string' ? item : (item.dataUrl || item.url);
            if (!dataUrl) continue;
            var image = { dataUrl: String(dataUrl) };
            var width = Math.round(toNumber(typeof item === 'string' ? 0 : item.width, 0));
            var height = Math.round(toNumber(typeof item === 'string' ? 0 : item.height, 0));
            if (!width || !height) {
                var guessed = guessImageSize(image.dataUrl);
                if (guessed) { width = guessed.width; height = guessed.height; }
            }
            if (width) image.width = width;
            if (height) image.height = height;
            if (isPlain(item) && item.seed !== undefined) image.seed = item.seed;
            out.push(image);
        }
        return out;
    }

    function guessImageSize(dataUrl) {
        var Providers = DreamAI.Providers;
        if (!Providers || typeof Providers.imageSizeFromBase64 !== 'function') return null;
        var match = String(dataUrl || '').match(/^data:[^;,]*(;base64)?,([\s\S]*)$/);
        if (!match || !match[2]) return null;
        try {
            var size = Providers.imageSizeFromBase64(match[2]);
            if (size && size.width && size.height) return size;
        } catch (error) { /* 解析失败不是错误 */ }
        return null;
    }

    /** 结果归档到画廊：best-effort，绝不因为归档失败而让任务失败 */
    function archiveImages(task, images) {
        var Gallery = DreamAI.Gallery;
        if (!Gallery || typeof Gallery.add !== 'function') return Promise.resolve(0);
        var jobs = [];
        for (var i = 0; i < images.length; i++) {
            jobs.push((function (image) {
                return Promise.resolve().then(function () {
                    return Gallery.add(image.dataUrl, {
                        prompt: task.prompt,
                        providerId: task.providerId,
                        modelId: task.modelId,
                        mode: task.mode,
                        width: image.width,
                        height: image.height,
                        source: 'task',
                        taskId: task.id
                    });
                }).then(function () { return 1; }, function (error) {
                    logTask(task, 'warn', t('task.logArchiveFailed', {
                        reason: error && error.message ? error.message : String(error)
                    }));
                    return 0;
                });
            })(images[i]));
        }
        return Promise.all(jobs).then(function (results) {
            var count = 0;
            for (var k = 0; k < results.length; k++) count += results[k] || 0;
            if (count) logTask(task, 'debug', t('task.logArchived', { count: count }));
            return count;
        });
    }

    /** 回写选项：spec.returnOptions 覆盖 settings.behavior 默认值 */
    function buildReturnOptions(task, spec) {
        var behavior = readBehavior();
        var selection = task.meta ? task.meta.selection : null;
        var options = {
            bounds: selection && selection.bounds ? clone(selection.bounds) : null,
            documentId: selection ? selection.documentId : undefined,
            layerName: null,
            blendMode: String(behavior.returnBlendMode || 'normal'),
            feather: toNumber(behavior.returnFeather, 0),
            shrink: 0,
            group: '',
            colorMatch: behavior.colorMatchOnReturn !== false,
            colorMatchMethod: String(behavior.colorMatchMethod || 'meanStd'),
            colorMatchReference: selection && selection.dataUrl ? selection.dataUrl : null,
            useSelectionBounds: true,
            taskId: task.id
        };

        var extra = isPlain(spec.returnOptions) ? spec.returnOptions : {};
        for (var key in extra) {
            if (!hasOwn(extra, key)) continue;
            if (extra[key] === undefined) continue;
            options[key] = extra[key];
        }

        // bounds / documentId 一律取任务开始时固化的选区，避免任务运行期间选区变化导致贴错位置
        var useSelection = options.useSelectionBounds !== false;
        if (selection && useSelection) {
            options.bounds = selection.bounds ? clone(selection.bounds) : null;
            options.documentId = selection.documentId === undefined ? undefined : selection.documentId;
            if (!options.colorMatchReference && selection.dataUrl) options.colorMatchReference = selection.dataUrl;
        } else if (options.bounds === undefined) {
            options.bounds = null;
        }
        return options;
    }

    function autoReturnEnabled(spec) {
        if (!spec || spec.autoReturn === false) return false;
        var PhotoReturn = DreamAI.PhotoReturn;
        if (!PhotoReturn || typeof PhotoReturn.place !== 'function') return false;
        if (typeof PhotoReturn.isAvailable === 'function' && !PhotoReturn.isAvailable()) return false;
        return true;
    }

    /** 自动回写：失败只记 task.meta.returnError，不能把任务标记成 failed */
    function autoReturn(task, spec, image) {
        var PhotoReturn = DreamAI.PhotoReturn;
        var options = buildReturnOptions(task, spec);
        task.meta = task.meta || {};
        task.meta.returnOptions = options;
        return Promise.resolve().then(function () {
            return PhotoReturn.place(image.dataUrl || image, options);
        }).then(function (result) {
            var layerName = result && result.layerName ? String(result.layerName) : '';
            task.meta.returned = layerName;
            if (result && result.layerId !== undefined) task.meta.returnedLayerId = result.layerId;
            emitUpdate(task);
            logTask(task, 'info', t('return.done', { name: layerName }));
            return result;
        }, function (error) {
            var reason = error && error.message ? error.message : String(error);
            task.meta.returnError = reason;
            emitUpdate(task);
            logTask(task, 'warn', t('return.failed', { reason: reason }));
            return null;
        });
    }

    /** 成功路径：归档 → result:ready → 自动回写 → done */
    function handleSuccess(task, spec, result) {
        var images = normalizeImages(result);
        var hasResult = result !== undefined && result !== null;
        if (!images.length && !hasResult) {
            // 执行器什么都没返回：属于契约违例，按失败处理
            finalize(task, 'failed', t('task.noImages'));
            return Promise.resolve();
        }
        if (!images.length) {
            // 返回了结果但没有图片（例如纯本地操作类任务）：任务仍然算完成，只记一条警告
            logTask(task, 'warn', t('task.noImages'));
            task.images = [];
            task.meta = task.meta || {};
            task.meta.empty = true;
            finalize(task, 'done', null);
            return Promise.resolve();
        }
        task.images = images;
        task.meta = task.meta || {};
        task.meta.imageCount = images.length;
        if (images[0].width || images[0].height) {
            task.meta.width = images[0].width || 0;
            task.meta.height = images[0].height || 0;
        }

        var willReturn = autoReturnEnabled(spec);
        if (willReturn) setState(task, 'returning');
        else if (spec.autoReturn !== false) logTask(task, 'debug', t('task.logSkipReturn'));

        return archiveImages(task, images).then(function () {
            if (task.settled) return null;
            if (DreamAI.bus) DreamAI.bus.emit('result:ready', { task: task, images: images });
            if (!willReturn) return null;
            return autoReturn(task, spec, images[0]);
        }).then(function () {
            if (task.settled) return;
            finalize(task, 'done', null);
        }, function (error) {
            // 归档/回写链路的意外异常也不应让任务变 failed
            if (task.settled) return;
            logTask(task, 'warn', t('task.logArchiveFailed', {
                reason: error && error.message ? error.message : String(error)
            }));
            finalize(task, 'done', null);
        });
    }

    /** 把任意失败翻译成已本地化的文案 */
    function localizedMessage(error) {
        if (!error) return t('task.failed', { reason: t('app.unknown') });
        if (error.localized && error.message) return error.message;
        var raw = error.message ? String(error.message) : String(error);
        if (error.name === 'AbortError') return t('error.aborted');
        if (/timeout after/i.test(raw)) {
            var seconds = Math.max(1, Math.round(toNumber(readBehavior().requestTimeout, DEFAULT_TIMEOUT_MS) / 1000));
            return t('error.requestTimeout', { seconds: seconds });
        }
        return t('task.failed', { reason: truncate(raw, 200) });
    }

    function startTask(task) {
        var spec = specOf(task);
        /* 显式传入的超时低于下限（5000ms）属于调用方错误：
           直接拒绝执行并给出本地化说明，避免"请求秒级超时"的假象。 */
        var requested = toNumber(spec.timeout, 0);
        if (requested > 0 && requested < MIN_TIMEOUT_MS) {
            task.stops = [];
            finalize(task, 'failed', t('task.timeoutTooSmall', {
                requested: Math.round(requested),
                min: MIN_TIMEOUT_MS
            }));
            return;
        }

        running.push(task);
        task.startedAt = Date.now();
        task.state = 'running';
        task.progress = 0;

        var controller = createController();
        var signal = controller ? controller.signal : null;
        var timeoutMs = resolveTimeout(spec);
        task.meta = task.meta || {};
        task.meta.timeoutMs = timeoutMs;

        // 停止句柄登记在任务记录上：cancel() 会依次调用它们
        task.stops = [];
        var stopped = false;
        function stop() {
            if (stopped) return;
            stopped = true;
            task.cancelRequested = true;
            if (controller) {
                try { controller.abort(); } catch (error) { /* 忽略中止失败 */ }
            }
        }
        task.stops.push(stop);
        task.stops.abort = stop;
        task.abort = stop;

        logTask(task, 'info', t('task.logStarted', { id: task.id }));
        emitUpdate(task);

        // 超时：改状态 + 记本地化错误 + 中止底层请求
        task._timer = setTimeout(function () {
            task._timer = null;
            if (task.settled) return;
            var seconds = Math.round(timeoutMs / 1000);
            task.timedOut = true;
            stop();
            finalize(task, 'timeout', t('task.timeout', { seconds: seconds }));
        }, timeoutMs);

        var execution = null;
        try {
            execution = runExecution(task, spec, { signal: signal, timeout: timeoutMs });
        } catch (error) {
            execution = Promise.reject(error);
        }

        Promise.resolve(execution).then(function (result) {
            if (task.settled) return null;
            return handleSuccess(task, spec, result);
        }, function (error) {
            if (task.settled) return;
            if (task.cancelRequested) {
                finalize(task, 'canceled', t('task.canceled'));
                return;
            }
            finalize(task, 'failed', localizedMessage(error));
        }).then(null, function (error) {
            // 兜底：保证任何意外都不会留下悬挂任务
            if (task.settled) return;
            finalize(task, 'failed', localizedMessage(error));
        });
    }

    /* ============================================================
     * 收尾
     * ============================================================ */

    /** 终态迁移，幂等；负责事件、持久化、遥测与后续调度 */
    function finalize(task, state, error) {
        if (!task || task.settled) return false;
        task.settled = true;
        if (task._timer) {
            clearTimeout(task._timer);
            task._timer = null;
        }
        var wasActive = task.id === activeId();
        removeFrom(running, task);
        removeFrom(pending, task);

        task.state = isTerminal(state) ? state : 'failed';
        task.finishedAt = Date.now();
        task.error = error || null;
        if (task.state === 'done') task.progress = 100;

        var elapsed = task.startedAt ? task.finishedAt - task.startedAt : 0;
        task.meta = task.meta || {};
        task.meta.elapsedMs = elapsed;

        // 遥测：任务 id / 渠道 / 模型 / 耗时
        if (task.state === 'done') {
            logTask(task, 'success', t('task.logDone', {
                id: task.id, elapsed: elapsed, count: task.images.length
            }));
        } else if (task.state === 'failed') {
            logTask(task, 'error', t('task.logFailed', { id: task.id, reason: task.error }));
        } else if (task.state === 'timeout') {
            logTask(task, 'error', t('task.logTimeout', {
                id: task.id,
                seconds: Math.round(toNumber(task.meta.timeoutMs, 0) / 1000) || Math.round(resolveTimeout(specOf(task)) / 1000)
            }));
        } else if (task.state === 'canceled') {
            logTask(task, 'warn', t('task.logCanceled', { id: task.id }));
        }

        persistHistory();
        if (DreamAI.bus) {
            DreamAI.bus.emit('task:update', { task: task });
            DreamAI.bus.emit('task:finished', { task: task });
        }
        if (wasActive) {
            var tone = task.state === 'done' ? 'ok' : (task.state === 'failed' || task.state === 'timeout' ? 'error' : 'warn');
            var key = 'state.' + (task.state === 'skipped' ? 'skipped' : task.state);
            reportStatus(task, task.state === 'failed' && task.error ? task.error : t(key), tone,
                task.state === 'done' ? 100 : null, true);
        }
        notify();
        schedulePump();
        return true;
    }

    /* ============================================================
     * 持久化（只存元数据 + 小体积首图）
     * ============================================================ */

    function dataUrlBytes(dataUrl) {
        var match = String(dataUrl || '').match(/^data:[^;,]*(;base64)?,([\s\S]*)$/);
        if (!match || !match[2]) return 0;
        var payload = match[2].replace(/\s+/g, '');
        return Math.floor(payload.length * 3 / 4);
    }

    /** 元数据脱敏：丢掉选区 dataUrl 等大对象，只留可序列化的上下文 */
    function sanitizeMeta(source) {
        var out = {};
        if (!isPlain(source)) return out;
        for (var key in source) {
            if (!hasOwn(source, key)) continue;
            if (key === 'selection') {
                var selection = source.selection;
                if (isPlain(selection)) {
                    out.selection = {
                        width: Math.round(toNumber(selection.width, 0)),
                        height: Math.round(toNumber(selection.height, 0)),
                        bounds: selection.bounds ? clone(selection.bounds) : null,
                        documentId: selection.documentId === undefined ? null : selection.documentId,
                        documentName: selection.documentName ? String(selection.documentName) : ''
                    };
                }
                continue;
            }
            if (key === 'returnOptions') {
                var options = source.returnOptions;
                if (isPlain(options)) {
                    var copy = {};
                    for (var optionKey in options) {
                        if (!hasOwn(options, optionKey)) continue;
                        if (optionKey === 'colorMatchReference' || optionKey === 'bounds') continue;
                        var optionValue = options[optionKey];
                        var optionType = typeof optionValue;
                        if (optionValue === null || optionType === 'string' || optionType === 'number' || optionType === 'boolean') {
                            copy[optionKey] = optionValue;
                        }
                    }
                    out.returnOptions = copy;
                }
                continue;
            }
            var value = source[key];
            var type = typeof value;
            if (value === null || type === 'string' || type === 'number' || type === 'boolean') {
                out[key] = type === 'string' && value.length > META_STRING_LIMIT ? value.slice(0, META_STRING_LIMIT) : value;
                continue;
            }
            if (type === 'object') {
                try {
                    var text = JSON.stringify(value);
                    if (text && text.length <= META_STRING_LIMIT) out[key] = JSON.parse(text);
                } catch (error) { /* 不可序列化的字段直接丢弃 */ }
            }
        }
        return out;
    }

    function toRecord(task) {
        var record = {
            id: task.id,
            state: task.state,
            title: task.title,
            providerId: task.providerId,
            modelId: task.modelId,
            mode: task.mode,
            // 历史里的提示词做长度截断（重放历史任务时可能不是完整原文，界面只用于展示）
            prompt: truncate(task.prompt, HISTORY_PROMPT_LIMIT),
            progress: task.progress,
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            finishedAt: task.finishedAt,
            error: task.error,
            images: [],
            meta: sanitizeMeta(task.meta)
        };
        var first = task.images && task.images.length ? task.images[0] : null;
        // 只内联小图（< 200 KB），避免 localStorage 被全尺寸结果撑爆
        if (first && first.dataUrl && dataUrlBytes(first.dataUrl) < INLINE_IMAGE_LIMIT) {
            record.images = [{ dataUrl: first.dataUrl, width: first.width, height: first.height }];
        }
        return record;
    }

    function persistHistory() {
        var Store = DreamAI.Store;
        if (!Store) return;
        var records = [];
        for (var i = 0; i < tasks.length && records.length < HISTORY_LIMIT; i++) {
            records.push(toRecord(tasks[i]));
        }
        try {
            if (typeof Store.writeAll === 'function') Store.writeAll(HISTORY_DOMAIN, records);
            else Store.write(HISTORY_DOMAIN, records);
        } catch (error) {
            logTask(null, 'warn', t('error.upstreamFailed', {
                reason: error && error.message ? error.message : String(error)
            }));
        }
        if (tasks.length > HISTORY_LIMIT) {
            logTask(null, 'debug', t('task.logHistoryTrimmed', { max: HISTORY_LIMIT }));
        }
    }

    /** 启动时恢复历史：只读回元数据，全部标记为已结束 */
    function restoreHistory() {
        var Store = DreamAI.Store;
        if (!Store) return 0;
        var raw = null;
        try { raw = Store.read(HISTORY_DOMAIN, []); } catch (error) { raw = null; }
        var records = Array.isArray(raw) ? raw : (isPlain(raw) && Array.isArray(raw.items) ? raw.items : []);
        var restored = 0;
        for (var i = 0; i < records.length; i++) {
            var record = records[i];
            if (!isPlain(record) || !record.id) continue;
            var task = {
                id: String(record.id),
                state: isTerminal(record.state) ? String(record.state) : 'canceled',
                title: String(record.title == null ? '' : record.title),
                providerId: String(record.providerId == null ? '' : record.providerId),
                modelId: String(record.modelId == null ? '' : record.modelId),
                mode: normalizeMode(record.mode),
                prompt: String(record.prompt == null ? '' : record.prompt),
                progress: Math.round(toNumber(record.progress, 100)),
                createdAt: toNumber(record.createdAt, Date.now()),
                startedAt: record.startedAt === null || record.startedAt === undefined ? null : toNumber(record.startedAt, 0),
                finishedAt: record.finishedAt === null || record.finishedAt === undefined ? null : toNumber(record.finishedAt, 0),
                images: Array.isArray(record.images) ? record.images.slice() : [],
                error: record.error ? String(record.error) : null,
                meta: isPlain(record.meta) ? clone(record.meta) : {},
                restored: true,
                settled: true,
                stops: []
            };
            if (tasks.length >= HISTORY_LIMIT) break;
            tasks.push(task);
            restored++;
        }
        tasks.sort(function (a, b) { return toNumber(b.createdAt, 0) - toNumber(a.createdAt, 0); });
        return restored;
    }

    /* ============================================================
     * 公共 API
     * ============================================================ */

    /**
     * 提交任务。立即返回任务对象，执行由内部 pump 按并发上限驱动。
     * @param {Object} spec 见 docs/INTERNALS.md 第 3 节
     * @returns {Object} task
     */
    function enqueue(spec) {
        var source = isPlain(spec) ? spec : {};
        var now = Date.now();
        var task = {
            id: uid('task'),
            state: 'queued',
            title: resolveTitle(source),
            providerId: String(source.providerId == null ? '' : source.providerId),
            modelId: String(source.modelId == null ? '' : source.modelId),
            mode: normalizeMode(source.mode),
            prompt: String(source.prompt == null ? '' : source.prompt),
            progress: 0,
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            images: [],
            error: null,
            meta: {
                size: String(source.size == null ? '' : source.size),
                count: clampCount(source.count),
                negativePrompt: String(source.negativePrompt == null ? '' : source.negativePrompt),
                autoReturn: source.autoReturn !== false,
                // 选区在入队时固化：任务运行期间选区可能变化，回写必须用入队那一刻的
                selection: captureSelection()
            }
        };
        defineSpec(task, source);
        task.stops = [];

        tasks.unshift(task);
        pending.push(task);
        notify();
        if (DreamAI.bus) DreamAI.bus.emit('task:created', { task: task });
        logTask(task, 'info', t('task.logCreated', {
            id: task.id,
            provider: task.providerId || '-',
            model: task.modelId || '-'
        }));
        schedulePump();
        return task;
    }

    /**
     * 重放一个已结束的任务（spec 原样保留在不可枚举属性上）。
     * @returns {Object|null} 新任务
     */
    function retry(taskId) {
        var task = get(taskId);
        if (!task || !isTerminal(task.state)) return null;
        var spec = specOf(task);
        var next = {};
        for (var key in spec) {
            if (hasOwn(spec, key)) next[key] = spec[key];
        }
        next.retryOf = task.id;
        var created = enqueue(next);
        logTask(created, 'info', t('task.logRetry', { id: task.id, newId: created.id }));
        return created;
    }

    /** 清除全部终态任务，返回清理条数 */
    function clearFinished() {
        var removed = 0;
        for (var i = tasks.length - 1; i >= 0; i--) {
            if (isTerminal(tasks[i].state)) {
                tasks.splice(i, 1);
                removed++;
            }
        }
        if (removed) {
            persistHistory();
            notify();
        }
        return removed;
    }

    function init() {
        if (initialized) return;
        initialized = true;
        pending = [];
        running = [];
        restoreHistory();
        // 恢复出来的任务都是终态，不需要重新调度；这里只把队列状态同步给订阅者
        notify();
    }

    DreamAI.TaskQueue = {
        init: init,
        enqueue: enqueue,
        cancel: cancel,
        retry: retry,
        list: list,
        get: get,
        clearFinished: clearFinished,
        runningCount: runningCount,
        activeId: activeId,
        subscribe: subscribe,
        /** 状态枚举（只读） */
        STATES: STATES.slice(),
        TERMINAL_STATES: TERMINAL_STATES.slice(),
        isTerminal: isTerminal,
        /** 当前并发上限（调试用） */
        maxConcurrent: maxConcurrent
    };
})(typeof window !== 'undefined' ? window : this);
