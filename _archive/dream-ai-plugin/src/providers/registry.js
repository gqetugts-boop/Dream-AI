/*
 * providers/registry.js — 服务渠道注册表与共用请求工具
 *
 * 职责：
 *   - 维护 provider 描述符注册表（register / get / list / pick），供 UI 与任务队列挑选渠道；
 *   - 依据 settings.channels[id] + settings.behavior 构造统一 ctx（见 INTERNALS.md 第 2 节）；
 *   - 提供所有 provider 共用的能力：baseUrl 规范化、鉴权头、统一请求出口（含错误归一）、
 *     上游响应图片解析（b64 / url / data URL）、multipart 组装、进度回调。
 * 输入：provider 描述符、settings 域数据、ctx 覆盖项、上游响应体。
 * 输出：描述符、ctx、统一的 { images } 结果、message 已本地化的 Error。
 * 边界：不实现任何具体渠道的协议；不访问 Photoshop 文档；不写设置；
 *       本文件为纯 ES5，可在没有 Photoshop 宿主的 Node 下加载。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.Providers) return;

    var util = DreamAI.util;

    var DEFAULT_TIMEOUT = 300000;
    var DEFAULT_POLL_INTERVAL = 3000;
    var DEFAULT_ORDER = 100;
    var DEFAULT_IMAGE_MIME = 'image/png';
    var MAX_IMAGE_COUNT = 10;
    var MAX_PARSE_DEPTH = 4;

    /** @type {Array} 注册顺序保留；对外读取一律走 list()（按 order/id 排序） */
    var descriptors = [];
    /** @type {Object<string,Object>} id → 描述符 */
    var byId = {};

    /* ============================================================
     * 基础工具
     * ============================================================ */

    function t(key, params) {
        return DreamAI.I18n ? DreamAI.I18n.t(key, params) : key;
    }

    /**
     * 构造已本地化的错误。localized 标记让 mapError 不再二次包装。
     * @param {string} key i18n 键
     * @param {Object} [params] 插值参数
     * @param {Object} [meta] 附加到 Error 上的机器可读字段（status / reason / url 等）
     */
    function makeError(key, params, meta) {
        var error = new Error(t(key, params));
        error.localized = true;
        error.key = key;
        if (meta && util.isPlainObject(meta)) {
            for (var name in meta) {
                if (Object.prototype.hasOwnProperty.call(meta, name)) error[name] = meta[name];
            }
        }
        return error;
    }

    function normalizeLevel(level) {
        var name = String(level == null ? '' : level).toLowerCase();
        if (name === 'debug' || name === 'success' || name === 'warn' || name === 'error') return name;
        return 'info';
    }

    /** 写一条渠道日志（转发 DreamAI.logbus，域固定为 providerId） */
    function log(ctx, level, message, meta) {
        if (!ctx || typeof ctx.log !== 'function') return;
        try {
            ctx.log(level, message, meta);
        } catch (error) {
            /* 日志失败不允许影响主流程 */
        }
    }

    /** 上报进度百分比；provider 只有确知百分比时才调用 */
    function progress(ctx, percent) {
        if (!ctx || typeof ctx.onProgress !== 'function') return;
        try {
            ctx.onProgress(Math.round(util.clamp(percent, 0, 100, 0)));
        } catch (error) {
            /* 进度回调失败不允许影响主流程 */
        }
    }

    /* ============================================================
     * URL 与鉴权
     * ============================================================ */

    /**
     * 规范化接口根地址。
     * @param {string} baseUrl
     * @param {{requireV1?: boolean}} [options] requireV1 为真时补上 /v1，
     *        否则去掉末尾的 /v1（由 provider 自行决定是否需要 /v1 前缀）。
     * @returns {string} 去掉末尾斜杠的地址；空输入返回空串
     */
    function normalizeBaseUrl(baseUrl, options) {
        var opts = options || {};
        var text = String(baseUrl == null ? '' : baseUrl).trim();
        text = text.replace(/\/+$/, '');
        if (!text) return '';
        var hasV1 = /\/v1$/i.test(text);
        if (opts.requireV1) {
            if (!hasV1) text = text + '/v1';
        } else if (hasV1) {
            text = text.replace(/\/v1$/i, '');
        }
        return text;
    }

    /** 拼接接口路径，避免出现重复或缺失的斜杠 */
    function joinUrl(baseUrl, path) {
        var base = String(baseUrl == null ? '' : baseUrl).replace(/\/+$/, '');
        var suffix = String(path == null ? '' : path);
        if (!suffix) return base;
        if (suffix.charAt(0) !== '/') suffix = '/' + suffix;
        return base + suffix;
    }

    /**
     * 生成鉴权头。没有 apiKey 时两个头都不带（自建网关可能完全免鉴权）。
     * 同时带 Authorization 与 X-API-Key：不同兼容层认不同的头。
     */
    function authHeaders(apiKey, extra) {
        var headers = {};
        var name;
        if (extra && util.isPlainObject(extra)) {
            for (name in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, name)) headers[name] = extra[name];
            }
        }
        if (!headers.Accept && !headers.accept) headers.Accept = 'application/json';
        var key = String(apiKey == null ? '' : apiKey).trim();
        if (key) {
            if (!headers.Authorization && !headers.authorization) headers.Authorization = 'Bearer ' + key;
            if (!headers['X-API-Key'] && !headers['x-api-key']) headers['X-API-Key'] = key;
        }
        return headers;
    }

    /* ============================================================
     * 中止与错误归一
     * ============================================================ */

    function isSignal(signal) {
        return !!signal && typeof signal.addEventListener === 'function';
    }

    /**
     * 把 ctx.signal 的中止接到任意 Promise 上。
     * 注意：DreamAI.util.request 内部自建 AbortController（只负责超时），
     * 不接受外部 signal，所以这里用竞速的方式让等待方立刻拿到 error.aborted。
     */
    function withAbort(promise, ctx) {
        var signal = ctx ? ctx.signal : null;
        if (!isSignal(signal)) return promise;
        if (signal.aborted) {
            // 调用方已经用 ctx.fetchJson 发起了请求，这里必须挂一个"哑"处理器，
            // 否则底层请求后续的失败会变成 unhandledRejection。
            Promise.resolve(promise).then(null, function () { /* 已中止，忽略 */ });
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

    /** 从上游响应体或 Error 上尽量抠出可读的原因文案 */
    function upstreamMessage(error) {
        if (!error) return '';
        var payload = error.payload;
        if (util.isPlainObject(payload)) {
            var detail = (payload.error && (payload.error.message || payload.error)) ||
                payload.message || payload.detail || payload.reason;
            if (typeof detail === 'string' && detail) return util.truncate(detail, 300);
        }
        if (typeof payload === 'string' && payload) return util.truncate(payload, 300);
        return error.message ? util.truncate(String(error.message), 300) : '';
    }

    /**
     * 把任意网络/HTTP 失败翻译成已本地化的 Error。
     * 映射规则（全渠道统一）：
     *   中止 → error.aborted；超时 → error.requestTimeout；
     *   401/403 → error.invalidKey；429 → error.rateLimited；
     *   5xx 与网络层失败 → error.upstreamFailed（附上游文案）；其余 4xx → error.upstreamFailed。
     * @param {Error} error
     * @param {{signal?: Object, status?: number, timeout?: number,
     *          statusKeys?: Object<number,string>}} [options]
     */
    function mapError(error, options) {
        var opts = options || {};
        if (error && error.localized) return error;

        var signal = opts.signal;
        if (signal && signal.aborted) return makeError('error.aborted');

        var raw = error && error.message ? String(error.message) : String(error == null ? '' : error);
        var status = opts.status;
        if (status === undefined || status === null) status = error && error.status;
        status = util.toNumber(status, 0);
        var reason = upstreamMessage(error) || util.truncate(raw, 200) || t('error.upstreamFailed', { reason: '' });

        if (error && error.name === 'AbortError' && !status) return makeError('error.aborted');
        if (/timeout after/i.test(raw)) {
            var ms = util.toNumber(opts.timeout, 0);
            return makeError('error.requestTimeout', { seconds: Math.max(1, Math.round((ms || DEFAULT_TIMEOUT) / 1000)) },
                { status: 0, timeout: true });
        }
        if (status === 401 || status === 403) {
            var authKey = opts.statusKeys && opts.statusKeys[status] ? opts.statusKeys[status] : 'error.invalidKey';
            return makeError(authKey, { status: status, reason: reason }, { status: status, reason: reason });
        }
        if (status === 429) {
            return makeError('error.rateLimited', { status: status }, { status: status });
        }
        return makeError('error.upstreamFailed', { reason: reason }, { status: status, reason: reason, raw: error });
    }

    /** 把一条非 2xx 的原始响应整理成带 status/payload 的 Error，交给 mapError 翻译 */
    function errorFromResponse(res) {
        var status = res && res.status ? res.status : 0;
        var detail = '';
        if (res && util.isPlainObject(res.data)) {
            detail = (res.data.error && (res.data.error.message || res.data.error)) || res.data.message || '';
        }
        if (typeof detail !== 'string' || !detail) detail = util.truncate(res && res.text, 200);
        var error = new Error(detail || ('HTTP ' + status));
        error.status = status;
        error.payload = res ? res.data : null;
        return error;
    }

    /* ============================================================
     * 请求出口：所有 provider 的网络调用都必须走这两个函数
     * ============================================================ */

    function requestOptions(ctx, options) {
        var opts = util.deepMerge({}, util.isPlainObject(options) ? options : {});
        if (!(util.toNumber(opts.timeout, 0) > 0)) opts.timeout = ctx.timeout;
        return opts;
    }

    /**
     * 发 JSON 请求并直接拿响应体；失败时抛已本地化的 Error。
     * 鉴权头由 ctx.fetchJson 注入。
     */
    function sendJson(ctx, url, options) {
        var opts = requestOptions(ctx, options);
        return withAbort(ctx.fetchJson(url, opts), ctx).catch(function (error) {
            throw mapError(error, {
                signal: ctx.signal,
                status: error && error.status,
                timeout: ctx.timeout,
                statusKeys: opts.statusKeys
            });
        });
    }

    /**
     * 发原始请求（需要状态码 / 二进制体时用，例如 multipart 上传与下载图片）；
     * 非 2xx 同样抛已本地化的 Error。
     */
    function sendRaw(ctx, url, options) {
        var opts = requestOptions(ctx, options);
        var statusKeys = opts.statusKeys;
        delete opts.statusKeys;
        opts.headers = authHeaders(ctx.apiKey, opts.headers);
        return withAbort(util.request(url, opts), ctx).then(function (res) {
            if (!res || !res.ok) {
                throw mapError(errorFromResponse(res), { signal: ctx.signal, timeout: ctx.timeout, statusKeys: statusKeys });
            }
            return res;
        }, function (error) {
            throw mapError(error, { signal: ctx.signal, timeout: ctx.timeout, statusKeys: statusKeys });
        });
    }

    /* ============================================================
     * 尺寸 / 数量
     * ============================================================ */

    /** '1024x1024' / '1024*1024' / { width, height } → { width, height } | null */
    function parseSize(size) {
        if (util.isPlainObject(size)) {
            var w = util.toNumber(size.width, 0);
            var h = util.toNumber(size.height, 0);
            if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
            return null;
        }
        var match = String(size == null ? '' : size).match(/^\s*(\d+)\s*[x*×]\s*(\d+)\s*$/i);
        if (!match) return null;
        return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
    }

    /** 统一成上游惯用的 'widthxheight' 字符串 */
    function formatSize(size, fallback) {
        var parsed = parseSize(size);
        if (parsed) return parsed.width + 'x' + parsed.height;
        var text = String(size == null ? '' : size).trim();
        if (text) return text;
        return fallback === undefined ? '' : fallback;
    }

    function imageCount(count, max) {
        var limit = util.toNumber(max, MAX_IMAGE_COUNT);
        return Math.round(util.clamp(count, 1, limit > 0 ? limit : MAX_IMAGE_COUNT, 1));
    }

    /** 从 base64 头部解析 PNG/JPEG/GIF 像素尺寸（不做完整解码） */
    function imageSizeFromBase64(base64) {
        var head = String(base64 == null ? '' : base64).replace(/\s+/g, '');
        if (head.length < 32) return null;
        var bytes;
        try {
            // 取 4 的整数倍长度，避免 base64 截断失败
            bytes = new Uint8Array(util.base64ToArrayBuffer(head.slice(0, 4092)));
        } catch (error) {
            return null;
        }
        if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
            return { width: readBe32(bytes, 16), height: readBe32(bytes, 20) };
        }
        if (bytes.length > 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) return jpegSize(bytes);
        if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
            return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
        }
        return null;
    }

    function readBe32(bytes, offset) {
        return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    }

    /** 在 JPEG 段里找 SOF，取宽高 */
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

    /* ============================================================
     * 上游响应 → data URL 图片
     * ============================================================ */

    function isHttpUrl(value) {
        return /^https?:\/\//i.test(String(value == null ? '' : value));
    }

    function isAbsolutePathUrl(value) {
        return /^\/[^\/]/.test(String(value == null ? '' : value));
    }

    function isBase64Image(value) {
        var text = String(value == null ? '' : value).replace(/\s+/g, '');
        if (text.length < 32) return false;
        return /^[A-Za-z0-9+/]+={0,2}$/.test(text);
    }

    /** 把任意字符串归类成 dataUrl / url / base64；无法归类返回 null */
    function classifyImageString(value) {
        var text = String(value == null ? '' : value).trim();
        if (!text) return null;
        if (util.isDataUrl(text)) return { kind: 'dataUrl', value: text };
        if (isHttpUrl(text) || isAbsolutePathUrl(text)) return { kind: 'url', value: text };
        if (isBase64Image(text)) return { kind: 'base64', value: text.replace(/\s+/g, '') };
        return null;
    }

    var BASE64_KEYS = ['b64_json', 'b64Json', 'b64', 'base64', 'image_base64', 'imageBase64', 'image_b64', 'imageB64'];
    var URL_KEYS = ['url', 'image_url', 'imageUrl', 'image', 'src', 'uri', 'link'];
    var ARRAY_KEYS = ['data', 'images', 'output', 'outputs', 'result', 'results', 'artifacts', 'samples', 'image_urls', 'imageUrls'];

    /**
     * 宽容地从上游响应体里收集图片条目。
     * 覆盖：{ data: [{ b64_json }] } / { data: [{ url }] } / { images: [base64] } /
     *       { images: [{ url }] } / 裸 base64 文本 / 裸 data URL / { output: [...] }。
     * @returns {Array<{kind:string, value:string}>}
     */
    function collectImages(payload, out, depth, seen) {
        var list = out || [];
        var seenMap = seen || {};
        var level = util.toNumber(depth, 0);
        if (payload === undefined || payload === null || level > MAX_PARSE_DEPTH) return list;

        if (Array.isArray(payload)) {
            for (var i = 0; i < payload.length; i++) collectImages(payload[i], list, level + 1, seenMap);
            return list;
        }
        if (typeof payload === 'string') {
            pushEntry(list, seenMap, classifyImageString(payload));
            return list;
        }
        if (!util.isPlainObject(payload)) return list;

        var k;
        for (k = 0; k < BASE64_KEYS.length; k++) {
            var b64 = payload[BASE64_KEYS[k]];
            if (typeof b64 === 'string' && isBase64Image(b64)) {
                pushEntry(list, seenMap, { kind: 'base64', value: b64.replace(/\s+/g, '') });
            }
        }
        for (k = 0; k < URL_KEYS.length; k++) {
            var url = payload[URL_KEYS[k]];
            if (typeof url === 'string') {
                if (util.isDataUrl(url)) pushEntry(list, seenMap, { kind: 'dataUrl', value: url });
                else if (isHttpUrl(url) || isAbsolutePathUrl(url)) pushEntry(list, seenMap, { kind: 'url', value: url });
            }
        }
        for (k = 0; k < ARRAY_KEYS.length; k++) {
            var nested = payload[ARRAY_KEYS[k]];
            if (nested === undefined || nested === null) continue;
            if (Array.isArray(nested) || util.isPlainObject(nested) || typeof nested === 'string') {
                collectImages(nested, list, level + 1, seenMap);
            }
        }
        return list;
    }

    function pushEntry(list, seen, entry) {
        if (!entry) return;
        var key = entry.kind + '|' + String(entry.value).slice(0, 160);
        if (seen[key]) return;
        seen[key] = true;
        list.push(entry);
    }

    function guessMimeFromBase64(base64) {
        var text = String(base64 || '');
        if (text.indexOf('iVBORw0KGgo') === 0) return 'image/png';
        if (text.indexOf('/9j/') === 0) return 'image/jpeg';
        if (text.indexOf('R0lGOD') === 0) return 'image/gif';
        if (text.indexOf('UklGR') === 0) return 'image/webp';
        if (text.indexOf('Qk') === 0) return 'image/bmp';
        if (text.indexOf('PHN2Zy') === 0 || text.indexOf('PD94bWw') === 0) return 'image/svg+xml';
        return DEFAULT_IMAGE_MIME;
    }

    function mimeFromHeaders(headers, url) {
        var type = '';
        if (headers) type = String(headers['content-type'] || headers['Content-Type'] || '');
        type = type.split(';')[0].trim().toLowerCase();
        if (type && type.indexOf('image/') === 0) return type;
        var match = String(url || '').match(/\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i);
        if (match) {
            var ext = match[1].toLowerCase();
            if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
            if (ext === 'svg') return 'image/svg+xml';
            return 'image/' + ext;
        }
        return DEFAULT_IMAGE_MIME;
    }

    /** 取根地址的 origin，用于把响应里的相对路径补全 */
    function resolveRelativeUrl(baseUrl, path) {
        var match = String(baseUrl || '').match(/^https?:\/\/[^\/]+/i);
        var origin = match ? match[0] : '';
        var suffix = String(path || '');
        if (!origin || !suffix) return suffix || '';
        return origin + (suffix.charAt(0) === '/' ? suffix : '/' + suffix);
    }

    /* ---------- UTF-8 与字节还原 ---------- */

    /**
     * 手写 UTF-8 编码（UXP 的 TextEncoder 不保证存在）。
     * @param {string} text
     * @param {boolean} strict 遇到孤立代理项时返回 null，而不是写入 U+FFFD
     */
    function encodeUtf8(text, strict) {
        var value = String(text == null ? '' : text);
        var out = new Uint8Array(value.length * 4);
        var size = 0;
        for (var i = 0; i < value.length; i++) {
            var code = value.charCodeAt(i);
            if (code < 0x80) {
                out[size++] = code;
            } else if (code < 0x800) {
                out[size++] = 0xC0 | (code >> 6);
                out[size++] = 0x80 | (code & 0x3F);
            } else if (code >= 0xD800 && code <= 0xDBFF) {
                var next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
                if (next >= 0xDC00 && next <= 0xDFFF) {
                    var point = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00);
                    out[size++] = 0xF0 | (point >> 18);
                    out[size++] = 0x80 | ((point >> 12) & 0x3F);
                    out[size++] = 0x80 | ((point >> 6) & 0x3F);
                    out[size++] = 0x80 | (point & 0x3F);
                    i++;
                } else if (strict) {
                    return null;
                } else {
                    out[size++] = 0xEF; out[size++] = 0xBF; out[size++] = 0xBD;
                }
            } else if (code >= 0xDC00 && code <= 0xDFFF) {
                if (strict) return null;
                out[size++] = 0xEF; out[size++] = 0xBF; out[size++] = 0xBD;
            } else {
                out[size++] = 0xE0 | (code >> 12);
                out[size++] = 0x80 | ((code >> 6) & 0x3F);
                out[size++] = 0x80 | (code & 0x3F);
            }
        }
        return out.subarray(0, size);
    }

    function looksLikeImageBytes(bytes) {
        if (!bytes || bytes.length < 12) return false;
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true;
        if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return true;
        if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
        if (bytes[0] === 0x42 && bytes[1] === 0x4D) return true;
        if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return true;
        if (bytes[0] === 0x3C && (bytes[1] === 0x73 || bytes[1] === 0x3F)) return true;
        return false;
    }

    /**
     * 把响应文本还原成原始字节。
     * DreamAI.util.request 只回传 response.text()，二进制体经 UTF-8 解码后
     * 只有「没有出现替换字符」时才能无损还原；否则返回 null，由调用方降级。
     */
    function bytesFromText(text) {
        var value = String(text == null ? '' : text);
        if (!value) return null;
        if (value.indexOf('\uFFFD') !== -1) return null;
        var bytes = encodeUtf8(value, true);
        if (!bytes || !looksLikeImageBytes(bytes)) return null;
        return bytes;
    }

    /**
     * 下载远端图片并转成 data URL。
     * 任何失败都不抛错，而是按约定降级为 { dataUrl: 原链接, remoteUrl }，
     * 让上层自行决定是否继续（例如直接把链接交给浏览器）。
     */
    function fetchRemoteImage(ctx, url, options) {
        var opts = options || {};
        var target = String(url || '');
        if (!isHttpUrl(target)) target = resolveRelativeUrl(ctx.baseUrl, target);
        var fallback = { dataUrl: target, remoteUrl: target, width: null, height: null, meta: { remoteUrl: target } };
        if (!isHttpUrl(target)) return Promise.resolve(fallback);

        var level = util.toNumber(opts.depth, 0);
        return withAbort(util.request(target, { method: 'GET', timeout: ctx.timeout }), ctx).then(function (res) {
            if (!res || !res.ok) {
                log(ctx, 'warn', t('provider.remoteFallback'), { url: target, status: res ? res.status : 0 });
                return fallback;
            }
            // 有的网关把 base64 包在 JSON 里，先试着走一遍解析
            if (util.isPlainObject(res.data) && level < MAX_PARSE_DEPTH) {
                var nested = collectImages(res.data, [], 0, {});
                if (nested.length) {
                    return resolveEntry(ctx, nested[0], { depth: level + 1, mime: opts.mime });
                }
            }
            var bytes = bytesFromText(res.text);
            if (!bytes) {
                log(ctx, 'warn', t('provider.remoteFallback'), { url: target, status: res.status });
                return fallback;
            }
            var base64 = util.arrayBufferToBase64(bytes);
            var size = imageSizeFromBase64(base64);
            log(ctx, 'debug', t('provider.remoteImage'), { url: target, bytes: bytes.length });
            return {
                dataUrl: util.base64ToDataUrl(base64, mimeFromHeaders(res.headers, target)),
                width: size ? size.width : null,
                height: size ? size.height : null
            };
        }, function (error) {
            log(ctx, 'warn', t('provider.remoteFallback'), { url: target, reason: error && error.message });
            return fallback;
        });
    }

    /** 单条图片条目 → { dataUrl, width, height, remoteUrl? } */
    function resolveEntry(ctx, entry, options) {
        var opts = options || {};
        if (!entry) return Promise.resolve(null);
        if (entry.kind === 'dataUrl') {
            var sizeFromDataUrl = null;
            try {
                sizeFromDataUrl = imageSizeFromBase64(util.dataUrlToBase64(entry.value));
            } catch (error) { sizeFromDataUrl = null; }
            return Promise.resolve({
                dataUrl: entry.value,
                width: sizeFromDataUrl ? sizeFromDataUrl.width : null,
                height: sizeFromDataUrl ? sizeFromDataUrl.height : null
            });
        }
        if (entry.kind === 'base64') {
            var size = imageSizeFromBase64(entry.value);
            return Promise.resolve({
                dataUrl: util.base64ToDataUrl(entry.value, opts.mime || guessMimeFromBase64(entry.value)),
                width: size ? size.width : null,
                height: size ? size.height : null
            });
        }
        return fetchRemoteImage(ctx, entry.value, opts);
    }

    /**
     * 上游响应 → 统一图片列表。URL 结果会被下载并转成 data URL。
     * @returns {Promise<{images: Array, remoteUrls: Array<string>}>}
     */
    function resolveImages(ctx, payload, options) {
        var entries = collectImages(payload, [], 0, {});
        var tasks = [];
        for (var i = 0; i < entries.length; i++) {
            tasks.push(resolveEntry(ctx, entries[i], options));
        }
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

    /**
     * 把解析结果整理成对外契约形状（INTERNALS.md 第 2 节）：
     * { images: [{ dataUrl, width, height, seed? }], raw, meta }。
     * 尺寸优先取图片自身头部，其次回退到请求里指定的尺寸。
     * @throws {Error} error.noImage（响应里没有可用图片）
     */
    function buildImageResult(ctx, raw, parsed, request) {
        var items = parsed && Array.isArray(parsed.images) ? parsed.images : [];
        if (!items.length) throw makeError('error.noImage', null, { raw: raw });
        var fallback = parseSize(request && request.size);
        var seed = findSeed(raw);
        var images = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var image = { dataUrl: item.dataUrl };
            var width = item.width || (fallback ? fallback.width : 0);
            var height = item.height || (fallback ? fallback.height : 0);
            if (width) image.width = width;
            if (height) image.height = height;
            if (seed !== null && seed !== undefined) image.seed = seed;
            if (item.remoteUrl) {
                image.remoteUrl = item.remoteUrl;
                image.meta = { remoteUrl: item.remoteUrl };
            }
            images.push(image);
        }
        var meta = {};
        if (parsed && Array.isArray(parsed.remoteUrls) && parsed.remoteUrls.length) meta.remoteUrls = parsed.remoteUrls;
        if (seed !== null && seed !== undefined) meta.seed = seed;
        progress(ctx, 100);
        return { images: images, raw: raw, meta: meta };
    }

    /** 从响应体里找数值型 seed（部分渠道会回传） */
    function findSeed(payload) {
        if (!util.isPlainObject(payload)) return null;
        var keys = ['seed', 'Seed', 'random_seed'];
        for (var i = 0; i < keys.length; i++) {
            var value = payload[keys[i]];
            if (typeof value === 'number' && isFinite(value)) return value;
            if (typeof value === 'string' && value.trim() && isFinite(Number(value))) return Number(value);
        }
        if (util.isPlainObject(payload.data)) return findSeed(payload.data);
        if (Array.isArray(payload.data) && payload.data.length) return findSeed(payload.data[0]);
        return null;
    }

    /* ============================================================
     * multipart/form-data 组装
     * UXP 不保证有 FormData/Blob，因此同时实现两条路径。
     * ============================================================ */

    function createBoundary() {
        return '----DreamAIFormBoundary' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    }

    function extFromMime(mime) {
        var type = String(mime || '').toLowerCase();
        if (type.indexOf('jpeg') !== -1 || type.indexOf('jpg') !== -1) return 'jpg';
        if (type.indexOf('webp') !== -1) return 'webp';
        if (type.indexOf('gif') !== -1) return 'gif';
        return 'png';
    }

    /** data URL / 裸 base64 → { mime, base64, bytes } */
    function imageBytesFrom(image) {
        var value = typeof image === 'string'
            ? image
            : (image && (image.dataUrl || image.data || image.base64));
        if (!value) return null;
        var text = String(value).trim();
        try {
            if (util.isDataUrl(text)) {
                var parsed = util.parseDataUrl(text);
                var payload = parsed.payload || '';
                return {
                    mime: parsed.mime || DEFAULT_IMAGE_MIME,
                    base64: payload,
                    bytes: new Uint8Array(util.base64ToArrayBuffer(payload))
                };
            }
            var clean = text.replace(/\s+/g, '');
            if (isBase64Image(clean)) {
                return {
                    mime: guessMimeFromBase64(clean),
                    base64: clean,
                    bytes: new Uint8Array(util.base64ToArrayBuffer(clean))
                };
            }
        } catch (error) {
            return null;
        }
        return null;
    }

    function tryFormData(parts) {
        if (typeof global.FormData !== 'function' || typeof global.Blob !== 'function') return null;
        try {
            var form = new global.FormData();
            for (var i = 0; i < parts.length; i++) {
                var part = parts[i];
                if (part.bytes) {
                    var type = part.contentType || DEFAULT_IMAGE_MIME;
                    var name = part.filename || (part.name + '.' + extFromMime(type));
                    form.append(part.name, new global.Blob([part.bytes], { type: type }), name);
                } else {
                    form.append(part.name, part.value === undefined || part.value === null ? '' : String(part.value));
                }
            }
            return form;
        } catch (error) {
            return null;
        }
    }

    /** 手工拼接 multipart 字节体（没有 FormData 的宿主走这条路） */
    function encodeMultipart(parts, boundary) {
        var chunks = [];
        var total = 0;
        function write(text) {
            var bytes = encodeUtf8(text, false);
            chunks.push(bytes);
            total += bytes.length;
        }
        function writeBytes(bytes) {
            chunks.push(bytes);
            total += bytes.length;
        }
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            write('--' + boundary + '\r\n');
            var disposition = 'Content-Disposition: form-data; name="' + part.name + '"';
            if (part.bytes) disposition += '; filename="' + (part.filename || (part.name + '.' + extFromMime(part.contentType))) + '"';
            write(disposition + '\r\n');
            if (part.bytes) write('Content-Type: ' + (part.contentType || DEFAULT_IMAGE_MIME) + '\r\n');
            write('\r\n');
            if (part.bytes) writeBytes(part.bytes);
            else write(String(part.value === undefined || part.value === null ? '' : part.value));
            write('\r\n');
        }
        write('--' + boundary + '--\r\n');
        var body = new Uint8Array(total);
        var offset = 0;
        for (var j = 0; j < chunks.length; j++) {
            body.set(chunks[j], offset);
            offset += chunks[j].length;
        }
        return body;
    }

    /**
     * 组装 multipart 请求体。
     * @param {Array<{name:string, value?:*, bytes?:Uint8Array, filename?:string, contentType?:string}>} parts
     * @param {{preferFormData?: boolean}} [options]
     * @returns {{body:*, headers:Object, mode:string}}
     *          mode = 'formdata' 时不要手工设置 Content-Type（浏览器要自己写 boundary）
     */
    function buildMultipart(parts, options) {
        var opts = options || {};
        var list = parts || [];
        if (opts.preferFormData !== false) {
            var form = tryFormData(list);
            if (form) return { body: form, headers: {}, mode: 'formdata' };
        }
        var boundary = createBoundary();
        return {
            body: encodeMultipart(list, boundary),
            headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
            mode: 'manual',
            boundary: boundary
        };
    }

    /* ============================================================
     * 注册表
     * ============================================================ */

    var REQUIRED_FIELDS = ['id', 'labelKey'];
    var OPTIONAL_METHODS = ['listModels', 'edit', 'chat', 'checkBalance', 'test', 'buildRequest'];

    /**
     * 注册一个服务渠道。
     * @param {Object} descriptor 见 docs/INTERNALS.md 第 2 节
     * @returns {Object} 规范化后的描述符
     * @throws {Error} 描述符非法（字段缺失 / 方法不是函数）
     */
    function register(descriptor) {
        if (!util.isPlainObject(descriptor)) {
            throw makeError('error.descriptorInvalid', { field: 'descriptor' });
        }
        for (var i = 0; i < REQUIRED_FIELDS.length; i++) {
            var field = REQUIRED_FIELDS[i];
            if (typeof descriptor[field] !== 'string' || !descriptor[field].trim()) {
                throw makeError('error.descriptorInvalid', { field: field });
            }
        }
        if (typeof descriptor.generate !== 'function') {
            throw makeError('error.descriptorInvalid', { field: 'generate' });
        }
        for (var j = 0; j < OPTIONAL_METHODS.length; j++) {
            var method = OPTIONAL_METHODS[j];
            if (descriptor[method] !== undefined && descriptor[method] !== null && typeof descriptor[method] !== 'function') {
                throw makeError('error.descriptorInvalid', { field: method });
            }
        }

        var supports = util.isPlainObject(descriptor.supports) ? descriptor.supports : {};
        var id = descriptor.id.trim();
        var normalized = {
            id: id,
            labelKey: descriptor.labelKey,
            order: util.toNumber(descriptor.order, DEFAULT_ORDER),
            needsKey: descriptor.needsKey !== false,
            defaultBaseUrl: String(descriptor.defaultBaseUrl || ''),
            defaultModel: String(descriptor.defaultModel || ''),
            defaultChatModel: String(descriptor.defaultChatModel || ''),
            supports: {
                txt2img: !!supports.txt2img,
                img2img: !!supports.img2img,
                edit: !!supports.edit,
                models: !!supports.models,
                chat: !!supports.chat,
                balance: !!supports.balance
            },
            generate: descriptor.generate,
            listModels: descriptor.listModels,
            edit: descriptor.edit,
            chat: descriptor.chat,
            checkBalance: descriptor.checkBalance,
            test: descriptor.test,
            /** 原始描述符：宿主适配等场景可按需覆盖（例如自定义 batchPlay 描述符） */
            source: descriptor
        };

        if (byId[id]) {
            // 同一文件被重复加载时替换而不是重复登记
            for (var k = 0; k < descriptors.length; k++) {
                if (descriptors[k].id === id) { descriptors[k] = normalized; break; }
            }
        } else {
            descriptors.push(normalized);
        }
        // 渠道自定义的额外方法（例如 native 的 isAvailable / detectSupport）也一并挂到描述符上，
        // 但绝不覆盖上面已经规范化的字段
        for (var extra in descriptor) {
            if (!Object.prototype.hasOwnProperty.call(descriptor, extra)) continue;
            if (normalized[extra] === undefined && typeof descriptor[extra] === 'function') {
                normalized[extra] = descriptor[extra];
            }
        }
        byId[id] = normalized;
        return normalized;
    }

    function get(id) {
        if (id === undefined || id === null) return null;
        return byId[String(id)] || null;
    }

    /** 按 order 升序、order 相同时按 id 排序 */
    function list() {
        return descriptors.slice().sort(function (a, b) {
            if (a.order !== b.order) return a.order - b.order;
            if (a.id === b.id) return 0;
            return a.id < b.id ? -1 : 1;
        });
    }

    /** 取渠道；id 未命中时回退到排序后的第一个渠道 */
    function pick(id) {
        var found = get(id);
        if (found) return found;
        var all = list();
        if (all.length) return all[0];
        throw makeError('error.noProvider');
    }

    /* ============================================================
     * ctx 构造
     * ============================================================ */

    function readSettings() {
        if (DreamAI.App && util.isPlainObject(DreamAI.App.settings)) return DreamAI.App.settings;
        if (DreamAI.Store && typeof DreamAI.Store.read === 'function') {
            var stored = DreamAI.Store.read('settings');
            if (util.isPlainObject(stored)) return stored;
        }
        return {};
    }

    /**
     * 构造 provider 运行上下文（INTERNALS.md 第 2 节）。
     * @param {string} providerId
     * @param {Object} [overrides] 覆盖 baseUrl / apiKey / modelId / timeout / pollInterval /
     *        signal / onProgress，其余字段原样透传到 ctx.overrides
     * @returns {Object} ctx
     */
    function createContext(providerId, overrides) {
        var opts = util.isPlainObject(overrides) ? overrides : {};
        var descriptor = pick(providerId);
        var settings = readSettings();
        var channels = util.isPlainObject(settings.channels) ? settings.channels : {};
        var channel = util.isPlainObject(channels[descriptor.id]) ? channels[descriptor.id] : {};
        var behavior = util.isPlainObject(settings.behavior) ? settings.behavior : {};

        var rawBase = opts.baseUrl !== undefined ? opts.baseUrl : channel.baseUrl;
        // 只有"从来没配过地址"时才回退到描述符默认值；用户/调用方显式清空则按缺失处理
        if (rawBase === undefined || rawBase === null) rawBase = descriptor.defaultBaseUrl;
        var baseUrl = normalizeBaseUrl(rawBase);
        if (!baseUrl && descriptor.needsKey !== false) {
            // 纯 Photoshop 原生渠道不需要接口地址，其余渠道缺地址直接报错
            throw makeError('error.baseUrlRequired', null, { providerId: descriptor.id });
        }

        var apiKey = String((opts.apiKey !== undefined ? opts.apiKey : channel.apiKey) || '').trim();
        var modelId = String(opts.modelId !== undefined ? opts.modelId : (channel.model || descriptor.defaultModel || '')).trim();
        var chatModel = String(opts.chatModel !== undefined
            ? opts.chatModel
            : (channel.chatModel || descriptor.defaultChatModel || modelId)).trim();

        var timeout = util.toNumber(opts.timeout, 0);
        if (!(timeout > 0)) timeout = util.toNumber(behavior.requestTimeout, DEFAULT_TIMEOUT);
        var pollInterval = util.toNumber(opts.pollInterval, 0);
        if (!(pollInterval > 0)) pollInterval = util.toNumber(behavior.pollInterval, DEFAULT_POLL_INTERVAL);

        var ctx = {
            providerId: descriptor.id,
            descriptor: descriptor,
            baseUrl: baseUrl,
            apiKey: apiKey,
            modelId: modelId,
            chatModel: chatModel,
            timeout: timeout,
            pollInterval: pollInterval,
            needsKey: descriptor.needsKey,
            supports: descriptor.supports,
            channel: channel,
            settings: settings,
            behavior: behavior,
            signal: opts.signal || null,
            onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
            overrides: opts
        };

        /** 日志出口：转发 DreamAI.logbus，域固定为渠道 id */
        ctx.log = function (level, message, meta) {
            var bus = DreamAI.logbus;
            if (!bus) return;
            var payload = util.isPlainObject(meta) ? util.deepMerge({}, meta) : (meta ? { extra: meta } : {});
            payload.domain = descriptor.id;
            var name = normalizeLevel(level);
            var fn = typeof bus[name] === 'function' ? bus[name] : bus.info;
            fn.call(bus, message, payload);
        };

        /** JSON 请求出口：自动带鉴权头、默认超时 */
        ctx.fetchJson = function (url, options) {
            var requestOpts = util.deepMerge({}, util.isPlainObject(options) ? options : {});
            var headers = util.isPlainObject(requestOpts.headers) ? requestOpts.headers : {};
            if (typeof requestOpts.body === 'string' && !headers['Content-Type'] && !headers['content-type']) {
                headers['Content-Type'] = 'application/json';
            }
            requestOpts.headers = authHeaders(apiKey, headers);
            if (!(util.toNumber(requestOpts.timeout, 0) > 0)) requestOpts.timeout = timeout;
            delete requestOpts.statusKeys;
            return util.requestJson(url, requestOpts);
        };

        return ctx;
    }

    DreamAI.Providers = {
        /* 注册表 */
        register: register,
        get: get,
        list: list,
        pick: pick,
        createContext: createContext,
        /* URL 与鉴权 */
        normalizeBaseUrl: normalizeBaseUrl,
        joinUrl: joinUrl,
        authHeaders: authHeaders,
        resolveRelativeUrl: resolveRelativeUrl,
        /* 请求出口与错误 */
        sendJson: sendJson,
        sendRaw: sendRaw,
        withAbort: withAbort,
        mapError: mapError,
        makeError: makeError,
        errorFromResponse: errorFromResponse,
        /* 响应解析 */
        collectImages: collectImages,
        resolveImages: resolveImages,
        resolveEntry: resolveEntry,
        fetchRemoteImage: fetchRemoteImage,
        classifyImageString: classifyImageString,
        imageSizeFromBase64: imageSizeFromBase64,
        guessMimeFromBase64: guessMimeFromBase64,
        findSeed: findSeed,
        /* 尺寸与 multipart */
        parseSize: parseSize,
        formatSize: formatSize,
        imageCount: imageCount,
        imageBytesFrom: imageBytesFrom,
        buildMultipart: buildMultipart,
        extFromMime: extFromMime,
        buildImageResult: buildImageResult,
        /* 杂项 */
        progress: progress,
        log: log,
        t: t,
        DEFAULT_TIMEOUT: DEFAULT_TIMEOUT,
        DEFAULT_POLL_INTERVAL: DEFAULT_POLL_INTERVAL,
        DEFAULT_IMAGE_MIME: DEFAULT_IMAGE_MIME
    };
})(typeof window !== 'undefined' ? window : this);
