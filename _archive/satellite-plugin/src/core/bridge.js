// ============================================================
//  bridge.js — 与「幻梦圆环」原生助手的连接
//
//  插件是 WebSocket 客户端，助手是服务端（UXP 只有客户端 API，
//  开不了监听端口，真机实测确认）。
//
//  助手没启动、被重启、或中途崩溃都很常见，所以这里的重连
//  是核心逻辑而不是兜底：指数退避 + 静默恢复，用户不需要管。
//  重连期间只更新状态标识，不弹提示。
// ============================================================

window.SatBridge = (function () {
    'use strict';

    var URL = 'ws://127.0.0.1:8799';
    var RECONNECT_BASE_MS = 800;
    var RECONNECT_MAX_MS = 15000;
    var STATE_THROTTLE_MS = 200;

    var socket = null;
    var reconnectTimer = null;
    var reconnectDelay = RECONNECT_BASE_MS;
    var connected = false;
    var lastStateSentAt = 0;
    var stateTimer = null;
    var handlers = {};
    var shouldRun = false;
    var attemptCount = 0;

    // ---------- 状态 ----------

    function statusText() {
        if (connected) return '圆环已连接';
        if (!shouldRun) return '圆环未启用';
        if (attemptCount > 3) return '圆环未启动（重试中）';
        return '正在连接圆环…';
    }

    function statusKind() {
        if (connected) return 'ok';
        return attemptCount > 3 ? 'warn' : 'info';
    }

    function isConnected() {
        return connected;
    }

    // ---------- 连接 ----------

    function open() {
        shouldRun = true;
        if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;

        try {
            socket = new WebSocket(URL);
        } catch (error) {
            console.error('[卫星] 无法创建 WebSocket：' + error.message);
            scheduleReconnect();
            return;
        }

        socket.addEventListener('open', function () {
            connected = true;
            reconnectDelay = RECONNECT_BASE_MS;
            attemptCount = 0;
            console.log('[卫星] 已连接到圆环助手');
            notifyStatus();
            pushState(true);
        });

        socket.addEventListener('message', function (event) {
            var message = null;
            try {
                message = JSON.parse(String(event.data));
            } catch (error) {
                return;
            }
            if (!message || message.type === 'hello') return;
            dispatch(message);
        });

        socket.addEventListener('error', function () {
            // 具体原因在 close 里统一处理，这里只避免未捕获的错误冒泡
        });

        socket.addEventListener('close', function () {
            var wasConnected = connected;
            connected = false;
            socket = null;
            if (wasConnected) console.log('[卫星] 圆环助手连接断开，将自动重连');
            notifyStatus();
            scheduleReconnect();
        });
    }

    function scheduleReconnect() {
        if (!shouldRun || reconnectTimer) return;
        attemptCount += 1;
        var delay = reconnectDelay;
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            // 退避翻倍，但封顶。连上以后会在 open 里重置。
            reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
            open();
        }, delay);
        notifyStatus();
    }

    function close() {
        shouldRun = false;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (socket) {
            try { socket.close(); } catch (error) {}
            socket = null;
        }
        connected = false;
        notifyStatus();
    }

    function send(payload) {
        if (!connected || !socket || socket.readyState !== 1) return false;
        try {
            socket.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            console.error('[卫星] 发送失败：' + error.message);
            return false;
        }
    }

    // ---------- 状态上报 ----------

    /** 立即或节流后把当前状态推给圆环。 */
    function pushState(immediate) {
        if (!connected) return;
        var now = Date.now();
        var wait = immediate ? 0 : STATE_THROTTLE_MS - (now - lastStateSentAt);

        if (wait <= 0) {
            lastStateSentAt = now;
            send({ type: 'state', payload: buildState() });
            return;
        }
        if (stateTimer) return;
        stateTimer = setTimeout(function () {
            stateTimer = null;
            lastStateSentAt = Date.now();
            send({ type: 'state', payload: buildState() });
        }, wait);
    }

    function buildState() {
        var config = SatStore.get();
        var channels = SatStore.channels();
        var parsed = SatProviders.parseModel(config.imageModel);
        var activeChannel = parsed.channel || config.channel;
        var meta = SatProviders.channelInfo(activeChannel) || {};

        var document_ = { open: false };
        try {
            if (SatPs.available()) {
                var described = SatPs.describeDocument();
                document_ = {
                    open: !!described.open,
                    name: described.name || '',
                    hasSelection: !!described.hasSelection,
                    selectionWidth: described.selection ? Math.round(described.selection.width) : 0,
                    selectionHeight: described.selection ? Math.round(described.selection.height) : 0
                };
            }
        } catch (error) {
            document_ = { open: false };
        }

        return {
            document: document_,
            params: {
                channel: activeChannel,
                channelLabel: meta.label || activeChannel,
                model: config.imageModel || '',
                aspectRatio: config.aspectRatio,
                resolution: config.imageResolution,
                count: config.imageCount
            },
            options: {
                aspectRatio: SatProviders.ASPECT_RATIOS,
                resolution: SatProviders.RESOLUTIONS,
                count: [1, 2, 3, 4],
                // 只把配好密钥的渠道给圆环。没配的列出来既选不了又误导，
                // 缺渠道这件事去参数页看更清楚。
                // 一个都没配时全部列出，至少让用户知道有哪些可选。
                channels: (function () {
                    function describe(name, markUnusable) {
                        var info = SatProviders.channelInfo(name);
                        var usable = !!channels[name].apiKey || info.apiKeyOptional;
                        return {
                            value: name,
                            label: info.label + (markUnusable && !usable ? '（缺密钥）' : ''),
                            models: info.imageModels || []
                        };
                    }
                    var usable = SatProviders.channelNames().filter(function (name) {
                        var info = SatProviders.channelInfo(name);
                        return !!channels[name].apiKey || info.apiKeyOptional;
                    });
                    if (usable.length) {
                        return usable.map(function (name) { return describe(name, false); });
                    }
                    return SatProviders.channelNames().map(function (name) { return describe(name, true); });
                })()
            },
            presets: groupPresets()
        };
    }

    /** 预设按分类分组，每组最多 8 条（圆环单层扇区上限）。 */
    function groupPresets() {
        var presets = (window.SatApp && SatApp.presets) ? SatApp.presets() : [];
        var buckets = {};
        var order = [];
        presets.forEach(function (preset) {
            var category = preset.category || '未分类';
            if (!buckets[category]) {
                buckets[category] = [];
                order.push(category);
            }
            if (buckets[category].length >= 8) return;
            buckets[category].push({
                name: preset.name,
                prompt: SatBase.truncate(preset.prompt, 40)
            });
        });
        return order.map(function (category) {
            return { category: category, items: buckets[category] };
        });
    }

    function progress(state, message, thumbnail) {
        var payload = { type: 'progress', state: state, message: message || '' };
        if (thumbnail) payload.thumbnail = thumbnail;
        send(payload);
    }

    // ---------- 指令分发 ----------

    function on(action, handler) {
        handlers[action] = handler;
    }

    function dispatch(message) {
        if (message.type !== 'command') return;
        var handler = handlers[message.action];
        if (!handler) {
            console.warn('[卫星] 圆环发来未知指令：' + message.action);
            return;
        }
        // 指令处理里会 await PS 操作，不能阻塞消息回调
        Promise.resolve()
            .then(function () { return handler(message); })
            .catch(function (error) {
                console.error('[卫星] 指令 ' + message.action + ' 执行失败：' + error.message);
                progress('failure', error.message);
            });
    }

    // ---------- 状态变化通知面板 ----------

    var listeners = [];

    function onStatusChange(listener) {
        listeners.push(listener);
    }

    function notifyStatus() {
        var text = statusText();
        var kind = statusKind();
        listeners.forEach(function (listener) {
            try { listener(connected, text, kind); } catch (error) {}
        });
    }

    return {
        URL: URL,
        open: open,
        close: close,
        on: on,
        onStatusChange: onStatusChange,
        isConnected: isConnected,
        statusText: statusText,
        statusKind: statusKind,
        pushState: pushState,
        progress: progress,
        groupPresets: groupPresets,
        _buildState: buildState
    };
})();
