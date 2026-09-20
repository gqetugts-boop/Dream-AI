/*
 * core/photo-io.js — 从 Photoshop 读取
 *
 * 职责：
 *   - 探测选区（三种降级路径），抓取像素并按采样上限缩放，编码成 PNG data URL，
 *     组装成 INTERNALS 第 1 节约定的 selection 形状；
 *   - 读取文档元信息（位深、色彩配置）与前景色；
 *   - 提供一组单步文档操作（取消选区 / 复制图层 / 反选 / 填充 / 自由变换 /
 *     合并可见 / 拼合 / 切换文档）。
 * 输入：可选的 { documentId, maxEdge }；无参时用活动文档。
 * 输出：Promise；readSelection 额外广播 selection:change { sample }。
 * 边界：
 *   - 浏览器预览（无 Photoshop）下 isAvailable() 为 false，所有方法 reject
 *     error.noPhotoshop；
 *   - 顶层不 require('photoshop')，可在 Node 下加载；
 *   - 所有宿主调用都走 DreamAI.psLock.acquire + core.executeAsModal；
 *   - 元信息读取失败绝不影响整次抓图（降级为默认值）。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.PhotoIO) return;

    /** 采样最长边默认上限 */
    var DEFAULT_SAMPLE_MAX_EDGE = 1536;
    /** 单步文档操作的锁超时（30 秒足够） */
    var STEP_TIMEOUT_MS = 30000;
    /** 抓图整体超时（大图 + 16bit 转换可能较慢） */
    var READ_TIMEOUT_MS = 300000;

    /* ============================================================
     * 基础工具
     * ============================================================ */

    /** 本地化文案；i18n 未加载时回退成键名，便于早期定位 */
    function tr(key, params) {
        if (DreamAI.I18n && typeof DreamAI.I18n.t === 'function') return DreamAI.I18n.t(key, params);
        return key;
    }

    function log(level, message, meta) {
        try {
            if (DreamAI.logbus && typeof DreamAI.logbus[level] === 'function') {
                DreamAI.logbus[level](message, meta);
            } else if (global.console) {
                global.console.log('[photo-io] ' + message + (meta === undefined ? '' : ' ' + JSON.stringify(meta)));
            }
        } catch (error) { /* 日志失败不影响主流程 */ }
    }

    function num(value, fallback) {
        var n = Number(value);
        return isFinite(n) ? n : fallback;
    }

    function isInt(value) {
        return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
    }

    /** 取宿主模块（每次调用时取，避免加载顺序问题） */
    function getPs() {
        return (DreamAI.host && DreamAI.host.modules && DreamAI.host.modules.photoshop) || null;
    }

    function isAvailable() {
        var ps = getPs();
        return !!(DreamAI.host && DreamAI.host.hasPhotoshop && ps && ps.app && ps.core && ps.action);
    }

    function requirePs() {
        if (!isAvailable()) throw new Error(tr('error.noPhotoshop'));
        return getPs();
    }

    /** batchPlay 的薄封装，接受单条或多条描述符 */
    function batchPlay(descriptors, options) {
        var ps = requirePs();
        var list = Array.isArray(descriptors) ? descriptors : [descriptors];
        return Promise.resolve(ps.action.batchPlay(list, options || {})).then(function (result) {
            return Array.isArray(result) ? result : (result ? [result] : []);
        });
    }

    /** 在 executeAsModal 里跑一段带锁的操作 */
    function withModal(taskId, commandName, worker) {
        var ps = requirePs();
        return DreamAI.psLock.acquire(function () {
            return ps.core.executeAsModal(function (executionContext) {
                return worker(executionContext);
            }, { commandName: commandName });
        }, taskId, { timeout: STEP_TIMEOUT_MS });
    }

    /* ============================================================
     * 文档与选区
     * ============================================================ */

    /** 取目标文档：优先 options.documentId，其次活动文档 */
    function resolveDocument(ps, options) {
        var opts = options || {};
        var requested = opts.documentId;
        if (requested !== undefined && requested !== null && requested !== '') {
            var id = num(requested, NaN);
            var docs = (ps.app && ps.app.documents) || [];
            for (var i = 0; i < docs.length; i++) {
                if (docs[i] && num(docs[i].id, -1) === id) return docs[i];
            }
            throw new Error(tr('error.noDocument'));
        }
        var active = ps.app && ps.app.activeDocument;
        if (!active) throw new Error(tr('error.noDocument'));
        return active;
    }

    /** 把 PS 返回的 coordinate / {_value} / 数字统一成数字 */
    function coord(value) {
        if (value === undefined || value === null) return NaN;
        if (typeof value === 'number') return value;
        if (typeof value === 'object' && value._value !== undefined) return numberOfString(value._value);
        return numberOfString(value);
    }

    /** 把矩形压成一行日志，避免打印整个对象 */
    function rectSummary(rect) {
        if (!rect) return '';
        return [rect.left, rect.top, rect.right, rect.bottom].join(',') +
            ' (' + rect.width + 'x' + rect.height + ')';
    }

    function numberOfString(value) {
        if (typeof value === 'number') return value;
        var n = Number(String(value).replace(/[^0-9.eE+-]/g, ''));
        return isFinite(n) ? n : NaN;
    }

    /**
     * 规范化矩形：四边取整，并用 width/height 校正 right/bottom。
     * 宽或高不足 1 像素视为退化矩形，返回 null。
     */
    function normalizeRect(left, top, right, bottom, width, height) {
        var l = Math.round(num(left, NaN));
        var t = Math.round(num(top, NaN));
        var r = Math.round(num(right, NaN));
        var b = Math.round(num(bottom, NaN));
        var w = Math.round(num(width, NaN));
        var h = Math.round(num(height, NaN));

        if (!isFinite(l) || !isFinite(t)) return null;
        if (!isFinite(r) && isFinite(w)) r = l + w;
        if (!isFinite(b) && isFinite(h)) b = t + h;
        if (!isFinite(r) || !isFinite(b)) return null;

        if (isFinite(w) && w > 0 && Math.abs((r - l) - w) > 1) r = l + w;
        if (isFinite(h) && h > 0 && Math.abs((b - t) - h) > 1) b = t + h;

        var outW = r - l;
        var outH = b - t;
        if (!(outW >= 1) || !(outH >= 1)) return null;
        return {
            left: l,
            top: t,
            right: l + outW,
            bottom: t + outH,
            width: outW,
            height: outH
        };
    }

    /** 降级路径 1：DOM API doc.selection.bounds */
    function boundsFromDom(doc) {
        var bounds = doc.selection && doc.selection.bounds;
        if (!bounds) return null;
        return normalizeRect(bounds.left, bounds.top, bounds.right, bounds.bottom,
            bounds.width, bounds.height);
    }

    /** 降级路径 2：batchPlay get selection */
    function boundsFromSelectionGet(doc) {
        return batchPlay({
            _obj: 'get',
            _target: [{ _property: 'selection' }, { _ref: 'document', _id: doc.id }]
        }).then(function (result) {
            var first = result && result[0];
            var sel = first && (first.selection || first);
            if (!sel) return null;
            var left = sel.left !== undefined ? sel.left : sel._left;
            var top = sel.top !== undefined ? sel.top : sel._top;
            var right = sel.right !== undefined ? sel.right : sel._right;
            var bottom = sel.bottom !== undefined ? sel.bottom : sel._bottom;
            return normalizeRect(coord(left), coord(top), coord(right), coord(bottom));
        });
    }

    /** 降级路径 3：读取选区通道的 bounds */
    function boundsFromChannel(doc) {
        return batchPlay({
            _obj: 'get',
            _target: [{ _property: 'bounds' }, { _ref: 'channel', _enum: 'channel', _value: 'selection' }]
        }).then(function (result) {
            var first = result && result[0];
            if (!first || !first.bounds) return null;
            var b = first.bounds;
            if (b._obj === 'rectangle' || b.left !== undefined) {
                return normalizeRect(coord(b.left), coord(b.top), coord(b.right), coord(b.bottom),
                    coord(b.width), coord(b.height));
            }
            return null;
        });
    }

    /**
     * 三种方式依次降级探测选区。
     * 只有在「三种方式全都没给出矩形」时才判定为无选区。
     */
    function probeBounds(doc) {
        var lastError = null;
        // 每一步都记日志：三路探测走的是不同的 UXP 能力，哪一路可用、
        // 哪一路报什么错，是判断"选区读不到"根因的唯一依据。
        return Promise.resolve().then(function () {
            return boundsFromDom(doc);
        }).then(function (rect) {
            if (rect) log('info', '选区边界：DOM 方式成功', rectSummary(rect));
            return rect;
        }).catch(function (error) {
            lastError = error;
            log('info', '选区边界：DOM 方式失败', String(error && error.message || error));
            return null;
        }).then(function (rect) {
            if (rect) return rect;
            return boundsFromSelectionGet(doc).then(function (next) {
                if (next) log('info', '选区边界：batchPlay selection 方式成功', rectSummary(next));
                return next;
            }).catch(function (error) {
                lastError = error;
                log('info', '选区边界：batchPlay selection 方式失败', String(error && error.message || error));
                return null;
            });
        }).then(function (rect) {
            if (rect) return rect;
            return boundsFromChannel(doc).then(function (next) {
                if (next) log('info', '选区边界：通道方式成功', rectSummary(next));
                return next;
            }).catch(function (error) {
                lastError = error;
                log('info', '选区边界：通道方式失败', String(error && error.message || error));
                return null;
            });
        }).then(function (rect) {
            if (rect) return rect;
            if (lastError) log('warn', '选区边界三路探测全部失败', String(lastError && lastError.message || lastError));
            else log('warn', '选区边界三路探测均未返回矩形');
            throw new Error(tr('error.emptySelection'));
        });
    }

    /* ============================================================
     * 元信息
     * ============================================================ */

    function depthToNumber(value) {
        if (typeof value === 'number' && isFinite(value)) return value;
        if (value && typeof value === 'object') {
            if (value._value !== undefined) return depthToNumber(value._value);
            if (value.value !== undefined) return depthToNumber(value.value);
        }
        var text = String(value || '');
        if (/bitDepth32|thirtyTwo|32/.test(text)) return 32;
        if (/bitDepth16|sixteen|16/.test(text)) return 16;
        if (/bitDepth8|eight|8/.test(text)) return 8;
        return 8;
    }

    /** 位深：DOM bitsPerChannel → batchPlay depth → batchPlay bitsPerChannel */
    function readBitDepth(doc) {
        var fromDom = NaN;
        try {
            fromDom = num(doc.bitsPerChannel, NaN);
        } catch (error) { fromDom = NaN; }
        if (isFinite(fromDom) && fromDom > 0) return Promise.resolve(depthToNumber(fromDom));

        return batchPlay({
            _obj: 'get',
            _target: [{ _property: 'depth' }, { _ref: 'document', _id: doc.id }]
        }).catch(function () {
            return [];
        }).then(function (result) {
            var first = result && result[0];
            if (first && first.depth !== undefined) return depthToNumber(first.depth);
            return batchPlay({
                _obj: 'get',
                _target: [{ _property: 'bitsPerChannel' }, { _ref: 'document', _id: doc.id }]
            }).catch(function () {
                return [];
            }).then(function (second) {
                var row = second && second[0];
                if (row && row.bitsPerChannel !== undefined) return depthToNumber(row.bitsPerChannel);
                return 8;
            });
        });
    }

    /** 色彩配置名：读不到就返回空串（不失败） */
    function readColorProfile(doc) {
        return batchPlay({
            _obj: 'get',
            _target: [{ _property: 'colorProfileName' }, { _ref: 'document', _id: doc.id }]
        }).catch(function () {
            return [];
        }).then(function (result) {
            var first = result && result[0];
            if (!first) return '';
            var value = first.colorProfileName !== undefined ? first.colorProfileName : first.profile;
            if (typeof value === 'string') return value;
            if (value && value._value !== undefined) return String(value._value);
            return '';
        });
    }

    /* ============================================================
     * 像素抓取
     * ============================================================ */

    /** 取采样上限：App.settings.behavior.sampleMaxEdge，读不到用默认值 */
    function readSampleMaxEdge(options) {
        // 设置可能还没就绪（或结构不完整），任何一步拿不到就用默认值，不能抛
        var opts = options || {};
        var override = num(opts.maxEdge, NaN);
        if (isFinite(override) && override >= 1) return Math.floor(override);

        var settings = null;
        try {
            if (DreamAI.App && DreamAI.App.settings) settings = DreamAI.App.settings;
            else if (DreamAI.App && typeof DreamAI.App.get === 'function') settings = DreamAI.App.get('settings');
            else if (DreamAI.Store && typeof DreamAI.Store.read === 'function') settings = DreamAI.Store.read('settings', {});
        } catch (error) { settings = null; }

        var value = NaN;
        if (settings && settings.behavior) value = num(settings.behavior.sampleMaxEdge, NaN);
        if (!isFinite(value) || value < 1) value = DEFAULT_SAMPLE_MAX_EDGE;
        return Math.floor(value);
    }

    /** 按最长边上限算目标尺寸（只缩不放） */
    function fitTargetSize(width, height, maxEdge) {
        var w = Math.max(1, Math.round(width));
        var h = Math.max(1, Math.round(height));
        var longest = Math.max(w, h);
        if (!(maxEdge > 0) || longest <= maxEdge) return { width: w, height: h, scaled: false };
        var ratio = maxEdge / longest;
        return {
            width: Math.max(1, Math.round(w * ratio)),
            height: Math.max(1, Math.round(h * ratio)),
            scaled: true
        };
    }

    /** 从 imaging 返回体里取像素缓冲字节 */
    function extractBytes(imageData) {
        return Promise.resolve().then(function () {
            if (!imageData) throw new Error('imageData missing');
            if (typeof imageData.getData === 'function') return imageData.getData({});
            if (typeof imageData.data === 'function') return imageData.data({});
            return imageData.data;
        }).then(function (raw) {
            if (!raw) throw new Error('pixel buffer missing');
            if (raw instanceof Uint8Array) return raw;
            if (typeof Uint16Array !== 'undefined' && raw instanceof Uint16Array) return raw;
            if (typeof Float32Array !== 'undefined' && raw instanceof Float32Array) return raw;
            if (typeof ArrayBuffer !== 'undefined' && raw instanceof ArrayBuffer) return new Uint8Array(raw);
            if (raw.buffer) return new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength || undefined);
            return new Uint8Array(raw);
        });
    }

    /** 线性光 → sRGB gamma（32bit 文档需要，否则整体偏暗） */
    function linearToSrgb(value) {
        var v = value;
        if (v < 0) v = 0;
        if (v > 1) v = 1;
        var s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        return Math.max(0, Math.min(255, Math.round(s * 255)));
    }

    /**
     * 把任意位深/字节序的像素缓冲统一成 8bit。
     * Photoshop 的 16bit 文档值域是 0-32768（不是 0-65535），需要采样判断。
     */
    function normalizeTo8Bit(raw, expectedLength) {
        var bytes = raw;

        if (typeof Uint16Array !== 'undefined' && bytes instanceof Uint16Array) {
            var sample16 = Math.min(bytes.length, 4096);
            var max16 = 0;
            for (var s16 = 0; s16 < sample16; s16++) if (bytes[s16] > max16) max16 = bytes[s16];
            var psRange = max16 > 0 && max16 <= 32769;
            var out16 = new Uint8Array(expectedLength);
            for (var i16 = 0; i16 < expectedLength && i16 < bytes.length; i16++) {
                out16[i16] = psRange
                    ? Math.min(255, Math.round(bytes[i16] * 255 / 32768))
                    : Math.min(255, (bytes[i16] + 128) >> 8);
            }
            return out16;
        }

        if (typeof Float32Array !== 'undefined' && bytes instanceof Float32Array) {
            var out32 = new Uint8Array(expectedLength);
            for (var i32 = 0; i32 < expectedLength && i32 < bytes.length; i32++) {
                out32[i32] = linearToSrgb(bytes[i32]);
            }
            return out32;
        }

        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);

        // 某些 PS 版本忽略 componentSize:8，16bit 文档返回的字节数是期望值的两倍
        if (bytes.length === expectedLength * 2 && bytes.length !== expectedLength) {
            var probe = Math.min(expectedLength, 2048);
            var sumEven = 0;
            var sumOdd = 0;
            for (var p = 0; p < probe; p++) {
                sumEven += bytes[p * 2];
                sumOdd += bytes[p * 2 + 1];
            }
            var bigEndian = sumEven >= sumOdd;
            var hi = bigEndian ? 0 : 1;
            var lo = bigEndian ? 1 : 0;
            var maxValue = 0;
            for (var q = 0; q < probe; q++) {
                var v16 = (bytes[q * 2 + hi] << 8) | bytes[q * 2 + lo];
                if (v16 > maxValue) maxValue = v16;
            }
            var isPsRange = maxValue > 0 && maxValue <= 32769;
            var outBytes = new Uint8Array(expectedLength);
            for (var k = 0; k < expectedLength; k++) {
                var value = (bytes[k * 2 + hi] << 8) | bytes[k * 2 + lo];
                outBytes[k] = isPsRange
                    ? Math.min(255, Math.round(value * 255 / 32768))
                    : Math.min(255, (value + 128) >> 8);
            }
            return outBytes;
        }

        if (bytes.length === expectedLength) return bytes;
        if (bytes.length > expectedLength) return bytes.subarray(0, expectedLength);
        var padded = new Uint8Array(expectedLength);
        padded.set(bytes);
        return padded;
    }

    /**
     * 在模态里用 imaging.getPixels 抓像素。
     * componentSize:8 在 16/32bit 文档上可能报错 → 去掉该字段重试并自行降位深。
     */
    function fetchPixels(ps, doc, bounds, target) {
        log('info', '抓取像素：请求 ' + target.width + 'x' + target.height +
            '（选区 ' + bounds.width + 'x' + bounds.height + '）');
        var baseOptions = {
            documentID: doc.id,
            sourceBounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
            targetSize: { width: target.width, height: target.height },
            colorSpace: 'RGB',
            applyAlpha: false
        };
        var strict = {
            documentID: baseOptions.documentID,
            sourceBounds: baseOptions.sourceBounds,
            targetSize: baseOptions.targetSize,
            componentSize: 8,
            colorSpace: baseOptions.colorSpace,
            applyAlpha: baseOptions.applyAlpha
        };

        return Promise.resolve().then(function () {
            return ps.imaging.getPixels(strict);
        }).catch(function (error) {
            log('warn', 'getPixels with componentSize:8 failed, retrying raw depth',
                String(error && error.message || error));
            return ps.imaging.getPixels(baseOptions);
        }).then(function (result) {
            var imageData = (result && result.imageData) || result;
            if (!imageData) throw new Error(tr('error.selectionReadFailed'));
            var components = num(imageData.components, 3);
            if (components !== 3 && components !== 4) components = 3;
            var width = Math.max(1, Math.round(num(imageData.width, target.width)));
            var height = Math.max(1, Math.round(num(imageData.height, target.height)));

            return extractBytes(imageData).then(function (raw) {
                var expected = width * height * components;
                // 无论 PS 给的是 8/16/32bit 还是被忽略的 componentSize，都走同一条归一化
                return {
                    pixels: normalizeTo8Bit(raw, expected),
                    width: width,
                    height: height,
                    components: components
                };
            }).then(function (normalized) {
                disposeImageData(imageData);
                return normalized;
            }, function (error) {
                disposeImageData(imageData);
                throw error;
            });
        });
    }

    function disposeImageData(imageData) {
        try {
            if (imageData && typeof imageData.dispose === 'function') imageData.dispose();
        } catch (error) { /* 释放失败不影响结果 */ }
    }

    /* ============================================================
     * 编码
     * ============================================================ */

    function imageToDataUrl(image, mime) {
        /*
         * 选区预览统一走 UXP 兼容编码（RGB + store 块，照参考插件的做法）。
         * UXP 对 RGBA PNG 解码有问题（元素 loaded 但不渲染），RGB 能正常显示。
         */
        var bytes = DreamAI.PhotoEncode.encodeUxpPng(image);
        var base64 = DreamAI.util.arrayBufferToBase64(bytes);
        return DreamAI.util.base64ToDataUrl(base64, mime || 'image/png');
    }

    /* ============================================================
     * 主流程
     * ============================================================ */

    function captureState(sample) {
        try {
            if (DreamAI.App && typeof DreamAI.App.set === 'function') DreamAI.App.set('selection', sample);
        } catch (error) { /* App 未就绪时忽略 */ }
        if (DreamAI.bus && typeof DreamAI.bus.emit === 'function') {
            DreamAI.bus.emit('selection:change', { sample: sample });
        }
    }

    /**
     * 读取选区并返回 selection 形状的对象。
     * @param {{documentId?:number, maxEdge?:number}} [options]
     */
    function readSelection(options) {
        var opts = options || {};

        // 用 Promise 包一层：无宿主时也必须是 reject，而不是同步 throw
        return Promise.resolve().then(function () {
            var ps = requirePs();
            return DreamAI.psLock.acquire(function () {
                var doc = null;
                var bounds = null;
                var target = null;
                var docName = '';
                var docId = 0;
                var bitDepth = 8;
                var colorProfile = '';
                var image = null;

                return Promise.resolve().then(function () {
                    doc = resolveDocument(ps, opts);
                    docId = num(doc.id, 0);
                    docName = String(doc.name || '');
                    var maxEdge = readSampleMaxEdge(opts);

                    return ps.core.executeAsModal(function () {
                        return Promise.resolve().then(function () {
                            return probeBounds(doc);
                        }).then(function (rect) {
                            bounds = rect;
                            target = fitTargetSize(rect.width, rect.height, maxEdge);
                            return fetchPixels(ps, doc, rect, target);
                        }).then(function (result) {
                            image = result;
                            return readBitDepth(doc);
                        }).then(function (depth) {
                            bitDepth = depth;
                            return readColorProfile(doc);
                        }).then(function (profile) {
                            colorProfile = profile;
                        });
                    }, { commandName: 'Dream AI 读取选区' });
                }).then(function () {
                    var sample = {
                        dataUrl: imageToDataUrl(image, 'image/png'),
                        width: image.width,
                        height: image.height,
                        bounds: {
                            left: bounds.left,
                            top: bounds.top,
                            right: bounds.right,
                            bottom: bounds.bottom,
                            width: bounds.width,
                            height: bounds.height
                        },
                        documentId: docId,
                        documentName: docName,
                        bitDepth: bitDepth,
                        colorProfile: colorProfile,
                        sampledAt: Date.now()
                    };
                    captureState(sample);
                    return sample;
                });
            }, opts.taskId || null, { timeout: READ_TIMEOUT_MS });
        });
    }

    /** readSelection 的别名（工具箱/工作台的「抓取画面」按钮） */
    function capture(options) {
        return readSelection(options);
    }

    /* ============================================================
     * 前景色
     * ============================================================ */

    function toByte(value) {
        return Math.max(0, Math.min(255, Math.round(num(value, 0))));
    }

    function componentByte(container, names) {
        for (var i = 0; i < names.length; i++) {
            var key = names[i];
            if (container && container[key] !== undefined && container[key] !== null) {
                var value = container[key];
                if (typeof value === 'object' && value._value !== undefined) value = value._value;
                if (isFinite(Number(value))) return toByte(Number(value));
            }
        }
        return null;
    }

    function hex2(value) {
        var text = toByte(value).toString(16).toUpperCase();
        return text.length < 2 ? '0' + text : text;
    }

    /** 读当前前景色（batchPlay get color），统一成 sRGB 0-255 + #RRGGBB */
    function getForegroundColor() {
        return Promise.resolve().then(function () {
            var ps = requirePs();
            return DreamAI.psLock.acquire(function () {
                return ps.core.executeAsModal(function () {
                    return batchPlay({
                        _obj: 'get',
                        _target: [{ _property: 'color' }, { _ref: 'color', _enum: 'color', _value: 'foregroundColor' }]
                    }).then(function (result) {
                        var first = result && result[0];
                        var color = first && (first.color || first.foregroundColor || first);
                        if (!color) throw new Error(tr('error.foregroundColorFailed'));

                        var r = componentByte(color, ['red', 'r']);
                        var g = componentByte(color, ['grain', 'green', 'g']);
                        var b = componentByte(color, ['blue', 'b']);
                        if (r === null || g === null || b === null) {
                            // CMYK 前景色的兜底换算
                            var c = num(color.cyan, 0) / 255;
                            var m = num(color.magenta, 0) / 255;
                            var y = num(color.yellow, 0) / 255;
                            var k = num(color.black, 0) / 255;
                            r = toByte(255 * (1 - Math.min(1, c + k)));
                            g = toByte(255 * (1 - Math.min(1, m + k)));
                            b = toByte(255 * (1 - Math.min(1, y + k)));
                        }
                        return { r: r, g: g, b: b, hex: '#' + hex2(r) + hex2(g) + hex2(b) };
                    });
                }, { commandName: 'Dream AI 读取前景色' });
            }, 'photo-io:fg', { timeout: STEP_TIMEOUT_MS });
        });
    }

    /* ============================================================
     * 单步文档操作
     * ============================================================ */

    /** 单条 batchPlay 的公共外壳：入锁 + 模态 + 返回 undefined */
    function runStep(descriptors, commandName, taskId) {
        return Promise.resolve().then(function () {
            var ps = requirePs();
            return DreamAI.psLock.acquire(function () {
                return ps.core.executeAsModal(function () {
                    return batchPlay(descriptors).then(function () { return undefined; });
                }, { commandName: commandName });
            }, taskId || ('photo-io:' + commandName), { timeout: STEP_TIMEOUT_MS });
        });
    }

    /** 取消选区 */
    function deselect() {
        return runStep({
            _obj: 'select',
            _target: [{ _ref: 'channel', _property: 'selection' }],
            to: { _enum: 'ordinal', _value: 'none' }
        }, 'Dream AI 取消选区', 'photo-io:deselect');
    }

    /** 复制当前图层 */
    function duplicateLayer() {
        return runStep({
            _obj: 'duplicate',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
        }, 'Dream AI 复制图层', 'photo-io:duplicate');
    }

    /** 反选 */
    function invertSelection() {
        return runStep({
            _obj: 'inverse',
            _target: [{ _ref: 'channel', _enum: 'channel', _value: 'selection' }]
        }, 'Dream AI 反选', 'photo-io:invert');
    }

    /** 用前景色填充选区 */
    function fillSelectionWithForeground() {
        return runStep({
            _obj: 'fill',
            _target: [{ _ref: 'channel', _enum: 'channel', _value: 'selection' }],
            using: { _enum: 'fillContents', _value: 'foregroundColor' }
        }, 'Dream AI 填充前景色', 'photo-io:fill');
    }

    /** 自由变换（进入变换状态，等待用户确认） */
    function freeTransform() {
        return runStep({
            _obj: 'transform',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' }
        }, 'Dream AI 自由变换', 'photo-io:freeTransform');
    }

    /** 合并可见图层 */
    function mergeVisible() {
        return runStep({ _obj: 'mergeVisible' }, 'Dream AI 合并可见图层', 'photo-io:mergeVisible');
    }

    /** 拼合图像 */
    function flattenImage() {
        return runStep({
            _obj: 'flattenImage',
            _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }]
        }, 'Dream AI 拼合图像', 'photo-io:flatten');
    }

    /** 切换到指定文档 */
    function selectDocument(documentId) {
        var id = num(documentId, NaN);
        if (!isFinite(id)) return Promise.reject(new Error(tr('error.noDocument')));
        return runStep({
            _obj: 'select',
            _target: [{ _ref: 'document', _id: id }],
            makeVisible: false
        }, 'Dream AI 切换文档', 'photo-io:selectDocument');
    }

    DreamAI.PhotoIO = {
        isAvailable: isAvailable,
        readSelection: readSelection,
        capture: capture,
        getForegroundColor: getForegroundColor,
        deselect: deselect,
        duplicateLayer: duplicateLayer,
        invertSelection: invertSelection,
        fillSelectionWithForeground: fillSelectionWithForeground,
        freeTransform: freeTransform,
        mergeVisible: mergeVisible,
        flattenImage: flattenImage,
        selectDocument: selectDocument,
        /** 供其他模块复用的小工具（纯函数，不碰宿主） */
        _internal: {
            normalizeRect: normalizeRect,
            fitTargetSize: fitTargetSize,
            normalizeTo8Bit: normalizeTo8Bit,
            depthToNumber: depthToNumber
        }
    };
})(typeof window !== 'undefined' ? window : this);
