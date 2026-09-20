/*
 * tests/ui-smoke.mjs — 界面骨架冒烟测试
 *
 * 目的：在没有 Photoshop、也没有真实浏览器的前提下，用最小 DOM 桩把
 *       插件的前端装配链路跑一遍，尽早暴露"脚本顺序错误 / 命名空间缺失 /
 *       页面注册失败 / i18n 键缺失"这类集成问题。
 *
 * 做法：
 *   1. 读取 index.html，按出现顺序抽出所有 <script src>；
 *   2. 用沙箱里的全局对象顺序加载它们（跳过需要真实 dom 的部分，
 *      注入一个够用的 document 桩）；
 *   3. 校验关键命名空间齐全、所有页面已注册、所有 labelKey 都能翻译。
 *
 * 用法：node tests/ui-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { installGlobals } from './sandbox.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const I18N_KEYS = [];

/* ============================================================
 * 最小 DOM 桩：只实现插件加载期真正会用到的那部分 API
 * ============================================================ */
function makeNode(tag) {
    const node = {
        tagName: String(tag || 'div').toUpperCase(),
        nodeType: 1,
        childNodes: [],
        parentNode: null,
        attributes: {},
        style: {
            setProperty() {},
            removeProperty() {},
            getPropertyValue() { return ''; }
        },
        dataset: {},
        classList: {
            add() {}, remove() {}, contains() { return false; }, toggle() {}
        },
        className: '',
        textContent: '',
        innerHTML: '',
        value: '',
        files: null,
        checked: false,
        hidden: false,
        firstChild: null,
        lastChild: null,
        children: [],
        scrollTop: 0,
        scrollHeight: 0,
        width: 0,
        height: 0,
        __listeners: {}
    };
    node.appendChild = function (child) {
        if (!child) return child;
        child.parentNode = node;
        node.childNodes.push(child);
        node.children.push(child);
        node.firstChild = node.childNodes[0] || null;
        node.lastChild = node.childNodes[node.childNodes.length - 1] || null;
        return child;
    };
    node.removeChild = function (child) {
        const index = node.childNodes.indexOf(child);
        if (index !== -1) {
            node.childNodes.splice(index, 1);
            node.children.splice(index, 1);
        }
        if (child) child.parentNode = null;
        node.firstChild = node.childNodes[0] || null;
        node.lastChild = node.childNodes[node.childNodes.length - 1] || null;
        return child;
    };
    node.setAttribute = function (name, value) {
        node.attributes[name] = String(value);
        if (name === 'class') node.className = String(value);
        if (name === 'id') node.id = String(value);
        if (name === 'hidden') node.hidden = true;
        if (name === 'value') node.value = String(value);
        if (name.indexOf('data-') === 0) {
            const camel = name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
            node.dataset[camel] = String(value);
        }
    };
    node.getAttribute = function (name) {
        if (name === 'class') return node.className || null;
        return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
    };
    node.removeAttribute = function (name) {
        delete node.attributes[name];
        if (name === 'hidden') node.hidden = false;
        if (name.indexOf('data-') === 0) {
            const camel = name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
            delete node.dataset[camel];
        }
    };
    node.hasAttribute = function (name) { return Object.prototype.hasOwnProperty.call(node.attributes, name); };
    node.addEventListener = function (type, handler) {
        node.__listeners[type] = node.__listeners[type] || [];
        node.__listeners[type].push(handler);
    };
    node.removeEventListener = function (type, handler) {
        const list = node.__listeners[type];
        if (!list) return;
        const index = list.indexOf(handler);
        if (index !== -1) list.splice(index, 1);
    };
    node.querySelector = function () { return null; };
    node.querySelectorAll = function () { return []; };
    node.closest = function () { return null; };
    node.contains = function () { return false; };
    node.click = function () {
        const list = node.__listeners.click || [];
        for (const handler of list) {
            try { handler({ target: node, preventDefault() {}, stopPropagation() {} }); } catch (error) { /* 记录即可 */ }
        }
    };
    node.focus = function () {};
    node.getBoundingClientRect = function () { return { left: 0, top: 0, width: 100, height: 20 }; };
    node.remove = function () { if (node.parentNode) node.parentNode.removeChild(node); };
    return node;
}

