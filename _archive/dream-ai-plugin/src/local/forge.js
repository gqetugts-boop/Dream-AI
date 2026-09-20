/*
 * local/forge.js — 本地 / 云端 Forge（SD WebUI 兼容 API，sdapi/v1）适配
 *
 * 职责：
 *   - 读写 engines.forge 域配置（连接、生成模式、采样参数、LoRA 与 ControlNet 数组）；
 *   - 枚举上游资源：模型 / 采样器 / LoRA / ControlNet 模块与模型；
 *   - 生成链路：归一化参数 → 组装 txt2img / img2img 请求体 → 提交 → 轮询 /progress 上报进度
 *     → 把返回的裸 base64 统一成 data URL；
 *   - 连接测试与中断。
 * 输入：ctx = { baseUrl, apiToken, timeout(毫秒), log, signal, onProgress }，
 *       以及 run() 的 request = { prompt, negativePrompt, mode, images, params, controlNetImages }。
 * 输出：{ images: [{ dataUrl, width, height }] } / [{ id }] / [string] / { modules, models } /
 *       { ok, models, samplers, currentModel } / { percent(0..100), state, stateText }。
 * 边界：不渲染界面、不写 Photoshop 文档；所有网络调用走 DreamAI.util.request，
 *       全部对外文案来自 DreamAI.I18n.t()；纯 ES5，可在没有 Photoshop / UXP 宿主的 Node 下加载。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.Forge) return;

    var util = DreamAI.util;

    var STORE_DOMAIN = 'engines.forge';
    var DEFAULT_BASE_URL = 'http://127.0.0.1:7860';
    var DEFAULT_REQUEST_TIMEOUT = 60000;
    var CONNECT_TIMEOUT = 30000;
    var LIST_TIMEOUT = 30000;
    var PROGRESS_TIMEOUT = 5000;
    var INTERRUPT_TIMEOUT = 8000;
    var RUN_TIMEOUT = 3600000;
    var PROGRESS_INTERVAL = 1000;
    var SIZE_STEP = 8;
    var MIN_SIZE = 64;
    var MAX_SIZE = 4096;
    var MIN_STEPS = 1;
    var MAX_STEPS = 150;
    var MIN_CFG = 1;
    var MAX_CFG = 30;
    var MIN_BATCH = 1;
    var MAX_BATCH = 8;
    var MIN_SEED = -1;
    var MAX_SEED = 2147483647;
    var MIN_WEIGHT = 0;
    var MAX_WEIGHT = 2;
    var DEFAULT_MIME = 'image/png';
    var PROGRESS_MIN_PERCENT = 5;
    var PROGRESS_MAX_PERCENT = 95;
    var MAX_REASON = 400;

    var ENDPOINTS = {
        options: '/sdapi/v1/options',
        models: '/sdapi/v1/sd-models',
        samplers: '/sdapi/v1/samplers',
        loras: '/sdapi/v1/loras',
        controlNetModules: '/controlnet/module_list',
        controlNetModels: '/controlnet/model_list',
        txt2img: '/sdapi/v1/txt2img',
        img2img: '/sdapi/v1/img2img',
        progress: '/sdapi/v1/progress',
        interrupt: '/sdapi/v1/interrupt'
    };

    var DEFAULTS = {
        endpointMode: 'local',
        localUrl: DEFAULT_BASE_URL,
        cloudUrl: '',
        apiToken: '',
        generateMode: 'img2img',
        prompt: '',
        negativePrompt: '',
        model: '',
        sampler: 'Euler a',
        scheduler: '',
        steps: 20,
        cfg: 7,
        denoise: 0.75,
        batch: 1,
        seed: -1,
        width: 1024,
        height: 1024,
        /* 数组而不是单值字段：面板可以动态增删多项 LoRA / ControlNet */
        loras: [],
        controlNets: [],
        presetName: ''
    };

    /** 没有 Store（纯算法测试环境）时的内存兜底 */
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

    function log(ctx, level, message, meta) {
        if (!ctx || typeof ctx.log !== 'function') return;
        try {
            ctx.log(level, message, meta);
        } catch (error) { /* 忽略 */ }
    }

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
     * 配置读写（engines.forge）
     * ============================================================ */

    /** 尺寸必须先向上取整到 8 的倍数，再钳制到 64..4096 */
    function alignSize(value, fallback) {
        var size = util.toNumber(value, fallback);
        if (!(size > 0)) size = fallback;
        size = Math.ceil(size / SIZE_STEP) * SIZE_STEP;
        return Math.round(util.clamp(size, MIN_SIZE, MAX_SIZE, fallback));
    }

    function normalizeLoras(value) {
        var list = Array.isArray(value) ? value : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var name = '';
            var weight = 1;
            if (typeof item === 'string') {
                name = item;
            } else if (util.isPlainObject(item)) {
                name = text(item.name || item.alias);
                weight = util.clamp(item.weight, MIN_WEIGHT, MAX_WEIGHT, 1);
            }
            name = text(name).trim();
            if (!name) continue;
            out.push({ name: name, weight: weight });
        }
        return out;
    }

    function normalizeControlNets(value) {
        var list = Array.isArray(value) ? value : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!util.isPlainObject(item)) continue;
            out.push({
                enabled: item.enabled !== false,
                module: text(item.module),
                model: text(item.model),
                weight: util.clamp(item.weight, MIN_WEIGHT, MAX_WEIGHT, 1),
                image: typeof item.image === 'string' ? item.image : ''
            });
        }
        return out;
    }

    /** 去掉地址末尾的斜杠；但 'http://' 这种还没写主机的输入保持原样，避免削成 'http:' */
    function normalizeUrlText(value, fallback) {
        var raw = text(value).trim();
        if (!raw) return fallback === undefined ? '' : fallback;
        return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\/]+/.test(raw) ? raw.replace(/\/+$/, '') : raw;
    }

    /** 归一化配置：合并默认值 + 类型与范围钳制；数组一律重建，避免 DEFAULTS 被外部改坏 */
    function normalizeConfig(raw) {
        var merged = util.deepMerge(DEFAULTS, util.isPlainObject(raw) ? raw : {});
        merged.endpointMode = merged.endpointMode === 'cloud' ? 'cloud' : 'local';
        merged.localUrl = normalizeUrlText(merged.localUrl, DEFAULT_BASE_URL);
        merged.cloudUrl = normalizeUrlText(merged.cloudUrl);
        merged.apiToken = text(merged.apiToken).trim();
        merged.generateMode = merged.generateMode === 'txt2img' ? 'txt2img' : 'img2img';
        merged.prompt = typeof merged.prompt === 'string' ? merged.prompt : '';
        merged.negativePrompt = typeof merged.negativePrompt === 'string' ? merged.negativePrompt : '';
        merged.model = text(merged.model).trim();
        merged.sampler = text(merged.sampler).trim() || DEFAULTS.sampler;
        merged.scheduler = text(merged.scheduler).trim();
        merged.presetName = text(merged.presetName);
        merged.steps = Math.round(util.clamp(merged.steps, MIN_STEPS, MAX_STEPS, DEFAULTS.steps));
        merged.cfg = util.clamp(merged.cfg, MIN_CFG, MAX_CFG, DEFAULTS.cfg);
        merged.denoise = util.clamp(merged.denoise, 0, 1, DEFAULTS.denoise);
        merged.batch = Math.round(util.clamp(merged.batch, MIN_BATCH, MAX_BATCH, DEFAULTS.batch));
        merged.seed = Math.round(util.clamp(merged.seed, MIN_SEED, MAX_SEED, DEFAULTS.seed));
        merged.width = alignSize(merged.width, DEFAULTS.width);
        merged.height = alignSize(merged.height, DEFAULTS.height);
        merged.loras = normalizeLoras(merged.loras);
        merged.controlNets = normalizeControlNets(merged.controlNets);
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

    function loadConfig() {
        return normalizeConfig(readDomain());
    }

    function saveConfig(patch) {
        var next = normalizeConfig(util.deepMerge(loadConfig(), util.isPlainObject(patch) ? patch : {}));
        writeDomain(next);
        return next;
    }

    function resetConfig() {
        var fresh = util.deepClone(DEFAULTS);
        writeDomain(fresh);
        return normalizeConfig(readDomain());
    }

    /* ============================================================
     * 地址与鉴权
     * ============================================================ */

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

    /** ctx.baseUrl 已由调用方按 endpointMode 选好；为空时回退 config 对应 URL */
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

    function reasonFromResponse(res) {
        var detail = '';
        if (res && util.isPlainObject(res.data)) {
            detail = (res.data.error && (res.data.error.message || res.data.error)) || res.data.message || res.data.detail || '';
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

    function effectiveTimeout(ctx, timeoutMs) {
        var limit = util.toNumber(ctx && ctx.timeout, 0);
        var wanted = util.toNumber(timeoutMs, 0);
        if (!(wanted > 0)) wanted = DEFAULT_REQUEST_TIMEOUT;
        return limit > 0 ? Math.min(limit, wanted) : wanted;
    }

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

    /** 原始请求出口（浅拷贝 options：body 可能是 Uint8Array / FormData，不能被 deepMerge 拆开） */
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

    function imageSizeFromBytes(bytes) {
        if (!bytes || bytes.length < 24) return null;
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
            return { width: readBe32(bytes, 16), height: readBe32(bytes, 20) };
        }
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) return jpegSize(bytes);
        return null;
    }

    /** 只解 base64 头部（约 4KB）就能拿到 PNG/JPEG 尺寸 */
    function sizeFromBase64(base64) {
        var clean = text(base64).replace(/\s+/g, '');
        if (clean.length < 40) return null;
        var head = clean.slice(0, 4096);
        var rest = head.length % 4;
        if (rest) head = head.slice(0, head.length - rest);
        try {
            return imageSizeFromBytes(new Uint8Array(util.base64ToArrayBuffer(head)));
        } catch (error) {
            return null;
        }
    }

    function guessMimeFromBase64(base64) {
        var clean = text(base64);
        if (clean.indexOf('iVBORw0KGgo') === 0) return 'image/png';
        if (clean.indexOf('/9j/') === 0) return 'image/jpeg';
        if (clean.indexOf('R0lGOD') === 0) return 'image/gif';
        if (clean.indexOf('UklGR') === 0) return 'image/webp';
        return DEFAULT_MIME;
    }

    /** 上游返回的裸 base64 → data URL；已经是 data URL 的原样返回 */
    function toDataUrl(value) {
        var raw = text(value).trim();
        if (!raw) return '';
        if (/^data:/i.test(raw)) return raw;
        var clean = raw.replace(/\s+/g, '');
        return util.base64ToDataUrl(clean, guessMimeFromBase64(clean));
    }

    /** 去掉 data: 前缀，只留纯 base64（init_images / controlnet 都要纯 base64） */
    function base64Payload(value) {
        var raw = text(value).trim();
        if (!raw) return '';
        if (util.isDataUrl(raw)) {
            try {
                return util.parseDataUrl(raw).payload || '';
            } catch (error) {
                return raw.replace(/^data:[^,]*,/, '');
            }
        }
        return raw.replace(/\s+/g, '');
    }

    /** request.images 允许字符串或 { dataUrl | data | base64 } */
    function collectImages(images) {
        var list = Array.isArray(images) ? images : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var value = typeof item === 'string' ? item : (item && (item.dataUrl || item.data || item.base64));
            if (value) out.push(value);
        }
        return out;
    }

    /* ============================================================
     * 资源枚举
     * ============================================================ */

    function rowsOf(payload, keys) {
        if (Array.isArray(payload)) return payload;
        if (!util.isPlainObject(payload)) return [];
        for (var i = 0; i < keys.length; i++) {
            if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
        }
        return [];
    }

    /** GET /sdapi/v1/sd-models → [{ id }]，id 取 title || model_name || name */
    function listModels(ctx) {
        var context = ctx || {};
        var config = resolveConfig(context);
        var base;
        try {
            base = requireBase(context, config);
        } catch (error) {
            return Promise.reject(error);
        }
        var url = joinUrl(base, ENDPOINTS.models);
        log(context, 'debug', t('provider.requesting', { url: url }));
        return httpJson(context, url, { method: 'GET' }, LIST_TIMEOUT).then(function (payload) {
            var rows = rowsOf(payload, ['models']);
            var out = [];
            var seen = {};
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                var id = typeof row === 'string' ? row : (row && (row.title || row.model_name || row.name));
                id = text(id).trim();
                if (!id || seen[id]) continue;
                seen[id] = true;
                out.push({ id: id });
            }
            log(context, 'debug', t('provider.modelsLoaded', { count: out.length }));
            return out;
        });
    }

    /** GET /sdapi/v1/samplers → [string] */
    function listSamplers(ctx) {
        var context = ctx || {};
        var config = resolveConfig(context);
        var base;
        try {
            base = requireBase(context, config);
        } catch (error) {
            return Promise.reject(error);
        }
        var url = joinUrl(base, ENDPOINTS.samplers);
        return httpJson(context, url, { method: 'GET' }, LIST_TIMEOUT).then(function (payload) {
            var rows = rowsOf(payload, ['samplers']);
            var out = [];
            var seen = {};
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                var name = typeof row === 'string' ? row : (row && row.name);
                name = text(name).trim();
                if (!name || seen[name]) continue;
                seen[name] = true;
                out.push(name);
            }
            return out;
        });
    }

    /** GET /sdapi/v1/loras → [{ name, alias }]；端点缺失时返回 []，不抛错 */
    function listLoras(ctx) {
        var context = ctx || {};
        var config = resolveConfig(context);
        var base = endpointOrEmpty(context, config);
        if (!base) return Promise.resolve([]);
        var url = joinUrl(base, ENDPOINTS.loras);
        return httpJson(context, url, { method: 'GET' }, LIST_TIMEOUT).then(function (payload) {
            var rows = rowsOf(payload, ['loras']);
            var out = [];
            var seen = {};
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                if (typeof row === 'string') {
                    if (!row.trim()) continue;
                    row = { name: row, alias: row };
                }
                if (!util.isPlainObject(row)) continue;
                var name = text(row.name || row.alias).trim();
                if (!name || seen[name]) continue;
                seen[name] = true;
                out.push({ name: name, alias: text(row.alias || row.name).trim() || name });
            }
            return out;
        }, function (error) {
            log(context, 'debug', t('engine.forgeLoraSkipped', { reason: error && error.message }));
            return [];
        });
    }

    /** GET /controlnet/module_list + /controlnet/model_list；任一侧失败都退化为空数组 */
    function listControlNets(ctx) {
        var context = ctx || {};
        var config = resolveConfig(context);
        var base = endpointOrEmpty(context, config);
        if (!base) return Promise.resolve({ modules: [], models: [] });

        function fetchList(path, keys, label) {
            var url = joinUrl(base, path);
            return httpJson(context, url, { method: 'GET' }, LIST_TIMEOUT).then(function (payload) {
                var rows = rowsOf(payload, keys);
                var out = [];
                for (var i = 0; i < rows.length; i++) {
                    var name = typeof rows[i] === 'string' ? rows[i] : (rows[i] && (rows[i].name || rows[i].model_name));
                    name = text(name).trim();
                    if (name) out.push(name);
                }
                return out;
            }, function (error) {
                log(context, 'debug', t('engine.forgeControlNetSkipped', { reason: error && error.message }));
                return [];
            });
        }

        return Promise.all([
            fetchList(ENDPOINTS.controlNetModules, ['module_list', 'modules'], 'module_list'),
            fetchList(ENDPOINTS.controlNetModels, ['model_list', 'models'], 'model_list')
        ]).then(function (result) {
            return { modules: result[0], models: result[1] };
        });
    }

    /**
     * 连接测试：并行读取 options / 模型 / 采样器。
     * options 失败视为连接失败（reject 已本地化错误）；模型与采样器失败只降级为空数组。
     */
    function testConnection(ctx) {
        var context = ctx || {};
        var config = resolveConfig(context);
        var base;
        try {
            base = requireBase(context, config);
        } catch (error) {
            return Promise.reject(error);
        }
        var url = joinUrl(base, ENDPOINTS.options);
        log(context, 'info', t('provider.requesting', { url: url }));

        var options = httpJson(context, url, { method: 'GET' }, CONNECT_TIMEOUT);
        var models = listModels(context).then(function (list) { return list; }, function () { return []; });
        var samplers = listSamplers(context).then(function (list) { return list; }, function () { return []; });

        return Promise.all([options, models, samplers]).then(function (result) {
            var payload = util.isPlainObject(result[0]) ? result[0] : {};
            var currentModel = text(payload.sd_model_checkpoint).trim();
            log(context, 'success', t('engine.forgeConnected', {
                model: currentModel || t('engine.forgeModelAuto'),
                count: result[1].length
            }));
            return {
                ok: true,
                models: result[1],
                samplers: result[2],
                currentModel: currentModel,
                raw: payload
            };
        });
    }

    /* ============================================================
     * 生成
     * ============================================================ */

    /** LoRA 以 " <lora:name:weight>" 追加到正向提示词末尾 */
    function promptWithLoras(prompt, loras) {
        var out = text(prompt);
        var list = Array.isArray(loras) ? loras : [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!util.isPlainObject(item)) continue;
            var name = text(item.name).trim();
            if (!name) continue;
            var weight = util.toNumber(item.weight, 1);
            out += ' <lora:' + name + ':' + weight + '>';
        }
        return out;
    }

    /** ControlNet 参数：图片优先取 request.controlNetImages，其次取配置里内嵌的 image */
    function buildControlNetArgs(config, extraImages, ctx) {
        var list = Array.isArray(config.controlNets) ? config.controlNets : [];
        var extras = collectImages(extraImages);
        var args = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!util.isPlainObject(item) || item.enabled === false) continue;
            var source = extras.length > i ? extras[i] : text(item.image);
            if (!source) {
                log(ctx, 'warn', t('engine.forgeControlNetImageMissing', { index: i + 1 }));
                continue;
            }
            args.push({
                enabled: true,
                image: base64Payload(source),
                module: text(item.module) || 'none',
                model: text(item.model) || 'None',
                weight: util.toNumber(item.weight, 1)
            });
        }
        return args;
    }

    function modeLabel(mode) {
        return mode === 'txt2img' ? t('engine.forgeTxt2img') : t('engine.forgeImg2img');
    }

    function humanSeconds(startedAt) {
        return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    }

    /**
     * 跑一次生成。
     * @param {Object} ctx { baseUrl, apiToken, timeout, log, signal, onProgress, config? }
     * @param {Object} request { prompt, negativePrompt, mode: 'txt2img'|'img2img',
     *                           images: [dataUrl], params: {...覆盖config...}, controlNetImages: [dataUrl] }
     * @returns {Promise<{images: Array<{dataUrl, width, height}>, raw: Object}>}
     */
    function run(ctx, request) {
        var context = ctx || {};
        var payload = util.isPlainObject(request) ? request : {};
        var baseConfig = resolveConfig(context);
        // params 逐项覆盖 config，再统一走一遍钳制
        var config = normalizeConfig(util.isPlainObject(payload.params)
            ? util.deepMerge(baseConfig, payload.params)
            : baseConfig);

        var base;
        try {
            base = requireBase(context, config);
        } catch (error) {
            return Promise.reject(error);
        }

        var mode = payload.mode === 'txt2img' || payload.mode === 'img2img' ? payload.mode : config.generateMode;
        var prompt = text(payload.prompt !== undefined ? payload.prompt : config.prompt);
        if (!prompt.trim() && !promptWithLoras('', config.loras).trim()) {
            return Promise.reject(makeError('ws.needPrompt'));
        }
        var negativePrompt = text(payload.negativePrompt !== undefined ? payload.negativePrompt : config.negativePrompt);
        var initImages = collectImages(payload.images);
        if (mode === 'img2img' && !initImages.length) {
            return Promise.reject(makeError('error.forgeImageRequired'));
        }

        var body = {
            prompt: promptWithLoras(prompt, config.loras),
            negative_prompt: negativePrompt,
            seed: config.seed,
            sampler_name: config.sampler || DEFAULTS.sampler,
            steps: config.steps,
            cfg_scale: config.cfg,
            width: config.width,
            height: config.height,
            batch_size: config.batch,
            n_iter: 1
        };
        if (config.scheduler) body.scheduler = config.scheduler;
        if (config.model) {
            body.override_settings = { sd_model_checkpoint: config.model };
            body.override_settings_restore_afterwards = true;
        }
        if (mode === 'img2img') {
            body.denoising_strength = config.denoise;
            body.init_images = [base64Payload(initImages[0])];
        }
        var cnArgs = buildControlNetArgs(config, payload.controlNetImages, context);
        if (cnArgs.length) body.alwayson_scripts = { controlnet: { args: cnArgs } };

        var url = joinUrl(base, mode === 'txt2img' ? ENDPOINTS.txt2img : ENDPOINTS.img2img);
        var startedAt = Date.now();
        log(context, 'info', t('provider.requesting', { url: url }));
        log(context, 'info', t('engine.forgeSubmitted', {
            mode: modeLabel(mode),
            width: config.width,
            height: config.height,
            steps: config.steps,
            batch: config.batch
        }));
        progress(context, PROGRESS_MIN_PERCENT);

        // /progress 轮询：每 1000ms 一次，请求本身失败时静默跳过，不打断生成
        var timer = null;
        var inflight = false;
        if (typeof setInterval === 'function') {
            timer = setInterval(function () {
                if (inflight) return;
                inflight = true;
                progress_(context).then(function (state) {
                    inflight = false;
                    if (!state || !(state.percent >= 0)) return;
                    progress(context, Math.max(PROGRESS_MIN_PERCENT, Math.min(PROGRESS_MAX_PERCENT, state.percent)),
                        t('engine.forgeGenerating', { percent: state.percent, seconds: humanSeconds(startedAt) }));
                }, function () {
                    inflight = false;
                });
            }, PROGRESS_INTERVAL);
        }
        function stopTimer() {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        }

        // 生成请求固定按 1 小时超时：本地 SD 出高分辨率图常常超过默认的请求超时，
        // 所以这里显式构造一个只用于本次请求的 ctx（保留 signal 以便随时取消）。
        var requestCtx = {
            baseUrl: base,
            apiToken: context.apiToken !== undefined ? context.apiToken : config.apiToken,
            timeout: RUN_TIMEOUT,
            log: context.log,
            signal: context.signal,
            onProgress: context.onProgress
        };
        var pending = httpRaw(requestCtx, url, { method: 'POST', body: JSON.stringify(body) }, RUN_TIMEOUT);

        return pending.then(function (res) {
            stopTimer();
            if (!res || !res.ok) throw translate(errorFromResponse(res), context, RUN_TIMEOUT);
            var data = util.isPlainObject(res.data) ? res.data : {};
            var raw = Array.isArray(data.images) ? data.images : [];
            if (!raw.length) throw makeError('error.emptyResponse');
            var images = [];
            for (var i = 0; i < raw.length; i++) {
                var dataUrl = toDataUrl(raw[i]);
                if (!dataUrl) continue;
                var size = sizeFromBase64(raw[i]);
                images.push({
                    dataUrl: dataUrl,
                    width: size ? size.width : config.width,
                    height: size ? size.height : config.height
                });
            }
            if (!images.length) throw makeError('error.emptyResponse');
            progress(context, 100);
            return { images: images, raw: data };
        }, function (error) {
            stopTimer();
            throw error;
        }).catch(function (error) {
            var key = error && error.key;
            var isAbort = key === 'error.aborted' || (error && error.name === 'AbortError') || aborted(context);
            if (isAbort) {
                // 取消时通知上游停手，否则显卡会继续跑完整张图
                interrupt(context);
                throw makeError('error.aborted');
            }
            throw error && error.localized ? error : translate(error, context, RUN_TIMEOUT);
        });
    }

    /* ============================================================
     * 进度与中断
     * ============================================================ */

    function describeState(state) {
        if (typeof state === 'string') return state;
        if (!util.isPlainObject(state)) return '';
        var step = util.toNumber(state.sampling_step, 0);
        var total = util.toNumber(state.sampling_steps, 0);
        if (total > 0) return Math.round(step) + '/' + Math.round(total);
        if (util.toNumber(state.job_count, 0) > 0) return String(Math.round(util.toNumber(state.job_count, 0)));
        return '';
    }

    /**
     * GET /sdapi/v1/progress（超时 5000ms）。
     * 轮询期间网络抖动不该打断任务：任何失败都返回 { percent: -1, state: null }。
     * percent 归一化到 0..100（上游 progress 是 0..1），便于直接喂给 onProgress。
     */
    function progress_(ctx) {
        var context = ctx || {};
        var config = resolveConfig(context);
        var base = endpointOrEmpty(context, config);
        if (!base) return Promise.resolve({ percent: -1, state: null, stateText: '', raw: null });
        var url = joinUrl(base, ENDPOINTS.progress);
        return httpJson(context, url, { method: 'GET' }, PROGRESS_TIMEOUT).then(function (payload) {
            var data = util.isPlainObject(payload) ? payload : {};
            var ratio = util.toNumber(data.progress, 0);
            var state = data.state === undefined ? null : data.state;
            return {
                percent: Math.round(util.clamp(ratio * 100, 0, 100, 0)),
                state: state,
                stateText: describeState(state),
                raw: data
            };
        }, function (error) {
            log(context, 'debug', t('engine.forgeProgressSkipped', { reason: error && error.message }));
            return { percent: -1, state: null, stateText: '', raw: null };
        });
    }

    /**
     * POST /sdapi/v1/interrupt：超时 8000ms，失败只记日志。
     * 刻意丢掉 ctx.signal —— 取消场景下 signal 已 abort，带上它中断请求根本发不出去。
     */
    function interrupt(ctx) {
        var context = ctx || {};
        var config = resolveConfig(context);
        var base = endpointOrEmpty(context, config);
        if (!base) {
            log(context, 'warn', t('engine.forgeInterruptFailed', { reason: t('error.baseUrlRequired') }));
            return Promise.resolve();
        }
        var url = joinUrl(base, ENDPOINTS.interrupt);
        var quiet = {
            baseUrl: base,
            apiToken: context.apiToken !== undefined ? context.apiToken : config.apiToken,
            timeout: INTERRUPT_TIMEOUT,
            log: context.log
        };
        return httpRaw(quiet, url, { method: 'POST' }, INTERRUPT_TIMEOUT).then(function (res) {
            if (!res || !res.ok) throw translate(errorFromResponse(res), quiet, INTERRUPT_TIMEOUT);
            log(context, 'info', t('engine.forgeInterrupted'));
        }, function (error) {
            log(context, 'warn', t('engine.forgeInterruptFailed', { reason: error && error.message }));
        }).catch(function (error) {
            log(context, 'warn', t('engine.forgeInterruptFailed', { reason: error && error.message }));
        });
    }

    DreamAI.Forge = {
        STORE_DOMAIN: STORE_DOMAIN,
        loadConfig: loadConfig,
        saveConfig: saveConfig,
        resetConfig: resetConfig,
        testConnection: testConnection,
        listModels: listModels,
        listSamplers: listSamplers,
        listLoras: listLoras,
        listControlNets: listControlNets,
        run: run,
        progress: progress_,
        interrupt: interrupt,
        DEFAULTS: DEFAULTS
    };
})(typeof window !== 'undefined' ? window : this);
