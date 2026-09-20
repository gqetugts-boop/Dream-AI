/*
 * core/ps-lock.js — Photoshop 串行锁
 *
 * 职责：
 *   - 为所有会碰 Photoshop 文档的操作提供一条 FIFO 队列，保证同一时刻只有一个
 *     executeAsModal 在跑（多个任务并发抢修改权会把宿主卡死）；
 *   - 每个入队项带硬超时（默认 3600000ms = 1 小时），超时后拒绝等待方，
 *     避免「宿主不返回也不抛错」把整条队列永久堵死；
 *   - 每项都吞掉自身异常（catch-all），一个任务失败不会打断后续链条；
 *   - 相邻两次操作之间留至少 150ms 间隔，给 Photoshop 喘息时间；
 *   - 队列深度变化时广播 pslock:change { pending, running } 供界面显示。
 *
 * 输入：acquire(task, taskId) 里的 task 是无参 async 函数。
 * 输出：acquire 返回 Promise；pending() 返回排队中（不含正在跑）的条数。
 * 边界：
 *   - 本文件不访问宿主、不在顶层 require('photoshop')，可在 Node 下直接加载；
 *   - 超时只解除「等待」，不会也不能强杀已经在跑的宿主操作，所以锁会保持到该操作
 *     真实结束为止（UXP 无法取消已进入模态的操作）；
 *   - 不负责重试，失败原样抛给调用方。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};

    // 幂等保护：重复加载不覆盖已存在的实例
    if (DreamAI.psLock) return;

    /** 事件名：队列深度变化 */
    var EVENT_CHANGE = 'pslock:change';
    /** 单个队列项的默认硬超时（1 小时） */
    var DEFAULT_TIMEOUT_MS = 3600000;
    /** 两次操作之间的最小间隔 */
    var GAP_MS = 150;

    var queue = [];
    var running = false;
    var lastEmitKey = null;

    function now() {
        return typeof Date.now === 'function' ? Date.now() : new Date().getTime();
    }

    function delay(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms > 0 ? ms : 0);
        });
    }

    /** 广播队列状态；同状态重复触发时去重，避免界面被无意义刷新淹没 */
    function emitChange(force) {
        var payload = { pending: queue.length, running: running };
        var key = payload.pending + '/' + (running ? '1' : '0');
        if (!force && key === lastEmitKey) return;
        lastEmitKey = key;
        if (DreamAI.bus && typeof DreamAI.bus.emit === 'function') {
            // 同步派发；订阅者异常由 bus 自己吞掉
            DreamAI.bus.emit(EVENT_CHANGE, payload);
        }
    }

    /** 等待方超时时用的文案；i18n 未加载时回退到中文兜底 */
    function timeoutMessage(taskId) {
        var label = taskId ? String(taskId) : 'unknown';
        if (DreamAI.I18n && typeof DreamAI.I18n.t === 'function') {
            return DreamAI.I18n.t('error.psLockTimeout', { id: label });
        }
        return 'Photoshop operation timed out (task ' + label + ')';
    }

    /** 队列被 clear() 取消时用的文案 */
    function canceledMessage() {
        if (DreamAI.I18n && typeof DreamAI.I18n.t === 'function') {
            return DreamAI.I18n.t('error.psLockCanceled');
        }
        return 'Photoshop operation canceled before it started';
    }

    /**
     * 顺序消费队列。
     * 每一步结束（无论成功/失败/超时）都保证 running 归位并重新调度。
     */
    function pump() {
        if (running) return;
        if (queue.length === 0) { emitChange(false); return; }
        var entry = queue.shift();
        running = true;
        emitChange(true);

        var timer = null;
        var timedOut = false;
        var waiterSettled = false;

        var started = now();

        function settleWaiter(ok, value) {
            if (waiterSettled) return;
            waiterSettled = true;
            if (ok) entry.resolve(value);
            else entry.reject(value);
        }

        var work = new Promise(function (resolve) {
            // 用 Promise.resolve().then 包一层：task 同步抛错也走 reject 分支，
            // 不会在这里炸掉队列
            resolve();
        }).then(function () {
            return entry.task();
        });

        var guard = new Promise(function (resolve, reject) {
            timer = setTimeout(function () {
                timedOut = true;
                settleWaiter(false, new Error(timeoutMessage(entry.taskId)));
                // 超时只让等待方先走，锁继续占用到真实结束（见文件头「边界」）
                resolve(undefined);
            }, entry.timeout);
        });

        Promise.race([work, guard]).then(function (value) {
            if (timer) { clearTimeout(timer); timer = null; }
            settleWaiter(true, value);
        }, function (error) {
            if (timer) { clearTimeout(timer); timer = null; }
            settleWaiter(false, error);
        }).then(function () {
            // 只有真实工作结束后才释放锁
            return work.then(function () { return undefined; }, function () { return undefined; });
        }).then(function () {
            if (timer) { clearTimeout(timer); timer = null; }
            running = false;
            // 最小间隔：即使上游 task 秒回也强制让出 150ms
            var elapsed = now() - started;
            var wait = GAP_MS - elapsed;
            if (timedOut || wait <= 0) wait = GAP_MS;
            return delay(wait);
        }).then(function () {
            emitChange(true);
            pump();
        });
    }

    /**
     * 入队一个任务。
     * @param {Function} task 无参函数，可返回 Promise
     * @param {string} [taskId] 业务任务 id，用于 clear(taskId) 定向取消
     * @param {{timeout?:number}} [options] 覆盖单项超时（毫秒）
     * @returns {Promise<*>} 任务结果；失败/超时/被取消时 reject
     */
    function acquire(task, taskId, options) {
        var opts = options || {};
        var timeout = Number(opts.timeout);
        if (!isFinite(timeout) || timeout <= 0) timeout = DEFAULT_TIMEOUT_MS;

        return new Promise(function (resolve, reject) {
            if (typeof task !== 'function') {
                reject(new Error(timeoutMessage(taskId)));
                return;
            }
            queue.push({
                task: task,
                taskId: taskId || null,
                timeout: timeout,
                resolve: resolve,
                reject: reject
            });
            emitChange(true);
            pump();
        });
    }

    /**
     * 取消「还没开始跑」的条目。
     * @param {string} [taskId] 不传 = 清空整条队列
     * @returns {number} 被取消的条数（正在运行的那项不在此列）
     */
    function clear(taskId) {
        var dropped = 0;
        var remaining = [];
        for (var i = 0; i < queue.length; i++) {
            var entry = queue[i];
            if (!taskId || entry.taskId === taskId) {
                dropped++;
                try { entry.reject(new Error(canceledMessage())); } catch (error) { /* 忽略重复 reject */ }
            } else {
                remaining.push(entry);
            }
        }
        queue = remaining;
        if (dropped > 0) emitChange(true);
        return dropped;
    }

    /** 排队中（不含正在跑）的条数，供界面显示 */
    function pending() {
        return queue.length;
    }

    /** 是否正在执行某项 */
    function isRunning() {
        return running;
    }

    /**
     * 逃生舱：界面上的「解锁」按钮用。
     * 只清空排队项并把 running 复位；已经在 Photoshop 里跑的那次操作仍然会继续，
     * 但它结束后不会再把队列搅乱（其结果会被丢弃）。
     */
    function reset() {
        var dropped = clear();
        running = false;
        lastEmitKey = null;
        emitChange(true);
        return dropped;
    }

    DreamAI.psLock = {
        EVENT_CHANGE: EVENT_CHANGE,
        DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
        GAP_MS: GAP_MS,
        acquire: acquire,
        clear: clear,
        pending: pending,
        isRunning: isRunning,
        reset: reset
    };
})(typeof window !== 'undefined' ? window : this);