function installDomStub() {
    const registry = new Map();
    const document = {
        readyState: 'complete',
        documentElement: makeNode('html'),
        body: makeNode('body'),
        createElement: (tag) => makeNode(tag),
        createTextNode: (text) => ({ nodeType: 3, textContent: String(text), parentNode: null }),
        getElementById: (id) => registry.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
        __registry: registry
    };
    // 预建 index.html 里真实存在的节点 id，让 shell/app 能取到
    const shellIds = [
        'appShell', 'bootVeil', 'appNav', 'appStage', 'statusMessage', 'statusProgress',
        'statusProgressBar', 'statusMeta', 'statusDot', 'activityDot', 'btnActivityLog',
        'taskDrawer', 'taskDrawerBody', 'logDrawer', 'logDrawerBody', 'modalLayer',
        'modalTitle', 'modalBody', 'modalFoot', 'toastStack', 'taskBadge', 'langChipText',
        'themeGlyph', 'btnTaskTray', 'btnLangToggle', 'btnThemeToggle', 'btnOpenSettings',
        'topbarPage', 'btnCloseTaskDrawer', 'btnCloseLogDrawer', 'btnCloseModal',
        'btnCopyLogs', 'btnClearLogs'
    ];
    for (const id of shellIds) {
        const node = makeNode('div');
        node.id = id;
        registry.set(id, node);
    }
    globalThis.Node = function Node() {};
    globalThis.document = document;
    return document;
}

/* ============================================================
 * CSS 静态审计
 *
 * 纯 JS 的测试查不出样式问题，这里补三类最容易踩的坑：
 *   1. 用了没定义的 CSS 变量（浏览器里会静默失效，颜色/圆角直接消失）；
 *   2. 声明块括号不配平（会让后面整段样式失效，典型"错位"来源）；
 *   3. JS 里写了 class 但样式表里没有任何规则（元素会裸奔、错位）。
 * ============================================================ */
