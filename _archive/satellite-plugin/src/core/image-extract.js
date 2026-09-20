// ============================================================
//  image-extract.js — 从各家渠道的响应里抠出图像
//
//  这一层是从主插件 Dream-ps-ai 移植的，那四个函数是多年踩坑的产物，
//  不要凭直觉简化：
//    collectImageCandidates  递归下钻，键名像图片但值是对象时也要进去
//    isLikelyImageResult     域名白名单是硬编码的，新渠道要补
//    sanitizeImageCandidate  正则扫出的 URL 要剥掉尾部标点
//    extractImageFromResponse 汇总入口
//  Gemini 走 inlineData{ mimeType, data }，data 是裸 base64 无前缀。
//
//  纯函数、无宿主依赖，可以直接在 Node 里跑测试。
// ============================================================

(function (root) {
    'use strict';

    var STRING_IMAGE_KEYS = [
        'url', 'image', 'image_url', 'output', 'b64_json', 'response_url', 'download_url',
        'uri', 'src', 'base64', 'base64Data', 'imageBase64', 'image_data', 'imageData',
        'result_image', 'original_url', 'originalUrl', 'file_url', 'fileUrl',
        'result_url', 'resultUrl', 'thumbnail', 'thumbnail_url', 'thumbnailUrl'
    ];

    // 容器键：这些键下面的内容继续递归找
    var CONTAINER_KEYS = [
        'data', 'results', 'images', 'result', 'output', 'outputs', 'items', 'attachments',
        'choices', 'content', 'message', 'payload', 'response', 'data_list', 'dataList',
        'image_list', 'imageList', 'artifacts', 'files', 'candidates', 'parts'
    ];

    function isLikelyBase64ImageData(value) {
        if (typeof value !== 'string') return false;
        var trimmed = value.trim();
        if (!trimmed || trimmed.length < 128) return false;
        if (/^data:image\//i.test(trimmed)) return true;
        return /^[A-Za-z0-9+/=\s]+$/.test(trimmed)
            && (trimmed.indexOf('/') > -1 || trimmed.indexOf('+') > -1 || trimmed.indexOf('=') > -1);
    }

    function makeImageDataUrl(value) {
        if (!value) return '';
        if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) return value;
        var normalized = String(value).replace(/\s+/g, '');
        var mimeMatch = normalized.match(/^([A-Za-z]+\/[A-Za-z0-9.+-]+);base64,(.+)$/i);
        if (mimeMatch) return 'data:' + mimeMatch[1] + ';base64,' + mimeMatch[2];
        return 'data:image/png;base64,' + normalized;
    }

    function collectImageCandidates(value, results) {
        results = results || [];
        if (!value) return results;

        if (typeof value === 'string') {
            var trimmed = value.trim();
            if (/^(https?:\/\/|data:image\/)/i.test(trimmed)) results.push(trimmed);
            else if (isLikelyBase64ImageData(trimmed)) results.push(makeImageDataUrl(trimmed));
            return results;
        }

        if (Array.isArray(value)) {
            value.forEach(function (item) { collectImageCandidates(item, results); });
            return results;
        }

        if (typeof value !== 'object') return results;

        STRING_IMAGE_KEYS.forEach(function (key) {
            if (typeof value[key] !== 'string') return;
            var fieldValue = value[key];
            var lower = key.toLowerCase();
            results.push(lower === 'b64_json' || lower.indexOf('base64') > -1 || lower.indexOf('image_data') > -1
                ? makeImageDataUrl(fieldValue)
                : fieldValue);
        });

        Object.keys(value).forEach(function (key) {
            var fieldValue = value[key];
            var lowerKey = key.toLowerCase();
            if (typeof fieldValue === 'string') {
                if (lowerKey.indexOf('image') === -1 && lowerKey.indexOf('img') === -1
                    && lowerKey.indexOf('url') === -1 && lowerKey.indexOf('base64') === -1
                    && lowerKey.indexOf('b64') === -1) return;
                if (/^(https?:\/\/|data:image\/)/i.test(fieldValue.trim()) || isLikelyBase64ImageData(fieldValue)) {
                    results.push(isLikelyBase64ImageData(fieldValue) ? makeImageDataUrl(fieldValue) : fieldValue.trim());
                }
                return;
            }
            if (fieldValue && typeof fieldValue === 'object') {
                // 键名像图片字段但值是对象时必须继续下钻，
                // 例如 Firefly 的 { outputs: [{ image: { url } }] }
                if (lowerKey.indexOf('image') > -1 || lowerKey.indexOf('img') > -1
                    || lowerKey.indexOf('url') > -1 || lowerKey.indexOf('thumb') > -1
                    || lowerKey.indexOf('file') > -1 || lowerKey.indexOf('asset') > -1
                    || lowerKey === 'output' || lowerKey === 'original' || lowerKey === 'source') {
                    collectImageCandidates(fieldValue, results);
                }
            }
        });

        // Gemini：candidates[].content.parts[].inlineData{ mimeType, data }
        ['inlineData', 'inline_data'].forEach(function (key) {
            var inline = value[key];
            if (!inline || typeof inline !== 'object') return;
            var mimeType = inline.mimeType || inline.mime_type || '';
            var data = inline.data;
            if (typeof data === 'string' && data.trim() && /^image\//i.test(mimeType)) {
                results.push('data:' + mimeType + ';base64,' + data.trim());
            }
        });

        CONTAINER_KEYS.forEach(function (key) {
            collectImageCandidates(value[key], results);
        });

        return results;
    }

    function isLikelyImageResult(value) {
        if (!value) return false;
        if (/^data:image\//i.test(value)) return true;
        try {
            var parsed = new URL(value.replace(/\\\//g, '/'));
            return /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(parsed.pathname)
                || /(?:^|\.)(oaidalleapiprodscus|blob|grs|claude|image|img|cdn|adobe|firefly|storage|xai-imgen)\./i.test(parsed.hostname)
                // 预签名直链通常没有扩展名，主机名也不含 image/firefly 字样。
                // 这是硬编码白名单，无法穷举，新渠道返回新域名时要在这里补一条。
                || /(?:^|\.)(amazonaws|cloudfront|aliyuncs|myqcloud|googleusercontent|digitaloceanspaces|backblazeb2|b-cdn|volces|volccdn|byteimg|ibyteimg)\./i.test(parsed.hostname);
        } catch (error) {
            return /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(value);
        }
    }

    function sanitizeImageCandidate(value) {
        if (typeof value !== 'string') return value;
        // data URL 里的 + / = 不能被当成尾部标点削掉
        if (/^data:image\//i.test(value)) return value.trim();
        var result = value.trim();
        // 从序列化文本里正则扫出来的 URL 常带着包裹标点：
        // markdown 的 ![img](https://x/y.png) 会连右括号一起扫进来
        var trailing = /[)\]}>"'`,;:，。；：）】》、»”’]+$/;
        var previous;
        do {
            previous = result;
            result = result.replace(trailing, '');
        } while (result !== previous);
        return result;
    }

    function extractImageFromResponse(response) {
        try {
            if (!response) return null;
            var candidates = collectImageCandidates(response, []);
            var serialized = JSON.stringify(response);
            var escapedUrlMatches = serialized.match(/https?:\\?\/\\?\/[^"'\\\s]+/g) || [];
            var dataMatches = serialized.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || [];
            var allMatches = candidates
                .concat(escapedUrlMatches.map(function (url) { return url.replace(/\\\//g, '/'); }))
                .concat(dataMatches);

            for (var i = 0; i < allMatches.length; i += 1) {
                var candidate = sanitizeImageCandidate(allMatches[i]);
                if (isLikelyImageResult(candidate)) return candidate;
            }
        } catch (error) {
            console.error('[卫星] 提取图像失败：' + error.message);
        }
        return null;
    }

    /** 一次响应里可能有多张图（imageCount > 1），全部收出来。 */
    function extractAllImagesFromResponse(response) {
        var found = [];
        if (!response) return found;
        var candidates = collectImageCandidates(response, []);
        var serialized = JSON.stringify(response);
        var dataMatches = serialized.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || [];
        candidates.concat(dataMatches).forEach(function (item) {
            var candidate = sanitizeImageCandidate(item);
            if (!isLikelyImageResult(candidate)) return;
            if (found.indexOf(candidate) > -1) return;
            found.push(candidate);
        });
        return found;
    }

    function detectImageMimeType(buffer, headerValue) {
        var header = String(headerValue || '').split(';')[0].trim().toLowerCase();
        if (/^image\/(?:png|jpe?g|webp|gif)$/i.test(header)) return header === 'image/jpg' ? 'image/jpeg' : header;
        var bytes = new Uint8Array(buffer || 0);
        if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
        if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
            && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
        if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
        return 'image/png';
    }

    function arrayBufferToBase64(buffer) {
        var binary = '';
        var bytes = new Uint8Array(buffer);
        var chunkSize = 0x8000;
        for (var i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    function base64ToArrayBuffer(base64) {
        var binaryString = atob(base64);
        var bytes = new Uint8Array(binaryString.length);
        for (var i = 0; i < binaryString.length; i += 1) bytes[i] = binaryString.charCodeAt(i);
        return bytes.buffer;
    }

    async function fetchImageAsDataUrl(imageUrl) {
        var response = await fetch(imageUrl);
        if (!response.ok) throw new Error('下载图像失败：' + response.status);
        var arrayBuffer = await response.arrayBuffer();
        var mimeType = detectImageMimeType(arrayBuffer,
            response.headers && response.headers.get ? response.headers.get('content-type') : '');
        return 'data:' + mimeType + ';base64,' + arrayBufferToBase64(arrayBuffer);
    }

    /** 已经是 data URL 就原样返回，是 http 链接就下载。 */
    async function ensureDataUrl(image) {
        if (!image) return '';
        if (/^data:image\//i.test(image)) return image;
        return await fetchImageAsDataUrl(image);
    }

    var api = {
        isLikelyBase64ImageData: isLikelyBase64ImageData,
        makeImageDataUrl: makeImageDataUrl,
        collectImageCandidates: collectImageCandidates,
        isLikelyImageResult: isLikelyImageResult,
        sanitizeImageCandidate: sanitizeImageCandidate,
        extractImageFromResponse: extractImageFromResponse,
        extractAllImagesFromResponse: extractAllImagesFromResponse,
        detectImageMimeType: detectImageMimeType,
        arrayBufferToBase64: arrayBufferToBase64,
        base64ToArrayBuffer: base64ToArrayBuffer,
        fetchImageAsDataUrl: fetchImageAsDataUrl,
        ensureDataUrl: ensureDataUrl
    };

    root.SatImageExtract = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
