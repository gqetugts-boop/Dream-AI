// ============================================================
//  providers.js — 渠道适配层
//
//  模型值统一用 "渠道/模型名"（例如 grs/nano-banana-pro），
//  与主插件的 buildModelValue / parseModelSelection 保持一致，
//  这样共享配置文件里的模型串可以直接拿来用。
//
//  注意：生图不再由本插件发起 —— 圆环的「生成」会转交给主插件执行，
//  见 src/core/main-link.js。这里保留渠道元数据（标签、模型列表、比例档位）
//  供界面显示，以及对话路径使用。
//  没有把握的渠道在 CHANNELS 里标 verified:false，
//  参数页会给它加「未验证」标记，避免用户以为是插件坏了。
// ============================================================

(function (root) {
    'use strict';

    var ASPECT_RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'];
    var RESOLUTIONS = ['auto', '1K', '2K', '4K'];

    // 各渠道的默认模型目录，取自主插件的默认选项表
    var CHANNELS = {
        grs: {
            label: 'GRS',
            kind: 'openai-images',
            defaultBaseUrl: 'https://grsaiapi.com',
            verified: true,
            supportsAspect: true,
            supportsResolution: false,
            maxSourceImages: 4,
            imageModels: [
                'nano-banana-fast', 'nano-banana', 'nano-banana-2', 'nano-banana-2-cl',
                'nano-banana-2-4k-cl', 'nano-banana-pro', 'nano-banana-pro-vt',
                'nano-banana-pro-cl', 'nano-banana-pro-vip', 'nano-banana-pro-4k-vip',
                'gpt-image-2', 'gpt-image-2-vip', 'gpt-image-2.5',
                'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'
            ],
            chatModels: ['gpt-5.4', 'gpt-5.5', 'gemini-3-pro', 'gemini-3.1-pro', 'gemini-2.5-pro']
        },
        newapi: {
            label: 'NewAPI',
            kind: 'openai-images',
            defaultBaseUrl: 'http://127.0.0.1:3000',
            verified: true,
            supportsAspect: true,
            supportsResolution: false,
            maxSourceImages: 4,
            imageModels: [],
            chatModels: []
        },
        xai: {
            label: 'xAI 官方',
            kind: 'openai-images',
            defaultBaseUrl: 'https://api.x.ai',
            verified: true,
            supportsAspect: true,
            supportsResolution: true,
            resolutionStyle: 'lower',
            maxSourceImages: 3,
            imageModels: ['grok-imagine-image-quality', 'grok-imagine-image'],
            chatModels: ['grok-4', 'grok-3']
        },
        grok2api: {
            label: 'grok2api',
            kind: 'openai-images',
            defaultBaseUrl: 'http://127.0.0.1:8000',
            verified: true,
            supportsAspect: true,
            supportsResolution: true,
            resolutionStyle: 'lower',
            maxSourceImages: 3,
            imageModels: [
                'grok-imagine-image-2.0', 'grok-imagine-image-quality',
                'grok-imagine-image', 'grok-imagine-image-lite'
            ],
            chatModels: []
        },
        sub2api: {
            label: 'Sub2API',
            kind: 'openai-images',
            defaultBaseUrl: 'http://127.0.0.1:8080',
            verified: true,
            supportsAspect: true,
            supportsResolution: true,
            resolutionStyle: 'lower',
            // edits 端点硬上限 3 张，超了上游直接报错
            maxSourceImages: 3,
            imageModels: [
                'grok-imagine-image-quality', 'grok-imagine-image', 'grok-imagine'
            ],
            chatModels: []
        },
        firefly: {
            label: 'Firefly 网关',
            kind: 'openai-images',
            defaultBaseUrl: 'http://127.0.0.1:8787',
            // 本地逆向网关，请求体形状未经真机验证
            verified: false,
            supportsAspect: true,
            supportsResolution: false,
            maxSourceImages: 4,
            apiKeyOptional: true,
            imageModels: [
                'google:firefly:colligo:gemini-flash', 'gemini-3-nano-banana-pro',
                'gpt-image-2', 'gpt-image-1.5', 'flux-2-pro'
            ],
            chatModels: []
        },
        volcengine: {
            label: '火山方舟',
            kind: 'volcengine-images',
            defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
            verified: true,
            supportsAspect: false,
            supportsResolution: true,
            maxSourceImages: 4,
            imageModels: ['doubao-seedream-4-0-250828'],
            chatModels: ['doubao-seed-1-6-250615']
        },
        gemini: {
            label: 'Google AI Studio',
            kind: 'gemini',
            defaultBaseUrl: 'https://generativelanguage.googleapis.com',
            verified: true,
            supportsAspect: true,
            supportsResolution: false,
            maxSourceImages: 4,
            imageModels: ['gemini-2.5-flash-image', 'gemini-3-pro-image'],
            chatModels: ['gemini-2.5-pro', 'gemini-3-pro']
        }
    };

    function parseModel(value) {
        var text = String(value || '');
        var index = text.indexOf('/');
        if (index <= 0) return { channel: '', model: text };
        return { channel: text.slice(0, index).toLowerCase(), model: text.slice(index + 1) };
    }

    function buildModel(channel, model) {
        if (!channel) return String(model || '');
        return String(channel).toLowerCase() + '/' + String(model || '');
    }

    function channelInfo(name) {
        return CHANNELS[String(name || '').toLowerCase()] || null;
    }

    function channelNames() {
        return Object.keys(CHANNELS);
    }

    function normalizeBaseUrl(url, fallback) {
        var value = String(url || '').trim() || String(fallback || '');
        return value.replace(/\/+$/, '');
    }

    function joinApiUrl(baseUrl, path) {
        var base = String(baseUrl || '').replace(/\/+$/, '');
        var suffix = String(path || '');
        if (suffix.charAt(0) !== '/') suffix = '/' + suffix;
        // 用户可能把 /v1 填进地址里，这里统一剥掉再拼，避免 /v1/v1/...
        if (/\/v1$/i.test(base) && /^\/v1\//i.test(suffix)) base = base.replace(/\/v1$/i, '');
        return base + suffix;
    }

    function normalizeAspect(aspectRatio) {
        var value = String(aspectRatio || '').trim();
        return ASPECT_RATIOS.indexOf(value) > -1 ? value : '1:1';
    }

    function normalizeResolution(resolution) {
        var value = String(resolution || '').trim().toUpperCase();
        return RESOLUTIONS.indexOf(value) > -1 ? value : 'auto';
    }

    /** 按选区宽高比挑一个最接近的预设比例。 */
    function aspectFromSize(width, height) {
        var w = Number(width);
        var h = Number(height);
        if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return '1:1';
        var target = w / h;
        var best = ASPECT_RATIOS[0];
        var bestDelta = Infinity;
        ASPECT_RATIOS.forEach(function (label) {
            var parts = label.split(':');
            var ratio = Number(parts[0]) / Number(parts[1]);
            var delta = Math.abs(ratio - target);
            if (delta < bestDelta) {
                bestDelta = delta;
                best = label;
            }
        });
        return best;
    }

    function authHeaders(apiKey) {
        var headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
        return headers;
    }

    // 本地网关（grok2api / Sub2API / NewAPI / Firefly）经常是刚启动、
    // 正在重启、或者偶发抽风，一次失败就报错太脆。这里做退避重试。
    var RETRY_ATTEMPTS = 3;
    var RETRY_BASE_MS = 700;
    // 网关刚起来时最常见的几种「暂时不可用」
    var RETRYABLE_STATUS = [502, 503, 504, 429];

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    async function postJson(url, body, headers, timeoutMs) {
        var lastError = null;

        for (var attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
            var controller = new AbortController();
            var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 240000);
            try {
                var response = await fetch(url, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                var text = await response.text();
                var data = {};
                try { data = text ? JSON.parse(text) : {}; } catch (parseError) { data = { __raw: text }; }

                // 暂时性 HTTP 错误才重试，4xx 是参数/密钥问题，重试没意义
                if (RETRYABLE_STATUS.indexOf(response.status) > -1 && attempt < RETRY_ATTEMPTS) {
                    await sleep(RETRY_BASE_MS * attempt);
                    continue;
                }
                return { ok: response.ok, status: response.status, data: data, text: text, attempts: attempt };
            } catch (error) {
                lastError = error;
                // 超时不重试：单次已经等了很久，再重试代价太高
                if (error && error.name === 'AbortError') throw error;
                if (attempt >= RETRY_ATTEMPTS) throw error;
                await sleep(RETRY_BASE_MS * attempt);
            } finally {
                clearTimeout(timer);
            }
        }
        throw lastError || new Error('请求失败');
    }

    function errorMessage(result, prefix) {
        var data = result && result.data ? result.data : {};
        var message = (data.error && (data.error.message || data.error)) || data.message || result.text || '未知错误';
        return prefix + '（HTTP ' + result.status + '）：' + String(message).slice(0, 300);
    }

    /** 对话。messages 是 [{role, content}]，image 是可选 data URL。 */
    async function chat(options) {
        var info = channelInfo(options.channel);
        if (!info) return { error: '不支持的渠道：' + options.channel };
        var baseUrl = normalizeBaseUrl(options.baseUrl, info.defaultBaseUrl);
        if (!options.apiKey && !info.apiKeyOptional) return { error: '缺少 ' + info.label + ' 的 API Key' };

        try {
            if (info.kind === 'gemini') return await chatGemini(baseUrl, options);
            return await chatOpenAi(baseUrl, info, options);
        } catch (error) {
            if (error && error.name === 'AbortError') return { error: info.label + ' 请求超时或已取消' };
            return { error: '无法连接 ' + info.label + '：' + error.message };
        }
    }

    async function chatOpenAi(baseUrl, info, options) {
        var messages = [];
        if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt });
        (options.messages || []).forEach(function (message) {
            if (!message || !message.content) return;
            if (message.image && message.role === 'user') {
                messages.push({
                    role: 'user',
                    content: [
                        { type: 'text', text: message.content },
                        { type: 'image_url', image_url: { url: message.image } }
                    ]
                });
                return;
            }
            messages.push({ role: message.role, content: message.content });
        });

        var body = { model: options.model, messages: messages, stream: false };
        if (typeof options.temperature === 'number') body.temperature = options.temperature;

        var result = await postJson(joinApiUrl(baseUrl, '/v1/chat/completions'), body, authHeaders(options.apiKey));
        if (!result.ok) return { error: errorMessage(result, info.label + ' 对话失败') };
        return { success: true, data: result.data };
    }

    async function chatGemini(baseUrl, options) {
        var modelPath = String(options.model).replace(/^models\//i, '');
        var url = joinApiUrl(baseUrl, '/v1beta/models/' + modelPath + ':generateContent')
            + '?key=' + encodeURIComponent(options.apiKey);

        var parts = [];
        (options.messages || []).forEach(function (message) {
            if (!message || !message.content) return;
            parts.push({ text: message.content });
            if (message.image) {
                var mimeMatch = String(message.image).match(/^data:(image\/\w+);base64,/);
                parts.push({
                    inlineData: {
                        mimeType: mimeMatch ? mimeMatch[1] : 'image/png',
                        data: String(message.image).replace(/^data:image\/\w+;base64,/, '')
                    }
                });
            }
        });

        var body = {
            contents: [{ role: 'user', parts: parts }],
            generationConfig: { responseModalities: ['TEXT'] }
        };
        if (options.systemPrompt) {
            body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
        }
        var result = await postJson(url, body, { 'Content-Type': 'application/json' });
        if (!result.ok) return { error: errorMessage(result, 'Google AI Studio 对话失败') };
        return { success: true, data: result.data };
    }

    /** 从对话响应里取文本，覆盖 OpenAI 与 Gemini 两种形状。 */
    function extractChatText(data) {
        if (!data) return '';
        var choices = data.choices;
        if (Array.isArray(choices) && choices.length) {
            var message = choices[0].message || {};
            if (typeof message.content === 'string') return message.content;
            if (Array.isArray(message.content)) {
                return message.content.map(function (part) {
                    return typeof part === 'string' ? part : (part && part.text) || '';
                }).join('');
            }
        }
        var candidates = data.candidates;
        if (Array.isArray(candidates) && candidates.length) {
            var parts = (candidates[0].content && candidates[0].content.parts) || [];
            return parts.map(function (part) { return part && part.text ? part.text : ''; }).join('');
        }
        if (typeof data.output_text === 'string') return data.output_text;
        return '';
    }

    var api = {
        ASPECT_RATIOS: ASPECT_RATIOS,
        RESOLUTIONS: RESOLUTIONS,
        CHANNELS: CHANNELS,
        parseModel: parseModel,
        buildModel: buildModel,
        channelInfo: channelInfo,
        channelNames: channelNames,
        normalizeBaseUrl: normalizeBaseUrl,
        joinApiUrl: joinApiUrl,
        normalizeAspect: normalizeAspect,
        normalizeResolution: normalizeResolution,
        aspectFromSize: aspectFromSize,
        chat: chat,
        extractChatText: extractChatText
    };

    root.SatProviders = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
