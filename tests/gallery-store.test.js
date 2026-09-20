'use strict';

// gallery-store 此前完全没有测试覆盖。
// 它在 UXP 下走 uxp.storage 文件系统，在浏览器/H5 下走 IndexedDB。
// Node 里 require('uxp') 会抛错，hasUxpStorage() 因此返回 false，
// 正好把浏览器分支（IndexedDB）跑起来。下面给出最小的 localStorage 与
// IndexedDB 替身，只实现 gallery-store 实际用到的那部分接口。

const assert = require('node:assert/strict');

// ---------- 最小 localStorage ----------
const lsData = new Map();
global.localStorage = {
    getItem: function (key) { return lsData.has(key) ? lsData.get(key) : null; },
    setItem: function (key, value) { lsData.set(key, String(value)); },
    removeItem: function (key) { lsData.delete(key); }
};

// ---------- 最小 IndexedDB ----------
const stores = new Map();
function makeRequest() {
    return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
}
function defer(fn) { queueMicrotask(fn); }

global.indexedDB = {
    open: function (name) {
        const request = makeRequest();
        const isNew = !stores.has(name);
        if (isNew) stores.set(name, new Map());
        const records = stores.get(name);

        const db = {
            objectStoreNames: { contains: function () { return true; } },
            createObjectStore: function () {},
            close: function () {},
            transaction: function () {
                const tx = { error: null, oncomplete: null, onerror: null };
                tx.objectStore = function () {
                    return {
                        put: function (record) {
                            records.set(record.id, record);
                            defer(function () { if (tx.oncomplete) tx.oncomplete(); });
                        },
                        get: function (id) {
                            const r = makeRequest();
                            defer(function () {
                                r.result = records.has(id) ? records.get(id) : null;
                                if (r.onsuccess) r.onsuccess();
                            });
                            return r;
                        },
                        delete: function (id) {
                            records.delete(id);
                            defer(function () { if (tx.oncomplete) tx.oncomplete(); });
                        }
                    };
                };
                return tx;
            }
        };

        request.result = db;
        defer(function () {
            if (isNew && request.onupgradeneeded) request.onupgradeneeded();
            if (request.onsuccess) request.onsuccess();
        });
        return request;
    }
};

global.window = global;
require('../src/features/gallery/gallery-store.js');

const Gallery = global.HuanmengGalleryStore;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DAY = 86400000;

