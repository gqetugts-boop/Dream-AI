/*
 * tests/sandbox.mjs — 把浏览器风格的模块装进 Node，便于对纯算法做单测。
 * 用法：const { DreamAI } = await loadDreamAI(['src/core/photo-encode.js']);
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function installGlobals() {
    globalThis.window = globalThis;
    if (!globalThis.localStorage) {
        const map = new Map();
        globalThis.localStorage = {
            getItem: (k) => (map.has(k) ? map.get(k) : null),
            setItem: (k, v) => { map.set(k, String(v)); },
            removeItem: (k) => { map.delete(k); },
            key: (i) => Array.from(map.keys())[i] ?? null,
            get length() { return map.size; },
            clear: () => map.clear()
        };
    }
    // 最小 style 实现：记录 setProperty，供样式键转换的用例断言
    if (!globalThis.document) {
        const makeStyle = () => {
            const store = new Map();
            return {
                setProperty(name, value) { store.set(name, String(value)); },
                getPropertyValue(name) { return store.has(name) ? store.get(name) : ''; },
                removeProperty(name) { store.delete(name); },
                get cssText() { return Array.from(store.entries()).map(([k, v]) => k + ':' + v).join(';'); }
            };
        };
        const makeNode = (tag) => ({
            nodeType: 1,
            tagName: String(tag || 'div').toUpperCase(),
            childNodes: [],
            style: makeStyle(),
            className: '',
            attributes: {},
            appendChild(child) { this.childNodes.push(child); return child; },
            setAttribute(name, value) { this.attributes[name] = String(value); },
            getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
            removeAttribute(name) { delete this.attributes[name]; },
            addEventListener() {},
            removeEventListener() {},
            querySelector() { return null; },
            querySelectorAll() { return []; },
            hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
        });
        globalThis.Node = function Node() {};
        globalThis.document = {
            createElement: (tag) => makeNode(tag),
            createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
            body: makeNode('body'),
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementById: () => null,
            addEventListener() {},
            removeEventListener() {}
        };
    }

    if (!globalThis.ImageData) {
        globalThis.ImageData = class ImageData {
            constructor(data, width, height) {
                if (typeof data === 'number') {
                    this.width = data; this.height = width;
                    this.data = new Uint8ClampedArray(this.width * this.height * 4);
                } else {
                    this.data = data; this.width = width; this.height = height;
                }
            }
        };
    }
    return globalThis;
}

export async function loadDreamAI(relativePaths) {
    installGlobals();
    const list = ['src/boot/util.js'].concat(relativePaths || []);
    const missing = [];
    for (const rel of list) {
        const full = path.join(ROOT, rel);
        if (!fs.existsSync(full)) {
            // 并行开发期允许文件尚未落盘：跳过并记录，调用方可用
            // 返回值上的 __missing 判断依赖是否齐全。
            missing.push(rel);
            continue;
        }
        await import(pathToFileURL(full).href);
    }
    globalThis.DreamAI.__missing = missing;
    return globalThis.DreamAI;
}

export function makeImage(width, height, fill) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            const c = typeof fill === 'function' ? fill(x, y) : (fill || [0, 0, 0, 255]);
            data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = c[3] ?? 255;
        }
    }
    return { data, width, height, channels: 4 };
}
