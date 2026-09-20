/*
 * providers/grok-gateway.js — 自建 Grok 网关（grok2api 一类的本地聚合服务）
 *
 * 职责：对接自建网关的 OpenAI 兼容面（/models、/images/generations、
 *       /images/edits、/chat/completions），并处理两个现实差异：
 *       1) 网关常常挂在根地址（不带 /v1）或只提供其中一种前缀 → 自动回退；
 *       2) 图片任务是异步的：先返回 task_id，需要轮询任务详情直到出图。
 * 输入：registry.createContext() 产出的 ctx、统一 request 对象。
 * 输出：{ images: [{ dataUrl, width, height, seed? }], raw, meta } / { text, raw } / [{ id }]。
 * 边界：鉴权只认网关后台签发的 g2a_... Client Key（401/403 给出专门提示）；
 *       不代理其它厂商；纯 ES5，可在没有 Photoshop 宿主的 Node 下加载。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var P = DreamAI.Providers;
    if (!P || P.get('grok')) return;

    var util = DreamAI.util;

    var DEFAULT_MODEL = 'grok-imagine-image';
    var DEFAULT_CHAT_MODEL = 'grok-2-latest';
    var KEY_PREFIX = 'g2a_';
    var MAX_IMAGES = 10;

    /** 401/403 一律翻译成"网关密钥无效"（网关的密钥体系与 xAI 官方不通用） */
    var AUTH_STATUS_KEYS = { 401: 'error.grokInvalidKey', 403: 'error.grokInvalidKey' };

    var TASK_ID_KEYS = ['task_id', 'taskId', 'taskID', 'id', 'job_id', 'jobId',
        'request_id', 'requestId', 'record_id', 'recordId', 'prompt_id', 'promptId'];

    var PENDING_STATUS = ['', 'pending', 'queued', 'queueing', 'queued_for_processing', 'processing',
        'running', 'in_progress', 'in-progress', 'starting', 'created', 'submitted', 'waiting', 'generating'];

    var FAILED_STATUS = ['failed', 'failure', 'error', 'canceled', 'cancelled', 'timeout', 'timed_out', 'expired', 'rejected'];

    function t(key, params) {
        return DreamAI.I18n ? DreamAI.I18n.t(key, params) : key;
    }

    function hasOwn(object, name) {
        return Object.prototype.hasOwnProperty.call(object, name);
    }

    /* ============================================================
     * 地址与状态探测
     * ============================================================ */

    /** 网关可能挂在 /v1 下，也可能直接挂在根地址：两个都作为候选 */
    function candidateBases(ctx) {
        var withV1 = P.normalizeBaseUrl(ctx.baseUrl, { requireV1: true });
        var root = P.normalizeBaseUrl(ctx.baseUrl);
        var list = [];
        if (withV1) list.push(withV1);
        if (root && root !== withV1) list.push(root);
        if (!list.length) list.push('');
        return list;
    }

    /** 404/405 视为"这个前缀不对"，可以换下一个候选地址 */
    function isEndpointMiss(error) {
        if (!error) return false;
        var status = util.toNumber(error.status, 0);
        if (status === 404 || status === 405) return true;
        return /HTTP (404|405)|not found/i.test(String(error.message || ''));
    }

    function requestOptionsWithAuth() {
        return { statusKeys: AUTH_STATUS_KEYS };
    }

    /** 依次尝试候选地址；遇到"前缀不对"才回退，其它错误直接抛出 */
    function requestAcrossBases(ctx, bases, path, options, index) {
        var i = util.toNumber(index, 0);
        if (i >= bases.length) i = bases.length - 1;
        var url = P.joinUrl(bases[i], path);
        return P.sendJson(ctx, url, options).catch(function (error) {
            if (i + 1 < bases.length && isEndpointMiss(error)) {
                P.log(ctx, 'warn', t('provider.endpointFallback'), { url: url, status: error.status });
                return requestAcrossBases(ctx, bases, path, options, i + 1);
            }
            throw error;
        });
    }

    function containerList(payload) {
        var list = [payload];
        if (util.isPlainObject(payload)) {
            if (util.isPlainObject(payload.data)) list.push(payload.data);
            if (util.isPlainObject(payload.result)) list.push(payload.result);
            if (util.isPlainObject(payload.output)) list.push(payload.output);
        }
        return list;
    }

    function findTaskId(payload) {
        var containers = containerList(payload);
        for (var c = 0; c < containers.length; c++) {
            var source = containers[c];
            if (!util.isPlainObject(source)) continue;
            for (var i = 0; i < TASK_ID_KEYS.length; i++) {
                var value = source[TASK_ID_KEYS[i]];
                if (typeof value === 'string' && value.trim()) return value.trim();
                if (typeof value === 'number' && isFinite(value)) return String(value);
            }
        }
        return '';
    }

    function taskStatus(payload) {
        var containers = containerList(payload);
        for (var c = 0; c < containers.length; c++) {
            var source = containers[c];
            if (!util.isPlainObject(source)) continue;
            var value = source.status !== undefined ? source.status : source.state;
            if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
        }
        return '';
    }

    function isPendingStatus(status) {
        return PENDING_STATUS.indexOf(String(status || '')) !== -1;
    }

    function isFailedStatus(status) {
        return FAILED_STATUS.indexOf(String(status || '')) !== -1;
    }

    /** 失败任务的简短原因（只回传上游文案，不做本地化包装） */
    function describeFailure(payload) {
        if (util.isPlainObject(payload)) {
            var detail = (payload.error && (payload.error.message || payload.error)) ||
                payload.message || payload.detail || payload.failure_reason || payload.reason;
            if (typeof detail === 'string' && detail.trim()) return util.truncate(detail, 300);
        }
        return String(taskStatus(payload) || t('state.failed'));
    }

    /**
     * 收集网关响应里的图片条目。
     * 额外过滤：任务详情里的 /images/generations/{id} 自引用链接不是图片，必须剔除。
     */
    function gatewayEntries(payload) {
        var entries = P.collectImages(payload, [], 0, {});
        var out = [];
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.kind === 'url' &&
                /\/images\/generations(\/|$)/i.test(entry.value) &&
                !/\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i.test(entry.value)) {
                continue;
            }
            out.push(entry);
        }
        return out;
    }

    function resolveGatewayImages(ctx, payload, options) {
        var entries = gatewayEntries(payload);
        var tasks = [];
        for (var i = 0; i < entries.length; i++) tasks.push(P.resolveEntry(ctx, entries[i], options));
        return Promise.all(tasks).then(function (list) {
            var images = [];
            var remoteUrls = [];
            for (var j = 0; j < list.length; j++) {
                var image = list[j];
                if (!image || !image.dataUrl) continue;
                images.push(image);
                if (image.remoteUrl) remoteUrls.push(image.remoteUrl);
            }
            return { images: images, remoteUrls: remoteUrls };
        });
    }

    function finalize(ctx, raw, request) {
        return resolveGatewayImages(ctx, raw, { mime: P.DEFAULT_IMAGE_MIME }).then(function (parsed) {
            return P.buildImageResult(ctx, raw, parsed, request);
        });
    }

    /* ============================================================
     * 异步任务轮询
     * ============================================================ */

    function pollTask(ctx, bases, taskId, startedAt) {
        var timeout = util.toNumber(ctx.timeout, P.DEFAULT_TIMEOUT);
        if (!(timeout > 0)) timeout = P.DEFAULT_TIMEOUT;
        var deadline = Date.now() + Math.max(1000, timeout);
        var path = '/images/generations/' + encodeURIComponent(taskId);
        var attempt = 0;

        function tick() {
            if (ctx.signal && ctx.signal.aborted) return Promise.reject(P.makeError('error.aborted'));
            if (Date.now() >= deadline) {
                return Promise.reject(P.makeError('error.taskTimeout', null, { taskId: taskId, attempts: attempt }));
            }
            attempt++;
            var elapsed = Date.now() - startedAt;
            var percent = Math.min(95, 5 + Math.round((elapsed / timeout) * 90));
            P.progress(ctx, percent);
            return requestAcrossBases(ctx, bases, path, requestOptionsWithAuth(), 0).then(function (raw) {
                var status = taskStatus(raw);
                if (isFailedStatus(status)) {
                    throw P.makeError('error.taskFailed', { reason: describeFailure(raw) },
                        { status: status, taskId: taskId, raw: raw });
                }
                var entries = gatewayEntries(raw);
                if (entries.length && !isPendingStatus(status)) {
                    P.progress(ctx, 95);
                    return raw;
                }
                // 上游若回传自身进度，优先采用（0-1 视为比例）
                var reported = util.toNumber(util.isPlainObject(raw) ? raw.progress : -1, -1);
                if (reported > 0 && reported <= 1) reported = reported * 100;
                if (reported > 0) P.progress(ctx, Math.max(percent, Math.min(95, reported)));
                P.log(ctx, 'debug', t('provider.polling'), {
                    taskId: taskId, attempt: attempt, status: status || 'pending', percent: percent
                });
                return util.sleep(ctx.pollInterval).then(tick);
            });
        }

        return util.sleep(ctx.pollInterval).then(tick);
    }

    /** 提交一次图片任务：同步出图直接返回，异步则轮询到出图 */
    function submitImageJob(ctx, bases, path, options, startedAt) {
        return requestAcrossBases(ctx, bases, path, options, 0).then(function (raw) {
            var status = taskStatus(raw);
            var entries = gatewayEntries(raw);
            if (entries.length && !isPendingStatus(status)) return raw;
            var taskId = findTaskId(raw);
            if (!taskId) return raw; // 交给 buildImageResult 抛 error.noImage
            P.log(ctx, 'info', t('provider.taskQueued'), { taskId: taskId, status: status || 'queued' });
            return pollTask(ctx, bases, taskId, startedAt);
        });
    }

    /* ============================================================
     * 请求体
     * ============================================================ */

    function requestImages(request) {
        var list = request && Array.isArray(request.images) ? request.images : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && (list[i].dataUrl || list[i].data || list[i].base64)) out.push(list[i]);
        }
        return out;
    }

    function buildBody(ctx, request, prompt) {
        var body = {
            model: String(ctx.modelId || DEFAULT_MODEL).trim(),
            prompt: prompt,
            n: P.imageCount(request.count, MAX_IMAGES),
            size: P.formatSize(request.size, '1024x1024')
        };
        if (request.quality !== undefined && request.quality !== null && request.quality !== '') body.quality = request.quality;
        if (request.style !== undefined && request.style !== null && request.style !== '') body.style = request.style;
        if (request.seed !== undefined && request.seed !== null && request.seed !== '') body.seed = request.seed;
        var extra = util.isPlainObject(request.extra) ? request.extra : {};
        for (var name in extra) {
            if (hasOwn(extra, name) && body[name] === undefined) body[name] = extra[name];
        }
        return body;
    }

    /** 密钥形态提示：网关只认 g2a_ 前缀的 Client Key */
    function warnOnKeyShape(ctx) {
        var key = String(ctx.apiKey || '').trim();
        if (key && key.toLowerCase().indexOf(KEY_PREFIX) !== 0) {
            P.log(ctx, 'warn', t('provider.grokKeyHint'), { providerId: ctx.providerId });
        }
    }

    /* ============================================================
     * 模型列表
     * ============================================================ */

    function listModels(ctx) {
        var bases = candidateBases(ctx);
        P.log(ctx, 'debug', t('provider.requesting'), { url: P.joinUrl(bases[0], '/models') });
        return requestAcrossBases(ctx, bases, '/models', { method: 'GET', statusKeys: AUTH_STATUS_KEYS }, 0)
            .then(function (payload) {
                var rows = null;
                if (Array.isArray(payload)) rows = payload;
                else if (util.isPlainObject(payload)) {
                    if (Array.isArray(payload.data)) rows = payload.data;
                    else if (Array.isArray(payload.models)) rows = payload.models;
                }
                if (!rows) throw P.makeError('error.emptyResponse', null, { raw: payload });

                var out = [];
                var seen = {};
                for (var i = 0; i < rows.length; i++) {
                    var row = rows[i];
                    var id = typeof row === 'string' ? row : (row && (row.id || row.name || row.model));
                    if (typeof id !== 'string' || !id.trim()) continue;
                    id = id.trim();
                    if (seen[id]) continue;
                    seen[id] = true;
                    out.push({ id: id });
                }
                P.log(ctx, 'success', t('provider.modelsLoaded', { count: out.length }), {});
                return out;
            });
    }

    /* ============================================================
     * 文生图
     * ============================================================ */

    function generate(ctx, request) {
        var payload = request || {};
        var prompt = String(payload.prompt === undefined || payload.prompt === null ? '' : payload.prompt).trim();
        if (!prompt) return Promise.reject(P.makeError('ws.needPrompt'));

        warnOnKeyShape(ctx);
        var bases = candidateBases(ctx);
        var body = buildBody(ctx, payload, prompt);
        var startedAt = Date.now();
        var options = requestOptionsWithAuth();
        options.method = 'POST';
        options.body = JSON.stringify(body);

        P.log(ctx, 'info', t('provider.requesting'), { url: P.joinUrl(bases[0], '/images/generations'), model: body.model });
        P.progress(ctx, 5);

        return submitImageJob(ctx, bases, '/images/generations', options, startedAt).then(function (raw) {
            P.progress(ctx, 90);
            return finalize(ctx, raw, payload);
        });
    }

    /* ============================================================
     * 图片编辑（网关的 /images/edits 只接受单个 image 字段）
     * ============================================================ */

    function edit(ctx, request) {
        var payload = request || {};
        var prompt = String(payload.prompt === undefined || payload.prompt === null ? '' : payload.prompt).trim();
        if (!prompt) return Promise.reject(P.makeError('ws.needPrompt'));

        var inputs = requestImages(payload);
        var sources = [];
        var hasMask = false;
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].role || '') === 'mask') { hasMask = true; continue; }
            sources.push(inputs[i]);
        }
        if (!sources.length) return Promise.reject(P.makeError('error.editNeedsImage'));

        var first = P.imageBytesFrom(sources[0].dataUrl || sources[0].data || sources[0].base64);
        if (!first) return Promise.reject(P.makeError('error.editNeedsImage'));
        if (sources.length > 1 || hasMask) {
            P.log(ctx, 'warn', t('provider.singleImageOnly'), { dropped: sources.length - 1, mask: hasMask });
        }

        warnOnKeyShape(ctx);
        var bases = candidateBases(ctx);
        var startedAt = Date.now();
        var model = String(ctx.modelId || DEFAULT_MODEL).trim();
        var multipart = P.buildMultipart([
            { name: 'model', value: model },
            { name: 'prompt', value: prompt },
            { name: 'n', value: String(P.imageCount(payload.count, MAX_IMAGES)) },
            { name: 'size', value: P.formatSize(payload.size, '1024x1024') },
            {
                name: 'image',
                bytes: first.bytes,
                contentType: first.mime,
                filename: 'image.' + P.extFromMime(first.mime)
            }
        ]);
        if (multipart.mode === 'manual') {
            P.log(ctx, 'debug', t('provider.multipartManual'), { parts: 5 });
        }
        var url = P.joinUrl(bases[0], '/images/edits');
        P.log(ctx, 'info', t('provider.requesting'), { url: url, model: model, images: 1 });
        P.progress(ctx, 5);

        return submitRawJob(ctx, bases, '/images/edits', {
            method: 'POST',
            headers: multipart.headers,
            body: multipart.body,
            statusKeys: AUTH_STATUS_KEYS
        }, startedAt).then(function (raw) {
            P.progress(ctx, 90);
            return finalize(ctx, raw, payload);
        });
    }

    /** 与 submitImageJob 同逻辑，但走原始请求出口（multipart 不能用 JSON 出口） */
    function submitRawJob(ctx, bases, path, options, startedAt) {
        return requestAcrossBasesRaw(ctx, bases, path, options, 0).then(function (raw) {
            var status = taskStatus(raw);
            var entries = gatewayEntries(raw);
            if (entries.length && !isPendingStatus(status)) return raw;
            var taskId = findTaskId(raw);
            if (!taskId) return raw;
            P.log(ctx, 'info', t('provider.taskQueued'), { taskId: taskId, status: status || 'queued' });
            return pollTask(ctx, bases, taskId, startedAt);
        });
    }

    function requestAcrossBasesRaw(ctx, bases, path, options, index) {
        var i = util.toNumber(index, 0);
        if (i >= bases.length) i = bases.length - 1;
        var url = P.joinUrl(bases[i], path);
        return P.sendRaw(ctx, url, options).then(function (res) {
            return res.data === null || res.data === undefined ? res.text : res.data;
        }, function (error) {
            if (i + 1 < bases.length && isEndpointMiss(error)) {
                P.log(ctx, 'warn', t('provider.endpointFallback'), { url: url, status: error.status });
                return requestAcrossBasesRaw(ctx, bases, path, options, i + 1);
            }
            throw error;
        });
    }

    /* ============================================================
     * 对话 / 余额 / 测试
     * ============================================================ */

    function chat(ctx, request) {
        var payload = request || {};
        var messages = Array.isArray(payload.messages) ? payload.messages : [];
        if (!messages.length) return Promise.reject(P.makeError('error.messagesRequired'));

        var model = String(payload.model || ctx.chatModel || DEFAULT_CHAT_MODEL).trim();
        var body = { model: model, messages: messages };
        if (payload.temperature !== undefined && payload.temperature !== null) body.temperature = payload.temperature;
        if (payload.maxTokens !== undefined && payload.maxTokens !== null) body.max_tokens = payload.maxTokens;
        var extra = util.isPlainObject(payload.extra) ? payload.extra : {};
        for (var name in extra) {
            if (hasOwn(extra, name) && body[name] === undefined) body[name] = extra[name];
        }

        warnOnKeyShape(ctx);
        var bases = candidateBases(ctx);
        P.log(ctx, 'info', t('provider.requesting'), { url: P.joinUrl(bases[0], '/chat/completions'), model: model });
        return requestAcrossBases(ctx, bases, '/chat/completions', {
            method: 'POST',
            body: JSON.stringify(body),
            statusKeys: AUTH_STATUS_KEYS
        }, 0).then(function (raw) {
            var choice = raw && Array.isArray(raw.choices) ? raw.choices[0] : null;
            if (!choice) throw P.makeError('error.noChoices', null, { raw: raw });
            var content = choice.message ? choice.message.content : choice.text;
            if (Array.isArray(content)) {
                var buffer = '';
                for (var i = 0; i < content.length; i++) {
                    buffer += typeof content[i] === 'string' ? content[i] : ((content[i] && content[i].text) || '');
                }
                content = buffer;
            }
            return { text: String(content === undefined || content === null ? '' : content), raw: raw };
        });
    }

    function checkBalance(ctx) {
        // 自建网关没有统一的余额接口：按约定降级
        return Promise.resolve({ display: t('settings.balanceUnsupported'), endpoint: null });
    }

    function test(ctx) {
        return listModels(ctx).then(function (models) {
            return { ok: true, models: models };
        }, function (error) {
            return { ok: false, models: [], error: error && error.message ? error.message : String(error) };
        });
    }

    P.register({
        id: 'grok',
        labelKey: 'settings.channelGrok',
        order: 40,
        needsKey: true,
        defaultBaseUrl: 'http://127.0.0.1:8000/v1',
        defaultModel: DEFAULT_MODEL,
        defaultChatModel: DEFAULT_CHAT_MODEL,
        supports: { txt2img: true, img2img: true, edit: true, models: true, chat: true, balance: false },
        listModels: listModels,
        generate: generate,
        edit: edit,
        chat: chat,
        checkBalance: checkBalance,
        test: test,
        /** 便于宿主适配与测试：暴露内部探测函数 */
        detectTaskId: findTaskId,
        detectStatus: taskStatus
    });
})(typeof window !== 'undefined' ? window : this);