(async function run() {
    assert.ok(Gallery, 'gallery-store 必须挂到 window.HuanmengGalleryStore');

    // ---- add：写入并落到 IndexedDB 分支 ----
    const first = await Gallery.add(PNG, { sourceLabel: 'test-a' });
    assert.ok(first.id.indexOf('gallery_') === 0, 'add 必须生成 gallery_ 前缀 id');
    assert.equal(first.storage, 'indexeddb', 'Node 下应走 IndexedDB 分支');
    assert.equal(first.placed, false, 'placed 默认 false');
    assert.equal(first.createdAt > 0, true, 'createdAt 必须被写入');

    // ---- getDataUrl：二进制原样读回 ----
    assert.equal(await Gallery.getDataUrl(first.id), PNG, 'getDataUrl 必须原样返回写入的 data URL');

    // ---- list：按 createdAt 倒序 ----
    const second = await Gallery.add(PNG, { sourceLabel: 'test-b' });
    const listed = Gallery.list();
    assert.equal(listed.length, 2);
    assert.equal(listed[0].id, second.id, 'list 必须按 createdAt 倒序，最新在前');

    // ---- update ----
    const patched = await Gallery.update(first.id, { placed: true, note: 'ok' });
    assert.equal(patched.placed, true);
    assert.equal(patched.note, 'ok');
    assert.equal(patched.sourceLabel, 'test-a', 'update 必须合并而不是覆盖元数据');
    assert.equal(await Gallery.update('gallery_不存在', { placed: true }), null, 'update 未知 id 必须返回 null');

    // ---- remove ----
    assert.equal(await Gallery.remove(second.id), true, 'remove 已存在项必须返回 true');
    assert.equal(await Gallery.remove(second.id), false, 'remove 不存在的项必须返回 false');
    assert.equal(Gallery.list().length, 1);

    // ---- prune：count 模式 ----
    for (let i = 0; i < 4; i++) await Gallery.add(PNG, { sourceLabel: 'bulk-' + i });
    assert.equal(Gallery.list().length, 5);
    const countPrune = await Gallery.prune({ mode: 'count', maxCount: 3 });
    assert.equal(countPrune.kept, 3, 'count 模式必须只保留 maxCount 条');
    assert.equal(countPrune.removed, 2);
    assert.equal(Gallery.list().length, 3);

    // prune 后索引与二进制必须一致：保留下来的仍能读出图片
    for (const item of Gallery.list()) {
        assert.equal(await Gallery.getDataUrl(item.id), PNG, 'prune 后保留项的二进制必须仍可读取');
    }

    // ---- prune：days 模式 ----
    const stale = await Gallery.add(PNG, { sourceLabel: 'stale' });
    await Gallery.update(stale.id, { createdAt: Date.now() - 40 * DAY });
    const daysPrune = await Gallery.prune({ mode: 'days', maxDays: 30 });
    assert.equal(daysPrune.removed, 1, 'days 模式必须清掉超过 maxDays 的条目');
    assert.equal(Gallery.list().some(function (i) { return i.id === stale.id; }), false, '过期条目必须从索引移除');
    assert.equal(await Gallery.getDataUrl(stale.id), '', '过期条目的二进制必须被删除，不能再读出');

    // ---- prune：both 模式 = 数量与时间任一超限即删 ----
    // maxDays 被 getPolicy 夹到最小 1 天，所以要把条目回拨 2 天才算过期。
    const beforeBoth = Gallery.list().length;
    const backdated = [];
    for (let i = 0; i < 2; i++) {
        const item = await Gallery.add(PNG, { sourceLabel: 'both-old-' + i });
        await Gallery.update(item.id, { createdAt: Date.now() - 2 * DAY });
        backdated.push(item.id);
    }
    await Gallery.add(PNG, { sourceLabel: 'both-fresh' });
    const bothPrune = await Gallery.prune({ mode: 'both', maxCount: 10, maxDays: 1 });
    assert.equal(bothPrune.removed, 2, 'both 模式下超过 maxDays 的条目必须被清理（数量未超限也照样删）');
    for (const id of backdated) {
        assert.equal(Gallery.list().some(function (i) { return i.id === id; }), false, '过期条目必须从索引移除');
        assert.equal(await Gallery.getDataUrl(id), '', '过期条目的二进制必须被删除');
    }
    assert.equal(Gallery.list().length, beforeBoth + 1, '未过期的条目必须原样保留');

    // ---- 磁盘/索引不泄漏：索引里的每一条都能读到二进制 ----
    for (const item of Gallery.list()) {
        assert.equal(await Gallery.getDataUrl(item.id), PNG);
    }

    // ---- 缩略图：卡片预览走小图，原图只在回放时读 ----
    // 回归：UXP 对超大 data URL 的 <img> 既不渲染也不报错，画廊因此一片空白。
    const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==';
    const withThumb = await Gallery.add(PNG, { sourceLabel: '带缩略图' }, undefined, THUMB);
    assert.equal(withThumb.thumb, THUMB, '缩略图必须随记录一起存下来');
    assert.equal(await Gallery.getThumbnail(withThumb.id), THUMB, 'getThumbnail 必须返回缩略图');
    assert.equal(await Gallery.getDataUrl(withThumb.id), PNG, 'getDataUrl 仍必须返回原图，不能被缩略图顶替');

    const noThumb = await Gallery.add(PNG, { sourceLabel: '无缩略图' });
    assert.equal(noThumb.thumb, undefined, '未传缩略图时不应有 thumb 字段');
    assert.equal(await Gallery.getThumbnail(noThumb.id), PNG, '无缩略图的老记录必须回退到原图');

    // 回图之后补写缩略图（Photoshop 路径走这条）
    const late = await Gallery.add(PNG, { sourceLabel: '后补缩略图' });
    assert.equal(late.thumb, undefined, '存档时没有缩略图');
    assert.equal(await Gallery.getThumbnail(late.id), PNG, '此时回退到原图');
    await Gallery.setThumbnail(late.id, THUMB);
    assert.equal(await Gallery.getThumbnail(late.id), THUMB, '补写后必须返回缩略图');
    assert.equal(await Gallery.getDataUrl(late.id), PNG, '补写缩略图不得影响原图');
    assert.equal(
        Gallery.list().find(function (entry) { return entry.id === late.id; }).thumb,
        THUMB, '缩略图必须写回元数据'
    );

    await Gallery.remove(withThumb.id);
    // 记录不存在时与 getDataUrl 保持一致：返回空串
    assert.equal(await Gallery.getThumbnail(withThumb.id), '', '删除后缩略图必须一并清理');
    assert.equal(await Gallery.getDataUrl(withThumb.id), '', '删除后原图也必须清理');

    // ---- 一键清空 ----
    // 必须把原图、缩略图和记录全部清掉。UXP 下图片是本地文件，
    // 只清元数据会在数据目录里留下孤儿文件。
    const clearA = await Gallery.add(PNG, { sourceLabel: '待清空A' }, undefined, THUMB);
    const clearB = await Gallery.add(PNG, { sourceLabel: '待清空B' });
    assert.ok(Gallery.list().length >= 2, '清空前应有多条记录');
    const clearResult = await Gallery.clear();
    assert.ok(clearResult.removed >= 2, 'clear 应报告删除数量，实际 ' + clearResult.removed);
    assert.equal(Gallery.list().length, 0, '清空后记录列表必须为空');
    assert.equal(await Gallery.getDataUrl(clearA.id), '', '清空后原图必须读不到');
    assert.equal(await Gallery.getThumbnail(clearA.id), '', '清空后缩略图必须一并删除');
    assert.equal(await Gallery.getDataUrl(clearB.id), '', '没有缩略图的记录也要清掉');
    assert.equal(await Gallery.clear().then(function (r) { return r.removed; }), 0, '对空画廊清空应返回 0 而不是报错');

    // ---- 格式嗅探：不能只信记录里的 mimeType ----
    // 回归：早先存下的记录可能没有 mimeType 字段，于是一张 JPEG 被标成
    // image/png，按 PNG 解码失败，画廊预览一片空白且控制台毫无报错。
    // 这里从源码切出真实的 detectImageMime / bytesToDataUrl 来跑。
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const storeSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'features', 'gallery', 'gallery-store.js'), 'utf8'
    ).split('\n');
    function sliceFn(name) {
        const start = storeSrc.findIndex(function (l) { return l.indexOf('function ' + name + '(') !== -1; });
        assert.ok(start > -1, '找不到 ' + name);
        let end = -1;
        for (let i = start + 1; i < storeSrc.length; i++) {
            if (/^    \}\s*$/.test(storeSrc[i])) { end = i + 1; break; }
        }
        assert.ok(end > -1, '无法确定 ' + name + ' 的结尾');
        return storeSrc.slice(start, end).join('\n');
    }
    const box = { console, btoa: btoa, atob: atob };
    vm.createContext(box);
    vm.runInContext(
        sliceFn('detectImageMime') + '\n' + sliceFn('bytesToDataUrl')
        + '\nthis.detect = detectImageMime; this.toUrl = bytesToDataUrl;',
        box
    );

    const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
    const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
    const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 5]);

    assert.equal(box.detect(PNG_BYTES), 'image/png');
    assert.equal(box.detect(JPG_BYTES), 'image/jpeg');
    assert.equal(box.detect(WEBP_BYTES), 'image/webp');

    // 关键回归：记录里 mimeType 写错时，必须以文件头为准
    assert.ok(box.toUrl(JPG_BYTES, 'image/png').startsWith('data:image/jpeg;base64,'),
        'JPEG 字节即使被标成 png 也必须按 jpeg 输出');
    assert.ok(box.toUrl(PNG_BYTES, undefined).startsWith('data:image/png;base64,'),
        'mimeType 缺失时按文件头判断');
    assert.ok(box.toUrl(PNG_BYTES, 'image/jpeg').startsWith('data:image/png;base64,'),
        '文件头优先于错误记录');

    console.log('gallery store: ok');
})().catch(function (error) {
    console.error(error);
    process.exit(1);
});
