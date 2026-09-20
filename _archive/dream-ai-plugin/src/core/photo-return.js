/*
 * core/photo-return.js — 把结果写回 Photoshop 文档
 *
 * 职责：
 *   - 把生成结果（data URL / 原始像素 / 裸 base64）规范化成 RGBA 像素；
 *   - 需要时按参考图做低频色彩匹配（DreamAI.ColorEngine）；
 *   - 编码 PNG（保留 alpha），缩放到目标 bounds，用
 *     createPixelLayer + imaging.createImageDataFromBuffer + imaging.putPixels 落到新图层；
 *   - 支持屏幕混合、矩形/alpha 图层蒙版（内缩 + 羽化）、自动打组。
 * 输入：place(image, options)，options 见 docs/INTERNALS.md 第 5 节。
 * 输出：Promise<{ layerName, layerId, bounds }>；成功/失败分别广播
 *       return:done / return:failed。
 * 边界：
 *   - 全程走 DreamAI.psLock 串行 + executeAsModal；
 *   - 指定了 documentId 却找不到文档时抛 error.docClosed，绝不改贴到别的文档；
 *   - 顶层不 require('photoshop')，可在 Node 下加载；色彩匹配失败只记警告，不阻断回写。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.PhotoReturn) return;

    /** 回写整体超时（写 4K 级大图 + 蒙版可能要几秒） */
    var PLACE_TIMEOUT_MS = 300000;
    /** 图层组/改名等辅助 batchPlay 的超时 */
    var STEP_TIMEOUT_MS = 30000;
    /** 每张文档的默认图层序号 */
    var layerCounters = {};

    /* ============================================================
     * 基础工具
     * ============================================================ */

    function tr(key, params) {
        if (DreamAI.I18n && typeof DreamAI.I18n.t === 'function') return DreamAI.I18n.t(key, params);
        return key;
    }

    function log(level, message, meta) {
        try {
            if (DreamAI.logbus && typeof DreamAI.logbus[level] === 'function') {
                DreamAI.logbus[level](message, meta);
            } else if (global.console) {
                global.console.log('[photo-return] ' + message + (meta === undefined ? '' : ' ' + JSON.stringify(meta)));
            }
        } catch (error) { /* 忽略日志异常 */ }
    }

    function num(value, fallback) {
        var n = Number(value);
        return isFinite(n) ? n : fallback;
    }

    function getPs() {
        return (DreamAI.host && DreamAI.host.modules && DreamAI.host.modules.photoshop) || null;
    }

    function isAvailable() {
        var ps = getPs();
        return !!(DreamAI.host && DreamAI.host.hasPhotoshop && ps && ps.app && ps.core && ps.action && ps.imaging);
    }

    function requirePs() {
        if (!isAvailable()) throw new Error(tr('error.noPhotoshop'));
        return getPs();
    }

    /* ============================================================
     * base64 / data URL
     * ============================================================ */

    function looksLikeDataUrl(value) {
        return typeof value === 'string' && value.slice(0, 5).toLowerCase() === 'data:';
    }

    function looksLikeBase64(value) {
        if (typeof value !== 'string') return false;
        var text = value.trim();
        if (text.length < 16) return false;
        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(text)) return false;
        // PNG 的 base64 前缀固定为 iVBOR，JPEG 为 /9j/
        return text.indexOf('iVBOR') === 0 || text.indexOf('/9j/') === 0 ||
            text.indexOf('IVBOR') === 0 || text.length > 64;
    }

    function base64ToBytes(base64, mime) {
        var payload = String(base64 || '');
        if (looksLikeDataUrl(payload)) {
            var parsed = DreamAI.util.parseDataUrl(payload);
            mime = parsed.mime;
            payload = parsed.payload;
        }
        payload = payload.replace(/\s+/g, '');
        var binary = atob(payload);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return { bytes: bytes, mime: mime || 'application/octet-stream' };
    }

    /* ============================================================
     * PNG 解码（自己实现，避免依赖 fetch / createImageBitmap）
     * ============================================================ */

    var PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    function isPng(bytes) {
        if (!bytes || bytes.length < 8) return false;
        for (var i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
        return true;
    }

    /**
     * zlib 解压：优先用自研 inflate（纯同步、异常可捕获）；
     * 自研实现失败时才退回宿主自带的 DecompressionStream。
     * 注意：DecompressionStream 在输入损坏时可能抛出无法被 Promise 链捕获的流错误，
     * 所以它不能作为首选。
     */
    function inflateZlib(bytes) {
        try {
            return Promise.resolve(inflateRaw(bytes));
        } catch (error) {
            log('warn', 'built-in inflate failed: ' + String(error && error.message || error));
            if (typeof DecompressionStream !== 'function') {
                return Promise.reject(error);
            }
        }
        try {
            var stream = new DecompressionStream('deflate');
            var writer = stream.writable.getWriter();
            writer.write(bytes);
            writer.close();
            return new Response(stream.readable).arrayBuffer().then(function (buffer) {
                return new Uint8Array(buffer);
            });
        } catch (fallbackError) {
            return Promise.reject(fallbackError);
        }
    }

    /**
     * 自研 DEFLATE 解压（覆盖 stored / 固定 Huffman / 动态 Huffman 三种块）。
     * 输入可为带 zlib 头的流（0x78 开头）或裸 deflate 流。
     */
    function inflateRaw(bytes) {
        var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        var pos = 0;
        if (input.length > 2 && (input[0] & 0x0F) === 8 && ((input[0] << 8 | input[1]) % 31 === 0)) {
            pos = 2; // 跳过 zlib 头（忽略 FDICT）
        }

        var out = new Uint8Array(Math.max(1024, input.length * 6));
        var outLength = 0;
        var bitBuffer = 0;
        var bitCount = 0;

        function ensure(extra) {
            if (outLength + extra <= out.length) return;
            var next = new Uint8Array(Math.max(out.length * 2, outLength + extra + 1024));
            next.set(out.subarray(0, outLength));
            out = next;
        }

        function readBits(count) {
            while (bitCount < count) {
                if (pos >= input.length) throw new Error('deflate stream truncated');
                bitBuffer |= input[pos++] << bitCount;
                bitCount += 8;
            }
            var value = bitBuffer & ((1 << count) - 1);
            bitBuffer >>>= count;
            bitCount -= count;
            return value;
        }

        function buildHuffman(lengths) {
            var maxBits = 0;
            var i;
            for (i = 0; i < lengths.length; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
            var counts = new Array(maxBits + 1);
            for (i = 0; i <= maxBits; i++) counts[i] = 0;
            for (i = 0; i < lengths.length; i++) counts[lengths[i]]++;
            counts[0] = 0;
            var offsets = new Array(maxBits + 2);
            offsets[0] = 0;
            offsets[1] = 0;
            for (i = 1; i <= maxBits; i++) offsets[i + 1] = offsets[i] + counts[i];
            var symbols = new Array(lengths.length);
            for (i = 0; i < lengths.length; i++) {
                if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
            }
            return { counts: counts, symbols: symbols, maxBits: maxBits };
        }

        function decodeSymbol(table) {
            var code = 0;
            var first = 0;
            var index = 0;
            for (var length = 1; length <= table.maxBits; length++) {
                code |= readBits(1);
                var count = table.counts[length];
                if (code - first < count) return table.symbols[index + (code - first)];
                index += count;
                first = (first + count) << 1;
                code <<= 1;
            }
            throw new Error('invalid Huffman code');
        }

        var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
            35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
        var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
            3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
        var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
            257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
        var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
            7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

        var fixedLiteral = null;
        var fixedDistance = null;

        function fixedTables() {
            if (!fixedLiteral) {
                var literalLengths = new Array(288);
                var i;
                for (i = 0; i < 144; i++) literalLengths[i] = 8;
                for (i = 144; i < 256; i++) literalLengths[i] = 9;
                for (i = 256; i < 280; i++) literalLengths[i] = 7;
                for (i = 280; i < 288; i++) literalLengths[i] = 8;
                fixedLiteral = buildHuffman(literalLengths);
                var distanceLengths = new Array(30);
                for (i = 0; i < 30; i++) distanceLengths[i] = 5;
                fixedDistance = buildHuffman(distanceLengths);
            }
        }

        function copyMatch(length, distance) {
            if (distance <= 0 || distance > outLength) throw new Error('invalid deflate distance');
            ensure(length);
            var start = outLength - distance;
            for (var i = 0; i < length; i++) out[outLength + i] = out[start + i];
            outLength += length;
        }

        function readBlockCodes(literalTable, distanceTable) {
            for (; ;) {
                var symbol = decodeSymbol(literalTable);
                if (symbol < 256) {
                    ensure(1);
                    out[outLength++] = symbol;
                } else if (symbol === 256) {
                    return;
                } else {
                    var lengthIndex = symbol - 257;
                    if (lengthIndex >= LENGTH_BASE.length) throw new Error('invalid length symbol');
                    var length = LENGTH_BASE[lengthIndex] + readBits(LENGTH_EXTRA[lengthIndex]);
                    var distanceSymbol = decodeSymbol(distanceTable);
                    if (distanceSymbol >= DIST_BASE.length) throw new Error('invalid distance symbol');
                    var distance = DIST_BASE[distanceSymbol] + readBits(DIST_EXTRA[distanceSymbol]);
                    copyMatch(length, distance);
                }
            }
        }

        var ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

        function readDynamicTables() {
            var hlit = readBits(5) + 257;
            var hdist = readBits(5) + 1;
            var hclen = readBits(4) + 4;
            var codeLengths = new Array(19);
            var i;
            for (i = 0; i < 19; i++) codeLengths[i] = 0;
            for (i = 0; i < hclen; i++) codeLengths[ORDER[i]] = readBits(3);
            var codeTable = buildHuffman(codeLengths);

            var lengths = [];
            while (lengths.length < hlit + hdist) {
                var symbol = decodeSymbol(codeTable);
                if (symbol < 16) {
                    lengths.push(symbol);
                } else if (symbol === 16) {
                    var repeat = 3 + readBits(2);
                    var previous = lengths.length ? lengths[lengths.length - 1] : 0;
                    for (i = 0; i < repeat; i++) lengths.push(previous);
                } else if (symbol === 17) {
                    var zeros = 3 + readBits(3);
                    for (i = 0; i < zeros; i++) lengths.push(0);
                } else {
                    var zerosLong = 11 + readBits(7);
                    for (i = 0; i < zerosLong; i++) lengths.push(0);
                }
            }

            var literalLengths = lengths.slice(0, hlit);
            var distanceLengths = lengths.slice(hlit, hlit + hdist);
            return {
                literal: buildHuffman(literalLengths),
                distance: buildHuffman(distanceLengths.length ? distanceLengths : [0, 0])
            };
        }

        var final = 0;
        do {
            final = readBits(1);
            var type = readBits(2);
            if (type === 0) {
                // 非压缩块：对齐到字节边界后按 LEN/NLEN 拷贝
                bitBuffer = 0;
                bitCount = 0;
                if (pos + 4 > input.length) throw new Error('stored block truncated');
                var length = input[pos] | (input[pos + 1] << 8);
                var inverse = input[pos + 2] | (input[pos + 3] << 8);
                pos += 4;
                if ((length ^ 0xFFFF) !== inverse) throw new Error('stored block length mismatch');
                ensure(length);
                out.set(input.subarray(pos, pos + length), outLength);
                outLength += length;
                pos += length;
            } else if (type === 1) {
                fixedTables();
                readBlockCodes(fixedLiteral, fixedDistance);
            } else if (type === 2) {
                var tables = readDynamicTables();
                readBlockCodes(tables.literal, tables.distance);
            } else {
                throw new Error('invalid deflate block type');
            }
        } while (!final);

        return out.subarray(0, outLength);
    }

    /** Paeth 预测器 */
    function paeth(a, b, c) {
        var p = a + b - c;
        var pa = Math.abs(p - a);
        var pb = Math.abs(p - b);
        var pc = Math.abs(p - c);
        if (pa <= pb && pa <= pc) return a;
        return pb <= pc ? b : c;
    }

    /** 解码 PNG 字节流 → { data(RGBA), width, height, channels } */
    function decodePng(bytes) {
        var width = 0;
        var height = 0;
        var bitDepth = 8;
        var colorType = 6;
        var interlace = 0;
        var idatParts = [];
        var idatLength = 0;
        var cursor = 8;

        while (cursor + 8 <= bytes.length) {
            var length = ((bytes[cursor] << 24) | (bytes[cursor + 1] << 16) |
                (bytes[cursor + 2] << 8) | bytes[cursor + 3]) >>> 0;
            var type = String.fromCharCode(bytes[cursor + 4], bytes[cursor + 5], bytes[cursor + 6], bytes[cursor + 7]);
            var dataStart = cursor + 8;
            if (type === 'IHDR') {
                width = ((bytes[dataStart] << 24) | (bytes[dataStart + 1] << 16) |
                    (bytes[dataStart + 2] << 8) | bytes[dataStart + 3]) >>> 0;
                height = ((bytes[dataStart + 4] << 24) | (bytes[dataStart + 5] << 16) |
                    (bytes[dataStart + 6] << 8) | bytes[dataStart + 7]) >>> 0;
                bitDepth = bytes[dataStart + 8];
                colorType = bytes[dataStart + 9];
                interlace = bytes[dataStart + 12];
            } else if (type === 'IDAT') {
                idatParts.push(bytes.subarray(dataStart, dataStart + length));
                idatLength += length;
            } else if (type === 'IEND') {
                break;
            }
            cursor = dataStart + length + 4;
        }

        if (!width || !height) throw new Error('PNG missing IHDR');
        if (bitDepth !== 8) throw new Error('unsupported PNG bit depth ' + bitDepth);
        if (interlace !== 0) throw new Error('interlaced PNG is not supported');
        var channels;
        if (colorType === 6) channels = 4;
        else if (colorType === 2) channels = 3;
        else if (colorType === 0) channels = 1;
        else if (colorType === 4) channels = 2;
        else throw new Error('unsupported PNG color type ' + colorType);

        var packed = new Uint8Array(idatLength);
        var offset = 0;
        for (var p = 0; p < idatParts.length; p++) {
            packed.set(idatParts[p], offset);
            offset += idatParts[p].length;
        }

        return inflateZlib(packed).then(function (raw) {
            if (colorType === 3) throw new Error('indexed PNG is not supported');
            var stride = width * channels;
            var expected = (stride + 1) * height;
            if (raw.length < expected) throw new Error('PNG pixel data truncated');

            var scan = new Uint8Array(stride * height);
            var prior = new Uint8Array(stride);
            for (var y = 0; y < height; y++) {
                var filter = raw[y * (stride + 1)];
                var rowStart = y * (stride + 1) + 1;
                var outStart = y * stride;
                for (var x = 0; x < stride; x++) {
                    var value = raw[rowStart + x];
                    var left = x >= channels ? scan[outStart + x - channels] : 0;
                    var up = prior[x];
                    var upLeft = x >= channels ? prior[x - channels] : 0;
                    if (filter === 0) { /* 原样 */ }
                    else if (filter === 1) value = (value + left) & 0xFF;
                    else if (filter === 2) value = (value + up) & 0xFF;
                    else if (filter === 3) value = (value + ((left + up) >> 1)) & 0xFF;
                    else if (filter === 4) value = (value + paeth(left, up, upLeft)) & 0xFF;
                    else throw new Error('unknown PNG filter ' + filter);
                    scan[outStart + x] = value;
                }
                prior.set(scan.subarray(outStart, outStart + stride));
            }

            if (channels === 4) {
                return { data: scan, width: width, height: height, channels: 4 };
            }
            var rgba = new Uint8ClampedArray(width * height * 4);
            for (var i = 0; i < width * height; i++) {
                var src = i * channels;
                var dst = i * 4;
                if (channels === 1) {
                    rgba[dst] = scan[src];
                    rgba[dst + 1] = scan[src];
                    rgba[dst + 2] = scan[src];
                    rgba[dst + 3] = 255;
                } else if (channels === 2) {
                    rgba[dst] = scan[src];
                    rgba[dst + 1] = scan[src];
                    rgba[dst + 2] = scan[src];
                    rgba[dst + 3] = scan[src + 1];
                } else {
                    rgba[dst] = scan[src];
                    rgba[dst + 1] = scan[src + 1];
                    rgba[dst + 2] = scan[src + 2];
                    rgba[dst + 3] = 255;
                }
            }
            return { data: rgba, width: width, height: height, channels: 4 };
        });
    }

    /** 画布兜底解码（非 PNG 且宿主有 Image + canvas 时才走得到） */
    function decodeViaCanvas(bytes, mime) {
        if (!global.document || typeof global.document.createElement !== 'function') {
            return Promise.reject(new Error('canvas unavailable'));
        }
        if (typeof global.Image !== 'function') return Promise.reject(new Error('Image unavailable'));

        return new Promise(function (resolve, reject) {
            var dataUrl = DreamAI.util.base64ToDataUrl(DreamAI.util.arrayBufferToBase64(bytes), mime);
            var image = new global.Image();
            image.onload = function () {
                try {
                    var canvas = global.document.createElement('canvas');
                    canvas.width = image.naturalWidth || image.width;
                    canvas.height = image.naturalHeight || image.height;
                    var context = canvas.getContext('2d');
                    context.drawImage(image, 0, 0);
                    var pixels = context.getImageData(0, 0, canvas.width, canvas.height);
                    resolve({
                        data: new Uint8ClampedArray(pixels.data),
                        width: canvas.width,
                        height: canvas.height,
                        channels: 4
                    });
                } catch (error) {
                    reject(error);
                }
            };
            image.onerror = function () { reject(new Error('image decode failed')); };
            image.src = dataUrl;
        });
    }

    /**
     * 把任意输入统一成 { data, width, height, channels, bytes, mime }。
     * bytes/mime 是原始编码数据，编码环节能直接复用时用它，避免二次压缩。
     */
    function normalizeImage(image) {
        return Promise.resolve().then(function () {
            if (!image) throw new Error(tr('error.imageRequired'));

            // 形态 3：已经是像素缓冲
            if (typeof image === 'object' && (image.data || image.pixels) && image.width && image.height) {
                var rawChannels = num(image.channels || image.components, 4);
                if (rawChannels !== 1 && rawChannels !== 3 && rawChannels !== 4) rawChannels = 4;
                var rawSource = image.data || image.pixels;
                var rawData = rawSource instanceof Uint8ClampedArray ? rawSource : new Uint8ClampedArray(
                    rawSource.buffer ? rawSource.buffer.slice(rawSource.byteOffset || 0,
                        (rawSource.byteOffset || 0) + rawSource.byteLength) : rawSource);
                var raw = { data: rawData, width: image.width, height: image.height, channels: rawChannels };
                if (rawChannels === 4) return { pixels: raw, bytes: null, mime: 'image/png' };
                return { pixels: toRgba(raw), bytes: null, mime: 'image/png' };
            }

            var dataUrl = null;
            if (typeof image === 'string') {
                if (looksLikeDataUrl(image)) dataUrl = image;
                else if (looksLikeBase64(image)) dataUrl = DreamAI.util.base64ToDataUrl(image, 'image/png');
                else throw new Error(tr('error.imageRequired'));
            } else if (typeof image === 'object' && typeof image.dataUrl === 'string') {
                dataUrl = image.dataUrl;
            }
            if (!dataUrl) throw new Error(tr('error.imageRequired'));

            var decoded = base64ToBytes(dataUrl);
            var bytes = decoded.bytes;
            var mime = decoded.mime;

            if (isPng(bytes)) {
                return decodePng(bytes).then(function (pixels) {
                    return { pixels: pixels, bytes: bytes, mime: mime || 'image/png' };
                });
            }
            return decodeViaCanvas(bytes, mime).then(function (pixels) {
                return { pixels: pixels, bytes: bytes, mime: mime };
            });
        });
    }

    /** 1/3 通道 → RGBA */
    function toRgba(image) {
        var channels = image.channels || 4;
        if (channels === 4) return image;
        var count = image.width * image.height;
        var out = new Uint8ClampedArray(count * 4);
        for (var i = 0; i < count; i++) {
            var src = i * channels;
            var dst = i * 4;
            if (channels === 1) {
                out[dst] = image.data[src];
                out[dst + 1] = image.data[src];
                out[dst + 2] = image.data[src];
                out[dst + 3] = 255;
            } else {
                out[dst] = image.data[src];
                out[dst + 1] = image.data[src + 1];
                out[dst + 2] = image.data[src + 2];
                out[dst + 3] = 255;
            }
        }
        return { data: out, width: image.width, height: image.height, channels: 4 };
    }

    /* ============================================================
     * 色彩匹配
     * ============================================================ */

    var METHOD_ALIASES = {
        meanstd: 'meanStd',
        mean: 'meanStd',
        reinhard: 'reinhard',
        histogram: 'histogram',
        hist: 'histogram',
        softlight: 'softLight',
        soft: 'softLight',
        luminance: 'luminanceOnly',
        luminanceonly: 'luminanceOnly',
        luma: 'luminanceOnly'
    };

    function normalizeMethod(method) {
        var key = String(method || 'meanStd').replace(/[^a-zA-Z]/g, '').toLowerCase();
        return METHOD_ALIASES[key] || 'meanStd';
    }

    /** 调用 ColorEngine 做低频色彩匹配；不同签名依次尝试，全部失败则抛错给上层吞掉 */
    function transferColor(source, reference, method) {
        var engine = DreamAI.ColorEngine;
        if (!engine) throw new Error('ColorEngine unavailable');

        var normalized = normalizeMethod(method);
        var fn = null;
        var fnName = 'transferMeanStd';
        if (normalized === 'histogram' && typeof engine.transferHistogram === 'function') {
            fn = engine.transferHistogram; fnName = 'transferHistogram';
        } else if (normalized === 'reinhard' && typeof engine.transferReinhard === 'function') {
            fn = engine.transferReinhard; fnName = 'transferReinhard';
        } else if (normalized === 'softLight' && typeof engine.transferSoftLight === 'function') {
            fn = engine.transferSoftLight; fnName = 'transferSoftLight';
        } else if (normalized === 'luminanceOnly' && typeof engine.alignLuminance === 'function') {
            fn = engine.alignLuminance; fnName = 'alignLuminance';
        }
        if (!fn && typeof engine.transferMeanStd === 'function') {
            fn = engine.transferMeanStd; fnName = 'transferMeanStd';
        }
        if (!fn) throw new Error('ColorEngine.' + fnName + ' unavailable');

        var request = { method: normalized };
        var result = fn(source, reference, request);

        var output = null;
        if (result && result.data && result.width) output = result;
        else if (result && result.length) {
            output = { data: result, width: source.width, height: source.height, channels: source.channels || 4 };
        }
        if (!output) throw new Error('ColorEngine.' + fnName + ' produced no result');

        // 校色只应改颜色：把原图 alpha 原样还原，蒙版/透明度判断才不会被带偏
        if ((output.channels || 4) === 4 && (source.channels || 4) === 4 && output.data !== source.data) {
            for (var i = 0; i < output.width * output.height; i++) {
                output.data[i * 4 + 3] = source.data[i * 4 + 3];
            }
        }
        return output;
    }

    /**
     * 需要时先校色，再把最终像素编码成 PNG。
     * 返回 { png, pixels }：pixels 是「校色后」的像素，写回时必须用它，
     * 否则会出现「PNG 是校色后的、落到图层的是原图」的错位。
     */
    function encodeForReturn(pixels, options) {
        var opts = options || {};
        var prepared = Promise.resolve(pixels);

        if (opts.colorMatch && opts.colorMatchReference) {
            prepared = prepared.then(function (current) {
                return normalizeImage(opts.colorMatchReference).then(function (reference) {
                    return transferColor(current, reference.pixels, opts.colorMatchMethod);
                }).catch(function (error) {
                    log('warn', 'color match skipped: ' + String(error && error.message || error));
                    return current;
                });
            });
        }

        return prepared.then(function (finalPixels) {
            return { png: encodePngForReturn(finalPixels), pixels: finalPixels };
        });
    }

    /* ============================================================
     * alpha / 蒙版
     * ============================================================ */

    /**
     * alpha 是否「有内容」。
     * 只有真正的不透明区域 + 足够比例的透明/半透明区域才算有意义：
     * 单像素或单行透明（缩放/边界噪声）不应该触发软蒙版，否则会把整图误裁。
     */
    function hasMeaningfulAlpha(image) {
        if (!image || (image.channels || 4) !== 4) return false;
        var data = image.data;
        var count = image.width * image.height;
        if (count < 1) return false;
        var step = Math.max(1, Math.floor(count / 20000));
        var sampled = 0;
        var opaque = 0;
        var transparent = 0;
        for (var i = 0; i < count; i += step) {
            var alpha = data[i * 4 + 3];
            sampled++;
            if (alpha >= 250) opaque++;
            else if (alpha <= 8) transparent++;
        }
        if (!opaque) return false;
        // 透明面积至少 2% 且至少 8 个采样点，才认为图本身带软边
        return transparent >= 8 && transparent / sampled >= 0.02;
    }

    /** 抽出 alpha 作为灰度像素（255 = 保留图层） */
    function buildAlphaMaskPixels(image) {
        var count = image.width * image.height;
        var out = new Uint8ClampedArray(count);
        for (var i = 0; i < count; i++) out[i] = image.data[i * 4 + 3];
        return { data: out, width: image.width, height: image.height, channels: 1 };
    }

    /**
     * 通过矩形选区建图层蒙版：先按 shrink 内缩，再羽化；
     * 若图本身带有效 alpha，则把 alpha 贴进蒙版通道做软蒙版（羽化作为兜底）。
     */
    function applyMask(ps, doc, layer, bounds, options, alphaPixels) {
        var opts = options || {};
        var shrink = Math.max(0, Math.round(num(opts.shrink, 0)));
        var feather = Math.max(0, num(opts.feather, 0));
        if (!(shrink > 0) && !(feather > 0) && !alphaPixels) return Promise.resolve();

        var right = bounds.left + bounds.width;
        var bottom = bounds.top + bounds.height;

        return batchPlay({
            _obj: 'set',
            _target: [{ _ref: 'channel', _property: 'selection' }],
            to: {
                _obj: 'rectangle',
                top: { _unit: 'pixelsUnit', _value: bounds.top },
                left: { _unit: 'pixelsUnit', _value: bounds.left },
                bottom: { _unit: 'pixelsUnit', _value: bottom },
                right: { _unit: 'pixelsUnit', _value: right }
            }
        }).then(function () {
            if (!(shrink > 0)) return null;
            return batchPlay({ _obj: 'contract', by: { _unit: 'pixelsUnit', _value: shrink } })
                .catch(function (error) {
                    log('warn', 'mask contract failed: ' + String(error && error.message || error));
                    return null;
                });
        }).then(function () {
            return batchPlay({
                _obj: 'make',
                new: { _class: 'channel' },
                at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
                using: { _enum: 'userMaskEnabled', _value: 'revealSelection' }
            });
        }).then(function () {
            if (!alphaPixels) return null;
            return paintMaskAlpha(ps, doc, layer, bounds, alphaPixels);
        }).then(function (painted) {
            if (painted || !(feather > 0)) return null;
            return batchPlay({
                _obj: 'select',
                _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }],
                makeVisible: false
            }).then(function () {
                return batchPlay({ _obj: 'gaussianBlur', radius: { _unit: 'pixelsUnit', _value: feather } });
            }).catch(function (error) {
                log('warn', 'mask feather failed: ' + String(error && error.message || error));
                return null;
            });
        }).then(function () {
            return batchPlay({
                _obj: 'set',
                _target: [{ _ref: 'channel', _property: 'selection' }],
                to: { _enum: 'ordinal', _value: 'none' }
            });
        }).then(function () {
            // 建完蒙版后选区落在蒙版通道上，把选中还原到图层本身
            return batchPlay({
                _obj: 'select',
                _target: [{ _ref: 'layer', _id: layer.id }],
                makeVisible: false
            });
        }).catch(function (error) {
            log('warn', 'mask creation failed, layer kept without mask: ' + String(error && error.message || error));
            return null;
        });
    }

    /** 把 alpha 写进蒙版通道（失败返回 false，交给矩形蒙版兜底） */
    function paintMaskAlpha(ps, doc, layer, bounds, alphaPixels) {
        var maskChannelId = null;
        return batchPlay({
            _obj: 'get',
            _target: [{ _property: 'channelID' }, { _ref: 'channel', _enum: 'channel', _value: 'mask' }]
        }).then(function (result) {
            var first = result && result[0];
            if (first && first.channelID !== undefined) maskChannelId = num(first.channelID, NaN);
            if (!isFinite(maskChannelId)) throw new Error('mask channel id unavailable');
            return ps.imaging.createImageDataFromBuffer(alphaPixels.data, {
                width: alphaPixels.width,
                height: alphaPixels.height,
                components: 1,
                chunky: true,
                colorSpace: 'Grayscale'
            });
        }).then(function (imageData) {
            return Promise.resolve(ps.imaging.putPixels({
                documentID: doc.id,
                layerID: layer.id,
                channelID: maskChannelId,
                imageData: imageData,
                replace: true,
                targetBounds: { left: bounds.left, top: bounds.top }
            })).then(function () {
                dispose(imageData);
                return true;
            }, function (error) {
                dispose(imageData);
                throw error;
            });
        }).catch(function (error) {
            log('warn', 'alpha mask write skipped: ' + String(error && error.message || error));
            return false;
        });
    }

    /* ============================================================
     * PNG 编码（自带 zip 兜底：PhotoEncode 的 deflate 有问题时也能出图）
     * ============================================================ */

    var CRC_TABLE = null;

    function crc32(bytes) {
        if (!CRC_TABLE) {
            CRC_TABLE = new Uint32Array(256);
            for (var n = 0; n < 256; n++) {
                var c = n;
                for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                CRC_TABLE[n] = c >>> 0;
            }
        }
        var value = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i++) value = CRC_TABLE[(value ^ bytes[i]) & 0xFF] ^ (value >>> 8);
        return (value ^ 0xFFFFFFFF) >>> 0;
    }

    function adler32(bytes) {
        var a = 1;
        var b = 0;
        for (var i = 0; i < bytes.length; i++) {
            a = (a + bytes[i]) % 65521;
            b = (b + a) % 65521;
        }
        return ((b << 16) | a) >>> 0;
    }

    /** zlib 容器 + 合法 deflate「stored」块：不压缩，但保证任何解码器都能读 */
    function deflateStored(bytes) {
        var MAX = 65535;
        var blocks = Math.max(1, Math.ceil(bytes.length / MAX));
        var out = new Uint8Array(2 + blocks * 5 + bytes.length + 4);
        out[0] = 0x78;
        out[1] = 0x01;
        var pos = 2;
        var offset = 0;
        while (offset < bytes.length || (bytes.length === 0 && offset === 0)) {
            var size = Math.min(MAX, bytes.length - offset);
            var last = offset + size >= bytes.length ? 1 : 0;
            out[pos++] = last;
            out[pos++] = size & 0xFF;
            out[pos++] = (size >>> 8) & 0xFF;
            out[pos++] = (~size) & 0xFF;
            out[pos++] = ((~size) >>> 8) & 0xFF;
            out.set(bytes.subarray(offset, offset + size), pos);
            pos += size;
            offset += size;
            if (size === 0) break;
        }
        var checksum = adler32(bytes);
        out[pos++] = (checksum >>> 24) & 0xFF;
        out[pos++] = (checksum >>> 16) & 0xFF;
        out[pos++] = (checksum >>> 8) & 0xFF;
        out[pos++] = checksum & 0xFF;
        return out.subarray(0, pos);
    }

    function pngChunk(type, data) {
        var payload = data || new Uint8Array(0);
        var out = new Uint8Array(12 + payload.length);
        var length = payload.length;
        out[0] = (length >>> 24) & 0xFF;
        out[1] = (length >>> 16) & 0xFF;
        out[2] = (length >>> 8) & 0xFF;
        out[3] = length & 0xFF;
        for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        out.set(payload, 8);
        var crcInput = new Uint8Array(4 + payload.length);
        crcInput.set(out.subarray(4, 8), 0);
        crcInput.set(payload, 4);
        var value = crc32(crcInput);
        out[8 + payload.length] = (value >>> 24) & 0xFF;
        out[9 + payload.length] = (value >>> 16) & 0xFF;
        out[10 + payload.length] = (value >>> 8) & 0xFF;
        out[11 + payload.length] = value & 0xFF;
        return out;
    }

    /** 自研 PNG 编码（RGBA / RGB），不依赖 DreamAI.PhotoEncode */
    function encodePngSelf(image) {
        var width = Math.max(1, Math.round(num(image && image.width, 1)));
        var height = Math.max(1, Math.round(num(image && image.height, 1)));
        var channels = num(image && image.channels, 4) === 4 ? 4 : 3;
        var source = (image && image.data) || new Uint8Array(width * height * channels);
        var stride = width * channels;
        var raw = new Uint8Array((stride + 1) * height);
        for (var y = 0; y < height; y++) {
            raw[y * (stride + 1)] = 0;
            for (var x = 0; x < stride; x++) {
                var value = source[y * stride + x];
                raw[y * (stride + 1) + 1 + x] = value === undefined ? 0 : value;
            }
        }

        var ihdr = new Uint8Array(13);
        ihdr[0] = (width >>> 24) & 0xFF; ihdr[1] = (width >>> 16) & 0xFF;
        ihdr[2] = (width >>> 8) & 0xFF; ihdr[3] = width & 0xFF;
        ihdr[4] = (height >>> 24) & 0xFF; ihdr[5] = (height >>> 16) & 0xFF;
        ihdr[6] = (height >>> 8) & 0xFF; ihdr[7] = height & 0xFF;
        ihdr[8] = 8;
        ihdr[9] = channels === 4 ? 6 : 2;
        ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

        var parts = [
            new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            pngChunk('IHDR', ihdr),
            pngChunk('sRGB', new Uint8Array([0])),
            pngChunk('gAMA', new Uint8Array([0x00, 0x00, 0xB1, 0x8F])),
            pngChunk('IDAT', deflateStored(raw)),
            pngChunk('IEND', new Uint8Array(0))
        ];

        var total = 0;
        for (var p = 0; p < parts.length; p++) total += parts[p].length;
        var png = new Uint8Array(total);
        var cursor = 0;
        for (var q = 0; q < parts.length; q++) {
            png.set(parts[q], cursor);
            cursor += parts[q].length;
        }
        return png;
    }

    /** 校验一段 PNG 的 IDAT 是否是可解压的合法 zlib/deflate 流 */
    function pngIdatIsValid(png) {
        try {
            var cursor = 8;
            var parts = [];
            var length = 0;
            while (cursor + 8 <= png.length) {
                var size = ((png[cursor] << 24) | (png[cursor + 1] << 16) |
                    (png[cursor + 2] << 8) | png[cursor + 3]) >>> 0;
                var type = String.fromCharCode(png[cursor + 4], png[cursor + 5], png[cursor + 6], png[cursor + 7]);
                if (type === 'IDAT') {
                    parts.push(png.subarray(cursor + 8, cursor + 8 + size));
                    length += size;
                }
                cursor = cursor + 12 + size;
            }
            if (!length) return false;
            var packed = new Uint8Array(length);
            var offset = 0;
            for (var i = 0; i < parts.length; i++) {
                packed.set(parts[i], offset);
                offset += parts[i].length;
            }
            var inflated = inflateRaw(packed);
            return inflated.length > 0;
        } catch (error) {
            return false;
        }
    }

    /**
     * 编码回写用的 PNG。
     * 优先用 DreamAI.PhotoEncode（压缩率好），但它产出的字节必须是可解压的合法 PNG；
     * 一旦校验不通过就用自己的 stored-deflate 编码器兜底，保证回写永远不会因为
     * 编码器缺陷而失败。
     */
    function encodePngForReturn(image) {
        var rgba = (image.channels || 4) === 4 ? image : toRgba(image);
        var input = {
            data: rgba.data,
            width: rgba.width,
            height: rgba.height,
            channels: rgba.channels || 4
        };
        var encode = DreamAI.PhotoEncode && DreamAI.PhotoEncode.encodePng;
        if (typeof encode === 'function') {
            try {
                var bytes = encode(input);
                if (bytes && bytes.length > 8 && isPng(bytes) && pngIdatIsValid(bytes)) return bytes;
                log('warn', 'PhotoEncode.encodePng produced an invalid deflate stream; using built-in encoder');
            } catch (error) {
                log('warn', 'PhotoEncode.encodePng failed: ' + String(error && error.message || error));
            }
        }
        return encodePngSelf(input);
    }

    /* ============================================================
     * 宿主小工具
     * ============================================================ */

    function batchPlay(descriptors, options) {
        var ps = requirePs();
        var list = Array.isArray(descriptors) ? descriptors : [descriptors];
        return Promise.resolve(ps.action.batchPlay(list, options || {})).then(function (result) {
            return Array.isArray(result) ? result : (result ? [result] : []);
        });
    }

    function dispose(imageData) {
        try {
            if (imageData && typeof imageData.dispose === 'function') imageData.dispose();
        } catch (error) { /* 忽略 */ }
    }

    /** 目标文档：指定了 id 就必须命中，否则抛 error.docClosed */
    function resolveDocument(ps, options) {
        var opts = options || {};
        var docs = (ps.app && ps.app.documents) || [];
        var active = (ps.app && ps.app.activeDocument) || null;

        if (opts.documentId !== undefined && opts.documentId !== null && opts.documentId !== '') {
            var requested = num(opts.documentId, NaN);
            if (!isFinite(requested)) throw new Error(tr('error.docClosed'));
            for (var i = 0; i < docs.length; i++) {
                if (docs[i] && num(docs[i].id, NaN) === requested) return docs[i];
            }
            throw new Error(tr('error.docClosed'));
        }

        if (active) return active;
        for (var j = 0; j < docs.length; j++) if (docs[j]) return docs[j];
        throw new Error(tr('error.noDocument'));
    }

    function resolveBounds(input, image) {
        var canvasWidth = 0;
        var canvasHeight = 0;
        try {
            var active = getPs() && getPs().app && getPs().app.activeDocument;
            if (active) {
                canvasWidth = num(active.width, 0);
                canvasHeight = num(active.height, 0);
            }
        } catch (error) { /* 读不到画布尺寸不影响 */ }

        function makeRect(left, top, width, height) {
            var l = Math.round(num(left, 0));
            var t = Math.round(num(top, 0));
            var w = Math.max(1, Math.round(num(width, 0)));
            var h = Math.max(1, Math.round(num(height, 0)));
            if (canvasWidth > 0 && canvasHeight > 0) {
                w = Math.min(w, Math.round(canvasWidth));
                h = Math.min(h, Math.round(canvasHeight));
                l = Math.max(0, Math.min(l, Math.round(canvasWidth) - w));
                t = Math.max(0, Math.min(t, Math.round(canvasHeight) - h));
            }
            return { left: l, top: t, width: w, height: h };
        }

        var bounds = input || {};
        var hasWidth = isFinite(Number(bounds.width)) && Number(bounds.width) > 0;
        var hasHeight = isFinite(Number(bounds.height)) && Number(bounds.height) > 0;
        if (hasWidth && hasHeight) {
            return makeRect(bounds.left, bounds.top, bounds.width, bounds.height);
        }
        if (isFinite(Number(bounds.left)) && isFinite(Number(bounds.top)) &&
            isFinite(Number(bounds.right)) && Number(bounds.right) > Number(bounds.left)) {
            return makeRect(bounds.left, bounds.top,
                Number(bounds.right) - Number(bounds.left),
                Number(bounds.bottom) - Number(bounds.top));
        }
        if (!bounds || input === undefined || input === null) {
            return makeRect(0, 0, image.width, image.height);
        }
        return makeRect(bounds.left, bounds.top, image.width, image.height);
    }

    /** 默认图层名 Dream AI <#n>；编号按文档分别递增 */
    function nextLayerName(documentId, requested) {
        var custom = typeof requested === 'string' ? requested.trim() : '';
        if (custom) return custom;
        var key = String(documentId === undefined || documentId === null ? 'unknown' : documentId);
        layerCounters[key] = (layerCounters[key] || 0) + 1;
        if (DreamAI.I18n && typeof DreamAI.I18n.t === 'function') {
            return DreamAI.I18n.t('return.layerNamePattern', { n: layerCounters[key] });
        }
        return 'Dream AI ' + layerCounters[key];
    }

    function blendModeConstant(blendMode) {
        if (String(blendMode || '').toLowerCase() !== 'screen') return undefined;
        try {
            var ps = getPs();
            var constants = ps && ps.constants;
            if (constants && constants.BlendMode) return constants.BlendMode.SCREEN;
        } catch (error) { /* 常量表缺失时交给 batchPlay 设置 */ }
        return undefined;
    }

    /* ============================================================
     * 主流程
     * ============================================================ */

    /**
     * 把结果写回文档。
     * @param {string|Object} image data URL / { dataUrl } / { data,width,height,channels } / 裸 base64
     * @param {Object} [options] 见 docs/INTERNALS.md 第 5 节
     * @returns {Promise<{layerName:string, layerId:number, bounds:Object}>}
     */
    function place(image, options) {
        var opts = options || {};
        var layerName = '';
        var documentId = opts.documentId;
        var ps = null;

        // 用 Promise 包一层：无宿主时必须 reject 而不是同步 throw
        return Promise.resolve().then(function () {
            ps = requirePs();
            return normalizeImage(image);
        }).then(function (normalized) {
            var pixels = normalized.pixels.channels === 4 ? normalized.pixels : toRgba(normalized.pixels);
            var bounds = resolveBounds(opts.bounds, pixels);
            var needResize = pixels.width !== bounds.width || pixels.height !== bounds.height;
            var resized = needResize
                ? DreamAI.PhotoEncode.resizeImage(pixels, bounds.width, bounds.height)
                : pixels;
            if (resized.channels !== 4) resized = toRgba(resized);

            return encodeForReturn(resized, opts).then(function (prepared) {
                var finalPixels = prepared.pixels;
                if (finalPixels.channels !== 4) finalPixels = toRgba(finalPixels);
                // alpha 蒙版基于最终像素（校色只改颜色，alpha 原样保留）
                var alphaPixels = hasMeaningfulAlpha(finalPixels) ? buildAlphaMaskPixels(finalPixels) : null;

                return DreamAI.psLock.acquire(function () {
                    return ps.core.executeAsModal(function () {
                        var doc = null;
                        var layer = null;
                        var rgbaData = null;

                        return Promise.resolve().then(function () {
                            doc = resolveDocument(ps, opts);
                            documentId = doc.id;
                            layerName = nextLayerName(documentId, opts.layerName);
                            // 明确切到目标文档，避免用户中途切换活动文档导致贴错地方
                            return batchPlay({
                                _obj: 'select',
                                _target: [{ _ref: 'document', _id: doc.id }],
                                makeVisible: false
                            }).catch(function () { return null; });
                        }).then(function () {
                            var blendMode = blendModeConstant(opts.blendMode);
                            var createOptions = { name: layerName };
                            if (blendMode !== undefined) createOptions.blendMode = blendMode;
                            if (typeof doc.createPixelLayer === 'function') {
                                return Promise.resolve(doc.createPixelLayer(createOptions));
                            }
                            return Promise.resolve(doc.createLayer(createOptions));
                        }).then(function (created) {
                            layer = created;
                            if (!layer) throw new Error(tr('error.returnLayerFailed'));
                            return ps.imaging.createImageDataFromBuffer(finalPixels.data, {
                                width: finalPixels.width,
                                height: finalPixels.height,
                                components: 4,
                                chunky: true,
                                colorSpace: 'RGB',
                                colorProfile: 'sRGB IEC61966-2.1'
                            });
                        }).then(function (imageData) {
                            rgbaData = imageData;
                            return ps.imaging.putPixels({
                                documentID: doc.id,
                                layerID: layer.id,
                                imageData: rgbaData,
                                replace: true,
                                targetBounds: { left: bounds.left, top: bounds.top }
                            });
                        }).then(function () {
                            // 显式设置混合模式（createPixelLayer 的 blendMode 参数并非所有版本都生效）
                            if (String(opts.blendMode || '').toLowerCase() !== 'screen') return null;
                            return batchPlay({
                                _obj: 'set',
                                _target: [{ _ref: 'layer', _id: layer.id }],
                                to: {
                                    _obj: 'layer',
                                    mode: { _enum: 'blendMode', _value: 'screen' },
                                    opacity: { _unit: 'percentUnit', _value: 100 }
                                }
                            }).catch(function (error) {
                                log('warn', 'screen blend set failed: ' + String(error && error.message || error));
                                return null;
                            });
                        }).then(function () {
                            // 蒙版：内缩 / 羽化 / alpha 软蒙版
                            return applyMask(ps, doc, layer, bounds, opts, alphaPixels);
                        }).then(function () {
                            // 改名兜底（make 阶段的 name 在部分版本不被采纳）
                            return batchPlay({
                                _obj: 'set',
                                _target: [{ _ref: 'layer', _id: layer.id }],
                                to: { _obj: 'layer', name: layerName }
                            }).catch(function () { return null; });
                        }).then(function () {
                            if (typeof opts.group !== 'string' || !opts.group.trim()) return null;
                            return makeGroup(layer, opts.group.trim());
                        }).then(function () {
                            return {
                                layerName: layerName,
                                layerId: num(layer.id, 0),
                                bounds: {
                                    left: bounds.left,
                                    top: bounds.top,
                                    width: finalPixels.width,
                                    height: finalPixels.height
                                }
                            };
                        }).then(function (result) {
                            dispose(rgbaData);
                            rgbaData = null;
                            return result;
                        }, function (error) {
                            dispose(rgbaData);
                            rgbaData = null;
                            throw error;
                        });
                    }, { commandName: 'Dream AI 回写图层' });
                }, opts.taskId || 'photo-return:place', { timeout: PLACE_TIMEOUT_MS });
            });
        }).then(function (result) {
            if (DreamAI.bus && typeof DreamAI.bus.emit === 'function') {
                DreamAI.bus.emit('return:done', result);
            }
            return result;
        }, function (error) {
            var reason = String((error && error.message) || error || '');
            if (DreamAI.bus && typeof DreamAI.bus.emit === 'function') {
                DreamAI.bus.emit('return:failed', { reason: reason, documentId: documentId });
            }
            throw new Error(tr('error.returnFailed', { reason: reason }));
        });
    }

    /** 选中新图层并打成同名图层组 */
    function makeGroup(layer, name) {
        return batchPlay({
            _obj: 'select',
            _target: [{ _ref: 'layer', _id: layer.id }],
            makeVisible: false
        }).then(function () {
            return batchPlay({
                _obj: 'make',
                _target: [{ _ref: 'layerSection' }],
                from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
                name: name
            });
        }).then(function () {
            // 双保险改名：部分 PS 版本忽略 make 顶层 name
            return batchPlay({
                _obj: 'set',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                to: { _obj: 'layer', name: name }
            }).catch(function () { return null; });
        }).catch(function (error) {
            log('warn', 'group creation failed: ' + String(error && error.message || error));
            return null;
        });
    }

    DreamAI.PhotoReturn = {
        isAvailable: isAvailable,
        place: place,
        /** 供其他模块复用（纯函数/纯解码） */
        _internal: {
            normalizeImage: normalizeImage,
            decodePng: decodePng,
            deflateStored: deflateStored,
            encodePngSelf: encodePngSelf,
            encodePngForReturn: encodePngForReturn,
            inflateRaw: inflateRaw,
            hasMeaningfulAlpha: hasMeaningfulAlpha,
            normalizeMethod: normalizeMethod,
            resolveBounds: resolveBounds
        }
    };
})(typeof window !== 'undefined' ? window : this);
