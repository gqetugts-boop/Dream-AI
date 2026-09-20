/*
 * boot/util.js — 通用小工具
 *
 * 职责：命名空间、数值/字符串/异步辅助、DOM 构造、图像数据辅助。
 * 边界：纯函数，不依赖宿主、不依赖其他 DreamAI 模块。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.util) return;

    /* ---------- 命名空间 ---------- */

    /** 注册一个命名空间对象，已存在则复用（避免重复加载互相覆盖） */
    function ns(path) {
        var parts = String(path || '').split('.').filter(Boolean);
        var cursor = DreamAI;
        for (var i = 0; i < parts.length; i++) {
            if (!cursor[parts[i]]) cursor[parts[i]] = {};
            cursor = cursor[parts[i]];
        }
        return cursor;
    }

    /* ---------- 数值 ---------- */

    function toNumber(value, fallback) {
        var n = Number(value);
        if (isFinite(n)) return n;
        var f = Number(fallback);
        return isFinite(f) ? f : 0;
    }

    function clamp(value, min, max, fallback) {
        var n = toNumber(value, fallback === undefined ? min : fallback);
        if (n < min) return min;
        if (n > max) return max;
        return n;
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    function roundTo(value, step) {
        var s = toNumber(step, 1) || 1;
        return Math.round(toNumber(value, 0) / s) * s;
    }

    function smoothstep(edge0, edge1, x) {
        var span = edge1 - edge0;
        if (Math.abs(span) < 1e-9) return x < edge0 ? 0 : 1;
        var t = clamp((x - edge0) / span, 0, 1);
        return t * t * (3 - 2 * t);
    }

    /* ---------- 字符串 ---------- */

    function uid(prefix) {
        return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
            Math.random().toString(36).slice(2, 8);
    }

    function truncate(text, max) {
        var s = String(text == null ? '' : text);
        var limit = toNumber(max, 0);
        if (limit <= 0 || s.length <= limit) return s;
        return s.slice(0, limit - 1) + '…';
    }

    /** 全角/半角安全的首字母大写 */
    function capitalize(text) {
        var s = String(text || '');
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }

    /** 字节数格式化：1024 → 1.0 KB */
    function formatBytes(bytes) {
        var n = toNumber(bytes, 0);
        if (n < 1024) return n + ' B';
        var units = ['KB', 'MB', 'GB'];
        var i = -1;
        do { n = n / 1024; i++; } while (n >= 1024 && i < units.length - 1);
        return n.toFixed(1) + ' ' + units[i];
    }

    /** 秒数 → 1:05 / 1:02:03 */
    function formatDuration(seconds) {
        var total = Math.max(0, Math.floor(toNumber(seconds, 0)));
        var h = Math.floor(total / 3600);
        var m = Math.floor((total % 3600) / 60);
        var s = total % 60;
        var pad = function (v) { return v < 10 ? '0' + v : String(v); };
        return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
    }

    /* ---------- 集合 ---------- */

    function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    /** 递归合并，数组整体替换（配置型数据不需要元素级合并） */
    function deepMerge(base, patch) {
        if (!isPlainObject(base)) return isPlainObject(patch) ? deepMerge({}, patch) : patch;
        if (!isPlainObject(patch)) return base;
        var out = {};
        var key;
        for (key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
        for (key in patch) {
            if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
            out[key] = isPlainObject(out[key]) && isPlainObject(patch[key])
                ? deepMerge(out[key], patch[key])
                : patch[key];
        }
        return out;
    }

    function deepClone(value) {
        if (Array.isArray(value)) return value.map(deepClone);
        if (isPlainObject(value)) {
            var out = {};
            for (var key in value) {
                if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = deepClone(value[key]);
            }
            return out;
        }
        return value;
    }

    /** 取对象路径值：get(obj, 'a.b.c', fallback) */
    function getPath(object, path, fallback) {
        var parts = String(path || '').split('.');
        var cursor = object;
        for (var i = 0; i < parts.length; i++) {
            if (cursor == null || typeof cursor !== 'object') return fallback;
            if (!(parts[i] in cursor)) return fallback;
            cursor = cursor[parts[i]];
        }
        return cursor === undefined ? fallback : cursor;
    }

    function setPath(object, path, value) {
        var parts = String(path || '').split('.');
        var cursor = object;
        for (var i = 0; i < parts.length - 1; i++) {
            var key = parts[i];
            if (!isPlainObject(cursor[key])) cursor[key] = {};
            cursor = cursor[key];
        }
        cursor[parts[parts.length - 1]] = value;
        return object;
    }

    /* ---------- 异步 ---------- */

    function sleep(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, Math.max(0, toNumber(ms, 0)));
        });
    }

    function debounce(fn, wait) {
        var timer = null;
        var delay = toNumber(wait, 200);
        return function () {
            var args = arguments;
            var self = this;
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () {
                timer = null;
                fn.apply(self, args);
            }, delay);
        };
    }

    function throttle(fn, wait) {
        var last = 0;
        var delay = toNumber(wait, 100);
        return function () {
            var now = Date.now();
            if (now - last < delay) return undefined;
            last = now;
            return fn.apply(this, arguments);
        };
    }

    /**
     * 限时 Promise。超时不会取消底层工作，只让等待方继续。
     * @param {Promise} promise
     * @param {number} ms
     * @param {string} [label] 超时错误里带上的业务名
     */
    function withTimeout(promise, ms, label) {
        var timeout = toNumber(ms, 0);
        if (timeout <= 0) return Promise.resolve(promise);
        return new Promise(function (resolve, reject) {
            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                reject(new Error((label ? label + ': ' : '') + 'timeout after ' + timeout + 'ms'));
            }, timeout);
            Promise.resolve(promise).then(function (value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            }, function (error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    /** 串行执行器：把并发调用排成队列，避免宿主 API 冲突 */
    function createSerializer() {
        var tail = Promise.resolve();
        return function (task) {
            var run = tail.then(function () { return task(); }, function () { return task(); });
            tail = run.then(function () { return undefined; }, function () { return undefined; });
            return run;
        };
    }

    /** 带并发上限的批量执行，保持结果顺序 */
    function mapLimit(items, limit, worker) {
        var list = Array.isArray(items) ? items.slice() : [];
        var max = Math.max(1, Math.floor(toNumber(limit, 1)));
        var results = new Array(list.length);
        var cursor = 0;
        function runner() {
            if (cursor >= list.length) return Promise.resolve();
            var index = cursor++;
            return Promise.resolve(worker(list[index], index)).then(function (value) {
                results[index] = value;
                return runner();
            }, function (error) {
                results[index] = { __error: error };
                return runner();
            });
        }
        var workers = [];
        for (var i = 0; i < Math.min(max, list.length); i++) workers.push(runner());
        return Promise.all(workers).then(function () { return results; });
    }

    /* ---------- data URL ---------- */

    var DATA_URL_PATTERN = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)?(;base64)?,/;

    function parseDataUrl(dataUrl) {
        var text = String(dataUrl || '');
        var match = text.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
        if (!match) throw new Error('not a data url');
        return {
            mime: match[1] || 'text/plain',
            base64: !!match[2],
            payload: match[3] || ''
        };
    }

    function isDataUrl(value) {
        return DATA_URL_PATTERN.test(String(value || ''));
    }

    function dataUrlToBase64(dataUrl) {
        return parseDataUrl(dataUrl).payload;
    }

    function base64ToDataUrl(base64, mime) {
        return 'data:' + (mime || 'image/png') + ';base64,' + String(base64 || '');
    }

    function arrayBufferToBase64(buffer) {
        var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        var chunks = [];
        var chunkSize = 8192;
        for (var i = 0; i < bytes.length; i += chunkSize) {
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
        }
        return btoa(chunks.join(''));
    }

    function base64ToArrayBuffer(base64) {
        var binary = atob(String(base64 || ''));
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    /* ---------- FETCH ---------- */

    /**
     * 统一请求封装：超时、中止、JSON 解析、错误归一。
     * @returns {Promise<{ok:boolean,status:number,data:*,text:string,headers:Object}>}
     */
    function request(url, options) {
        var opts = options || {};
        var timeout = toNumber(opts.timeout, 60000);
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = null;
        var fetchOptions = {
            method: opts.method || 'GET',
            headers: opts.headers || {}
        };
        if (opts.body !== undefined && opts.body !== null) fetchOptions.body = opts.body;
        if (controller && opts.signal !== false) fetchOptions.signal = controller.signal;

        var binary = opts.as === 'arrayBuffer' || opts.binary === true;

        var pending = new Promise(function (resolve, reject) {
            if (!global.fetch) {
                reject(new Error('fetch unavailable in this host'));
                return;
            }
            global.fetch(url, fetchOptions).then(function (response) {
                if (binary && typeof response.arrayBuffer === 'function') {
                    // 二进制模式：用于下载图片等不能走 UTF-8 文本的响应
                    return response.arrayBuffer().then(function (buffer) {
                        var headers = {};
                        try {
                            if (response.headers && typeof response.headers.forEach === 'function') {
                                response.headers.forEach(function (value, key) { headers[key] = value; });
                            }
                        } catch (e) { /* 部分宿主不实现 headers 遍历 */ }
                        resolve({
                            ok: !!response.ok,
                            status: Number(response.status) || 0,
                            data: null,
                            buffer: buffer,
                            text: '',
                            headers: headers
                        });
                    });
                }
                return response.text().then(function (text) {
                    var data = null;
                    var contentType = '';
                    try { contentType = (response.headers && response.headers.get('content-type')) || ''; } catch (e) { contentType = ''; }
                    if (text && (contentType.indexOf('json') !== -1 || /^\s*[[{]/.test(text))) {
                        try { data = JSON.parse(text); } catch (e) { data = null; }
                    }
                    var headers = {};
                    try {
                        if (response.headers && typeof response.headers.forEach === 'function') {
                            response.headers.forEach(function (value, key) { headers[key] = value; });
                        }
                    } catch (e) { /* 部分宿主不实现 headers 遍历 */ }
                    resolve({
                        ok: !!response.ok,
                        status: Number(response.status) || 0,
                        data: data,
                        text: text || '',
                        headers: headers
                    });
                });
            }, function (error) {
                reject(error);
            });
        });

        var guarded = controller && timeout > 0
            ? withTimeout(pending, timeout, url).catch(function (error) {
                try { controller.abort(); } catch (e) { /* 忽略中止失败 */ }
                throw error;
            })
            : pending;

        return new Promise(function (resolve, reject) {
            guarded.then(function (result) {
                if (timer) clearTimeout(timer);
                resolve(result);
            }, function (error) {
                if (timer) clearTimeout(timer);
                reject(error);
            });
        });
    }

    /** request 的 JSON 便捷版：非 2xx 抛出带响应细节的错误 */
    function requestJson(url, options) {
        return request(url, options).then(function (res) {
            if (!res.ok) {
                var detail = res.data && (res.data.error && (res.data.error.message || res.data.error) || res.data.message);
                var message = typeof detail === 'string' && detail
                    ? detail
                    : truncate(res.text, 200) || ('HTTP ' + res.status);
                var error = new Error(message);
                error.status = res.status;
                error.payload = res.data;
                throw error;
            }
            return res.data !== null ? res.data : res.text;
        });
    }

    /* ---------- DOM ---------- */

    /**
     * 极简元素构造器。
     * el('div', { class: 'card', dataset: { role: 'x' }, text: 'hi' }, [child, 'string'])
     */
    function el(tag, attrs, children) {
        var node = global.document.createElement(tag);
        if (attrs) {
            for (var key in attrs) {
                if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
                var value = attrs[key];
                if (value === undefined || value === null || value === false) continue;
                if (key === 'class' || key === 'className') { node.className = value; }
                else if (key === 'text') { node.textContent = String(value); }
                else if (key === 'html') { node.innerHTML = String(value); }
                else if (key === 'dataset') {
                    for (var dataKey in value) {
                        if (Object.prototype.hasOwnProperty.call(value, dataKey)) {
                            node.setAttribute('data-' + dataKey.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }), String(value[dataKey]));
                        }
                    }
                } else if (key === 'style' && isPlainObject(value)) {
                    for (var styleKey in value) {
                        if (!Object.prototype.hasOwnProperty.call(value, styleKey)) continue;
                        /*
                         * CSSStyleDeclaration.setProperty 只接受 kebab-case 属性名。
                         * 传 camelCase（backgroundColor / maxWidth …）不会报错，
                         * 而是**静默忽略** —— 踩过一次：马赛克的背景色一直不生效，
                         * 排查很久才发现是这里没做转换。这里统一转成 kebab-case，
                         * 两种写法都能用。
                         */
                        node.style.setProperty(toKebabCase(styleKey), String(value[styleKey]));
                    }
                } else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
                    node.addEventListener(key.slice(2).toLowerCase(), value);
                } else if (key === 'value') {
                    node.value = value;
                } else {
                    node.setAttribute(key, value === true ? '' : String(value));
                }
            }
        }
        appendChildren(node, children);
        return node;
    }

    /** camelCase → kebab-case；已经是 kebab 的原样返回（自定义属性 --x 也保持） */
    function toKebabCase(name) {
        var text = String(name || '');
        if (!text || text.indexOf('--') === 0 || text.indexOf('-') !== -1) return text;
        return text.replace(/[A-Z]/g, function (match) { return '-' + match.toLowerCase(); });
    }

    function appendChildren(node, children) {
        if (children === undefined || children === null || children === false) return node;
        if (Array.isArray(children)) {
            for (var i = 0; i < children.length; i++) appendChildren(node, children[i]);
            return node;
        }
        if (children instanceof global.Node) node.appendChild(children);
        else if (typeof children === 'string' || typeof children === 'number') node.appendChild(global.document.createTextNode(String(children)));
        return node;
    }

    function clear(node) {
        if (!node) return node;
        while (node.firstChild) node.removeChild(node.firstChild);
        return node;
    }

    function qs(selector, root) {
        return (root || global.document).querySelector(selector);
    }

    function qsa(selector, root) {
        return Array.prototype.slice.call((root || global.document).querySelectorAll(selector));
    }

    /**
     * 原生 range 在 UXP 里样式控制不住，统一改成 "轨道 + 手指" 结构，
     * 由这里负责把滑块值同步到 CSS 变量与数值标签。
     */
    function bindRange(input, onChange) {
        if (!input) return;
        var hostNode = input.closest ? input.closest('.range') : null;
        var readout = hostNode ? hostNode.querySelector('.range-readout') : null;
        function sync() {
            var min = toNumber(input.min, 0);
            var max = toNumber(input.max, 100);
            var value = toNumber(input.value, min);
            var ratio = max === min ? 0 : (value - min) / (max - min);
            if (hostNode) hostNode.style.setProperty('--range-ratio', String(clamp(ratio, 0, 1)));
            if (readout) readout.textContent = String(value);
            if (typeof onChange === 'function') onChange(value);
        }
        input.addEventListener('input', sync);
        input.addEventListener('change', sync);
        sync();
        return sync;
    }

    DreamAI.util = {
        ns: ns,
        toNumber: toNumber,
        clamp: clamp,
        lerp: lerp,
        roundTo: roundTo,
        smoothstep: smoothstep,
        uid: uid,
        truncate: truncate,
        capitalize: capitalize,
        formatBytes: formatBytes,
        formatDuration: formatDuration,
        isPlainObject: isPlainObject,
        deepMerge: deepMerge,
        deepClone: deepClone,
        getPath: getPath,
        setPath: setPath,
        sleep: sleep,
        debounce: debounce,
        throttle: throttle,
        withTimeout: withTimeout,
        createSerializer: createSerializer,
        mapLimit: mapLimit,
        isDataUrl: isDataUrl,
        parseDataUrl: parseDataUrl,
        dataUrlToBase64: dataUrlToBase64,
        base64ToDataUrl: base64ToDataUrl,
        arrayBufferToBase64: arrayBufferToBase64,
        base64ToArrayBuffer: base64ToArrayBuffer,
        request: request,
        requestJson: requestJson,
        el: el,
        toKebabCase: toKebabCase,
        clear: clear,
        qs: qs,
        qsa: qsa,
        bindRange: bindRange
    };
})(typeof window !== 'undefined' ? window : this);
