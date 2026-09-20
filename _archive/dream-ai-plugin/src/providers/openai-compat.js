/*
 * providers/openai-compat.js — OpenAI 兼容渠道
 *
 * 职责：实现 OpenAI 官方及其兼容网关（NewAPI / one-api / 各类自建代理）的
 *       /models、/images/generations、/images/edits、/chat/completions、余额查询。
 * 输入：registry.createContext() 产出的 ctx，以及统一的 request 对象（见 INTERNALS.md 第 2 节）。
 * 输出：{ images: [{ dataUrl, width, height, seed? }], raw, meta } / { text, raw } / [{ id }]。
 * 边界：不做提示词改写、不写 Photoshop 文档、不缓存结果；所有网络调用走 DreamAI.util.request，
 *       文件为纯 ES5，可在没有 Photoshop 宿主的 Node 下加载。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var P = DreamAI.Providers;
    // registry.js 必须排在前面（index.html 脚本顺序保证）；重复加载本文件时直接退出
    if (!P || P.get('openai')) return;

    var util = DreamAI.util;

    var DEFAULT_MODEL = 'gpt-image-1';
    var DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
    var RESPONSE_FORMAT = 'b64_json';
    var MAX_IMAGES = 10;

    function t(key, params) {
        return DreamAI.I18n ? DreamAI.I18n.t(key, params) : key;
    }

    function hasOwn(object, name) {
        return Object.prototype.hasOwnProperty.call(object, name);
    }

    /** 接口根地址：兼容层约定必须带 /v1 */
    function apiBase(ctx) {
        return P.normalizeBaseUrl(ctx.baseUrl, { requireV1: true });
    }

    function requestImages(request) {
        var list = request && Array.isArray(request.images) ? request.images : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && (list[i].dataUrl || list[i].data || list[i].base64)) out.push(list[i]);
        }
        return out;
    }

    /** 组装请求体；withResponseFormat 为假时不发送 response_format（部分网关不认） */
    function buildBody(ctx, request, prompt, withResponseFormat) {
        var body = {
            model: String(ctx.modelId || DEFAULT_MODEL).trim(),
            prompt: prompt,
            n: P.imageCount(request.count, MAX_IMAGES),
            size: P.formatSize(request.size, 'auto')
        };
        if (request.quality !== undefined && request.quality !== null && request.quality !== '') body.quality = request.quality;
        if (request.style !== undefined && request.style !== null && request.style !== '') body.style = request.style;
        if (withResponseFormat) body.response_format = RESPONSE_FORMAT;
        if (request.seed !== undefined && request.seed !== null && request.seed !== '') body.seed = request.seed;
        var extra = util.isPlainObject(request.extra) ? request.extra : {};
        for (var name in extra) {
            if (hasOwn(extra, name) && body[name] === undefined) body[name] = extra[name];
        }
        return body;
    }

    /** 上游响应 → 对外契约结果（尺寸/seed/远端链接的回退逻辑由 registry 统一处理） */
    function finalize(ctx, raw, parsed, request) {
        return P.buildImageResult(ctx, raw, parsed, request);
    }

    /* ============================================================
     * 模型列表
     * ============================================================ */

    function listModels(ctx) {
        var url = P.joinUrl(apiBase(ctx), '/models');
        P.log(ctx, 'debug', t('provider.requesting'), { url: url });
        return P.sendJson(ctx, url, { method: 'GET' }).then(function (payload) {
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
            P.log(ctx, 'success', t('provider.modelsLoaded', { count: out.length }), { url: url });
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

        var body = buildBody(ctx, payload, prompt, true);
        var url = P.joinUrl(apiBase(ctx), '/images/generations');
        P.log(ctx, 'info', t('provider.requesting'), { url: url, model: body.model, size: body.size });
        P.progress(ctx, 10);

        return P.sendJson(ctx, url, { method: 'POST', body: JSON.stringify(body) }).then(function (raw) {
            P.progress(ctx, 80);
            return P.resolveImages(ctx, raw, { mime: 'image/png' }).then(function (parsed) {
                return finalize(ctx, raw, parsed, payload);
            });
        });
    }

    /* ============================================================
     * 图片编辑（multipart/form-data）
     * ============================================================ */

    function edit(ctx, request) {
        var payload = request || {};
        var prompt = String(payload.prompt === undefined || payload.prompt === null ? '' : payload.prompt).trim();
        if (!prompt) return Promise.reject(P.makeError('ws.needPrompt'));

        var inputs = requestImages(payload);
        var sources = [];
        var mask = null;
        for (var i = 0; i < inputs.length; i++) {
            if (String(inputs[i].role || '') === 'mask' && !mask) mask = inputs[i];
            else sources.push(inputs[i]);
        }
        if (!sources.length) return Promise.reject(P.makeError('error.editNeedsImage'));

        var model = String(ctx.modelId || DEFAULT_MODEL).trim();
        var count = P.imageCount(payload.count, MAX_IMAGES);
        var size = P.formatSize(payload.size, 'auto');
        // OpenAI 的 /images/edits 只接受这几个文本字段，quality/style 不在此接口生效
        var parts = [
            { name: 'model', value: model },
            { name: 'prompt', value: prompt },
            { name: 'n', value: String(count) },
            { name: 'size', value: size }
        ];
        var fieldName = sources.length > 1 ? 'image[]' : 'image';
        for (var j = 0; j < sources.length; j++) {
            var decoded = P.imageBytesFrom(sources[j].dataUrl || sources[j].data || sources[j].base64);
            if (!decoded) return Promise.reject(P.makeError('error.editNeedsImage'));
            parts.push({
                name: fieldName,
                bytes: decoded.bytes,
                contentType: decoded.mime,
                filename: 'image-' + j + '.' + P.extFromMime(decoded.mime)
            });
        }
        if (mask) {
            var maskBytes = P.imageBytesFrom(mask.dataUrl || mask.data || mask.base64);
            if (!maskBytes) return Promise.reject(P.makeError('error.editNeedsImage'));
            parts.push({
                name: 'mask',
                bytes: maskBytes.bytes,
                contentType: maskBytes.mime,
                filename: 'mask.' + P.extFromMime(maskBytes.mime)
            });
        }

        var multipart = P.buildMultipart(parts);
        if (multipart.mode === 'manual') {
            P.log(ctx, 'debug', t('provider.multipartManual'), { parts: parts.length });
        }
        var url = P.joinUrl(apiBase(ctx), '/images/edits');
        P.log(ctx, 'info', t('provider.requesting'), { url: url, model: model, images: sources.length });
        P.progress(ctx, 10);

        return P.sendRaw(ctx, url, {
            method: 'POST',
            headers: multipart.headers,
            body: multipart.body
        }).then(function (res) {
            var raw = res.data === null || res.data === undefined ? res.text : res.data;
            P.progress(ctx, 80);
            return P.resolveImages(ctx, raw, { mime: 'image/png' }).then(function (parsed) {
                return finalize(ctx, raw, parsed, payload);
            });
        });
    }

    /* ============================================================
     * 对话
     * ============================================================ */

    function chat(ctx, request) {
        var payload = request || {};
        var messages = Array.isArray(payload.messages) ? payload.messages : [];
        if (!messages.length) return Promise.reject(P.makeError('error.messagesRequired'));

        var model = String(payload.model || ctx.chatModel || ctx.modelId || DEFAULT_CHAT_MODEL).trim();
        var body = { model: model, messages: messages };
        if (payload.temperature !== undefined && payload.temperature !== null) body.temperature = payload.temperature;
        if (payload.maxTokens !== undefined && payload.maxTokens !== null) body.max_tokens = payload.maxTokens;
        var extra = util.isPlainObject(payload.extra) ? payload.extra : {};
        for (var name in extra) {
            if (hasOwn(extra, name) && body[name] === undefined) body[name] = extra[name];
        }

        var url = P.joinUrl(apiBase(ctx), '/chat/completions');
        P.log(ctx, 'info', t('provider.requesting'), { url: url, model: model });
        return P.sendJson(ctx, url, { method: 'POST', body: JSON.stringify(body) }).then(function (raw) {
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

    /* ============================================================
     * 余额查询（端点缺失时不报错，降级为"不支持"提示）
     * ============================================================ */

    function pickNumber(source, keys, depth) {
        if (!util.isPlainObject(source) || util.toNumber(depth, 0) > 3) return null;
        for (var i = 0; i < keys.length; i++) {
            var value = source[keys[i]];
            if (typeof value === 'number' && isFinite(value)) return value;
            if (typeof value === 'string' && value.trim() && isFinite(Number(value))) return Number(value);
        }
        for (var j = 0; j < keys.length; j++) {
            var nested = source[keys[j]];
            if (util.isPlainObject(nested)) {
                var found = pickNumber(nested, keys, util.toNumber(depth, 0) + 1);
                if (found !== null) return found;
            }
        }
        var containers = ['data', 'result', 'grants', 'billing', 'credit_grants'];
        for (var k = 0; k < containers.length; k++) {
            var container = source[containers[k]];
            if (util.isPlainObject(container)) {
                var deep = pickNumber(container, keys, util.toNumber(depth, 0) + 1);
                if (deep !== null) return deep;
            }
        }
        return null;
    }

    function formatAmount(value) {
        var rounded = Math.round(util.toNumber(value, 0) * 100) / 100;
        return String(rounded);
    }

    function describeBalance(payload) {
        var available = pickNumber(payload, ['total_available', 'total_remaining', 'remaining', 'available_balance', 'balance', 'credits', 'credit'], 0);
        if (available !== null) return t('balance.available', { value: formatAmount(available) });
        var quota = pickNumber(payload, ['quota', 'hard_limit_usd', 'total_granted', 'granted'], 0);
        var used = pickNumber(payload, ['used_quota', 'total_used', 'usage', 'used'], 0);
        if (quota !== null && used !== null) {
            return t('balance.quota', { quota: formatAmount(quota), used: formatAmount(used) });
        }
        if (quota !== null) return t('balance.available', { value: formatAmount(quota) });
        return '';
    }

    function probeBalance(ctx, base, paths, index) {
        if (index >= paths.length) {
            return Promise.resolve({ display: t('settings.balanceUnsupported'), endpoints: paths });
        }
        var url = P.joinUrl(base, paths[index]);
        return P.sendJson(ctx, url, { method: 'GET' }).then(function (payload) {
            var display = describeBalance(payload);
            if (!display) return { display: t('settings.balanceUnsupported'), raw: payload, endpoint: paths[index] };
            return { display: display, raw: payload, endpoint: paths[index] };
        }, function (error) {
            // 端点不存在或没有权限都继续试下一个，绝不把错误抛给 UI
            P.log(ctx, 'debug', t('provider.balanceProbe'), { url: url, reason: error && error.message });
            return probeBalance(ctx, base, paths, index + 1);
        });
    }

    function checkBalance(ctx) {
        return probeBalance(ctx, apiBase(ctx), ['/dashboard/billing/credit_grants', '/user/self'], 0)
            .catch(function () {
                return { display: t('settings.balanceUnsupported') };
            });
    }

    /* ============================================================
     * 连接测试
     * ============================================================ */

    function test(ctx) {
        return listModels(ctx).then(function (models) {
            return { ok: true, models: models };
        }, function (error) {
            return { ok: false, models: [], error: error && error.message ? error.message : String(error) };
        });
    }

    P.register({
        id: 'openai',
        labelKey: 'settings.channelOpenAI',
        order: 20,
        needsKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModel: DEFAULT_MODEL,
        defaultChatModel: DEFAULT_CHAT_MODEL,
        supports: { txt2img: true, img2img: true, edit: true, models: true, chat: true, balance: true },
        listModels: listModels,
        generate: generate,
        edit: edit,
        chat: chat,
        checkBalance: checkBalance,
        test: test
    });
})(typeof window !== 'undefined' ? window : this);
