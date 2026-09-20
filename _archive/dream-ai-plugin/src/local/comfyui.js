/*
 * local/comfyui.js — 本地 / 云端 ComfyUI 引擎适配
 *
 * 职责：
 *   - 读写 engines.comfy 域配置（endpointMode / localUrl / cloudUrl / apiToken /
 *     timeout / workflowJson / workflowName / prompt）；
 *   - 校验并解析 ComfyUI 的 API 格式工作流（validateWorkflow / extractParams）；
 *   - 完整生成链路：上传输入图 → 注入提示词与参数 → POST /prompt → 轮询 /history →
 *     GET /view 下载输出图并统一成 base64 data URL；
 *   - 连接测试（GET /system_stats）与中断（POST /interrupt）。
 * 输入：ctx = { baseUrl, apiToken, timeout(毫秒), pollInterval(毫秒), log, signal, onProgress }，
 *       以及 run() 的 request = { workflow, prompt, negativePrompt, images, params, timeout }。
 * 输出：{ images: [{ dataUrl, width, height, filename }], promptId, raw } /
 *       { ok, device, system, systemText } / { ok, nodeCount, reason } / [{ nodeId, classType, key, label, value }]。
 * 边界：不渲染界面、不写 Photoshop 文档、不缓存工作流；所有网络调用走 DreamAI.util.request，
 *       全部对外文案来自 DreamAI.I18n.t()；纯 ES5，可在没有 Photoshop / UXP 宿主的 Node 下加载。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.ComfyUI) return;

    var util = DreamAI.util;

    var STORE_DOMAIN = 'engines.comfy';
    var DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
    var MIN_TIMEOUT_SECONDS = 60;
    var MAX_TIMEOUT_SECONDS = 86400;
    var DEFAULT_POLL_INTERVAL = 1000;
    var DEFAULT_REQUEST_TIMEOUT = 60000;
    var CONNECT_TIMEOUT = 30000;
    var UPLOAD_TIMEOUT = 60000;
    var SUBMIT_TIMEOUT = 60000;
    var HISTORY_TIMEOUT = 15000;
    var VIEW_TIMEOUT = 120000;
    var INTERRUPT_TIMEOUT = 8000;
    var PROGRESS_MIN = 5;
    var PROGRESS_MAX = 95;
    var UPLOAD_FILENAME = 'dream-ai-input.png';
    var DEFAULT_MIME = 'image/png';
    var MAX_REASON = 400;

    var DEFAULTS = {
        endpointMode: 'local',
        localUrl: DEFAULT_BASE_URL,
        cloudUrl: '',
        apiToken: '',
        timeout: 3600,
        workflowJson: '',
        workflowName: '',
        prompt: ''
    };

    /** 没有 Store（纯算法测试环境）时的内存兜底，避免 loadConfig 直接抛错 */
    var memory = null;

    /* ============================================================
     * 基础工具
     * ============================================================ */

    function t(key, params) {
        return DreamAI.I18n ? DreamAI.I18n.t(key, params) : key;
    }

    function hasOwn(object, name) {
        return !!object && Object.prototype.hasOwnProperty.call(object, name);
    }

    function text(value) {
        return value === undefined || value === null ? '' : String(value);
    }

    /**
     * 构造已本地化的错误。localized 标记让上层知道 message 已经是文案，
     * 不再二次包装（与 src/providers/registry.js 的约定一致）。
     */
    function makeError(key, params, meta) {
        var error = new Error(t(key, params));
        error.localized = true;
        error.key = key;
        if (util.isPlainObject(meta)) {
            for (var name in meta) {
                if (hasOwn(meta, name)) error[name] = meta[name];
            }
        }
        return error;
    }

    /** 写一条引擎日志；日志失败绝不影响主流程 */
    function log(ctx, level, message, meta) {
        if (!ctx || typeof ctx.log !== 'function') return;
        try {
            ctx.log(level, message, meta);
        } catch (error) { /* 忽略 */ }
    }

    /** 上报进度；detail 供状态条直接显示（已本地化） */
    function progress(ctx, percent, detail) {
        if (!ctx || typeof ctx.onProgress !== 'function') return;
        try {
            ctx.onProgress(Math.round(util.clamp(percent, 0, 100, 0)), detail);
        } catch (error) { /* 忽略 */ }
    }

    function isSignal(signal) {
        return !!signal && typeof signal.addEventListener === 'function';
    }

    function aborted(ctx) {
        return !!(ctx && ctx.signal && ctx.signal.aborted === true);
    }

    /* ============================================================
     * 配置读写（engines.comfy）
     * ============================================================ */

    function clampConfigTimeout(value) {
        return Math.round(util.clamp(value, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, DEFAULTS.timeout));
    }

    /** 去掉地址末尾的斜杠；但 'http://' 这种还没写主机的输入保持原样，避免削成 'http:' */
    function normalizeUrlText(value, fallback) {
        var raw = text(value).trim();
        if (!raw) return fallback === undefined ? '' : fallback;
        return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\/]+/.test(raw) ? raw.replace(/\/+$/, '') : raw;
    }

    /** 归一化配置：合并默认值 + 类型与范围钳制 */
    function normalizeConfig(raw) {
        var merged = util.deepMerge(DEFAULTS, util.isPlainObject(raw) ? raw : {});
        merged.endpointMode = merged.endpointMode === 'cloud' ? 'cloud' : 'local';
        merged.localUrl = normalizeUrlText(merged.localUrl, DEFAULT_BASE_URL);
        merged.cloudUrl = normalizeUrlText(merged.cloudUrl);
        merged.apiToken = text(merged.apiToken).trim();
        merged.timeout = clampConfigTimeout(merged.timeout);
        merged.workflowJson = typeof merged.workflowJson === 'string' ? merged.workflowJson : '';
        merged.workflowName = text(merged.workflowName);
        merged.prompt = typeof merged.prompt === 'string' ? merged.prompt : '';
        return merged;
    }

    function readDomain() {
        if (DreamAI.Store) return DreamAI.Store.read(STORE_DOMAIN, DEFAULTS);
        return util.deepClone(memory || DEFAULTS);
    }

    function writeDomain(patch) {
        if (DreamAI.Store) return DreamAI.Store.write(STORE_DOMAIN, patch, DEFAULTS);
        memory = util.deepMerge(readDomain(), util.isPlainObject(patch) ? patch : {});
        return memory;
    }

    /** 读取配置，与 DEFAULTS 深合并后返回（每次都是新对象） */
    function loadConfig() {
        return normalizeConfig(readDomain());
    }

    /** 合并写入配置并返回写入后的完整配置 */
    function saveConfig(patch) {
        var next = normalizeConfig(util.deepMerge(loadConfig(), util.isPlainObject(patch) ? patch : {}));
        writeDomain(next);
        return next;
    }

    /** 恢复默认配置 */
    function resetConfig() {
        var fresh = util.deepClone(DEFAULTS);
        writeDomain(fresh);
        return normalizeConfig(readDomain());
    }

    /* ============================================================
     * 地址与鉴权
     * ============================================================ */

    /** ctx.config 优先（调用方可能已按界面状态构造），否则读 Store */
    function resolveConfig(ctx) {
        if (ctx && util.isPlainObject(ctx.config)) return normalizeConfig(ctx.config);
        return loadConfig();
    }

    function joinUrl(baseUrl, path) {
        var base = text(baseUrl).replace(/\/+$/, '');
        var suffix = text(path);
        if (!suffix) return base;
        if (suffix.charAt(0) !== '/') suffix = '/' + suffix;
        return base + suffix;
    }

    /**
     * 接口根地址：ctx.baseUrl 已由调用方按 endpointMode 选好；
     * 为空时回退到 config 里对应的 URL；仍为空则抛本地化错误。
     */
    function requireBase(ctx, config) {
        var raw = ctx && ctx.baseUrl !== undefined && ctx.baseUrl !== null ? text(ctx.baseUrl) : '';
        if (!raw.trim()) raw = config.endpointMode === 'cloud' ? config.cloudUrl : config.localUrl;
        var base = text(raw).trim().replace(/\/+$/, '');
        if (!base) throw makeError('error.baseUrlRequired');
        return base;
    }

    function endpointOrEmpty(ctx, config) {
        try {
            return requireBase(ctx, config);
        } catch (error) {
            return '';
        }
    }

    /** 有 apiToken 时同时带 Authorization 与 X-API-Key（不同反代认不同的头） */
    function authHeaders(ctx, extra) {
        var headers = {};
        var name;
        if (util.isPlainObject(extra)) {
            for (name in extra) if (hasOwn(extra, name)) headers[name] = extra[name];
        }
        if (!headers.Accept && !headers.accept) headers.Accept = 'application/json';
        var token = text(ctx && ctx.apiToken).trim();
        if (token) {
            var bearer = /^Bearer\s+/i.test(token) ? token : 'Bearer ' + token;
            if (!headers.Authorization && !headers.authorization) headers.Authorization = bearer;
            if (!headers['X-API-Key'] && !headers['x-api-key']) headers['X-API-Key'] = token.replace(/^Bearer\s+/i, '');
        }
        return headers;
    }

    function headerValue(headers, name) {
        if (!util.isPlainObject(headers)) return '';
        var lower = String(name).toLowerCase();
        for (var key in headers) {
            if (hasOwn(headers, key) && key.toLowerCase() === lower) return text(headers[key]);
        }
        return '';
    }

    /* ============================================================
     * 错误归一与请求出口
     * ============================================================ */

    /** 从上游响应体里尽量抠出可读原因 */
    function reasonFromResponse(res) {
        var detail = '';
        if (res && util.isPlainObject(res.data)) {
            detail = (res.data.error && (res.data.error.message || res.data.error)) || res.data.message || '';
        }
        if (typeof detail !== 'string' || !detail) detail = util.truncate(res && res.text, 200);
        return text(detail);
    }

    function upstreamReason(error) {
        if (!error) return '';
        var payload = error.payload;
        if (util.isPlainObject(payload)) {
            var detail = (payload.error && (payload.error.message || payload.error)) ||
                payload.message || payload.detail || payload.reason;
            if (typeof detail === 'string' && detail) return util.truncate(detail, 300);
        }
        if (typeof payload === 'string' && payload) return util.truncate(payload, 300);
        return error.message ? util.truncate(text(error.message), 300) : '';
    }

    function errorFromResponse(res) {
        var status = res && res.status ? res.status : 0;
        var error = new Error(reasonFromResponse(res) || ('HTTP ' + status));
        error.status = status;
        error.payload = res ? res.data : null;
        return error;
    }

    function timeoutSeconds(timeoutMs, ctx) {
        var ms = util.toNumber(timeoutMs, 0);
        if (!(ms > 0)) ms = util.toNumber(ctx && ctx.timeout, 0);
        if (!(ms > 0)) ms = DEFAULT_REQUEST_TIMEOUT;
        return Math.max(1, Math.round(ms / 1000));
    }

    /**
     * 把网络 / HTTP 失败翻译成已本地化错误。
     * 映射：中止 → error.aborted；超时 → error.requestTimeout；
     *       401/403 → error.invalidKey；429 → error.rateLimited；其余 → error.upstreamFailed。
     */
    function translate(error, ctx, timeoutMs) {
        if (error && error.localized) return error;
        if (aborted(ctx)) return makeError('error.aborted');

        var status = util.toNumber(error && error.status, 0);
        var raw = error && error.message ? text(error.message) : text(error);
        var reason = upstreamReason(error) || util.truncate(raw, 200);

        if (error && error.name === 'AbortError' && !status) return makeError('error.aborted');
        if (/timeout after/i.test(raw)) {
            return makeError('error.requestTimeout', { seconds: timeoutSeconds(timeoutMs, ctx) }, { timeout: true });
        }
        if (status === 401 || status === 403) {
            return makeError('error.invalidKey', { status: status, reason: reason }, { status: status, reason: reason });
        }
        if (status === 429) return makeError('error.rateLimited', { status: status }, { status: status });
        return makeError('error.upstreamFailed', { reason: reason }, { status: status, reason: reason });
    }

    /** 有效超时：显式值优先，其次 ctx.timeout，最后默认；再取两者较小值 */
    function effectiveTimeout(ctx, timeoutMs) {
        var limit = util.toNumber(ctx && ctx.timeout, 0);
        var wanted = util.toNumber(timeoutMs, 0);
        if (!(wanted > 0)) wanted = DEFAULT_REQUEST_TIMEOUT;
        return limit > 0 ? Math.min(limit, wanted) : wanted;
    }

    /** 把 ctx.signal 的中止接到任意 Promise 上（util.request 只处理自身超时） */
    function withAbort(promise, ctx) {
        var signal = ctx ? ctx.signal : null;
        if (!isSignal(signal)) return promise;
        if (signal.aborted) {
            Promise.resolve(promise).then(null, function () { /* 已中止，忽略底层失败 */ });
            return Promise.reject(makeError('error.aborted'));
        }
        return new Promise(function (resolve, reject) {
            var settled = false;
            function cleanup() {
                try { signal.removeEventListener('abort', onAbort); } catch (error) { /* 忽略 */ }
            }
            function onAbort() {
                if (settled) return;
                settled = true;
                cleanup();
                reject(makeError('error.aborted'));
            }
            signal.addEventListener('abort', onAbort);
            Promise.resolve(promise).then(function (value) {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            }, function (error) {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            });
        });
    }

    /**
     * 原始请求出口：返回 DreamAI.util.request 的结果（含 status / headers / buffer）。
     * 注意用浅拷贝组装 options：body 可能是 Uint8Array 或 FormData，
     * 走 deepMerge 会被当成普通对象拆开。
     */
    function httpRaw(ctx, url, options, timeoutMs) {
        var source = util.isPlainObject(options) ? options : {};
        var opts = {};
        for (var name in source) if (hasOwn(source, name)) opts[name] = source[name];

        var headers = {};
        var sourceHeaders = util.isPlainObject(source.headers) ? source.headers : {};
        for (var key in sourceHeaders) if (hasOwn(sourceHeaders, key)) headers[key] = sourceHeaders[key];
        if (typeof opts.body === 'string' && !headerValue(headers, 'content-type')) headers['Content-Type'] = 'application/json';
        opts.headers = authHeaders(ctx, headers);
        opts.timeout = effectiveTimeout(ctx, timeoutMs);
        delete opts.statusKeys;

        return withAbort(util.request(url, opts), ctx).catch(function (error) {
            throw translate(error, ctx, opts.timeout);
        });
    }

    /** JSON 请求出口：非 2xx 抛已本地化错误，2xx 返回响应体 */
    function httpJson(ctx, url, options, timeoutMs) {
        return httpRaw(ctx, url, options, timeoutMs).then(function (res) {
            if (!res || !res.ok) throw translate(errorFromResponse(res), ctx, effectiveTimeout(ctx, timeoutMs));
            return res.data !== null && res.data !== undefined ? res.data : res.text;
        });
    }

    /* ============================================================
     * 图像辅助
     * ============================================================ */

    function readBe32(bytes, offset) {
        return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    }

    /** 扫 JPEG 段找 SOF，取宽高 */
    function jpegSize(bytes) {
        var offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xFF) { offset++; continue; }
            var marker = bytes[offset + 1];
            if (marker === 0xFF) { offset++; continue; }
            if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { offset += 2; continue; }
            var length = (bytes[offset + 2] << 8) | bytes[offset + 3];
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                return {
                    height: (bytes[offset + 5] << 8) | bytes[offset + 6],
                    width: (bytes[offset + 7] << 8) | bytes[offset + 8]
                };
            }
            if (length <= 0) break;
            offset += 2 + length;
        }
        return null;
    }

    /** 从字节头解析尺寸（PNG 字节 16..24 大端 / JPEG SOF），解析不出返回 null */
    function imageSizeFromBytes(bytes) {
        if (!bytes || bytes.length < 24) return null;
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
            return { width: readBe32(bytes, 16), height: readBe32(bytes, 20) };
        }
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) return jpegSize(bytes);
        return null;
    }

    function mimeFromResponse(res, filename) {
        var type = text(headerValue(res && res.headers, 'content-type')).split(';')[0].trim().toLowerCase();
        if (type.indexOf('image/') === 0) return type;
        var match = text(filename).match(/\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i);
        if (match) {
            var ext = match[1].toLowerCase();
            if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
            return 'image/' + ext;
        }
        return DEFAULT_MIME;
    }

    /** data URL / 裸 base64 → { mime, base64, bytes }；无法解析返回 null */
    function decodeImage(value) {
        var raw = text(value).trim();
        if (!raw) return null;
        try {
            if (util.isDataUrl(raw)) {
                var parsed = util.parseDataUrl(raw);
                var payload = parsed.payload || '';
                return {
                    mime: parsed.mime || DEFAULT_MIME,
                    base64: payload,
                    bytes: new Uint8Array(util.base64ToArrayBuffer(payload))
                };
            }
            var clean = raw.replace(/\s+/g, '');
            if (clean.length > 32 && /^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
                return {
                    mime: DEFAULT_MIME,
                    base64: clean,
                    bytes: new Uint8Array(util.base64ToArrayBuffer(clean))
                };
            }
        } catch (error) {
            return null;
        }
        return null;
    }

    /** request.images 允许字符串或 { dataUrl | data | base64 } */
    function collectInputImages(images) {
        var list = Array.isArray(images) ? images : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var value = typeof item === 'string'
                ? item
                : (item && (item.dataUrl || item.data || item.base64));
            if (value) out.push(value);
        }
        return out;
    }

    /* ============================================================
     * multipart/form-data
     * UXP 不保证有可用的 FormData/Blob，所以同时实现手工拼装路径。
     * ============================================================ */

    function createBoundary() {
        return '----DreamAIComfyBoundary' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    }

    function utf8Bytes(value) {
        var str = text(value);
        var out = new Uint8Array(str.length * 4);
        var size = 0;
        for (var i = 0; i < str.length; i++) {
            var code = str.charCodeAt(i);
            if (code < 0x80) {
                out[size++] = code;
            } else if (code < 0x800) {
                out[size++] = 0xC0 | (code >> 6);
                out[size++] = 0x80 | (code & 0x3F);
            } else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
                var next = str.charCodeAt(i + 1);
                if (next >= 0xDC00 && next <= 0xDFFF) {
                    var point = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00);
                    out[size++] = 0xF0 | (point >> 18);
                    out[size++] = 0x80 | ((point >> 12) & 0x3F);
                    out[size++] = 0x80 | ((point >> 6) & 0x3F);
                    out[size++] = 0x80 | (point & 0x3F);
                    i++;
                    continue;
                }
                out[size++] = 0xEF; out[size++] = 0xBF; out[size++] = 0xBD;
            } else {
                out[size++] = 0xE0 | (code >> 12);
                out[size++] = 0x80 | ((code >> 6) & 0x3F);
                out[size++] = 0x80 | (code & 0x3F);
            }
        }
        return out.subarray(0, size);
    }

    /** 手工拼接 multipart 字节体：随机 boundary，二进制体直接内联 */
    function encodeMultipart(parts, boundary) {
        var chunks = [];
        var total = 0;
        function push(bytes) {
            chunks.push(bytes);
            total += bytes.length;
        }
        function pushText(str) {
            push(utf8Bytes(str));
        }
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            pushText('--' + boundary + '\r\n');
            var disposition = 'Content-Disposition: form-data; name="' + part.name + '"';
            if (part.bytes) disposition += '; filename="' + (part.filename || part.name) + '"';
            pushText(disposition + '\r\n');
            if (part.bytes) pushText('Content-Type: ' + (part.contentType || DEFAULT_MIME) + '\r\n');
            pushText('\r\n');
            if (part.bytes) push(part.bytes);
            else pushText(text(part.value));
            pushText('\r\n');
        }
        pushText('--' + boundary + '--\r\n');

        var body = new Uint8Array(total);
        var offset = 0;
        for (var j = 0; j < chunks.length; j++) {
            body.set(chunks[j], offset);
            offset += chunks[j].length;
        }
        return body;
    }

    function tryFormData(parts) {
        if (typeof global.FormData !== 'function' || typeof global.Blob !== 'function') return null;
        try {
            var form = new global.FormData();
            for (var i = 0; i < parts.length; i++) {
                var part = parts[i];
                if (part.bytes) form.append(part.name, new global.Blob([part.bytes], { type: part.contentType || DEFAULT_MIME }), part.filename || part.name);
                else form.append(part.name, text(part.value));
            }
            return form;
        } catch (error) {
            return null;
        }
    }

    /**
     * 组装 multipart 请求体。
     * @param {Array} parts 字段列表
     * @param {{preferFormData?: boolean}} [options]
     * @returns {{ body: *, headers: Object, mode: string }} mode = 'formdata' 时不要自己写 Content-Type
     */
    function buildMultipart(parts, options) {
        var opts = options || {};
        if (opts.preferFormData !== false) {
            var form = tryFormData(parts);
            if (form) return { body: form, headers: {}, mode: 'formdata' };
        }
        var boundary = createBoundary();
        return {
            body: encodeMultipart(parts, boundary),
            headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
            mode: 'manual',
            boundary: boundary
        };
    }

    /* ============================================================
     * 工作流解析与参数识别
     * ============================================================ */

    function invalidWorkflow(reason) {
        return { ok: false, nodeCount: 0, reason: reason };
    }

    /** 解析工作流：字符串走 JSON.parse，兼容 { prompt: {...} } 包装；永不抛错 */
    function parseWorkflow(json) {
        var parsed;
        try {
            if (typeof json === 'string') {
                var raw = json.trim();
                if (!raw) return { ok: false, nodeCount: 0, reason: t('engine.workflowEmpty') };
                try {
                    parsed = JSON.parse(raw);
                } catch (error) {
                    return { ok: false, nodeCount: 0, reason: t('engine.workflowInvalid', { reason: error && error.message ? error.message : text(error) }) };
                }
            } else {
                parsed = json;
            }

            if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return { ok: false, nodeCount: 0, reason: t('engine.workflowInvalid', { reason: t('engine.workflowNotObject') }) };
            }
            // 界面格式（ComfyUI 前端导出的完整工程）顶层是 nodes 数组，必须先拦下来
            if (Array.isArray(parsed.nodes)) return { ok: false, nodeCount: 0, reason: t('engine.workflowUiFormat') };
            // 少数导出会包在 { prompt: {...} } 里
            if (util.isPlainObject(parsed.prompt)) parsed = parsed.prompt;

            var ids = Object.keys(parsed);
            if (!ids.length) return { ok: false, nodeCount: 0, reason: t('engine.workflowNoNodes') };
            var count = 0;
            for (var i = 0; i < ids.length; i++) {
                var node = parsed[ids[i]];
                if (!util.isPlainObject(node) || typeof node.class_type !== 'string' || !node.class_type.trim()) {
                    return { ok: false, nodeCount: 0, reason: t('engine.workflowNodeInvalid', { nodeId: ids[i] }) };
                }
                count++;
            }
            if (!count) return { ok: false, nodeCount: 0, reason: t('engine.workflowNoNodes') };
            return { ok: true, nodeCount: count, reason: '', workflow: parsed };
        } catch (error) {
            return { ok: false, nodeCount: 0, reason: t('engine.workflowInvalid', { reason: error && error.message ? error.message : text(error) }) };
        }
    }

    /** 校验工作流结构；同步、永不抛错 */
    function validateWorkflow(json) {
        var result = parseWorkflow(json);
        return { ok: result.ok, nodeCount: result.nodeCount, reason: result.reason };
    }

    /** 节点显示名：优先 _meta.title / title，否则 '<class_type> #<id>' */
    function nodeLabel(node, nodeId, classType) {
        var meta = util.isPlainObject(node && node._meta) ? node._meta : {};
        var title = text(meta.title || (node && node.title)).trim();
        return title || (text(classType) + ' #' + nodeId);
    }

    /** 各类节点可调参数的识别表（按顺序取第一个命中的规则） */
    var PARAM_SPECS = [
        { match: 'cliptextencode', keys: ['text'] },
        { match: 'ksampler', keys: ['seed', 'noise_seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler'] },
        { match: 'emptylatentimage', keys: ['width', 'height', 'batch_size'] },
        { match: 'loadimage', keys: ['image'] }
    ];

    /**
     * 列出工作流里可调的参数。
     * 只返回节点 inputs 里真实存在的键，便于界面直接生成输入控件。
     * @returns {Array<{nodeId: string, classType: string, key: string, label: string, value: *}>}
     */
    function extractParams(workflow) {
        var parsed = workflow;
        try {
            if (typeof workflow === 'string') {
                var check = parseWorkflow(workflow);
                if (!check.ok) return [];
                parsed = check.workflow;
            }
            if (parsed && util.isPlainObject(parsed) && util.isPlainObject(parsed.prompt)) parsed = parsed.prompt;
            if (!util.isPlainObject(parsed)) return [];

            var out = [];
            var ids = Object.keys(parsed);
            for (var i = 0; i < ids.length; i++) {
                var nodeId = ids[i];
                var node = parsed[nodeId];
                if (!util.isPlainObject(node)) continue;
                var classType = text(node.class_type);
                var lower = classType.toLowerCase();
                if (!lower || !util.isPlainObject(node.inputs)) continue;

                var spec = null;
                for (var s = 0; s < PARAM_SPECS.length; s++) {
                    if (lower.indexOf(PARAM_SPECS[s].match) !== -1) { spec = PARAM_SPECS[s]; break; }
                }
                if (!spec) continue;

                var label = nodeLabel(node, nodeId, classType);
                for (var k = 0; k < spec.keys.length; k++) {
                    var key = spec.keys[k];
                    if (!hasOwn(node.inputs, key)) continue;
                    out.push({
                        nodeId: String(nodeId),
                        classType: classType,
                        key: key,
                        label: label,
                        value: node.inputs[key]
                    });
                }
            }
            return out;
        } catch (error) {
            return [];
        }
    }

    /* ============================================================
     * 工作流改写
     * ============================================================ */

    /** 把上传后的文件名写进第一个 LoadImage 节点，并把 class_type 规范化为 LoadImage */
    function injectUploadedImage(workflow, fileName) {
        var ids = Object.keys(workflow);
        for (var i = 0; i < ids.length; i++) {
            var node = workflow[ids[i]];
            if (!util.isPlainObject(node)) continue;
            if (text(node.class_type).toLowerCase().indexOf('loadimage') === -1) continue;
            if (!util.isPlainObject(node.inputs)) node.inputs = {};
            node.inputs.image = fileName;
            node.class_type = 'LoadImage';
            return true;
        }
        return false;
    }

    /** 正向写第一个文本编码节点，负向写第二个 */
    function injectPrompts(workflow, promptText, negativeText, ctx) {
        var ids = Object.keys(workflow);
        var textNodes = [];
        for (var i = 0; i < ids.length; i++) {
            var node = workflow[ids[i]];
            if (!util.isPlainObject(node) || !util.isPlainObject(node.inputs)) continue;
            if (text(node.class_type).toLowerCase().indexOf('cliptextencode') === -1) continue;
            if (typeof node.inputs.text !== 'string') continue;
            textNodes.push({ nodeId: ids[i], node: node });
        }
        if (typeof promptText === 'string' && promptText.length && textNodes[0]) {
            textNodes[0].node.inputs.text = promptText;
            log(ctx, 'info', t('engine.comfyPromptInjected', { nodeId: textNodes[0].nodeId }));
        }
        if (typeof negativeText === 'string' && negativeText.length) {
            if (textNodes[1]) {
                textNodes[1].node.inputs.text = negativeText;
                log(ctx, 'info', t('engine.comfyNegativeInjected', { nodeId: textNodes[1].nodeId }));
            } else if (textNodes.length === 1) {
                log(ctx, 'warn', t('engine.comfyNegativeSkipped'));
            }
        }
    }

    /** params 的键是 "<nodeId>.<key>"，只覆写已存在的键，未知键记 warning */
    function applyParams(workflow, params, ctx) {
        if (!util.isPlainObject(params)) return 0;
        var applied = 0;
        var targets = Object.keys(params);
        for (var i = 0; i < targets.length; i++) {
            var target = targets[i];
            var dot = target.indexOf('.');
            if (dot <= 0 || dot === target.length - 1) {
                log(ctx, 'warn', t('engine.comfyParamUnknown', { target: target }));
                continue;
            }
            var nodeId = target.slice(0, dot);
            var key = target.slice(dot + 1);
            var node = workflow[nodeId];
            if (!util.isPlainObject(node) || !util.isPlainObject(node.inputs) || !hasOwn(node.inputs, key)) {
                log(ctx, 'warn', t('engine.comfyParamUnknown', { target: target }));
                continue;
            }
            node.inputs[key] = params[target];
            applied++;
            log(ctx, 'info', t('engine.comfyParamOverride', { nodeId: nodeId, key: key }));
        }
        return applied;
    }

    /* ============================================================
     * 上传 / 提交 / 轮询 / 下载
     * ============================================================ */

    function uploadImage(ctx, base, image) {
        var decoded = decodeImage(image);
        if (!decoded) {
            return Promise.reject(makeError('error.comfyUploadFailed', { reason: t('engine.imageDecodeFailed') }));
        }
        var parts = [
            { name: 'image', bytes: decoded.bytes, filename: UPLOAD_FILENAME, contentType: decoded.mime || DEFAULT_MIME },
            { name: 'type', value: 'input' },
            { name: 'overwrite', value: 'true' }
        ];
        // 宿主 FormData/Blob 不可靠时（部分 UXP 版本）可以显式要求手工拼装
        var multipart = buildMultipart(parts, { preferFormData: !(ctx && ctx.manualMultipart === true) });
        if (multipart.mode === 'manual') log(ctx, 'debug', t('provider.multipartManual', { parts: parts.length }));

        var url = joinUrl(base, '/upload/image');
        log(ctx, 'debug', t('provider.requesting', { url: url }));
        return httpRaw(ctx, url, { method: 'POST', headers: multipart.headers, body: multipart.body }, UPLOAD_TIMEOUT)
            .then(function (res) {
                // 必须显式判状态：httpRaw 对非 2xx 也会 resolve，
                // 否则带 JSON 错误体的 401 会被当成上传成功，后续拿一个不存在的文件名去跑工作流
                if (!res || !res.ok) {
                    var status = util.toNumber(res && res.status, 0);
                    var reason = reasonFromResponse(res);
                    if (status === 401 || status === 403) {
                        throw makeError('error.invalidKey', { status: status, reason: reason }, { status: status, reason: reason });
                    }
                    if (status === 429) throw makeError('error.rateLimited', { status: status }, { status: status });
                    throw makeError('error.comfyUploadFailed', { reason: reason || ('HTTP ' + status) }, { status: status, reason: reason });
                }
                var data = util.isPlainObject(res.data) ? res.data : null;
                if (!data || !text(data.name).trim()) {
                    throw makeError('error.comfyUploadFailed', { reason: t('error.emptyResponse') });
                }
                var name = text(data.name).trim();
                var subfolder = text(data.subfolder).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
                var fileName = subfolder ? subfolder + '/' + name : name;
                log(ctx, 'success', t('engine.comfyUploaded', { filename: fileName }));
                return fileName;
            });
    }

    /** 汇总 /prompt 的失败原因：error.message 与 node_errors 摘要 */
    function summarizeNodeErrors(nodeErrors) {
        var ids = Object.keys(nodeErrors);
        var out = [];
        for (var i = 0; i < ids.length && out.length < 3; i++) {
            var entry = nodeErrors[ids[i]];
            var list = util.isPlainObject(entry) && Array.isArray(entry.errors) ? entry.errors : (Array.isArray(entry) ? entry : []);
            var texts = [];
            for (var j = 0; j < list.length && texts.length < 2; j++) {
                var item = list[j];
                var message = util.isPlainObject(item) ? (item.message || item.details || '') : text(item);
                if (message) texts.push(text(message));
            }
            out.push('#' + ids[i] + ' ' + (texts.join('; ') || t('engine.comfyNodeErrorUnknown')));
        }
        return out.join(' | ');
    }

    function promptFailureReason(res) {
        var payload = res && res.data;
        var parts = [];
        if (util.isPlainObject(payload)) {
            if (payload.error) {
                var errorText = typeof payload.error === 'string'
                    ? payload.error
                    : text(payload.error.message || payload.error.type || '');
                if (errorText) parts.push(errorText);
            }
            if (util.isPlainObject(payload.node_errors) && Object.keys(payload.node_errors).length) {
                parts.push(summarizeNodeErrors(payload.node_errors));
            }
            if (payload.message) parts.push(text(payload.message));
        }
        if (!parts.length) parts.push(reasonFromResponse(res));
        var joined = [];
        for (var i = 0; i < parts.length; i++) if (parts[i]) joined.push(parts[i]);
        return util.truncate(joined.join(' | '), MAX_REASON);
    }

    function submitFailure(res, ctx) {
        var status = util.toNumber(res && res.status, 0);
        var reason = promptFailureReason(res);
        if (status === 401 || status === 403) {
            return makeError('error.invalidKey', { status: status, reason: reason }, { status: status, reason: reason });
        }
        if (status === 429) return makeError('error.rateLimited', { status: status }, { status: status });
        return makeError('error.comfySubmitFailed', { reason: reason || ('HTTP ' + status) }, { status: status, reason: reason });
    }

    function submit(ctx, base, workflow) {
        var url = joinUrl(base, '/prompt');
        var clientId = 'dream-ai-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        log(ctx, 'info', t('provider.requesting', { url: url }));
        return httpRaw(ctx, url, {
            method: 'POST',
            body: JSON.stringify({ prompt: workflow, client_id: clientId })
        }, SUBMIT_TIMEOUT).then(function (res) {
            if (!res || !res.ok) throw submitFailure(res, ctx);
            var data = util.isPlainObject(res.data) ? res.data : {};
            var promptId = text(data.prompt_id).trim();
            if (!promptId) throw makeError('error.comfySubmitFailed', { reason: t('engine.comfyNoPromptId') });
            log(ctx, 'success', t('engine.comfyQueued', { promptId: promptId }));
            return promptId;
        });
    }

    /** history[promptId].status.status_str === 'error' 时提取原因 */
    function executionError(entry) {
        var status = entry && entry.status;
        if (!util.isPlainObject(status) || status.status_str !== 'error') return '';
        var messages = Array.isArray(status.messages) ? status.messages : [];
        for (var i = messages.length - 1; i >= 0; i--) {
            var payload = Array.isArray(messages[i]) ? messages[i][1] : messages[i];
            if (util.isPlainObject(payload) && (payload.exception_message || payload.message)) {
                return util.truncate(text(payload.exception_message || payload.message), 300);
            }
        }
        return t('engine.comfyFailedUnknown');
    }

    function outputImages(outputs) {
        var ids = util.isPlainObject(outputs) ? Object.keys(outputs) : [];
        var seen = {};
        var out = [];
        for (var i = 0; i < ids.length; i++) {
            var node = outputs[ids[i]];
            if (!util.isPlainObject(node)) continue;
            var keys = ['images', 'gifs'];
            for (var k = 0; k < keys.length; k++) {
                var list = Array.isArray(node[keys[k]]) ? node[keys[k]] : [];
                for (var j = 0; j < list.length; j++) {
                    var info = list[j];
                    if (!util.isPlainObject(info) || !info.filename) continue;
                    var key = text(info.subfolder) + '/' + text(info.filename) + '/' + text(info.type);
                    if (seen[key]) continue;
                    seen[key] = true;
                    out.push({
                        filename: text(info.filename),
                        subfolder: text(info.subfolder),
                        type: text(info.type) || 'output'
                    });
                }
            }
        }
        return out;
    }

    function hasOutputImages(outputs) {
        return outputImages(outputs).length > 0;
    }

    function viewUrl(base, info) {
        return joinUrl(base, '/view') +
            '?filename=' + encodeURIComponent(info.filename) +
            '&subfolder=' + encodeURIComponent(info.subfolder || '') +
            '&type=' + encodeURIComponent(info.type || 'output');
    }

    /** 下载单张输出图；非 2xx 一律当失败（此时 res.buffer 是错误页字节，绝不能当图片用） */
    function fetchOutputImage(ctx, base, info) {
        return httpRaw(ctx, viewUrl(base, info), { method: 'GET', as: 'arrayBuffer' }, VIEW_TIMEOUT)
            .then(function (res) {
                if (!res || !res.ok) {
                    throw makeError('error.upstreamFailed', {
                        reason: reasonFromResponse(res) || ('HTTP ' + (res && res.status))
                    }, { status: res ? res.status : 0 });
                }
                var bytes = res.buffer instanceof Uint8Array ? res.buffer : new Uint8Array(res.buffer);
                var mime = mimeFromResponse(res, info.filename);
                var size = imageSizeFromBytes(bytes);
                log(ctx, 'debug', t('engine.comfyImageDownloaded', { filename: info.filename, bytes: bytes.length }));
                return {
                    dataUrl: util.base64ToDataUrl(util.arrayBufferToBase64(bytes), mime),
                    width: size ? size.width : 0,
                    height: size ? size.height : 0,
                    filename: info.filename
                };
            });
    }

    /**
     * 逐张下载输出图；单张失败只记 warning 并跳过，取消与超时照样往上抛。
     * 失败处理挂在单张下载上（而不是递归调用上），避免把子调用的致命错误吞掉。
     */
    function downloadImages(ctx, base, infos, index, out, total) {
        if (index >= infos.length) return Promise.resolve(out);
        var info = infos[index];
        return fetchOutputImage(ctx, base, info).then(function (image) {
            out.push(image);
            progress(ctx, PROGRESS_MAX + Math.round(((index + 1) / Math.max(1, total)) * (99 - PROGRESS_MAX)));
            return downloadImages(ctx, base, infos, index + 1, out, total);
        }, function (error) {
            var key = error && error.key;
            var fatal = key === 'error.aborted' || key === 'error.requestTimeout' || aborted(ctx);
            if (fatal) throw error;
            log(ctx, 'warn', t('engine.comfyImageSkipped', { filename: info.filename, reason: error && error.message }));
            return downloadImages(ctx, base, infos, index + 1, out, total);
        });
    }

    /** 轮询 /history/{promptId}；进度按已用时间映射到 5..95 */
    function waitForHistory(ctx, base, promptId, pollInterval, pollTimeout, startedAt) {
        var attempt = 0;
        var deadline = startedAt + pollTimeout;

        function attemptOnce() {
            if (aborted(ctx)) return Promise.reject(makeError('error.aborted'));
            if (Date.now() >= deadline) {
                return Promise.reject(makeError(
                    'error.requestTimeout',
                    { seconds: Math.max(1, Math.round(pollTimeout / 1000)) },
                    { timeout: true }
                ));
            }
            attempt++;
            var elapsed = Date.now() - startedAt;
            var seconds = Math.max(0, Math.round(elapsed / 1000));
            var ratio = Math.min(1, elapsed / Math.max(1, pollTimeout));
            progress(ctx, PROGRESS_MIN + ratio * (PROGRESS_MAX - PROGRESS_MIN),
                t('engine.comfyGenerating', { seconds: seconds }));
            log(ctx, 'debug', t('engine.comfyPolling', { attempt: attempt, seconds: seconds }));

            var url = joinUrl(base, '/history/' + encodeURIComponent(promptId));
            return httpJson(ctx, url, { method: 'GET' }, HISTORY_TIMEOUT).then(function (history) {
                var entry = util.isPlainObject(history) && util.isPlainObject(history[promptId]) ? history[promptId] : null;
                var failure = executionError(entry);
                if (failure) throw makeError('error.comfyFailed', { reason: failure }, { reason: failure });
                if (entry && hasOutputImages(entry.outputs)) return { entry: entry, promptId: promptId, attempts: attempt };
                return util.sleep(pollInterval).then(attemptOnce);
            });
        }

        return attemptOnce();
    }

    /* ============================================================
     * 对外接口
     * ============================================================ */

    /** GET /system_stats，返回设备名与系统信息 */
    function testConnection(ctx) {
        var context = ctx || {};
        var config = resolveConfig(context);
        var base;
        try {
            base = requireBase(context, config);
        } catch (error) {
            return Promise.reject(error);
        }
        var url = joinUrl(base, '/system_stats');
        log(context, 'info', t('provider.requesting', { url: url }));
        return httpJson(context, url, { method: 'GET' }, CONNECT_TIMEOUT).then(function (payload) {
            var stats = util.isPlainObject(payload) ? payload : {};
            var devices = Array.isArray(stats.devices) ? stats.devices : [];
            var first = util.isPlainObject(devices[0]) ? devices[0] : {};
            var device = text(first.name || first.type).trim();
            var system = util.isPlainObject(stats.system) ? stats.system : null;
            log(context, 'success', device
                ? t('engine.comfyConnected', { device: device })
                : t('engine.comfyConnectedNoDevice'));
            return { ok: true, device: device, system: system, systemText: describeSystem(system), raw: stats };
        });
    }

    /** 系统信息摘要（纯数据拼接，供状态条展示） */
    function describeSystem(system) {
        if (!util.isPlainObject(system)) return '';
        var parts = [];
        if (system.comfyui_version) parts.push('ComfyUI ' + text(system.comfyui_version));
        if (system.python_version) parts.push('python ' + text(system.python_version).split(' ')[0]);
        if (system.os) parts.push(text(system.os));
        if (util.toNumber(system.ram_total, 0) > 0) parts.push('RAM ' + util.formatBytes(system.ram_total));
        return parts.join(' · ');
    }

    /**
     * 跑一次工作流。
     * @param {Object} ctx { baseUrl, apiToken, timeout(ms, 同时是轮询总预算), pollInterval(ms),
     *                       log, signal, onProgress(percent, detail), config?, manualMultipart? }
     * @param {Object} request { workflow(对象或字符串), prompt, negativePrompt,
     *                           images: [dataUrl], params: { '<nodeId>.<key>': value }, timeout }
     * @returns {Promise<{images: Array, promptId: string, raw: Object}>}
     */
    function run(ctx, request) {
        var context = ctx || {};
        var payload = util.isPlainObject(request) ? request : {};
        var config = resolveConfig(context);

        var base;
        var workflow;
        try {
            base = requireBase(context, config);
            var source = payload.workflow !== undefined && payload.workflow !== null && payload.workflow !== ''
                ? payload.workflow
                : config.workflowJson;
            if (source === undefined || source === null || source === '') {
                return Promise.reject(makeError('error.workflowRequired'));
            }
            var check = parseWorkflow(source);
            if (!check.ok) {
                return Promise.reject(makeError('error.comfyWorkflowInvalid', { reason: check.reason }, { reason: check.reason }));
            }
            workflow = util.deepClone(check.workflow);
        } catch (error) {
            return Promise.reject(error);
        }

        var workflowPrompt = payload.prompt !== undefined ? payload.prompt : config.prompt;
        var negativePrompt = payload.negativePrompt !== undefined ? payload.negativePrompt : '';
        var pollInterval = util.toNumber(context.pollInterval, 0);
        if (!(pollInterval > 0)) pollInterval = DEFAULT_POLL_INTERVAL;
        var pollTimeout = util.toNumber(context.timeout, 0);
        if (!(pollTimeout > 0)) pollTimeout = util.toNumber(payload.timeout, 0);
        if (!(pollTimeout > 0)) pollTimeout = config.timeout * 1000;

        var startedAt = Date.now();
        var inputs = collectInputImages(payload.images);
        progress(context, PROGRESS_MIN);

        var chain = Promise.resolve();
        if (inputs.length) {
            chain = uploadImage(context, base, inputs[0]).then(function (fileName) {
                if (!injectUploadedImage(workflow, fileName)) log(context, 'warn', t('engine.comfyNoLoadImage'));
            });
        }

        return chain.then(function () {
            injectPrompts(workflow, workflowPrompt, negativePrompt, context);
            applyParams(workflow, payload.params, context);
            return submit(context, base, workflow);
        }).then(function (promptId) {
            return waitForHistory(context, base, promptId, pollInterval, pollTimeout, startedAt);
        }).then(function (result) {
            var infos = outputImages(result.entry.outputs);
            if (!infos.length) throw makeError('error.comfyNoImage');
            return downloadImages(context, base, infos, 0, [], infos.length).then(function (images) {
                if (!images.length) throw makeError('error.comfyNoImage');
                progress(context, 100);
                return { images: images, promptId: result.promptId, raw: result.entry };
            });
        }).catch(function (error) {
            var key = error && error.key;
            var isAbort = key === 'error.aborted' || (error && error.name === 'AbortError') || aborted(context);
            if (isAbort) {
                // 取消时必须通知 ComfyUI 停手，否则引擎会继续占着显卡跑完
                interrupt(context);
                throw makeError('error.aborted');
            }
            throw error && error.localized ? error : translate(error, context, pollTimeout);
        });
    }

    /**
     * POST /interrupt：超时 8000ms，失败只记日志。
     * 这里刻意丢掉 ctx.signal —— 取消场景下 signal 已经 abort，
     * 带上它会让中断请求根本发不出去。
     */
    function interrupt(ctx) {
        var context = ctx || {};
        var config = resolveConfig(context);
        var base = endpointOrEmpty(context, config);
        if (!base) {
            log(context, 'warn', t('engine.comfyInterruptFailed', { reason: t('error.baseUrlRequired') }));
            return Promise.resolve();
        }
        var url = joinUrl(base, '/interrupt');
        var quiet = {
            baseUrl: base,
            apiToken: context.apiToken !== undefined ? context.apiToken : config.apiToken,
            timeout: INTERRUPT_TIMEOUT,
            log: context.log
        };
        return httpRaw(quiet, url, { method: 'POST' }, INTERRUPT_TIMEOUT).then(function (res) {
            if (!res || !res.ok) throw translate(errorFromResponse(res), quiet, INTERRUPT_TIMEOUT);
            log(context, 'info', t('engine.comfyInterrupted'));
        }, function (error) {
            log(context, 'warn', t('engine.comfyInterruptFailed', { reason: error && error.message }));
        }).catch(function (error) {
            log(context, 'warn', t('engine.comfyInterruptFailed', { reason: error && error.message }));
        });
    }

    DreamAI.ComfyUI = {
        STORE_DOMAIN: STORE_DOMAIN,
        loadConfig: loadConfig,
        saveConfig: saveConfig,
        resetConfig: resetConfig,
        testConnection: testConnection,
        validateWorkflow: validateWorkflow,
        extractParams: extractParams,
        run: run,
        interrupt: interrupt,
        DEFAULTS: DEFAULTS
    };
})(typeof window !== 'undefined' ? window : this);