function auditCss() {
    const cssDir = path.join(ROOT, 'src', 'ui');
    const files = fs.readdirSync(cssDir).filter((name) => name.endsWith('.css'));
    const source = {};
    for (const name of files) source[name] = fs.readFileSync(path.join(cssDir, name), 'utf8');

    // 1) 收集已定义的变量
    const defined = new Set();
    for (const name of files) {
        const re = /(--[a-zA-Z0-9-]+)\s*:/g;
        let match;
        while ((match = re.exec(source[name]))) defined.add(match[1]);
    }

    // 2) 收集被引用的变量
    const used = new Map();
    for (const name of files) {
        const re = /var\(\s*(--[a-zA-Z0-9-]+)/g;
        let match;
        while ((match = re.exec(source[name]))) {
            if (!used.has(match[1])) used.set(match[1], new Set());
            used.get(match[1]).add(name);
        }
    }
    const undefinedVars = [];
    for (const [name, where] of used) {
        if (!defined.has(name)) undefinedVars.push(name + '（' + Array.from(where).join(', ') + '）');
    }

    // 3) 括号配平 + 变量声明以分号结尾的粗检
    const braceProblems = [];
    for (const name of files) {
        const text = source[name];
        let depth = 0;
        let broken = false;
        for (const ch of text) {
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth < 0) { broken = true; break; }
            }
        }
        if (broken || depth !== 0) braceProblems.push(name + '（' + (broken ? '出现多余的 }' : '未闭合，差 ' + depth + ' 个 }') + '）');
    }

    // 4) 收集样式表里出现过的 class
    const styled = new Set();
    for (const name of files) {
        const re = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g;
        let match;
        while ((match = re.exec(source[name]))) styled.add(match[1]);
    }

    // 5) 从 JS 里提取字面量 class（只查 class: 附近，避免误报）
    const jsFiles = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) jsFiles.push(full);
        }
    };
    // 只扫界面层：core/ 里的 'channel' / 'layer' 等是 Photoshop action 描述符，
    // 不是 CSS class，混进来会产生误报。
    walk(path.join(ROOT, 'src', 'ui'));
    walk(path.join(ROOT, 'src', 'boot'));
    const unstyled = new Map();
    for (const file of jsFiles) {
        const text = fs.readFileSync(file, 'utf8');
        const re = /class:\s*'([^']+)'|class:\s*"([^"]+)"|classList\.add\('([^']+)'/g;
        let match;
        while ((match = re.exec(text))) {
            const raw = match[1] || match[2] || match[3] || '';
            for (const token of raw.split(/\s+/)) {
                if (!token || token.indexOf('$') !== -1) continue;
                if (styled.has(token)) continue;
                if (!unstyled.has(token)) unstyled.set(token, new Set());
                unstyled.get(token).add(path.relative(ROOT, file));
            }
        }
    }

    // 6) HTML 里的 class 同样查一遍
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const htmlClasses = new Set();
    const classRe = /class="([^"]+)"/g;
    let htmlMatch;
    while ((htmlMatch = classRe.exec(html))) {
        for (const token of htmlMatch[1].split(/\s+/)) if (token) htmlClasses.add(token);
    }
    const unstyledHtml = Array.from(htmlClasses).filter((token) => !styled.has(token));

    return { undefinedVars, braceProblems, unstyled, unstyledHtml, definedCount: defined.size, usedCount: used.size };
}

/* ============================================================
 * 按 index.html 的顺序加载脚本
 * ============================================================ */
function scriptSources() {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const out = [];
    const re = /<script\s+src="([^"]+)"><\/script>/g;
    let match;
    while ((match = re.exec(html))) out.push(match[1]);
    return out;
}

function i18nKeysUsed() {
    // 从页面与 UI 源码里抓出所有形如 'xxx.yyy' 的字符串字面量，用于校验键存在
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.js$/.test(entry.name)) files.push(full);
        }
    };
    walk(path.join(ROOT, 'src', 'ui'));
    walk(path.join(ROOT, 'src', 'boot'));
    /*
     * 只认「域.名称」或「域.名称.名称」两/三段式词条键。
     * 这样可以自动排除：
     *   - 持久化域与状态路径（settings.gallery.maxCount 这种四段的）
     *   - 字符串拼接片段（settings.channels. / settings.channel.）
     *   - 资源后缀与 URL
     */
    const pattern = /(?:'|")([a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)?)(?:'|")/g;
    const SKIP = /(settings|store|workbench|chat|gallery|presets|tools|engines|taskHistory|references|collapsed)\.(gallery|channels|channel|systemPrompt|chatSystemPrompt|uiScale|modelCache|behavior|history|items|queue|user|meta|comfy|forge|glow|vfx|scope)/;
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        let match;
        while ((match = pattern.exec(text))) {
            const key = match[1];
            if (/\.(js|css|png|json|svg|webmanifest)$/.test(key)) continue;
            if (/^(www|http|https)\./.test(key)) continue;
            if (SKIP.test(key)) continue;
            // App.get/saveSettings 里的状态路径也长得像词条键，一并排除
            if (/^settings\./.test(key)) continue;
            if (key === 'a.b.c' || key === 'does.not.exist') continue;   // i18n 自测用的假键
            // 诊断文案里会直接写 API 名（ctx.createImageData 之类），不是词条键
            if (/^(ctx|canvas|document|window|img|style)\./.test(key)) continue;
            I18N_KEYS.push({ key, file: path.relative(ROOT, file) });
        }
    }
}

