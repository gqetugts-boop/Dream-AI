/*
 * features/gallery.js — 生成结果画廊
 *
 * 职责：
 *   - 保存生成结果的图片二进制与索引元数据，提供列表 / 读取 / 删除 / 按策略清理；
 *   - 把画廊里的图片回写进 Photoshop（转发 DreamAI.PhotoReturn.place）；
 *   - 导出图片：浏览器走 a[download]，UXP 写入数据目录 dream-ai-exports/。
 * 输入：dataUrl + 元数据（providerId / modelId / mode / 尺寸等）、清理策略（见 §8.2）。
 * 输出：Promise<item>、Promise<{kept, removed}>、Promise<string>（data URL）；
 *       所有失败都降级处理并写日志，绝不向调用方抛出。
 * 边界：存储策略按「IndexedDB → UXP 数据目录 → localStorage（小图）」降级；
 *       不改动选区、不直接调用宿主批处理；纯 ES5，可在没有 Photoshop 宿主的 Node 下加载。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.Gallery) return;

    var util = DreamAI.util || {};

    /* ============================================================
     * 基础工具（util 缺失时兜底，保证本文件可独立加载）
     * ============================================================ */

    function t(key, params) {
        return DreamAI.I18n ? DreamAI.I18n.t(key, params) : key;
    }

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function isPlain(value) {
        if (typeof util.isPlainObject === 'function') return util.isPlainObject(value);
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function toNumber(value, fallback) {
        if (typeof util.toNumber === 'function') return util.toNumber(value, fallback);
        var n = Number(value);
        return isFinite(n) ? n : fallback;
    }

    function clamp(value, min, max, fallback) {
        if (typeof util.clamp === 'function') return util.clamp(value, min, max, fallback);
        var n = toNumber(value, fallback === undefined ? min : fallback);
        if (n < min) return min;
        if (n > max) return max;
        return n;
    }

    function clone(value) {
        if (typeof util.deepClone === 'function') return util.deepClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function uid(prefix) {
        if (typeof util.uid === 'function') return util.uid(prefix);
        return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function formatBytes(bytes) {
        if (typeof util.formatBytes === 'function') return util.formatBytes(bytes);
        return String(bytes) + ' B';
    }

    function truncateText(value, max) {
        var text = String(value == null ? '' : value);
        return text.length <= max ? text : text.slice(0, max - 1) + '…';
    }

    function makeError(key, params) {
        var error = new Error(t(key, params));
        error.localized = true;
        error.key = key;
        return error;
    }

    function log(level, message, meta) {
        var bus = DreamAI.logbus;
        var payload = isPlain(meta) ? meta : {};
        if (payload.domain === undefined) payload.domain = 'gallery';
        if (bus) {
            var name = String(level || 'debug').toLowerCase();
            var fn = typeof bus[name] === 'function' ? bus[name] : bus.debug;
            fn.call(bus, message, payload);
            return;
        }
        if (level === 'warn' || level === 'error') {
            if (global.console && global.console.warn) global.console.warn('[gallery] ' + message, payload);
        }
    }

    /* ============================================================
     * 常量
     * ============================================================ */

    var DB_NAME = 'dream-ai-gallery';
    var DB_VERSION = 1;
    var STORE_NAME = 'images';
    var META_DOMAIN = 'gallery.meta';
    var META_LIMIT = 200;
    var UXP_FOLDER = 'dream-ai-gallery';
    var EXPORT_FOLDER = 'dream-ai-exports';
    var LOCAL_PREFIX = 'dream-ai:gallery.img:';
    /** localStorage 兜底的总容量预算（按 UTF-16 字符数 × 2 估算） */
    var LOCAL_BUDGET_BYTES = 4 * 1024 * 1024;
    /** 单张图片进 localStorage 的上限，避免一次写入就撑爆配额 */
    var LOCAL_SINGLE_BYTES = 2 * 1024 * 1024;
    var DEFAULT_POLICY = { mode: 'count', maxCount: 30, maxDays: 30 };
    /** 索引里保存的提示词上限：索引走 localStorage，必须防超长文案撑爆配额 */
    var META_PROMPT_LIMIT = 2000;

    /* ============================================================
     * 状态
     * ============================================================ */

    /** @type {Array} 索引元数据，新到旧 */
    var meta = [];
    var metaLoaded = false;
    var dbPromise = null;
    var idbBroken = false;
    var backendLogged = '';
    var initialized = false;

    /* ============================================================
     * base64 / data URL
     * ============================================================ */

    function base64ToBytes(base64) {
        var text = String(base64 || '');
        if (typeof util.base64ToArrayBuffer === 'function') {
            try { return new Uint8Array(util.base64ToArrayBuffer(text)); } catch (error) { /* 走下面的兜底 */ }
        }
        try {
            var binary = global.atob ? global.atob(text) : null;
            if (binary === null) {
                if (typeof Buffer === 'undefined') return null;
                binary = Buffer.from(text, 'base64').toString('binary');
            }
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
        } catch (error) {
            return null;
        }
    }

    function bytesToBase64(bytes) {
        var array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (typeof util.arrayBufferToBase64 === 'function') {
            try { return util.arrayBufferToBase64(array); } catch (error) { /* 走下面的兜底 */ }
        }
        try {
            var binary = '';
            var chunk = 0x8000;
            for (var i = 0; i < array.length; i += chunk) {
                binary += String.fromCharCode.apply(null, array.subarray(i, i + chunk));
            }
            return global.btoa ? global.btoa(binary)
                : (typeof Buffer === 'undefined' ? '' : Buffer.from(binary, 'binary').toString('base64'));
        } catch (error) {
            return '';
        }
    }

    /** data URL → { mime, base64, bytes }；非法或非 base64 时返回 null */
    function parseDataUrl(dataUrl) {
        var text = String(dataUrl == null ? '' : dataUrl);
        var match = text.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
        if (!match || !match[2]) return null;
        var base64 = (match[3] || '').replace(/\s+/g, '');
        if (!base64) return null;
        var bytes = base64ToBytes(base64);
        if (!bytes || !bytes.length) return null;
        return { mime: match[1] || 'image/png', base64: base64, bytes: bytes };
    }

    function bytesToDataUrl(bytes, mime) {
        return 'data:' + (mime || 'image/png') + ';base64,' + bytesToBase64(bytes);
    }

    function extensionFor(mime) {
        var type = String(mime || '').toLowerCase();
        if (type.indexOf('jpeg') !== -1 || type.indexOf('jpg') !== -1) return 'jpg';
        if (type.indexOf('webp') !== -1) return 'webp';
        if (type.indexOf('gif') !== -1) return 'gif';
        return 'png';
    }

    function guessSizeFromDataUrl(dataUrl) {
        var parsed = parseDataUrl(dataUrl);
        if (!parsed) return null;
        var Providers = DreamAI.Providers;
        if (Providers && typeof Providers.imageSizeFromBase64 === 'function') {
            try {
                var size = Providers.imageSizeFromBase64(parsed.base64);
                if (size && size.width && size.height) return size;
            } catch (error) { /* 忽略，交给调用方兜底 */ }
        }
        return null;
    }

    /* ============================================================
     * 索引元数据（Store 域 gallery.meta）
     * ============================================================ */

    function readMetaRaw() {
        var Store = DreamAI.Store;
        if (!Store) return [];
        var raw = null;
        try { raw = Store.read(META_DOMAIN, []); } catch (error) { raw = null; }
        if (Array.isArray(raw)) return raw;
        if (isPlain(raw) && Array.isArray(raw.items)) return raw.items;
        return [];
    }

    function loadMeta() {
        var list = readMetaRaw();
        var out = [];
        for (var i = 0; i < list.length; i++) {
            if (!isPlain(list[i]) || !list[i].id) continue;
            out.push(normalizeMeta(list[i]));
        }
        out.sort(function (a, b) { return toNumber(b.createdAt, 0) - toNumber(a.createdAt, 0); });
        meta = out;
        metaLoaded = true;
        return meta;
    }

    function normalizeMeta(raw) {
        var item = {
            id: String(raw.id),
            createdAt: toNumber(raw.createdAt, Date.now()),
            width: Math.round(toNumber(raw.width, 0)),
            height: Math.round(toNumber(raw.height, 0)),
            prompt: String(raw.prompt == null ? '' : raw.prompt),
            providerId: String(raw.providerId == null ? '' : raw.providerId),
            modelId: String(raw.modelId == null ? '' : raw.modelId),
            mode: String(raw.mode == null ? '' : raw.mode),
            source: String(raw.source == null ? '' : raw.source),
            storage: String(raw.storage == null ? 'metadata-only' : raw.storage),
            mime: String(raw.mime == null ? '' : raw.mime),
            bytes: Math.round(toNumber(raw.bytes, 0)),
            fileName: raw.fileName ? String(raw.fileName) : undefined,
            error: raw.error ? String(raw.error) : undefined
        };
        for (var key in raw) {
            if (!hasOwn(raw, key)) continue;
            if (item[key] !== undefined) continue;
            var value = raw[key];
            var type = typeof value;
            if (value === null || type === 'string' || type === 'number' || type === 'boolean') item[key] = value;
        }
        return item;
    }

    function persistMeta() {
        var Store = DreamAI.Store;
        if (!Store) return;
        var records = [];
        for (var i = 0; i < meta.length; i++) records.push(meta[i]);
        try {
            if (typeof Store.writeAll === 'function') Store.writeAll(META_DOMAIN, records);
            else Store.write(META_DOMAIN, records);
        } catch (error) {
            log('warn', t('gallery.storageFailed', { reason: error && error.message ? error.message : String(error) }), { domain: 'gallery' });
        }
    }

    function ensureMeta() {
        if (!metaLoaded) loadMeta();
        return meta;
    }

    function findMeta(id) {
        var key = String(id == null ? '' : id);
        var list = ensureMeta();
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === key) return list[i];
        }
        return null;
    }

    function emitChange() {
        if (DreamAI.bus) DreamAI.bus.emit('gallery:change', {});
    }

    /* ============================================================
     * 后端一：IndexedDB（浏览器预览 / 有 IDB 的宿主）
     * ============================================================ */

    function hasIndexedDb() {
        if (idbBroken) return false;
        return !!(global.indexedDB && typeof global.indexedDB.open === 'function');
    }

    function openDb() {
        if (dbPromise) return dbPromise;
        if (!hasIndexedDb()) {
            idbBroken = true;
            return Promise.reject(new Error('indexedDB unavailable'));
        }
        dbPromise = new Promise(function (resolve, reject) {
            var request = null;
            try {
                request = global.indexedDB.open(DB_NAME, DB_VERSION);
            } catch (error) {
                reject(error);
                return;
            }
            request.onupgradeneeded = function () {
                try {
                    var db = request.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    }
                } catch (error) { /* 升级失败交由 onerror 处理 */ }
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error || new Error('open failed')); };
            request.onblocked = function () { reject(new Error('open blocked')); };
        }).catch(function (error) {
            idbBroken = true;
            dbPromise = null;
            throw error;
        });
        return dbPromise;
    }

    /**
     * 写入 IndexedDB。记录形状为 { id, blob }：
     * blob 优先存 Blob，宿主没有 Blob 时退化为 data URL 字符串；
     * 另外镜像一份 dataUrl 字段，方便没有 FileReader 的宿主直接读取。
     */
    function idbPut(id, dataUrl) {
        return openDb().then(function (db) {
            var parsed = parseDataUrl(dataUrl);
            var blob = null;
            if (typeof global.Blob === 'function' && parsed) {
                try { blob = new global.Blob([parsed.bytes], { type: parsed.mime }); } catch (error) { blob = null; }
            }
            var record = {
                id: id,
                blob: blob || dataUrl,
                dataUrl: dataUrl,
                mime: parsed ? parsed.mime : '',
                updatedAt: Date.now()
            };
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put(record);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('put failed')); };
                tx.onabort = function () { reject(tx.error || new Error('put aborted')); };
            });
        });
    }

    function idbGet(id) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
                request.onsuccess = function () { resolve(request.result || null); };
                request.onerror = function () { reject(request.error || new Error('get failed')); };
            });
        }).then(function (record) {
            if (!record) return '';
            if (typeof record.dataUrl === 'string' && record.dataUrl) return record.dataUrl;
            if (typeof record.blob === 'string') return record.blob;
            return blobToDataUrl(record.blob);
        });
    }

    function idbDelete(id) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).delete(id);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('delete failed')); };
            });
        });
    }

    /** Blob → data URL；没有 FileReader 时返回空串（调用方负责降级） */
    function blobToDataUrl(blob) {
        if (!blob) return '';
        if (typeof global.FileReader !== 'function') return '';
        return new Promise(function (resolve) {
            try {
                var reader = new global.FileReader();
                reader.onload = function () { resolve(String(reader.result || '')); };
                reader.onerror = function () { resolve(''); };
                reader.readAsDataURL(blob);
            } catch (error) {
                resolve('');
            }
        });
    }

    /* ============================================================
     * 后端二：UXP 数据目录 dream-ai-gallery/<id>.png
     * ============================================================ */

    function hasUxpFs() {
        return !!(DreamAI.host && DreamAI.host.isUxp && DreamAI.host.modules && DreamAI.host.modules.fs);
    }

    function uxpModules() {
        return DreamAI.host && DreamAI.host.modules ? DreamAI.host.modules : {};
    }

    function uxpBinaryFormat() {
        var modules = uxpModules();
        try {
            if (modules.uxp && modules.uxp.storage && modules.uxp.storage.formats) {
                return modules.uxp.storage.formats.binary || 'binary';
            }
        } catch (error) { /* 忽略 */ }
        return 'binary';
    }

    /** 取得（必要时创建）数据目录下的子目录 */
    function uxpFolder(name) {
        var fs = uxpModules().fs;
        return Promise.resolve().then(function () {
            return fs.getDataFolder();
        }).then(function (dataFolder) {
            return dataFolder.getEntry(name).then(null, function () {
                return dataFolder.createFolder(name);
            });
        });
    }

    function uxpWriteFile(folderName, fileName, bytes) {
        return uxpFolder(folderName).then(function (folder) {
            return folder.createFile(fileName, { overwrite: true }).then(function (file) {
                return Promise.resolve()
                    .then(function () { return file.write(bytes, { format: uxpBinaryFormat() }); })
                    .then(function () { return file; }, function () { return file.write(bytes).then(function () { return file; }); });
            });
        }).then(function (file) {
            var path = '';
            try { path = file.nativePath || ''; } catch (error) { path = ''; }
            return path || (folderName + '/' + fileName);
        });
    }

    function uxpDeleteFile(folderName, fileName) {
        return uxpFolder(folderName).then(function (folder) {
            return folder.getEntry(fileName);
        }).then(function (file) {
            return file.delete();
        });
    }

    /* ============================================================
     * 后端三：localStorage（小图兜底）
     * ============================================================ */

    function hasLocalStorage() {
        try {
            if (!global.localStorage) return false;
            var probe = LOCAL_PREFIX + '__probe';
            global.localStorage.setItem(probe, '1');
            global.localStorage.removeItem(probe);
            return true;
        } catch (error) {
            return false;
        }
    }

    /** 已占用的估算字节数（UTF-16 每字符 2 字节） */
    function localUsage() {
        var total = 0;
        try {
            var storage = global.localStorage;
            for (var i = 0; i < storage.length; i++) {
                var key = storage.key(i);
                if (!key || key.indexOf(LOCAL_PREFIX) !== 0) continue;
                var value = storage.getItem(key) || '';
                total += (key.length + value.length) * 2;
            }
        } catch (error) { /* 忽略统计失败 */ }
        return total;
    }

    function localSave(id, dataUrl) {
        if (!hasLocalStorage()) return Promise.reject(new Error('localStorage unavailable'));
        var text = String(dataUrl || '');
        var size = text.length * 2;
        if (size > LOCAL_SINGLE_BYTES) {
            return Promise.reject(makeError('gallery.storageQuota', { limit: formatBytes(LOCAL_BUDGET_BYTES) }));
        }
        if (localUsage() + size > LOCAL_BUDGET_BYTES) {
            return Promise.reject(makeError('gallery.storageQuota', { limit: formatBytes(LOCAL_BUDGET_BYTES) }));
        }
        return Promise.resolve().then(function () {
            global.localStorage.setItem(LOCAL_PREFIX + id, text);
            return true;
        });
    }

    function localRead(id) {
        try {
            return Promise.resolve(global.localStorage.getItem(LOCAL_PREFIX + id) || '');
        } catch (error) {
            return Promise.resolve('');
        }
    }

    function localDelete(id) {
        return Promise.resolve().then(function () {
            try { global.localStorage.removeItem(LOCAL_PREFIX + id); } catch (error) { /* 忽略 */ }
            return true;
        });
    }

    /* ============================================================
     * 存储策略分发
     * IndexedDB 优先；UXP 下改用数据目录；再退到 localStorage 小图兜底。
     * ============================================================ */

    function resolveBackend() {
        if (hasIndexedDb()) return 'indexeddb';
        if (hasUxpFs()) return 'uxp';
        if (hasLocalStorage()) return 'localstorage';
        return 'none';
    }

    function noteBackend(name) {
        if (backendLogged === name) return;
        backendLogged = name;
        log('debug', t('gallery.logBackend', { backend: name }), { domain: 'gallery', backend: name });
    }

    /**
     * 按策略保存二进制。
     * @returns {Promise<{storage:string, fileName?:string, mime:string}>}
     */
    function storeBinary(item, dataUrl) {
        var parsed = parseDataUrl(dataUrl);
        if (!parsed) return Promise.reject(makeError('gallery.invalidData'));
        var backend = resolveBackend();
        noteBackend(backend);

        if (backend === 'indexeddb') {
            return idbPut(item.id, dataUrl).then(function () {
                return { storage: 'indexeddb', mime: parsed.mime, bytes: parsed.bytes.length };
            });
        }
        if (backend === 'uxp') {
            var fileName = item.id + '.' + extensionFor(parsed.mime);
            return uxpWriteFile(UXP_FOLDER, fileName, parsed.bytes).then(function () {
                return { storage: 'uxp', fileName: fileName, mime: parsed.mime, bytes: parsed.bytes.length };
            });
        }
        if (backend === 'localstorage') {
            return localSave(item.id, dataUrl).then(function () {
                return { storage: 'localstorage', mime: parsed.mime, bytes: parsed.bytes.length };
            });
        }
        return Promise.reject(makeError('gallery.storageFailed', { reason: 'no storage backend' }));
    }

    /** 读取二进制；先按记录的后端读，失败后依次尝试其他后端 */
    function readBinary(item) {
        if (!item) return Promise.resolve('');
        var storage = String(item.storage || '');
        if (storage === 'metadata-only' || storage === 'none') return Promise.resolve('');

        var attempts = [];
        function push(name, fn) { attempts.push({ name: name, run: fn }); }
        if (storage === 'indexeddb') push('indexeddb', function () { return idbGet(item.id); });
        if (storage === 'uxp') push('uxp', function () {
            return uxpFolder(UXP_FOLDER).then(function (folder) {
                return folder.getEntry(item.fileName || (item.id + '.' + extensionFor(item.mime)));
            }).then(function (file) {
                return Promise.resolve()
                    .then(function () { return file.read({ format: uxpBinaryFormat() }); })
                    .then(null, function () { return file.read(); });
            }).then(function (data) {
                if (typeof data === 'string') return data;
                return bytesToDataUrl(new Uint8Array(data), item.mime);
            });
        });
        if (storage === 'localstorage') push('localstorage', function () { return localRead(item.id); });
        // 记录的后端读不到时，兜底再试一遍能力最强的两个后端
        if (storage !== 'indexeddb' && hasIndexedDb()) push('indexeddb', function () { return idbGet(item.id); });
        if (storage !== 'localstorage' && hasLocalStorage()) push('localstorage', function () { return localRead(item.id); });

        var index = 0;
        function next() {
            if (index >= attempts.length) return Promise.resolve('');
            var attempt = attempts[index++];
            return Promise.resolve().then(attempt.run).then(function (value) {
                if (typeof value === 'string' && value) return value;
                return next();
            }, function () {
                return next();
            });
        }
        return next();
    }

    /** 删除二进制；无论后端是否可用都不抛错 */
    function deleteBinary(item) {
        if (!item) return Promise.resolve(false);
        var storage = String(item.storage || '');
        var jobs = [];
        if (storage === 'indexeddb' && hasIndexedDb()) jobs.push(idbDelete(item.id));
        if (storage === 'uxp' && hasUxpFs()) {
            jobs.push(uxpDeleteFile(UXP_FOLDER, item.fileName || (item.id + '.png')));
        }
        if (storage === 'localstorage' && hasLocalStorage()) jobs.push(localDelete(item.id));
        if (!jobs.length) return Promise.resolve(false);
        return Promise.all(jobs.map(function (job) {
            return Promise.resolve(job).then(function () { return true; }, function () { return false; });
        })).then(function () { return true; });
    }

    /* ============================================================
     * 策略
     * ============================================================ */

    function readSettings() {
        if (DreamAI.App && isPlain(DreamAI.App.settings)) return DreamAI.App.settings;
        if (DreamAI.Store && typeof DreamAI.Store.read === 'function') {
            var stored = DreamAI.Store.read('settings');
            if (isPlain(stored)) return stored;
        }
        return {};
    }

    /** 归一化清理策略：mode=count|days|both，maxCount 1..500，maxDays 1..3650 */
    function normalizePolicy(policy) {
        var source = isPlain(policy) ? policy : {};
        var mode = String(source.mode || DEFAULT_POLICY.mode);
        if (mode !== 'days' && mode !== 'both') mode = mode === 'count' ? 'count' : DEFAULT_POLICY.mode;
        // 缺省 / 0 / 非法值都退回默认值，再做范围钳制（1..500 / 1..3650）
        var count = toNumber(source.maxCount, 0) || DEFAULT_POLICY.maxCount;
        var days = toNumber(source.maxDays, 0) || DEFAULT_POLICY.maxDays;
        return {
            mode: mode,
            maxCount: Math.round(clamp(count, 1, 500, DEFAULT_POLICY.maxCount)),
            maxDays: Math.round(clamp(days, 1, 3650, DEFAULT_POLICY.maxDays))
        };
    }

    /** 当前策略：优先取 App.settings.gallery */
    function policy() {
        var settings = readSettings();
        var gallery = isPlain(settings.gallery) ? settings.gallery : {};
        return normalizePolicy(gallery);
    }

    /* ============================================================
     * 公共 API
     * ============================================================ */

    function list() {
        var items = ensureMeta();
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var copy = clone(items[i]);
            out.push(copy);
        }
        out.sort(function (a, b) { return toNumber(b.createdAt, 0) - toNumber(a.createdAt, 0); });
        return out;
    }

    function get(id) {
        var item = findMeta(id);
        return item ? clone(item) : null;
    }

    /** 构建索引记录；元数据里绝不保存全尺寸图（dataUrl 只出现在返回值上） */
    function buildItem(dataUrl, metadata) {
        var source = isPlain(metadata) ? metadata : {};
        var parsed = parseDataUrl(dataUrl);
        var size = null;
        if (!(toNumber(source.width, 0) > 0) || !(toNumber(source.height, 0) > 0)) {
            size = guessSizeFromDataUrl(dataUrl);
        }
        var item = {
            id: uid('img'),
            createdAt: toNumber(source.createdAt, Date.now()),
            width: Math.round(toNumber(source.width, size ? size.width : 0)),
            height: Math.round(toNumber(source.height, size ? size.height : 0)),
            prompt: truncateText(source.prompt, META_PROMPT_LIMIT),
            providerId: String(source.providerId == null ? '' : source.providerId),
            modelId: String(source.modelId == null ? '' : source.modelId),
            mode: String(source.mode == null ? '' : source.mode),
            source: String(source.source == null ? 'generated' : source.source),
            storage: 'pending',
            mime: parsed ? parsed.mime : '',
            bytes: parsed ? parsed.bytes.length : 0
        };
        return item;
    }

    /** 索引超过 200 条时裁掉最旧的（同时尽力删掉它们的二进制） */
    function capMeta() {
        if (meta.length <= META_LIMIT) return;
        var dropped = meta.splice(META_LIMIT, meta.length - META_LIMIT);
        for (var i = 0; i < dropped.length; i++) {
            deleteBinary(dropped[i]).then(null, function () { /* 已降级处理 */ });
        }
    }

    /**
     * 加入一张图片。
     * 存储失败不会抛错：元数据照常写入，并把 storage 标记为 metadata-only。
     * @returns {Promise<Object>} 新到旧的索引项（含 dataUrl 字段）
     */
    function add(dataUrl, metadata) {
        ensureMeta();
        var text = String(dataUrl == null ? '' : dataUrl);
        var item = buildItem(text, metadata);
        if (!text) {
            item.storage = 'metadata-only';
            item.error = t('gallery.invalidData');
            log('warn', item.error, { domain: 'gallery', imageId: item.id });
        }
        var start = text
            ? storeBinary(item, text)
            : Promise.reject(makeError('gallery.invalidData'));

        return start.then(function (result) {
            item.storage = result.storage;
            item.mime = result.mime || item.mime;
            if (result.fileName) item.fileName = result.fileName;
            if (result.bytes) item.bytes = result.bytes;
            return item;
        }, function (error) {
            item.storage = 'metadata-only';
            item.error = error && error.message ? error.message : String(error);
            log('warn', t('gallery.storageFailed', { reason: item.error }), { domain: 'gallery', imageId: item.id });
            return item;
        }).then(function (saved) {
            // 元数据无论如何都写入，保证列表里能看到这张图
            meta.unshift(saved);
            capMeta();
            persistMeta();
            emitChange();
            var record = clone(saved);
            if (text) record.dataUrl = text;
            log('debug', t('gallery.logAdded', { id: saved.id }), { domain: 'gallery', imageId: saved.id, bytes: saved.bytes });
            return prune(policy()).then(function () { return record; }, function () { return record; });
        }, function (error) {
            // 极端情况下（Store 也不可用）仍然返回构造好的项，绝不抛出
            log('warn', t('gallery.storageFailed', { reason: error && error.message ? error.message : String(error) }), { domain: 'gallery', imageId: item.id });
            var fallback = clone(item);
            if (text) fallback.dataUrl = text;
            return fallback;
        });
    }

    /**
     * 按策略清理。
     * @param {Object} [policyArg] { mode, maxCount, maxDays }
     * @returns {Promise<{kept:number, removed:number}>}
     */
    function prune(policyArg) {
        return Promise.resolve().then(function () {
            var normalized = normalizePolicy(policyArg || policy());
            var items = ensureMeta().slice();
            items.sort(function (a, b) { return toNumber(b.createdAt, 0) - toNumber(a.createdAt, 0); });
            var cutoff = Date.now() - normalized.maxDays * 86400000;
            var keep = [];
            var removed = [];
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                var countExpired = (normalized.mode === 'count' || normalized.mode === 'both') && i >= normalized.maxCount;
                var timeExpired = (normalized.mode === 'days' || normalized.mode === 'both') &&
                    toNumber(item.createdAt, 0) < cutoff;
                if (countExpired || timeExpired) removed.push(item);
                else keep.push(item);
            }
            meta = keep;
            persistMeta();
            if (removed.length) {
                for (var j = 0; j < removed.length; j++) {
                    deleteBinary(removed[j]).then(null, function () { /* 已降级处理 */ });
                }
                log('debug', t('gallery.logPruned', { kept: keep.length, removed: removed.length }), {
                    domain: 'gallery', kept: keep.length, removed: removed.length
                });
                emitChange();
            }
            return { kept: keep.length, removed: removed.length };
        }).catch(function (error) {
            log('warn', t('gallery.storageFailed', { reason: error && error.message ? error.message : String(error) }), { domain: 'gallery' });
            return { kept: ensureMeta().length, removed: 0 };
        });
    }

    function remove(id) {
        return Promise.resolve().then(function () {
            var list = ensureMeta();
            var key = String(id == null ? '' : id);
            var index = -1;
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === key) { index = i; break; }
            }
            if (index === -1) return false;
            var item = list.splice(index, 1)[0];
            persistMeta();
            emitChange();
            log('debug', t('gallery.logRemoved', { id: key }), { domain: 'gallery', imageId: key });
            return deleteBinary(item).then(function () { return true; }, function () { return true; });
        }).catch(function () {
            return false;
        });
    }

    /**
     * 读取图片 data URL，读不到时返回空串（绝不抛错）。
     * @returns {Promise<string>}
     */
    function getDataUrl(id) {
        return Promise.resolve().then(function () {
            var item = findMeta(id);
            if (!item) return '';
            return readBinary(item);
        }).then(function (url) {
            return String(url || '');
        }, function (error) {
            log('debug', t('gallery.imageMissing'), { domain: 'gallery', imageId: String(id), reason: error && error.message });
            return '';
        });
    }

    /** 回写 PhotoReturn 的选项：settings.behavior 默认值 + 当前选区 */
    function buildReturnOptions() {
        var settings = readSettings();
        var behavior = isPlain(settings.behavior) ? settings.behavior : {};
        var selection = readSelection();
        return {
            bounds: selection && selection.bounds ? clone(selection.bounds) : null,
            documentId: selection ? selection.documentId : undefined,
            layerName: null,
            blendMode: String(behavior.returnBlendMode || 'normal'),
            feather: toNumber(behavior.returnFeather, 0),
            shrink: 0,
            group: '',
            colorMatch: behavior.colorMatchOnReturn !== false,
            colorMatchMethod: String(behavior.colorMatchMethod || 'meanStd'),
            colorMatchReference: selection && selection.dataUrl ? selection.dataUrl : null,
            useSelectionBounds: true
        };
    }

    /** 读取当前选区（同时兼容 App.selection / App.state.selection / App.get） */
    function readSelection() {
        var App = DreamAI.App;
        if (!App) return null;
        var selection = null;
        if (App.state && App.state.selection) selection = App.state.selection;
        else if (typeof App.get === 'function') selection = App.get('selection', null);
        if (!selection && App.selection) selection = App.selection;
        return selection || null;
    }

    /**
     * 把画廊里的图片回写进 Photoshop。
     * @returns {Promise<{layerName:string, layerId?:number, bounds?:Object}>}
     */
    function saveToPhotoshop(id) {
        var PhotoReturn = DreamAI.PhotoReturn;
        if (!PhotoReturn || typeof PhotoReturn.place !== 'function' ||
            (typeof PhotoReturn.isAvailable === 'function' && !PhotoReturn.isAvailable())) {
            return Promise.reject(makeError('return.disabled'));
        }
        return getDataUrl(id).then(function (dataUrl) {
            if (!dataUrl) throw makeError('gallery.imageMissing');
            return PhotoReturn.place(dataUrl, buildReturnOptions());
        });
    }

    function defaultFileName(dataUrl) {
        var parsed = parseDataUrl(dataUrl);
        var ext = parsed ? extensionFor(parsed.mime) : 'png';
        return 'dream-ai-' + Date.now() + '.' + ext;
    }

    function normalizeFileName(fileName, dataUrl) {
        var name = String(fileName == null ? '' : fileName).trim();
        if (!name) return defaultFileName(dataUrl);
        if (!/\.[a-z0-9]+$/i.test(name)) {
            var parsed = parseDataUrl(dataUrl);
            name += '.' + (parsed ? extensionFor(parsed.mime) : 'png');
        }
        return name.replace(/[\\/:*?"<>|]+/g, '_');
    }

    /**
     * 导出图片。
     * 浏览器：触发 a[download] 下载；UXP：写入数据目录 dream-ai-exports/ 并记录路径。
     * @returns {Promise<string>} 成功时返回文件名或路径，失败返回空串（不抛错）
     */
    function download(dataUrl, fileName) {
        return Promise.resolve().then(function () {
            var text = String(dataUrl == null ? '' : dataUrl);
            if (!text) throw makeError('gallery.imageMissing');
            var name = normalizeFileName(fileName, text);

            if (hasUxpFs()) {
                var parsed = parseDataUrl(text);
                if (!parsed) throw makeError('gallery.invalidData');
                return uxpWriteFile(EXPORT_FOLDER, name, parsed.bytes).then(function (path) {
                    log('info', t('gallery.logExport', { path: path }), { domain: 'gallery', path: path });
                    return path;
                });
            }

            var doc = global.document;
            if (!doc || typeof doc.createElement !== 'function') {
                throw makeError('gallery.downloadFailed', { reason: 'no document' });
            }
            var anchor = doc.createElement('a');
            anchor.href = text;
            anchor.download = name;
            try { anchor.style.display = 'none'; } catch (error) { /* 忽略样式失败 */ }
            if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(anchor);
            try {
                anchor.click();
            } finally {
                if (doc.body && anchor.parentNode) anchor.parentNode.removeChild(anchor);
            }
            return name;
        }).catch(function (error) {
            var reason = error && error.message ? error.message : String(error);
            log('warn', t('gallery.downloadFailed', { reason: reason }), { domain: 'gallery' });
            return '';
        });
    }

    /* ============================================================
     * 生命周期
     * ============================================================ */

    function init() {
        if (initialized) return;
        initialized = true;
        ensureMeta();
        noteBackend(resolveBackend());
        // 启动时按策略清理一次；失败只记日志
        prune(policy()).then(null, function () { /* 已内部降级 */ });
    }

    DreamAI.Gallery = {
        init: init,
        list: list,
        get: get,
        add: add,
        remove: remove,
        prune: prune,
        policy: policy,
        saveToPhotoshop: saveToPhotoshop,
        download: download,
        getDataUrl: getDataUrl,
        /** 调试辅助：当前生效的存储后端 */
        backend: function () { return resolveBackend(); },
        /** 调试辅助：索引条目数量 */
        count: function () { return ensureMeta().length; },
        /** 供测试/工具复用的纯函数 */
        _internal: {
            parseDataUrl: parseDataUrl,
            bytesToDataUrl: bytesToDataUrl,
            normalizePolicy: normalizePolicy,
            resolveBackend: resolveBackend,
            localUsage: localUsage
        }
    };
})(typeof window !== 'undefined' ? window : this);
