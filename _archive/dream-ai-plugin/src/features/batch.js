/*
 * features/batch.js — 批处理队列
 *
 * 职责：
 *   - 维护待生成清单（Store 域 batch.queue，最多 50 项，超出丢弃最旧项）；
 *   - start() 串行执行队列：逐项交给 DreamAI.TaskQueue.enqueue，等待任务结束后记录成功/失败；
 *   - stop() 取消当前在跑的任务并让 start() 提前兑现。
 * 输入：item（{ prompt, negativePrompt, providerId, modelId, size, count, note, source }）。
 * 输出：Promise<{ ok, fail }>、队列快照、batch:change 事件与状态条进度。
 * 边界：不做生成算法、不直接回写 Photoshop（都交给 TaskQueue）；
 *       纯 ES5，可在没有 Photoshop 宿主的 Node 下加载；start() 永不抛错。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.Batch) return;

    var util = DreamAI.util || {};

    /* ============================================================
     * 基础工具（util 缺失时兜底）
     * ============================================================ */

    function t(key, params) {
        return DreamAI.I18n ? DreamAI.I18n.t(key, params) : key;
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

    function sleep(ms) {
        if (typeof util.sleep === 'function') return util.sleep(ms);
        return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, toNumber(ms, 0))); });
    }

    function makeError(key, params) {
        var error = new Error(t(key, params));
        error.localized = true;
        error.key = key;
        return error;
    }

    function log(level, message, meta) {
        var bus = DreamAI.logbus;
        if (!bus) return;
        var payload = isPlain(meta) ? meta : {};
        if (payload.domain === undefined) payload.domain = 'batch';
        var name = String(level || 'info').toLowerCase();
        var fn = typeof bus[name] === 'function' ? bus[name] : bus.info;
        fn.call(bus, message, payload);
    }

    /* ============================================================
     * 常量与状态
     * ============================================================ */

    var DOMAIN = 'batch.queue';
    var QUEUE_LIMIT = 50;
    var GAP_MS = 300;
    var POLL_MS = 150;
    var MAX_COUNT = 10;
    var TERMINAL_STATES = ['done', 'failed', 'canceled', 'timeout', 'skipped'];

    /** @type {Array} 队列，按执行顺序排列（队首最先执行） */
    var queue = [];
    var listeners = [];
    var initialized = false;
    var running = false;
    var startPromise = null;
    var cancelRequested = false;
    var currentTaskId = null;
    var processedCount = 0;

    /* ============================================================
     * 持久化
     * ============================================================ */

    function load() {
        var Store = DreamAI.Store;
        if (!Store) return [];
        var raw = null;
        try { raw = Store.read(DOMAIN, []); } catch (error) { raw = null; }
        var records = Array.isArray(raw) ? raw : (isPlain(raw) && Array.isArray(raw.items) ? raw.items : []);
        var out = [];
        for (var i = 0; i < records.length && out.length < QUEUE_LIMIT; i++) {
            if (!isPlain(records[i]) || !records[i].id) continue;
            out.push(normalizeItem(records[i], true));
        }
        queue = out;
        return queue;
    }

    function persist() {
        var Store = DreamAI.Store;
        if (!Store) return;
        var records = [];
        for (var i = 0; i < queue.length; i++) {
            var item = queue[i];
            records.push({
                id: item.id,
                prompt: item.prompt,
                negativePrompt: item.negativePrompt,
                providerId: item.providerId,
                modelId: item.modelId,
                size: item.size,
                count: item.count,
                note: item.note,
                source: item.source,
                state: item.state,
                error: item.error,
                taskId: item.taskId,
                createdAt: item.createdAt,
                startedAt: item.startedAt,
                finishedAt: item.finishedAt
            });
        }
        try {
            if (typeof Store.writeAll === 'function') Store.writeAll(DOMAIN, records);
            else Store.write(DOMAIN, records);
        } catch (error) {
            log('warn', t('error.upstreamFailed', { reason: error && error.message ? error.message : String(error) }), { domain: 'batch' });
        }
    }

    function normalizeItem(raw, restored) {
        var source = isPlain(raw) ? raw : {};
        var state = String(source.state || 'queued');
        if (restored && (state === 'running' || state === 'queued')) state = 'queued';
        return {
            id: String(source.id || uid('batch')),
            prompt: String(source.prompt == null ? '' : source.prompt),
            negativePrompt: String(source.negativePrompt == null ? '' : source.negativePrompt),
            providerId: String(source.providerId == null ? '' : source.providerId),
            modelId: String(source.modelId == null ? '' : source.modelId),
            size: String(source.size == null ? '' : source.size),
            count: Math.round(clamp(toNumber(source.count, 1), 1, MAX_COUNT, 1)),
            note: String(source.note == null ? '' : source.note),
            source: String(source.source == null ? 'manual' : source.source),
            state: state === 'done' || state === 'failed' ? state : 'queued',
            error: source.error ? String(source.error) : null,
            taskId: source.taskId ? String(source.taskId) : null,
            createdAt: toNumber(source.createdAt, Date.now()),
            startedAt: source.startedAt === null || source.startedAt === undefined ? null : toNumber(source.startedAt, 0),
            finishedAt: source.finishedAt === null || source.finishedAt === undefined ? null : toNumber(source.finishedAt, 0)
        };
    }

    function readSettings() {
        if (DreamAI.App && isPlain(DreamAI.App.settings)) return DreamAI.App.settings;
        if (DreamAI.Store && typeof DreamAI.Store.read === 'function') {
            var stored = DreamAI.Store.read('settings');
            if (isPlain(stored)) return stored;
        }
        return {};
    }

    /* ============================================================
     * 事件与状态条
     * ============================================================ */

    function emitChange() {
        var snapshot = list();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](snapshot); } catch (error) { /* 订阅者异常不影响主流程 */ }
        }
        if (DreamAI.bus) DreamAI.bus.emit('batch:change', { items: snapshot });
    }

    function reportStatus(text, tone, progress) {
        if (!DreamAI.bus) return;
        DreamAI.bus.emit('status:message', {
            text: String(text == null ? '' : text),
            tone: tone || 'busy',
            progress: progress === undefined ? null : progress
        });
    }

    function progressPercent(done, total) {
        if (!(total > 0)) return null;
        return Math.round(clamp(done / total, 0, 1, 0) * 100);
    }

    function isTerminal(state) {
        return TERMINAL_STATES.indexOf(String(state)) !== -1;
    }

    function messageOf(error) {
        if (!error) return t('state.failed');
        if (error.localized && error.message) return error.message;
        return error.message ? String(error.message) : String(error);
    }

    /* ============================================================
     * 队列操作
     * ============================================================ */

    /** @returns {Array} 队列快照（副本，按执行顺序） */
    function list() {
        var out = [];
        for (var i = 0; i < queue.length; i++) out.push(clone(queue[i]));
        return out;
    }

    function get(id) {
        var key = String(id == null ? '' : id);
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].id === key) return queue[i];
        }
        return null;
    }

    /**
     * 追加一项到队尾。
     * @param {Object} item { prompt, negativePrompt, providerId, modelId, size, count, note, source }
     * @returns {Object} 新项
     */
    function add(item) {
        var entry = normalizeItem(item, false);
        entry.state = 'queued';
        entry.error = null;
        entry.taskId = null;
        entry.createdAt = Date.now();
        entry.startedAt = null;
        entry.finishedAt = null;
        queue.push(entry);
        if (queue.length > QUEUE_LIMIT) {
            // 超出上限时丢弃最旧的项（队首）
            var dropped = queue.splice(0, queue.length - QUEUE_LIMIT);
            log('debug', t('batch.logTrimmed', { max: QUEUE_LIMIT, count: dropped.length }), {
                domain: 'batch', max: QUEUE_LIMIT, dropped: dropped.length
            });
        }
        persist();
        emitChange();
        return clone(entry);
    }

    function remove(id) {
        var key = String(id == null ? '' : id);
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].id !== key) continue;
            queue.splice(i, 1);
            persist();
            emitChange();
            return true;
        }
        return false;
    }

    /** 清空队列（运行中会先请求停止）；返回清掉的条数 */
    function clear() {
        if (running) stop();
        var count = queue.length;
        queue = [];
        persist();
        emitChange();
        return count;
    }

    /* ============================================================
     * 执行
     * ============================================================ */

    /**
     * 等待任务进入终态。
     * 事件优先（task:finished），同时用轮询兜底，避免任务在订阅之前就已结束。
     */
    function waitForTerminal(task) {
        return new Promise(function (resolve) {
            if (!task || !task.id) { resolve(null); return; }
            var Queue = DreamAI.TaskQueue;
            var settled = false;
            var timer = null;
            var off = null;

            function finish(entry) {
                if (settled) return;
                settled = true;
                if (timer) { clearInterval(timer); timer = null; }
                if (off) {
                    try { off(); } catch (error) { /* 忽略退订失败 */ }
                    off = null;
                }
                resolve(entry || null);
            }

            var current = Queue && typeof Queue.get === 'function' ? Queue.get(task.id) : null;
            if (current && isTerminal(current.state)) { finish(current); return; }

            if (DreamAI.bus && typeof DreamAI.bus.on === 'function') {
                off = DreamAI.bus.on('task:finished', function (payload) {
                    if (!payload || !payload.task || payload.task.id !== task.id) return;
                    finish(payload.task);
                });
            }
            timer = setInterval(function () {
                var entry = Queue && typeof Queue.get === 'function' ? Queue.get(task.id) : null;
                if (entry && isTerminal(entry.state)) finish(entry);
            }, POLL_MS);
        });
    }

    /** 把一项提交给任务队列，返回创建出来的任务 */
    function submit(item, index) {
        var Queue = DreamAI.TaskQueue;
        if (!Queue || typeof Queue.enqueue !== 'function') {
            return Promise.reject(makeError('batch.noTaskQueue'));
        }
        var settings = readSettings();
        var behavior = isPlain(settings.behavior) ? settings.behavior : {};
        var task = null;
        try {
            task = Queue.enqueue({
                title: t('batch.image', { index: index }),
                providerId: item.providerId || String(settings.activeChannelId || ''),
                modelId: item.modelId || '',
                mode: 'txt2img',
                prompt: item.prompt,
                negativePrompt: item.negativePrompt,
                size: item.size,
                count: item.count,
                autoReturn: behavior.autoReturn !== false
            });
        } catch (error) {
            return Promise.reject(error);
        }
        item.taskId = task.id;
        persist();
        emitChange();
        return Promise.resolve(task);
    }

    /**
     * 串行执行队列。
     * 绝不会 reject：单项失败记为 failed，最终兑现 { ok, fail }。
     * @returns {Promise<{ok:number, fail:number}>}
     */
    function start() {
        if (running && startPromise) return startPromise;

        if (!DreamAI.TaskQueue || typeof DreamAI.TaskQueue.enqueue !== 'function') {
            var reason = t('batch.noTaskQueue');
            log('error', reason, { domain: 'batch' });
            reportStatus(reason, 'error', null);
            return Promise.resolve({ ok: 0, fail: 0 });
        }

        var plan = [];
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].state !== 'done') plan.push(queue[i]);
        }
        var total = plan.length;
        if (!total) {
            log('debug', t('batch.needItem'), { domain: 'batch' });
            reportStatus(t('batch.needItem'), 'warn', null);
            return Promise.resolve({ ok: 0, fail: 0 });
        }

        running = true;
        cancelRequested = false;
        processedCount = 0;
        currentTaskId = null;
        log('info', t('batch.logStart', { total: total }), { domain: 'batch', total: total });

        var ok = 0;
        var fail = 0;

        function step() {
            if (cancelRequested || !plan.length) return Promise.resolve();
            var item = plan.shift();
            var index = queue.indexOf(item) + 1;
            if (index < 1) index = processedCount + 1;
            item.state = 'running';
            item.error = null;
            item.startedAt = Date.now();
            item.finishedAt = null;
            persist();
            emitChange();
            reportStatus(t('batch.itemRunning', { index: index }), 'busy', progressPercent(processedCount, total));

            return submit(item, index).then(function (task) {
                currentTaskId = task ? task.id : null;
                return waitForTerminal(task).then(function (settled) {
                    return { task: task, entry: settled };
                });
            }, function (error) {
                return { task: null, entry: null, error: error };
            }).then(function (outcome) {
                var state = outcome.entry && outcome.entry.state ? String(outcome.entry.state) : 'failed';
                if (!outcome.task) state = 'failed';
                if (state === 'done') {
                    item.state = 'done';
                    item.error = null;
                    ok++;
                } else if (state === 'canceled' && cancelRequested) {
                    // 用户主动停止：这一项退回排队，下次 start() 继续
                    item.state = 'queued';
                    item.error = null;
                } else {
                    item.state = 'failed';
                    item.error = (outcome.entry && outcome.entry.error)
                        ? String(outcome.entry.error)
                        : messageOf(outcome.error);
                    fail++;
                }
                item.finishedAt = Date.now();
                if (outcome.task && outcome.task.id) item.taskId = outcome.task.id;
                if (!outcome.task) item.taskId = null;
                processedCount++;

                persist();
                emitChange();
                log(item.state === 'failed' ? 'warn' : 'info', t('batch.logItem', {
                    index: index, total: total, state: item.state
                }), { domain: 'batch', itemId: item.id, taskId: item.taskId });
                if (item.state === 'failed') {
                    log('warn', t('batch.itemFailed', { index: index, reason: item.error }), { domain: 'batch', itemId: item.id });
                }
                reportStatus(t('batch.progress', { done: processedCount, total: total }), 'busy', progressPercent(processedCount, total));

                // 每项之间至少间隔 300ms，避免连续轰炸宿主与上游
                return sleep(GAP_MS).then(step);
            });
        }

        function finishStart() {
            var stopped = cancelRequested;
            running = false;
            currentTaskId = null;
            cancelRequested = false;
            startPromise = null;
            persist();
            emitChange();
            if (stopped) {
                log('warn', t('batch.logStopped', { index: processedCount }), { domain: 'batch', ok: ok, fail: fail });
                reportStatus(t('batch.stopped'), 'warn', null);
            } else {
                log('info', t('batch.logDone', { ok: ok, fail: fail }), { domain: 'batch', ok: ok, fail: fail });
                reportStatus(t('batch.finished', { ok: ok, fail: fail }), fail ? 'error' : 'ok', 100);
            }
            return { ok: ok, fail: fail };
        }

        startPromise = step().then(finishStart, function (error) {
            // 兜底：循环本身出错也要兑现结果，绝不 reject
            log('error', t('error.upstreamFailed', { reason: messageOf(error) }), { domain: 'batch' });
            return finishStart();
        });
        return startPromise;
    }

    /** 请求停止当前批处理：取消在跑任务，start() 会在当前项结束后兑现 */
    function stop() {
        if (!running) return false;
        cancelRequested = true;
        var taskId = currentTaskId;
        if (taskId && DreamAI.TaskQueue && typeof DreamAI.TaskQueue.cancel === 'function') {
            DreamAI.TaskQueue.cancel(taskId);
        }
        // 还没开始跑当前项时，直接放掉它，让 start() 尽快收尾
        emitChange();
        return true;
    }

    function isRunning() {
        return running;
    }

    function subscribe(handler) {
        if (typeof handler !== 'function') return function () {};
        listeners.push(handler);
        return function () {
            var index = listeners.indexOf(handler);
            if (index !== -1) listeners.splice(index, 1);
        };
    }

    function init() {
        if (initialized) return;
        initialized = true;
        load();
        if (queue.length) {
            log('debug', t('batch.queueRestored', { count: queue.length }), { domain: 'batch', count: queue.length });
        }
        persist();
        emitChange();
    }

    DreamAI.Batch = {
        init: init,
        add: add,
        list: list,
        get: get,
        remove: remove,
        clear: clear,
        start: start,
        stop: stop,
        isRunning: isRunning,
        subscribe: subscribe,
        /** 队列上限与项间间隔（调试/测试用） */
        QUEUE_LIMIT: QUEUE_LIMIT,
        GAP_MS: GAP_MS
    };
})(typeof window !== 'undefined' ? window : this);
