// ============================================================
//  ps-bridge.js — Photoshop 宿主桥接
//
//  三条硬规则：
//    1. 任何读/写像素的操作都必须包在 core.executeAsModal 里 ——
//       getPixels / putPixels 不在模态里会直接抛
//       "only allowed from inside a modal scope"
//    2. 模态内不能弹交互式对话框、不能嵌套 executeAsModal
//    3. 多任务并发要走串行锁，否则 PS 会报模态冲突
//
//  真机实测（UXP 8.0.1 / PS 26）后确认的两件事，别再走回头路：
//    · UXP 的 canvas 是**纯绘图上下文**，没有 drawImage / getImageData /
//      toDataURL；createImageBitmap 也不存在。所以「把 data URL 画到
//      canvas 再取像素」这条路在这个环境里根本不存在。
//    · imaging 只有 8 个方法，没有 decodeImageData。把图像塞进文档的
//      唯一可行路径是：写临时文件 → batchPlay placeEvent。
// ============================================================

(function (root) {
    'use strict';

    var LOCK_TIMEOUT_MS = 3600 * 1000;
    var DEFAULT_MAX_DIMENSION = 1536;
    var COLOR_PROFILE = 'sRGB IEC61966-2.1';

    var queue = [];
    var running = false;

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function acquire(fn, label) {
        return new Promise(function (resolve, reject) {
            queue.push({ fn: fn, resolve: resolve, reject: reject, label: label || '' });
            processQueue();
        });
    }

    async function processQueue() {
        if (running) return;
        if (!queue.length) return;
        running = true;
        var item = queue.shift();
        var operation = Promise.resolve().then(function () { return item.fn(); });
        var timer = null;
        var timedOut = false;
        try {
            var result = await Promise.race([
                operation,
                new Promise(function (_, reject) {
                    timer = setTimeout(function () {
                        timedOut = true;
                        reject(new Error('PS 操作超时：模态可能被其它对话框占用，结束当前操作后重试'));
                    }, LOCK_TIMEOUT_MS);
                })
            ]);
            item.resolve(result);
        } catch (error) {
            item.reject(error);
            // 调用者已收到超时，但锁要继续占用到旧操作真正结束
            if (timedOut) {
                try { await operation; } catch (ignored) {}
            }
        } finally {
            if (timer) clearTimeout(timer);
            running = false;
            await sleep(30);
            processQueue();
        }
    }

    function ps() {
        return require('photoshop');
    }

    function storage() {
        return require('uxp').storage;
    }

    function available() {
        try {
            var photoshop = ps();
            return !!(photoshop && photoshop.app && photoshop.core && photoshop.action && photoshop.imaging);
        } catch (error) {
            return false;
        }
    }

    function activeDocument() {
        if (!available()) return null;
        return ps().app.activeDocument || null;
    }

    function numberOf(value) {
        if (value === null || value === undefined) return NaN;
        if (typeof value === 'number') return value;
        if (typeof value === 'object') {
            if (typeof value._value === 'number') return value._value;
            if (typeof value.value === 'number') return value.value;
        }
        return Number(value);
    }

    // ---------- 文档与选区 ----------

    function selectionBounds() {
        try {
            var doc = activeDocument();
            var bounds = doc && doc.selection && doc.selection.bounds;
            if (!bounds) return null;
            var result = {
                left: numberOf(bounds.left),
                top: numberOf(bounds.top),
                right: numberOf(bounds.right),
                bottom: numberOf(bounds.bottom)
            };
            result.width = result.right - result.left;
            result.height = result.bottom - result.top;
            var valid = [result.left, result.top, result.right, result.bottom, result.width, result.height]
                .every(function (value) { return isFinite(value); });
            if (!valid || result.width <= 0 || result.height <= 0) return null;
            return result;
        } catch (error) {
            return null;
        }
    }

    function documentBounds() {
        try {
            var doc = activeDocument();
            if (!doc) return null;
            return {
                left: 0, top: 0,
                right: numberOf(doc.width), bottom: numberOf(doc.height),
                width: numberOf(doc.width), height: numberOf(doc.height)
            };
        } catch (error) {
            return null;
        }
    }

    function captureBounds() {
        return selectionBounds() || documentBounds();
    }

    function describeDocument() {
        try {
            var doc = activeDocument();
            if (!doc) return { open: false };
            var bounds = selectionBounds();
            return {
                open: true,
                id: Number(doc.id),
                name: String(doc.name || ''),
                width: numberOf(doc.width),
                height: numberOf(doc.height),
                hasSelection: !!bounds,
                selection: bounds
            };
        } catch (error) {
            return { open: false, error: error.message };
        }
    }

    // ---------- data URL 工具 ----------

    /**
     * imaging.encodeImageData 返回的是**裸 base64、不带 data: 前缀**，
     * 而且默认编码成 JPEG（base64 以 /9j/ 开头）。
     * Firefly / GRS 这类返回 PNG 的渠道不能直接套这个前缀。
     */
    function toDataUrl(base64) {
        var trimmed = String(base64 || '').trim();
        if (/^data:/i.test(trimmed)) return trimmed;
        var mime = trimmed.indexOf('/9j/') === 0 ? 'image/jpeg'
            : trimmed.indexOf('iVBOR') === 0 ? 'image/png'
            : 'image/jpeg';
        return 'data:' + mime + ';base64,' + trimmed;
    }

    function splitDataUrl(dataUrl) {
        var match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
        if (!match) throw new Error('不是有效的 Base64 图像数据');
        var mime = match[1].toLowerCase();
        var extension = mime.indexOf('jpeg') > -1 || mime.indexOf('jpg') > -1 ? 'jpg'
            : mime.indexOf('webp') > -1 ? 'webp' : 'png';
        return {
            mime: mime,
            extension: extension,
            bytes: new Uint8Array(root.SatImageExtract.base64ToArrayBuffer(match[2].replace(/\s+/g, '')))
        };
    }

    /** 把图像写成临时文件，返回 { entry, token }，调用方负责清理。 */
    async function writeTempImage(dataUrl, prefix) {
        var parsed = splitDataUrl(dataUrl);
        var fs = storage().localFileSystem;
        var folder = await fs.getTemporaryFolder();
        var name = (prefix || 'huanmeng_sat') + '_' + Date.now() + '_'
            + Math.random().toString(36).slice(2, 7) + '.' + parsed.extension;
        var entry = await folder.createFile(name, { overwrite: true });
        await entry.write(parsed.bytes.buffer ? parsed.bytes.buffer : parsed.bytes,
            { format: storage().formats.binary });
        return { entry: entry, token: await fs.createSessionToken(entry) };
    }

    async function removeTempEntry(entry) {
        try {
            if (entry && entry.delete) await entry.delete();
        } catch (error) {
            // 临时目录里的残留由系统回收，清理失败不该影响主流程
        }
    }

    // ---------- 读取 ----------

    /**
     * 把选区（或整图）读成 data URL。
     * 超过 maxDimension 时用 targetSize 让 PS 直接缩放，避免把巨图拉进内存。
     */
    async function captureAsDataUrl(bounds, options) {
        if (!available()) throw new Error('当前环境没有 Photoshop 宿主');
        var target = bounds || captureBounds();
        if (!target) throw new Error('没有可读取的范围：请先打开文档或建立选区');
        var opts = options || {};
        var maxDimension = Number(opts.maxDimension) || DEFAULT_MAX_DIMENSION;

        var scale = Math.min(1, maxDimension / Math.max(target.width, target.height));
        var targetSize = {
            width: Math.max(1, Math.round(target.width * scale)),
            height: Math.max(1, Math.round(target.height * scale))
        };

        return await acquire(async function () {
            var photoshop = ps();
            var doc = photoshop.app.activeDocument;
            if (!doc) throw new Error('没有打开的文档');

            var docId = Number(doc.id);
            var left = Math.round(target.left);
            var top = Math.round(target.top);
            var right = Math.round(target.right);
            var bottom = Math.round(target.bottom);
            var base64 = '';

            // getPixels 和 encodeImageData 都必须在模态作用域内
            await photoshop.core.executeAsModal(async function () {
                var imageData = null;
                try {
                    var capture = await photoshop.imaging.getPixels({
                        documentID: docId,
                        sourceBounds: { left: left, top: top, right: right, bottom: bottom },
                        targetSize: targetSize,
                        colorSpace: 'RGB',
                        colorProfile: COLOR_PROFILE,
                        componentSize: 8,
                        applyAlpha: true
                    });
                    imageData = capture.imageData;
                    base64 = await photoshop.imaging.encodeImageData({
                        imageData: imageData,
                        base64: true,
                        quality: 100
                    });
                } finally {
                    if (imageData && imageData.dispose) imageData.dispose();
                }
            }, { commandName: '幻梦卫星：读取选区' });

            if (!base64) throw new Error('读取选区返回了空数据');
            return {
                dataUrl: toDataUrl(base64),
                width: targetSize.width,
                height: targetSize.height,
                sourceBounds: target
            };
        }, '读取选区');
    }

    // ---------- 写入 ----------

    /**
     * 把一张图作为新图层放回文档，缩放到 bounds 大小并对齐到 bounds 左上角。
     * 走「临时文件 + placeEvent」，这是 UXP 里唯一可行的置入方式。
     */
    async function placeAtBounds(dataUrl, bounds, layerName, documentId) {
        if (!available()) throw new Error('当前环境没有 Photoshop 宿主');
        var target = bounds || captureBounds();
        if (!target) throw new Error('没有可写入的范围');

        var temp = await writeTempImage(dataUrl, 'huanmeng_place');
        try {
            return await acquire(async function () {
                var photoshop = ps();
                var fs = storage().localFileSystem;

                return await photoshop.core.executeAsModal(async function () {
                    var targetDocument = null;
                    if (Number.isFinite(Number(documentId))) {
                        targetDocument = Array.from(photoshop.app.documents || []).find(function (item) {
                            return Number(item.id) === Number(documentId);
                        }) || null;
                        if (!targetDocument) throw new Error('生成时绑定的原文档已关闭，为避免错贴已停止');
                    }
                    if (!targetDocument) targetDocument = photoshop.app.activeDocument;
                    if (!targetDocument) throw new Error('没有可用于回写的 Photoshop 文档');

                    if (!photoshop.app.activeDocument
                        || Number(photoshop.app.activeDocument.id) !== Number(targetDocument.id)) {
                        await photoshop.action.batchPlay([{
                            _obj: 'select',
                            _target: [{ _ref: 'document', _id: targetDocument.id }]
                        }], { synchronousExecution: true });
                    }

                    await photoshop.action.batchPlay([{
                        _obj: 'placeEvent',
                        null: { _path: temp.token, _kind: 'local' },
                        linked: false,
                        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
                        offset: {
                            _obj: 'offset',
                            horizontal: { _unit: 'pixelsUnit', _value: 0 },
                            vertical: { _unit: 'pixelsUnit', _value: 0 }
                        }
                    }], { synchronousExecution: true });

                    var readBounds = async function () {
                        var result = await photoshop.action.batchPlay([{
                            _obj: 'get',
                            _target: [
                                { _property: 'boundsNoEffects' },
                                { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }
                            ]
                        }], { synchronousExecution: true });
                        var raw = result && result[0] && result[0].boundsNoEffects;
                        if (!raw) throw new Error('无法读取置入图层的范围');
                        var left = numberOf(raw.left);
                        var top = numberOf(raw.top);
                        var right = numberOf(raw.right);
                        var bottom = numberOf(raw.bottom);
                        return { left: left, top: top, right: right, bottom: bottom,
                                 width: right - left, height: bottom - top };
                    };

                    var placed = await readBounds();
                    if (placed.width <= 0 || placed.height <= 0) throw new Error('置入图层的尺寸无效');

                    // 缩放到目标范围
                    var scaleX = target.width / placed.width * 100;
                    var scaleY = target.height / placed.height * 100;
                    if (Math.abs(scaleX - 100) > 0.01 || Math.abs(scaleY - 100) > 0.01) {
                        await photoshop.action.batchPlay([{
                            _obj: 'transform',
                            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                            freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSCorner0' },
                            width: { _unit: 'percentUnit', _value: scaleX },
                            height: { _unit: 'percentUnit', _value: scaleY },
                            interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubicAutomatic' }
                        }], { synchronousExecution: true });
                        placed = await readBounds();
                    }

                    // 平移到目标位置
                    var dx = Math.round(target.left - placed.left);
                    var dy = Math.round(target.top - placed.top);
                    if (dx !== 0 || dy !== 0) {
                        var layerId = photoshop.app.activeDocument.activeLayers
                            && photoshop.app.activeDocument.activeLayers[0]
                            ? photoshop.app.activeDocument.activeLayers[0].id : null;
                        await photoshop.action.batchPlay([{
                            _obj: 'move',
                            _target: layerId
                                ? { _ref: 'layer', _id: layerId }
                                : { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
                            to: {
                                _obj: 'offset',
                                horizontal: { _unit: 'pixelsUnit', _value: dx },
                                vertical: { _unit: 'pixelsUnit', _value: dy }
                            }
                        }], { synchronousExecution: true });
                        placed = await readBounds();
                    }

                    if (layerName) {
                        try {
                            await photoshop.action.batchPlay([{
                                _obj: 'set',
                                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                                to: { _obj: 'layer', name: layerName }
                            }], { synchronousExecution: true });
                        } catch (renameError) {
                            // 重命名失败不影响图像已经放好这件事
                        }
                    }

                    return { bounds: placed, target: target, documentId: Number(targetDocument.id) };
                }, { commandName: '幻梦卫星：放置生成结果' });
            }, '放置结果');
        } finally {
            await removeTempEntry(temp.entry);
        }
    }

    /** 把结果开成一个新文档，原文档不受影响。 */
    async function openAsDocument(dataUrl, name) {
        if (!available()) throw new Error('当前环境没有 Photoshop 宿主');
        var temp = await writeTempImage(dataUrl, 'huanmeng_doc');
        try {
            return await acquire(async function () {
                var photoshop = ps();
                var created = null;
                await photoshop.core.executeAsModal(async function () {
                    created = await photoshop.app.open(temp.entry);
                }, { commandName: '幻梦卫星：打开为新文档' });
                return {
                    documentId: created ? Number(created.id) : null,
                    name: created ? String(created.name || '') : (name || '')
                };
            }, '新建文档');
        } finally {
            await removeTempEntry(temp.entry);
        }
    }

    /** 弹出系统保存对话框把 data URL 落盘。 */
    async function saveAs(dataUrl, suggestedName) {
        var parsed = splitDataUrl(dataUrl);
        var fs = storage().localFileSystem;
        var file = await fs.getFileForSaving(suggestedName || 'huanmeng-satellite.png', {
            types: [parsed.extension]
        });
        if (!file) return null;
        await file.write(parsed.bytes.buffer ? parsed.bytes.buffer : parsed.bytes,
            { format: storage().formats.binary });
        return fs.getNativePath(file);
    }

    var api = {
        available: available,
        activeDocument: activeDocument,
        describeDocument: describeDocument,
        selectionBounds: selectionBounds,
        documentBounds: documentBounds,
        captureBounds: captureBounds,
        captureAsDataUrl: captureAsDataUrl,
        placeAtBounds: placeAtBounds,
        openAsDocument: openAsDocument,
        saveAs: saveAs,
        toDataUrl: toDataUrl,
        numberOf: numberOf,
        sleep: sleep
    };

    root.SatPs = api;
})(typeof window !== 'undefined' ? window : globalThis);
