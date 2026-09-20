(function () {
    'use strict';

    const META_KEY = 'huanmeng_gallery_meta_v1';
    const DB_NAME = 'huanmeng-ai-gallery';
    // 已经提示过「没有缩略图」的记录，避免每次渲染刷屏
    const warnedNoThumb = new Set();
    const STORE_NAME = 'images';
    const UXP_FOLDER = 'gallery';

    function readMeta() {
        try {
            const value = JSON.parse(localStorage.getItem(META_KEY) || '[]');
            return Array.isArray(value) ? value : [];
        } catch (error) {
            console.warn('读取画廊索引失败:', error);
            return [];
        }
    }

    function writeMeta(items) {
        localStorage.setItem(META_KEY, JSON.stringify(items));
    }

    function uid() {
        return 'gallery_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    }

    function parseDataUrl(dataUrl) {
        const match = String(dataUrl || '').match(/^data:([^;,]+);base64,(.+)$/);
        if (!match) throw new Error('画廊只接受 base64 图像');
        const binary = atob(match[2]);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return { mimeType: match[1], bytes: bytes };
    }

    // 按文件头判断真实格式。
    // 不能只信 item.mimeType：早先存下的记录可能没有该字段，
    // 于是一张 JPEG 会被标成 image/png，浏览器按 PNG 解码失败，
    // 表现就是画廊预览一片空白、控制台却没有任何报错。
    function detectImageMime(array) {
        if (!array || array.length < 12) return '';
        if (array[0] === 0x89 && array[1] === 0x50 && array[2] === 0x4e && array[3] === 0x47) return 'image/png';
        if (array[0] === 0xff && array[1] === 0xd8 && array[2] === 0xff) return 'image/jpeg';
        if (array[0] === 0x47 && array[1] === 0x49 && array[2] === 0x46 && array[3] === 0x38) return 'image/gif';
        if (array[0] === 0x52 && array[1] === 0x49 && array[2] === 0x46 && array[3] === 0x46
            && array[8] === 0x57 && array[9] === 0x45 && array[10] === 0x42 && array[11] === 0x50) return 'image/webp';
        if (array[0] === 0x42 && array[1] === 0x4d) return 'image/bmp';
        return '';
    }

    function bytesToDataUrl(bytes, mimeType) {
        const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let binary = '';
        const chunk = 0x8000;
        for (let index = 0; index < array.length; index += chunk) {
            binary += String.fromCharCode.apply(null, array.subarray(index, index + chunk));
        }
        // 文件头优先，其次才用记录里的 mimeType，最后兜底 PNG
        const resolved = detectImageMime(array) || mimeType || 'image/png';
        return 'data:' + resolved + ';base64,' + btoa(binary);
    }

    function hasUxpStorage() {
        try {
            return typeof require === 'function' && !!require('uxp').storage.localFileSystem;
        } catch (error) {
            return false;
        }
    }

    async function getUxpFolder() {
        const uxp = require('uxp');
        const dataFolder = await uxp.storage.localFileSystem.getDataFolder();
        try {
            return await dataFolder.getEntry(UXP_FOLDER);
        } catch (error) {
            return dataFolder.createFolder(UXP_FOLDER);
        }
    }

    function openDb() {
        return new Promise(function (resolve, reject) {
            if (!window.indexedDB) return reject(new Error('当前环境不支持 IndexedDB'));
            const request = window.indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = function () {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                    request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error || new Error('打开画廊数据库失败')); };
        });
    }

    async function browserPut(id, dataUrl) {
        const db = await openDb();
        await new Promise(function (resolve, reject) {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put({ id: id, dataUrl: dataUrl });
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error || new Error('保存画廊图片失败')); };
        });
        db.close();
    }

    async function browserGet(id) {
        const db = await openDb();
        const result = await new Promise(function (resolve, reject) {
            const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
            request.onsuccess = function () { resolve(request.result || null); };
            request.onerror = function () { reject(request.error || new Error('读取画廊图片失败')); };
        });
        db.close();
        return result && result.dataUrl;
    }

    async function browserDelete(id) {
        const db = await openDb();
        await new Promise(function (resolve, reject) {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(id);
            tx.oncomplete = resolve;
            tx.onerror = function () { reject(tx.error || new Error('删除画廊图片失败')); };
        });
        db.close();
    }

    async function saveBinary(item, dataUrl, thumbDataUrl) {
        const withThumb = thumbDataUrl ? { thumb: thumbDataUrl } : {};
        if (!hasUxpStorage()) {
            await browserPut(item.id, dataUrl);
            return Object.assign(item, { storage: 'indexeddb' }, withThumb);
        }
        const parsed = parseDataUrl(dataUrl);
        const extension = parsed.mimeType.indexOf('jpeg') > -1 ? 'jpg' : 'png';
        const folder = await getUxpFolder();
        const fileName = item.id + '.' + extension;
        const file = await folder.createFile(fileName, { overwrite: true });
        const uxp = require('uxp');
        await file.write(parsed.bytes, { format: uxp.storage.formats.binary });
        return Object.assign(item, {
            storage: 'uxp',
            fileName: fileName,
            mimeType: parsed.mimeType
        }, withThumb);
    }

    async function readBinary(item) {
        if (!item) return '';
        if (item.storage !== 'uxp') return browserGet(item.id);
        const folder = await getUxpFolder();
        const file = await folder.getEntry(item.fileName);
        let data;
        try {
            const uxp = require('uxp');
            data = await file.read({ format: uxp.storage.formats.binary });
        } catch (error) {
            data = await file.read();
        }
        return bytesToDataUrl(data, item.mimeType);
    }

    // 缩略图存在元数据里，随记录一并消失，这里只需要清原图文件。
    async function deleteBinary(item) {
        if (!item) return;
        if (item.storage !== 'uxp') return browserDelete(item.id);
        try {
            const folder = await getUxpFolder();
            const file = await folder.getEntry(item.fileName);
            await file.delete();
        } catch (error) {
            console.warn('删除画廊文件失败:', error);
        }
    }

    // 回图完成后补写缩略图。
    // 之所以不在 add() 时生成：那一刻只能靠 new Image() 解码，而 UXP 解不了
    // 几 MB 的 data URL（实测 naturalWidth 为 0）。回图之后图已经在 Photoshop
    // 文档里，用 captureBoundsToBrowserImageData 从画布抓一张小的最稳。
    //
    // 缩略图直接以 data URL 形式存在元数据里，不走文件：
    // 之前写成 .jpg 文件再读回来的方案实测解不了（11KB 的小图也一样），
    // 问题出在写入/读回这一趟。而这个 data URL 就是编码器的原始产物，
    // 与辉光预览用的是同一个字符串，那条路已验证可用。
    // 体积上 160×240 约 11KB，默认保留 30 张也就 300KB 上下，可以接受。
    async function setThumbnail(id, thumbDataUrl) {
        if (!thumbDataUrl) return null;
        const items = readMeta();
        const index = items.findIndex(function (item) { return item.id === id; });
        if (index < 0) return null;
        items[index] = Object.assign({}, items[index], { thumb: thumbDataUrl });
        writeMeta(items);
        return items[index];
    }

    // 卡片预览用的小图。
    // 存在元数据里的 thumb 就是编码器产出的原始 data URL，直接用，不做任何转换。
    async function readThumbBinary(item) {
        if (!item) return '';
        if (item.thumb) return item.thumb;
        // 没有缩略图的多是升级前存下的旧记录：原图 data URL 常有数 MB，
        // UXP 的 <img> 解不了（实测 naturalWidth 为 0），回退只是白等一场，
        // 而且每张卡片都要处理几 MB 字符串。所以 UXP 下直接返回空，
        // 由渲染层提示「无预览」；浏览器没有这个限制，仍回退原图。
        if (hasUxpStorage()) {
            // renderGallery 每次刷新都会走到这里，同一条记录只提示一次，避免刷屏
            if (!warnedNoThumb.has(item.id)) {
                warnedNoThumb.add(item.id);
                console.warn('画廊记录没有缩略图，跳过原图回退（升级前的旧记录）:', item.id);
            }
            return '';
        }
        return readBinary(item);
    }

    function getPolicy(policy) {
        const source = policy || {};
        return {
            mode: source.mode === 'days' ? 'days' : source.mode === 'both' ? 'both' : 'count',
            maxCount: Math.max(1, Math.min(500, Number(source.maxCount) || 30)),
            maxDays: Math.max(1, Math.min(3650, Number(source.maxDays) || 30))
        };
    }

    async function prune(policy) {
        const normalized = getPolicy(policy);
        const items = readMeta().sort(function (a, b) { return Number(b.createdAt) - Number(a.createdAt); });
        const cutoff = Date.now() - normalized.maxDays * 86400000;
        const keep = [];
        const removed = [];
        items.forEach(function (item, index) {
            const countExpired = (normalized.mode === 'count' || normalized.mode === 'both') && index >= normalized.maxCount;
            const timeExpired = (normalized.mode === 'days' || normalized.mode === 'both') && Number(item.createdAt) < cutoff;
            (countExpired || timeExpired ? removed : keep).push(item);
        });
        writeMeta(keep);
        for (const item of removed) await deleteBinary(item);
        return { kept: keep.length, removed: removed.length };
    }

    async function add(dataUrl, metadata, policy, thumbDataUrl) {
        const item = Object.assign({
            id: uid(),
            createdAt: Date.now(),
            type: 'image',
            sourceLabel: '幻梦 AI',
            placed: false
        }, metadata || {});
        const saved = await saveBinary(item, dataUrl, thumbDataUrl);
        const items = readMeta();
        items.unshift(saved);
        writeMeta(items);
        await prune(policy);
        return saved;
    }

    // 一键清空。逐条走 deleteBinary，保证原图、缩略图和记录都被清掉，
    // 不留孤儿文件（UXP 下图片是本地文件，只清元数据会留下垃圾）。
    async function clear() {
        const items = readMeta();
        for (const item of items) await deleteBinary(item);
        writeMeta([]);
        warnedNoThumb.clear();
        return { removed: items.length };
    }

    async function update(id, patch) {
        const items = readMeta();
        const index = items.findIndex(function (item) { return item.id === id; });
        if (index < 0) return null;
        items[index] = Object.assign({}, items[index], patch || {});
        writeMeta(items);
        return items[index];
    }

    async function remove(id) {
        const items = readMeta();
        const index = items.findIndex(function (item) { return item.id === id; });
        if (index < 0) return false;
        const item = items.splice(index, 1)[0];
        writeMeta(items);
        await deleteBinary(item);
        return true;
    }

    window.HuanmengGalleryStore = {
        list: function () { return readMeta().sort(function (a, b) { return Number(b.createdAt) - Number(a.createdAt); }); },
        getDataUrl: async function (id) {
            const item = readMeta().find(function (entry) { return entry.id === id; });
            return readBinary(item);
        },
        // 卡片预览用小图；没有缩略图的老记录回退到原图。
        getThumbnail: async function (id) {
            const item = readMeta().find(function (entry) { return entry.id === id; });
            return readThumbBinary(item);
        },
        add: add,
        setThumbnail: setThumbnail,
        update: update,
        remove: remove,
        clear: clear,
        prune: prune
    };
})();