async function main() {
    installGlobals();
    installDomStub();
    const sources = scriptSources();
    console.log('按 index.html 顺序加载 ' + sources.length + ' 个脚本');

    const failed = [];
    for (const relative of sources) {
        const full = path.join(ROOT, relative);
        if (!fs.existsSync(full)) {
            failed.push({ relative, error: 'file missing' });
            continue;
        }
        try {
            await import(pathToFileURL(full).href);
        } catch (error) {
            failed.push({ relative, error: error && error.message ? error.message : String(error) });
        }
    }

    const D = globalThis.DreamAI || {};
    const required = [
        'host', 'util', 'I18n', 'Store', 'bus', 'logbus', 'psLock', 'Theme', 'PhotoEncode',
        'PhotoIO', 'PhotoReturn', 'Widgets', 'Router', 'Shell', 'Providers', 'TaskQueue',
        'Gallery', 'Batch', 'ColorEngine', 'GlowCore', 'VfxCore', 'Scope',
        'ComfyUI', 'Forge', 'GlowTool', 'VfxTool', 'App'
    ];
    const missing = required.filter((name) => !D[name]);


    D.I18n && D.I18n.flushQueue && D.I18n.flushQueue();
    const pages = D.Router ? D.Router.list() : [];
    const expectedPages = [
        'workbench', 'chat', 'toolbox', 'vfx', 'comfyui', 'forge',
        'gallery', 'batch', 'logs', 'settings', 'about'
    ];
    const missingPages = expectedPages.filter((id) => !pages.some((page) => page.id === id));

    i18nKeysUsed();
    const uniqueKeys = Array.from(new Set(I18N_KEYS.map((entry) => entry.key)));
    const untranslatedZh = [];
    const untranslatedEn = [];
    if (D.I18n) {
        for (const key of uniqueKeys) {
            const inZh = Object.prototype.hasOwnProperty.call(D.I18n.dictionaries['zh-CN'], key);
            const inEn = Object.prototype.hasOwnProperty.call(D.I18n.dictionaries['en-US'], key);
            if (!inZh) untranslatedZh.push(key);
            if (!inEn) untranslatedEn.push(key);
        }
    }

    /* ------------------------------------------------------------
     * 真正把每个页面 build + mount 一遍，确认页面工厂能跑通
     * ---------------------------------------------------------- */
    const pageErrors = [];
    if (D.Router && D.Widgets && D.App) {
        // App 可能已经自己 boot 过；这里直接手动初始化路由，避免依赖 boot 时序
        try {
            const shellNodes = { nav: makeNode('nav'), stage: makeNode('div') };
            D.Router.init(shellNodes.nav, shellNodes.stage, {});
        } catch (error) {
            pageErrors.push({ id: '(router.init)', error: error && error.message ? error.message : String(error) });
        }
        for (const page of pages) {
            try {
                D.Router.activate(page.id, { silent: true });
                const instance = D.Router.getInstance(page.id);
                if (!instance) throw new Error('页面未构建实例');
                if (typeof instance.api.mount === 'function') instance.api.mount();
                if (typeof instance.api.unmount === 'function') instance.api.unmount();
                if (typeof instance.api.mount === 'function') instance.api.mount();
                // 检查完立刻卸载：页面可能注册了轮询定时器，不卸载会拖住进程
                if (typeof instance.api.unmount === 'function') instance.api.unmount();
            } catch (error) {
                pageErrors.push({
                    id: page.id,
                    error: (error && error.message ? error.message : String(error)) +
                        (error && error.stack ? '\n      ' + String(error.stack).split('\n').slice(1, 4).join('\n      ') : '')
                });
            }
        }
    }

    /* 顶栏动作也要能点：语言切换与主题切换 */
    const toggleErrors = [];
    for (const id of ['btnLangToggle', 'btnThemeToggle', 'btnOpenSettings', 'btnTaskTray', 'btnActivityLog']) {
        const node = document.getElementById(id);
        if (!node) continue;
        try { node.click(); } catch (error) { toggleErrors.push({ id, error: error && error.message ? error.message : String(error) }); }
    }

    /* ------------------------------------------------------------
     * 启动链路：确认 App 引导真的跑到底（外壳显示、首屏就位、状态条就绪）
     * ---------------------------------------------------------- */
    const bootProblems = [];
    if (D.App) {
        if (!D.App.state || D.App.state.ready !== true) bootProblems.push('App.state.ready 未置为 true（引导中断）');
        if (D.App.state && !D.App.state.activePageId) bootProblems.push('未激活任何页面');
        const veil = document.getElementById('bootVeil');
        const shell = document.getElementById('appShell');
        if (veil && !veil.hasAttribute('hidden')) bootProblems.push('启动遮罩未被移除');
        if (shell && shell.hasAttribute('hidden')) bootProblems.push('外壳仍处于隐藏状态');
        const status = document.getElementById('statusMessage');
        if (status && !status.textContent) bootProblems.push('状态条没有初始文案');
        if (D.App.settings && !D.App.settings.behavior) bootProblems.push('设置未加载默认值');
        if (D.App.settings && typeof D.App.settings.behavior.maxConcurrent !== 'number') {
            bootProblems.push('设置默认值结构不完整（behavior.maxConcurrent 缺失）');
        }
    } else {
        bootProblems.push('缺少 DreamAI.App');
    }

    /* 侧栏结构检查：分组、tab 数量、图标与文字是否齐全 */
    if (D.Router && D.Router.list().length) {
        const expectedSidebarPages = D.Router.list().filter((page) => D.Router.SIDEBAR_GROUPS.indexOf(page.group) !== -1);
        if (D.Router.list().length && expectedSidebarPages.length === 0) {
            bootProblems.push('侧栏分组为空：没有页面落在 create/engine/asset 组里');
        }
        if (expectedSidebarPages.length < 9) {
            bootProblems.push('侧栏页面数量偏少（' + expectedSidebarPages.length + '），导航可能不完整');
        }
        for (const page of expectedSidebarPages) {
            if (!page.glyph) bootProblems.push('页面 ' + page.id + ' 缺少侧栏图标');
        }
    }

    /* ------------------------------------------------------------
     * 布局标定校验：把"元素标准相对位置"固化成断言
     *
     * 这里不是渲染，而是把布局算术写成断言。任何改动只要破坏了下面任何一条，
     * 就说明竖排适配或宽度收敛被改坏了（历史上就是这几条出过挤压/错位）。
     * ---------------------------------------------------------- */
    const layoutProblems = [];
    const readCss = (name) => fs.readFileSync(path.join(ROOT, 'src', 'ui', name), 'utf8');
    const tokenCss = readCss('tokens.css');
    const layoutCss = readCss('layout.css');
    const widgetsCss = readCss('widgets.css');

    const numVar = (css, name, fallback) => {
        const m = css.match(new RegExp(name.replace(/[-]/g, '\\-') + '\\s*:\\s*([0-9.]+)px'));
        return m ? parseFloat(m[1]) : fallback;
    };

    const sidebarW = numVar(tokenCss, '--sidebar-w', 68);
    const stageW = numVar(tokenCss, '--stage-w', 760);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const minPanel = manifest.entrypoints[0].minimumSize.width;

    // 1) 侧栏必须能容纳 34px 品牌块（内距 6px 两侧）
    const sidebarInner = sidebarW - 6 * 2;
    if (sidebarInner < 34) {
        layoutProblems.push('侧栏内容宽 ' + sidebarInner + 'px 放不下 34px 品牌块');
    }

    // 2) 侧栏标签宽度必须容得下 4 个中文字（按 9px 字号 ≈ 40px）
    // 中文标签最多 3 字（工具箱/批处理），按 9px 字号 ≈ 27px；留 4px 安全余量
    if (sidebarInner - 4 < 31) {
        layoutProblems.push('侧栏标签可用宽 ' + (sidebarInner - 4) + 'px 放不下 3 个中文字（需 ≥31px）');
    }
    // 标签必须禁止省略号：出现 text-overflow: ellipsis 就会被截成 "工..."
    const labelRule = layoutCss.match(/\.sidebar-tab-label\s*\{[^}]*\}/s);
    if (labelRule && /text-overflow:\s*ellipsis/.test(labelRule[0])) {
        layoutProblems.push('.sidebar-tab-label 又用回了省略号截断');
    }

    // 3) 最小面板宽度下主区必须还有可用空间
    const minMain = minPanel - sidebarW;
    if (minMain < 200) {
        layoutProblems.push('面板最小宽 ' + minPanel + 'px 时主区只剩 ' + minMain + 'px');
    }

    // 4) 侧栏宽度不得随断点收窄（本轮回归点：收窄会把中文标签截成省略号）
    const narrowSidebar = layoutCss.match(/@media[^{]*max-width:\s*\d+px[^{]*\{[^@]*?--sidebar-w:\s*([0-9]+)px/g) || [];
    for (const block of narrowSidebar) {
        const value = parseFloat(block.match(/--sidebar-w:\s*([0-9]+)px/)[1]);
        if (value < 68) layoutProblems.push('断点把侧栏收窄到 ' + value + 'px，会截断中文标签（下限 68）');
    }

    // 5) 关键容器必须有 min-width:0，否则 nowrap 内容会撑宽父级
    const mustHaveMinWidthZero = ['.app-main', '.sidebar-scroll', '.row', '.card-titles', '.page'];
    for (const selector of mustHaveMinWidthZero) {
        const re = new RegExp(selector.replace(/\./g, '\\.') + '\\s*\\{[^}]*min-width:\\s*0', 's');
        if (!re.test(layoutCss + widgetsCss + readCss('pages.css'))) {
            layoutProblems.push(selector + ' 缺少 min-width:0（nowrap 内容会撑宽父级）');
        }
    }

    // 6) 按钮必须有收缩约束，否则文字会把按钮撑出容器
    if (!/\.btn\s*\{[^}]*max-width:\s*100%/s.test(widgetsCss)) {
        layoutProblems.push('.btn 缺少 max-width:100%（按钮文字会撑出卡片）');
    }
    if (!/\.btn-label\s*\{[^}]*text-overflow:\s*ellipsis/s.test(widgetsCss)) {
        layoutProblems.push('.btn-label 缺少省略号截断');
    }

    // 7) 图片槽不能用 aspect-ratio（会撑高且让内部 img 拿不到高度）
    if (/\.image-slot\s*\{[^}]*aspect-ratio/s.test(widgetsCss)) {
        layoutProblems.push('.image-slot 又用回了 aspect-ratio（会撑高、图片高度算成 0）');
    }
    if (!/\.image-slot\s*\{[^}]*height:\s*[0-9]+px/s.test(widgetsCss)) {
        layoutProblems.push('.image-slot 缺少确定高度');
    }
    /*
     * 预览/槽位图片必须靠 CSS 自己缩放，不允许依赖 JS 算像素宽高。
     * 历史上正是 JS 里读 naturalWidth/clientWidth 拿到 0 → 算出 0×0 →
     * 元素在 DOM 里但完全不可见（"读取了选区却没有预览"）。
     */
    for (const selector of ['.preview-frame', '.image-slot']) {
        const rule = widgetsCss.match(new RegExp(selector.replace(/\./g, '\\.') + '\\s*\\{[^}]*\\}', 's'));
        if (rule && !/height:\s*\d+px/.test(rule[0])) {
            layoutProblems.push(selector + ' 缺少确定高度（图片的 max-height:100% 会失去参照）');
        }
    }
    // 选择器可能写成合并形式（.preview-frame img, .preview-frame canvas），
    // 所以按"包含该选择器的规则块"来查找，而不是要求精确匹配整条选择器
    /*
     * 预览与槽位里的图片都要靠 CSS 缩放：object-fit:contain +
     * 明确的高度约束（预览 240px 上限 / 槽位 100%）。
     */
    const imageRules = [
        { selector: '.preview-frame .preview-image', requireHeight: /max-height:\s*240px/ },
        { selector: '.image-slot img', requireHeight: /max-height:\s*100%/ }
    ];
    for (const entry of imageRules) {
        const esc = entry.selector.replace(/\./g, '\\.').replace(/ /g, '\\s+');
        const rule = widgetsCss.match(new RegExp(esc + '\\s*,[^{}]*\\{[^}]*\\}|' + esc + '\\s*\\{[^}]*\\}', 's'));
        if (!rule) { layoutProblems.push(entry.selector + ' 规则缺失'); continue; }
        if (!/object-fit:\s*contain/.test(rule[0])) {
            layoutProblems.push(entry.selector + ' 应为 object-fit:contain');
        }
        if (!entry.requireHeight.test(rule[0])) {
            layoutProblems.push(entry.selector + ' 缺少高度约束');
        }
    }
    // 关键回归点：预览图片必须是 width:100%，不能是 auto
    // （width:auto 会按固有尺寸铺开，683x1536 的选区远超容器后被裁掉）
    const shown = widgetsCss.match(/\.preview-frame\[data-has-image="true"\]\s*\.preview-image\s*\{[^}]*\}/s);
    if (!shown) {
        layoutProblems.push('.preview-frame[data-has-image="true"] .preview-image 规则缺失');
    } else if (!/width:\s*100%\s*!?important?/.test(shown[0]) && !/width:\s*100%/.test(shown[0])) {
        layoutProblems.push('预览图片显示规则缺少 width:100%（width:auto 会被 overflow 裁掉）');
    }
    // 预览实现不得再回去做 JS 尺寸计算
    const widgetsJs = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'widgets.js'), 'utf8');
    const previewBlock = widgetsJs.slice(widgetsJs.indexOf('function previewFrame'));
    const previewFn = previewBlock.slice(0, previewBlock.indexOf('function '));
    if (/naturalWidth|clientWidth/.test(previewFn.slice(0, 4000).replace(/\/\*[\s\S]*?\*\//g, ''))) {
        layoutProblems.push('previewFrame 又在 JS 里读固有尺寸算宽高（拿不到就会算出 0×0，图片不可见）');
    }

    // 8) 舞台不允许横向滚动
    if (!/\.app-stage\s*\{[^}]*overflow-x:\s*hidden/s.test(layoutCss)) {
        layoutProblems.push('.app-stage 缺少 overflow-x:hidden');
    }

    // 9) 圆角不许出现胶囊/正圆
    const allCssText = tokenCss + layoutCss + widgetsCss + readCss('pages.css');
    if (/border-radius:\s*(999px|50%)/.test(allCssText)) {
        layoutProblems.push('样式里仍有 999px / 50% 的椭圆圆角');
    }

    // 10) 逐级宽度收敛：把结果打出来，便于人工核对
    const widthTable = [];
    for (const panelWidth of [300, 360, 460, 900]) {
        const pad = panelWidth <= 360 ? 7 : (panelWidth <= 440 ? 8 : 12);
        const sb = panelWidth <= 440 ? 72 : sidebarW;
        const stage = panelWidth - sb - pad * 2;
        const page = Math.min(stage, stageW);
        const interior = page - 12 * 2 - 2;
        widthTable.push({
            panel: panelWidth,
            sidebar: sb,
            stage,
            page,
            interior,
            column2: Math.round((interior - 10) / 2),
            slot: Math.round((interior - 8) / 2)
        });
    }

    console.log('');
    console.log('逐级宽度收敛（面板 / 侧栏 / 舞台 / 页面 / 卡片内容 / 两列单列 / 槽位单宽）：');
    for (const row of widthTable) {
        console.log('  ' + String(row.panel).padStart(4) + ' / ' + String(row.sidebar).padStart(3) +
            ' / ' + String(row.stage).padStart(4) + ' / ' + String(row.page).padStart(4) +
            ' / ' + String(row.interior).padStart(4) + ' / ' + String(row.column2).padStart(4) +
            ' / ' + String(row.slot).padStart(4));
    }
    console.log('布局标定问题: ' + layoutProblems.length);
    for (const item of layoutProblems) console.log('  ✗ ' + item);

    /* ------------------------------------------------------------
     * CSS 审计
     * ---------------------------------------------------------- */
    const cssAudit = auditCss();

    console.log('');
    console.log('CSS 变量: 定义 ' + cssAudit.definedCount + ' 个 / 引用 ' + cssAudit.usedCount + ' 个');
    console.log('未定义的 CSS 变量: ' + cssAudit.undefinedVars.length);
    for (const item of cssAudit.undefinedVars) console.log('  ✗ ' + item);
    console.log('CSS 括号问题: ' + cssAudit.braceProblems.length);
    for (const item of cssAudit.braceProblems) console.log('  ✗ ' + item);
    console.log('JS 中未样式化的 class: ' + cssAudit.unstyled.size);
    for (const [token, where] of cssAudit.unstyled) {
        console.log('  ✗ .' + token + ' ← ' + Array.from(where).join(', '));
    }
    console.log('HTML 中未样式化的 class: ' + cssAudit.unstyledHtml.length);
    if (cssAudit.unstyledHtml.length) console.log('  ✗ ' + cssAudit.unstyledHtml.join(', '));

    console.log('');
    console.log('启动链路问题: ' + bootProblems.length);
    for (const item of bootProblems) console.log('  ✗ ' + item);
    console.log('脚本加载失败: ' + failed.length);
    for (const item of failed) console.log('  ✗ ' + item.relative + ' — ' + item.error);
    console.log('缺失命名空间: ' + missing.length + (missing.length ? ' → ' + missing.join(', ') : ''));
    console.log('已注册页面: ' + pages.length + ' / 期望 ' + expectedPages.length +
        (missingPages.length ? '（缺 ' + missingPages.join(', ') + '）' : ''));
    console.log('扫描到的 i18n 键: ' + uniqueKeys.length +
        '（中文缺 ' + untranslatedZh.length + '，英文缺 ' + untranslatedEn.length + '）');
    if (untranslatedZh.length) console.log('  中文缺: ' + untranslatedZh.slice(0, 25).join(', '));
    if (untranslatedEn.length) console.log('  英文缺: ' + untranslatedEn.slice(0, 25).join(', '));

    console.log('页面构建/挂载失败: ' + pageErrors.length);
    for (const item of pageErrors) console.log('  ✗ ' + item.id + ' — ' + item.error);
    console.log('顶栏控件点击失败: ' + toggleErrors.length);
    for (const item of toggleErrors) console.log('  ✗ ' + item.id + ' — ' + item.error);

    const ok = failed.length === 0 && missing.length === 0 && missingPages.length === 0 &&
        untranslatedZh.length === 0 && untranslatedEn.length === 0 &&
        pageErrors.length === 0 && toggleErrors.length === 0 && bootProblems.length === 0 &&
        cssAudit.undefinedVars.length === 0 && cssAudit.braceProblems.length === 0 &&
        cssAudit.unstyled.size === 0 && cssAudit.unstyledHtml.length === 0 &&
        layoutProblems.length === 0;
    console.log('');
    console.log(ok ? '界面冒烟测试通过' : '界面冒烟测试存在失败项');
    if (!ok) process.exitCode = 1;
    // 页面与模块可能留下定时器/句柄；检查完成后直接退出，避免测试挂住
    setTimeout(function () { process.exit(ok ? 0 : 1); }, 50).unref();
}

main().catch((error) => {
    console.error('冒烟测试运行器崩溃：', error);
    process.exitCode = 1;
});
