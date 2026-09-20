/*
 * providers/photoshop-native.js — Photoshop 原生生成式填充渠道
 *
 * 职责：把生成请求交给 Photoshop 自带的生成式填充（generativeFill），
 *       再把结果像素读回来，对外返回与其它渠道一致的 { images: [{ dataUrl }] }。
 * 输入：ctx（该渠道不需要 baseUrl/apiKey）、统一 request 对象（必须有 prompt，
 *       并且要么已有 Photoshop 选区，要么提供输入图）。
 * 输出：{ images: [{ dataUrl, width, height }], raw: { version, documentId, bounds } }。
 * 边界：
 *   - 先探测宿主能力：非 UXP / 无 photoshop 模块 / 无 batchPlay / 版本低于 24.0 一律
 *     抛 error.nativeUnsupported；
 *   - 任何写文档的操作都在 DreamAI.psLock 内、core.executeAsModal 里执行；
 *   - 不支持 edit / chat / 余额查询；
 *   - 纯 ES5，在 Node 下加载不会触碰宿主 API（全部探测都在调用时进行）。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var P = DreamAI.Providers;
    if (!P || P.get('native')) return;

    var util = DreamAI.util;

    var ID = 'native';
    var DEFAULT_MODEL = 'photoshop-generative';
    /** 生成式填充自 Photoshop 24.0（2023）起提供 */
    var MIN_MAJOR = 24;
    var MIN_MINOR = 0;

    function t(key, params) {
        return DreamAI.I18n ? DreamAI.I18n.t(key, params) : key;
    }

    /**
     * 宿主适配层（可选）。其它模块可以把以下函数挂到描述符的 adapter 上覆盖默认行为：
     *   detectSupport() / getPhotoshop() / readSelection() / buildFillDescriptor(prompt, selection)
     * 这样无需改动本文件即可适配特殊 Photoshop 版本。
     */
    function adapter() {
        var descriptor = P.get(ID);
        var source = descriptor && descriptor.source ? descriptor.source : null;
        return source && util.isPlainObject(source.adapter) ? source.adapter : null;
    }

    function adapterMethod(name) {
        var host = adapter();
        return host && typeof host[name] === 'function' ? host[name] : null;
    }

    /* ============================================================
     * 宿主能力探测
     * ============================================================ */

    function getPhotoshop() {
        var override = adapterMethod('getPhotoshop');
        if (override) return override();
        var host = DreamAI.host;
        if (!host || !host.modules) return null;
        return host.modules.photoshop || null;
    }

    /** 新旧宿主都兼容：优先 action.batchPlay，退回 app.batchPlay */
    function resolveBatchPlay(ps) {
        if (!ps) return null;
        var action = ps.action;
        if (action && typeof action.batchPlay === 'function') return { owner: action, fn: action.batchPlay };
        var app = ps.app;
        if (app && typeof app.batchPlay === 'function') return { owner: app, fn: app.batchPlay };
        return null;
    }

    function versionParts(version) {
        var parts = String(version || '').split('.');
        var out = [];
        for (var i = 0; i < 3; i++) {
            var value = parseInt(parts[i], 10);
            out.push(isFinite(value) ? value : 0);
        }
        return out;
    }

    function versionAtLeast(version, major, minor) {
        var parts = versionParts(version);
        if (parts[0] !== major) return parts[0] > major;
        return parts[1] >= minor;
    }

    /**
     * 探测宿主是否支持带 prompt 的生成式填充。
     * @returns {{ok:boolean, reason:string, version?:string}}
     */
    function detectSupport() {
        var override = adapterMethod('detectSupport');
        if (override) return override();

        var ps = getPhotoshop();
        if (!ps) return { ok: false, reason: 'noHost' };
        if (!resolveBatchPlay(ps)) return { ok: false, reason: 'noBatchPlay' };
        var core = ps.core;
        if (!core || typeof core.executeAsModal !== 'function') return { ok: false, reason: 'noModal' };
        var version = String((ps.app && ps.app.version) || '');
        if (!version) return { ok: false, reason: 'noVersion' };
        if (!versionAtLeast(version, MIN_MAJOR, MIN_MINOR)) return { ok: false, reason: 'version', version: version };
        return { ok: true, reason: 'ok', version: version };
    }

    /** 供 UI 判断该渠道是否可用 */
    function isAvailable() {
        return detectSupport().ok;
    }

    /* ============================================================
     * 选区与串行队列
     * ============================================================ */

    function readSelection() {
        var override = adapterMethod('readSelection');
        if (override) return Promise.resolve().then(function () { return override(); });
        var io = DreamAI.PhotoIO;
        if (!io || typeof io.readSelection !== 'function') {
            return Promise.reject(P.makeError('error.nativeUnsupported', null, { reason: 'noPhotoIO' }));
        }
        return Promise.resolve().then(function () { return io.readSelection(); });
    }

    /**
     * PhotoIO 在"文档里没有选区"时会抛 error.emptySelection；
     * 这在本渠道里不是失败，而是"没有素材"的信号，交给上层决定是否用输入图兜底。
     */
    function isNoSelectionError(error) {
        if (!error) return false;
        var text = String(error.message || '');
        return text === t('error.emptySelection') || text === t('error.nativeNoSelection');
    }

    /** 读选区；"没有选区"统一归一成 null，其余错误照常抛出 */
    function readSelectionOrNull() {
        return readSelection().catch(function (error) {
            if (isNoSelectionError(error)) return null;
            throw error;
        });
    }

    function hasUsableBounds(selection) {
        var bounds = selection && selection.bounds;
        if (!util.isPlainObject(bounds)) return false;
        return util.toNumber(bounds.width, 0) > 0 && util.toNumber(bounds.height, 0) > 0;
    }

    /** 所有写文档动作必须经过 psLock（CONTRACT.md 第 7 节） */
    function withLock(task) {
        var lock = DreamAI.psLock;
        if (lock && typeof lock.acquire === 'function') return Promise.resolve(lock.acquire(task));
        if (typeof lock === 'function') return Promise.resolve(lock(task));
        // 没有串行队列（例如单测）时直接执行
        return Promise.resolve().then(task);
    }

    function executeAsModal(task) {
        var ps = getPhotoshop();
        var core = ps && ps.core;
        if (!core || typeof core.executeAsModal !== 'function') {
            return Promise.reject(P.makeError('error.nativeUnsupported', null, { reason: 'noModal' }));
        }
        return Promise.resolve(core.executeAsModal(function () { return task(); }, {
            commandName: t('provider.nativeCommandName')
        }));
    }

    /* ============================================================
     * batchPlay 描述符
     * ============================================================ */

    /**
     * 生成式填充描述符。字符串 prompt 是必需的；
     * 不同 Photoshop 小版本对字段容忍度不同，因此允许宿主适配层整体替换。
     */
    function buildFillDescriptor(prompt, selection) {
        var override = adapterMethod('buildFillDescriptor');
        if (override) return override(prompt, selection);
        return {
            _obj: 'generativeFill',
            _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
            prompt: String(prompt === undefined || prompt === null ? '' : prompt),
            _options: { dialogOptions: 'dontDisplay' }
        };
    }

    /** 文档里没有可用选区时补一个全选，否则生成式填充会被宿主拒绝 */
    function ensureDocumentSelection(batch, selection) {
        if (hasUsableBounds(selection)) return Promise.resolve(false);
        return Promise.resolve(batch.fn.call(batch.owner, [{
            _obj: 'selectAll',
            _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
            _options: { dialogOptions: 'dontDisplay' }
        }], {})).then(function () { return true; });
    }

    function checkBatchResult(result) {
        if (!Array.isArray(result)) return;
        for (var i = 0; i < result.length; i++) {
            var entry = result[i];
            if (!util.isPlainObject(entry)) continue;
            if (entry._obj === 'error' || entry.error) {
                var message = entry.message || (entry.error && entry.error.message) || '';
                throw P.makeError('error.nativeFailed', {
                    reason: util.truncate(String(message || ''), 200) || t('state.failed')
                }, { result: entry });
            }
        }
    }

    /* ============================================================
     * 主流程
     * ============================================================ */

    function requestImages(request) {
        var list = request && Array.isArray(request.images) ? request.images : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && (list[i].dataUrl || list[i].data || list[i].base64)) out.push(list[i]);
        }
        return out;
    }

    /**
     * 保证有可用的素材：优先用现成选区；没有选区时把输入图落成图层再重新读取。
     * 注意 PhotoReturn 内部自己会取 psLock，所以这一步必须在取锁之前完成。
     */
    function ensureSource(ctx, request) {
        return readSelectionOrNull().then(function (selection) {
            if (selection && selection.dataUrl) return selection;
            var images = requestImages(request);
            if (!images.length) throw P.makeError('error.nativeNoSelection');
            var placer = DreamAI.PhotoReturn;
            if (!placer || typeof placer.place !== 'function') {
                throw P.makeError('error.nativeUnsupported', null, { reason: 'noPhotoReturn' });
            }
            P.log(ctx, 'info', t('provider.nativePlacingInput'), {});
            return Promise.resolve(placer.place(images[0].dataUrl, {
                layerName: t('provider.nativeInputLayer')
            })).then(function () {
                return readSelectionOrNull();
            });
        }).then(function (selection) {
            if (!selection || !selection.dataUrl) throw P.makeError('error.nativeNoSelection');
            return selection;
        });
    }

    /** 取锁 + executeAsModal 内执行生成式填充 */
    function runGenerativeFill(ctx, prompt, selection) {
        var ps = getPhotoshop();
        var batch = resolveBatchPlay(ps);
        if (!batch) return Promise.reject(P.makeError('error.nativeUnsupported', null, { reason: 'noBatchPlay' }));
        var descriptor = buildFillDescriptor(prompt, selection);

        return withLock(function () {
            return executeAsModal(function () {
                return ensureDocumentSelection(batch, selection).then(function () {
                    return batch.fn.call(batch.owner, [descriptor], { synchronousExecution: false });
                }).then(function (result) {
                    checkBatchResult(result);
                    return result;
                });
            });
        });
    }

    function generate(ctx, request) {
        var payload = request || {};
        var prompt = String(payload.prompt === undefined || payload.prompt === null ? '' : payload.prompt).trim();
        if (!prompt) return Promise.reject(P.makeError('ws.needPrompt'));

        var support = detectSupport();
        if (!support.ok) {
            P.log(ctx, 'warn', t('provider.nativeUnsupportedLog'), { reason: support.reason, version: support.version || '' });
            return Promise.reject(P.makeError('error.nativeUnsupported', null, {
                reason: support.reason,
                version: support.version || ''
            }));
        }

        P.log(ctx, 'info', t('provider.nativeGenerating'), { version: support.version });
        P.progress(ctx, 5);

        return ensureSource(ctx, payload).then(function (selection) {
            P.progress(ctx, 20);
            return runGenerativeFill(ctx, prompt, selection);
        }).then(function () {
            P.progress(ctx, 80);
            // 生成式填充已经改写选区像素，读回来即是结果
            return readSelection();
        }).then(function (result) {
            if (!result || !result.dataUrl) throw P.makeError('error.noImage');
            P.progress(ctx, 100);
            return {
                images: [{
                    dataUrl: result.dataUrl,
                    width: result.width,
                    height: result.height
                }],
                raw: {
                    version: support.version,
                    documentId: result.documentId,
                    bounds: result.bounds
                },
                meta: { version: support.version }
            };
        });
    }

    function listModels() {
        return Promise.resolve([{ id: DEFAULT_MODEL }]);
    }

    function edit() {
        return Promise.reject(P.makeError('error.unsupportedMode', null, { providerId: ID, mode: 'edit' }));
    }

    function chat() {
        return Promise.reject(P.makeError('error.unsupportedMode', null, { providerId: ID, mode: 'chat' }));
    }

    function checkBalance() {
        return Promise.resolve({ display: t('settings.balanceUnsupported'), endpoint: null });
    }

    function test(ctx) {
        var support = detectSupport();
        if (!support.ok) {
            return Promise.resolve({
                ok: false,
                models: [],
                reason: support.reason,
                error: t('error.nativeUnsupported')
            });
        }
        return listModels(ctx).then(function (models) {
            return { ok: true, models: models, version: support.version };
        });
    }

    P.register({
        id: ID,
        labelKey: 'settings.channelNative',
        order: 10,
        needsKey: false,
        defaultBaseUrl: '',
        defaultModel: DEFAULT_MODEL,
        supports: { txt2img: true, img2img: true, edit: false, models: false, chat: false, balance: false },
        listModels: listModels,
        generate: generate,
        edit: edit,
        chat: chat,
        checkBalance: checkBalance,
        test: test,
        /* 宿主适配与 UI 判定用的额外接口（register 会一并挂到描述符上） */
        isAvailable: isAvailable,
        detectSupport: detectSupport,
        getPhotoshop: getPhotoshop,
        readSelection: readSelection,
        buildFillDescriptor: buildFillDescriptor
    });
})(typeof window !== 'undefined' ? window : this);
