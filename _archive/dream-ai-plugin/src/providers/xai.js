/*
 * providers/xai.js — xAI 官方渠道
 *
 * 职责：实现 xAI（api.x.ai）的 /models、/images/generations、/images/edits、/chat/completions。
 * 输入：registry.createContext() 产出的 ctx，以及统一的 request 对象。
 * 输出：{ images: [{ dataUrl, width, height, seed? }], raw, meta } / { text, raw } / [{ id }]。
 * 边界：xAI 与 OpenAI 兼容层的差异按官方行为处理——
 *       1) 不发送 response_format（xAI 不接受该字段）；
 *       2) 图片结果统一是 { data: [{ url | b64_json }] }，URL 由 registry 下载转 data URL；
 *       3) /images/edits 只接受单个 image 字段，多余输入与蒙版会被忽略并记日志；
 *       4) 官方不提供余额接口，checkBalance 直接返回"不支持"。
 *       文件为纯 ES5，可在没有 Photoshop 宿主的 Node 下加载。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var P = DreamAI.Providers;
    if (!P || P.get('xai')) return;

    var util = DreamAI.util;

    var DEFAULT_MODEL = 'grok-2-image';
    var DEFAULT_CHAT_MODEL = 'grok-2-latest';
    var MAX_IMAGES = 10;

    function t(key, params) {
        return DreamAI.I18n ? DreamAI.I18n.t(key, params) : key;
    }

    function hasOwn(object, name) {
        return Object.prototype.hasOwnProperty.call(object, name);
    }

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
        // 注意：这里刻意不写 response_format —— xAI 的图片接口不接受该字段
        return body;
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

        var body = buildBody(ctx, payload, prompt);
        var url = P.joinUrl(apiBase(ctx), '/images/generations');
        P.log(ctx, 'info', t('provider.requesting'), { url: url, model: body.model, size: body.size });
        P.progress(ctx, 10);

        return P.sendJson(ctx, url, { method: 'POST', body: JSON.stringify(body) }).then(function (raw) {
            P.progress(ctx, 80);
            return P.resolveImages(ctx, raw, { mime: 'image/jpeg' }).then(function (parsed) {
                return P.buildImageResult(ctx, raw, parsed, payload);
            });
        });
    }

    /* ============================================================
     * 图片编辑（单图 multipart）
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

        var model = String(ctx.modelId || DEFAULT_MODEL).trim();
        var count = P.imageCount(payload.count, MAX_IMAGES);
        var size = P.formatSize(payload.size, '1024x1024');
        var first = P.imageBytesFrom(sources[0].dataUrl || sources[0].data || sources[0].base64);
        if (!first) return Promise.reject(P.makeError('error.editNeedsImage'));

        if (sources.length > 1 || hasMask) {
            // xAI 的 /images/edits 只认一个 image 字段：多余输入与蒙版丢弃，避免请求被判非法
            P.log(ctx, 'warn', t('provider.singleImageOnly'), { dropped: sources.length - 1, mask: hasMask });
        }

        var parts = [
            { name: 'model', value: model },
            { name: 'prompt', value: prompt },
            { name: 'n', value: String(count) },
            { name: 'size', value: size },
            {
                name: 'image',
                bytes: first.bytes,
                contentType: first.mime,
                filename: 'image.' + P.extFromMime(first.mime)
            }
        ];
        var multipart = P.buildMultipart(parts);
        if (multipart.mode === 'manual') {
            P.log(ctx, 'debug', t('provider.multipartManual'), { parts: parts.length });
        }
        var url = P.joinUrl(apiBase(ctx), '/images/edits');
        P.log(ctx, 'info', t('provider.requesting'), { url: url, model: model, images: 1 });
        P.progress(ctx, 10);

        return P.sendRaw(ctx, url, {
            method: 'POST',
            headers: multipart.headers,
            body: multipart.body
        }).then(function (res) {
            var raw = res.data === null || res.data === undefined ? res.text : res.data;
            P.progress(ctx, 80);
            return P.resolveImages(ctx, raw, { mime: 'image/jpeg' }).then(function (parsed) {
                return P.buildImageResult(ctx, raw, parsed, payload);
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

        var model = String(payload.model || ctx.chatModel || DEFAULT_CHAT_MODEL).trim();
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
     * 余额：官方没有开放计费接口，直接降级
     * ============================================================ */

    function checkBalance(ctx) {
        // 官方未开放计费查询：按约定优雅降级，不抛错
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
        id: 'xai',
        labelKey: 'settings.channelXai',
        order: 30,
        needsKey: true,
        defaultBaseUrl: 'https://api.x.ai/v1',
        defaultModel: DEFAULT_MODEL,
        defaultChatModel: DEFAULT_CHAT_MODEL,
        supports: { txt2img: true, img2img: true, edit: true, models: true, chat: true, balance: false },
        listModels: listModels,
        generate: generate,
        edit: edit,
        chat: chat,
        checkBalance: checkBalance,
        test: test
    });
})(typeof window !== 'undefined' ? window : this);
