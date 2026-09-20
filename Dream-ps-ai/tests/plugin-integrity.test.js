/*
 * 插件完整性静态校验
 *   1. 所有 API.xxx() 调用都能在 API 对象里找到定义（防手删函数留下悬空调用）
 *   2. manifest / index.html / sw.js / CSS 里引用的静态资源都真实存在
 *   3. UXP 兼容红线：不用 CSS Grid、声明块内不写注释、不用内联 script
 *
 * 运行：node tests/plugin-integrity.test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let total = 0;

function check(name, ok, detail) {
    total++;
    if (ok) { pass++; return; }
    console.log('❌ ' + name + (detail ? '\n    ' + detail : ''));
}

// ── 1. API 方法调用是否都有定义 ──
const appSource = fs.readFileSync(path.join(ROOT, 'src', 'app', 'index.js'), 'utf8');
const appLines = appSource.split('\n');
const apiStart = appLines.findIndex(function (l) { return /^\s*const API = \{/.test(l); });
check('能定位 API 对象', apiStart > -1);

const methods = new Set();
let apiEnd = -1;
for (let i = apiStart + 1; i < appLines.length; i++) {
    const m = appLines[i].match(/^        (?:async )?([A-Za-z_$][\w$]*)\s*\(/);
    if (m) methods.add(m[1]);
    if (/^    \};/.test(appLines[i])) { apiEnd = i; break; }
}
check('能定位 API 对象结尾', apiEnd > -1);
check('API 方法数合理（>= 15）', methods.size >= 15, '实际 ' + methods.size);

const called = new Set();
const callRe = /\bAPI\.([A-Za-z_$][\w$]*)\s*\(/g;
let cm;
while ((cm = callRe.exec(appSource))) called.add(cm[1]);
const missing = [...called].filter(function (n) { return !methods.has(n); });
check('所有 API.xxx() 调用都有定义', missing.length === 0, '悬空调用: ' + missing.join(', '));
console.log('   API 方法 ' + methods.size + ' 个，被调用 ' + called.size + ' 个，无悬空');

// ── 2. 静态资源引用是否存在 ──
const missingRefs = [];
function checkRef(ref, from) {
    const clean = String(ref).split('?')[0].split('#')[0];
    if (!clean || /^(https?:|data:|ws:|#|\/\/)/.test(clean)) return;
    if (!fs.existsSync(path.resolve(path.dirname(from), clean))) {
        missingRefs.push(clean + '  ← ' + path.relative(ROOT, from));
    }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
checkRef(manifest.main, path.join(ROOT, 'manifest.json'));
(manifest.icons || []).forEach(function (i) { checkRef(i.path, path.join(ROOT, 'manifest.json')); });

const htmlPath = path.join(ROOT, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].forEach(function (m) { checkRef(m[1], htmlPath); });
[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].forEach(function (m) { checkRef(m[1], htmlPath); });
[...html.matchAll(/<img[^>]+src="([^"]+)"/g)].forEach(function (m) { checkRef(m[1], htmlPath); });

const swPath = path.join(ROOT, 'sw.js');
fs.readFileSync(swPath, 'utf8').replace(/'\.\/([^']+)'/g, function (_, ref) { checkRef(ref, swPath); return _; });

const cssDir = path.join(ROOT, 'src', 'styles');
if (fs.existsSync(cssDir)) {
    fs.readdirSync(cssDir).filter(function (f) { return f.endsWith('.css'); }).forEach(function (f) {
        const cssPath = path.join(cssDir, f);
        const css = fs.readFileSync(cssPath, 'utf8');
        [...css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].forEach(function (m) { checkRef(m[1], cssPath); });
    });
}
check('所有静态资源引用都存在', missingRefs.length === 0, missingRefs.join('\n    '));
console.log('   静态资源引用全部命中');

// ── 3. 外部 CSS 也要检查声明块内注释（UXP 会报 CssSyntaxError: Unknown word）──
const externalCss = fs.existsSync(cssDir)
    ? fs.readdirSync(cssDir).filter(function (f) { return f.endsWith('.css'); })
    : [];
const externalCssText = externalCss.map(function (f) {
    return fs.readFileSync(path.join(cssDir, f), 'utf8');
}).join('\n');
let externalInlineComment = 0;
externalCssText.replace(/\{[^{}]*\}/g, function (rule) {
    const found = rule.slice(1, -1).match(/\/\*/g);
    if (found) externalInlineComment += found.length;
    return rule;
});
check('外部 CSS 声明块内没有 /* */ 注释', externalInlineComment === 0,
    externalInlineComment + ' 处（UXP 报 CssSyntaxError: Unknown word）');
console.log('   外部 CSS ' + externalCss.length + ' 个文件，块内注释检查通过');

// ── 4. 布局类必须有样式定义（防止再出现「删 CSS 把布局一起删掉」）──
// kao 面板的 .kao-two-column / .kao-effects-grid 曾随 local-engines.css 一起被删，
// 结果整个面板静默退化成单列，没有任何报错。
const allCss = html + '\n' + externalCssText;
['kao-two-column', 'kao-effects-grid', 'kao-generation-grid', 'kao-select-card', 'kao-control-card']
    .forEach(function (cls) {
        total++;
        if (allCss.indexOf('.' + cls) > -1) { pass++; return; }
        console.log('❌ .' + cls + ' 被 JS 使用但没有任何 CSS 定义（布局会静默失效）');
    });
console.log('   5 个 kao 布局类均有样式定义');

// ── 画廊预览区：必须是 div + 方形 ──
// 两条实测踩过的坑：
//   1. 用 <button> 做预览区 → UXP 给原生按钮画自带边框/圆角，border:0 压不住，
//      整个预览区渲染成一个大椭圆
//   2. 用 object-fit 控制缩放 → UXP 支持不稳定，竖图被拉成长条
// 注释里会引用这些规则的原文，检查前必须先剥掉注释，否则自己误伤自己
const cssNoCommentsForGallery = allCss.replace(/\/\*[\s\S]*?\*\//g, '');
check('预览区样式 .gallery-card-thumb 已定义', allCss.indexOf('.gallery-card-thumb') > -1);
check('不再有 .gallery-card button 规则（原生按钮样式压不住）',
    !/\.gallery-card\s+button\s*\{/.test(cssNoCommentsForGallery));
check('预览区使用 div 而非 button',
    /className\s*=\s*'gallery-card-thumb'/.test(appSource));
check('预览区不使用 object-fit（UXP 支持不稳定）',
    !/\.gallery-card-thumb[^{]*\{[^}]*object-fit/.test(cssNoCommentsForGallery));
check('缩略图按原始比例算尺寸（fitThumbInside）',
    /function fitThumbInside/.test(appSource));
console.log('   画廊预览区为方形 div，无原生按钮 / object-fit 依赖');

// ── 侧边栏 tab 与内容区必须一一对应 ──
// switchTab(id) 靠 .tab[data-tab=id] 和 #id 两处查找，
// 拆页面时漏掉任何一边都会点不动或者白屏。
const tabIds = new Set([...html.matchAll(/data-tab="([A-Za-z]+)"/g)].map(function (m) { return m[1]; }));
const contentIds = new Set([...html.matchAll(/id="([A-Za-z]+)" class="tab-content/g)].map(function (m) { return m[1]; }));
const orphanTabs = [...tabIds].filter(function (id) { return !contentIds.has(id); });
check('每个侧边栏 tab 都有对应内容区', orphanTabs.length === 0,
    '缺少内容区的 tab: ' + orphanTabs.join(', '));
console.log('   侧边栏 ' + tabIds.size + ' 个 tab 与内容区一一对应');

// 对话功能已从生成中心拆出，两边的内容不能混
check('对话页含对话输入区', /id="chat"[\s\S]*?id="chatPrompt"/.test(html));
check('对话页不再包含运行中任务', !/id="chat"[\s\S]*?id="taskCenterList"[\s\S]*?id="generationCenter"/.test(html));
check('生成中心保留运行中任务', /id="generationCenter"[\s\S]*?id="taskCenterList"/.test(html));
check('对话按钮已独立成组', /class="sidebar-group"[\s\S]*?data-tab="chat"/.test(html));
console.log('   对话 / 生成中心 内容已分离，对话按钮独立分组');

// ── 图标一律用单色 SVG，不用 emoji ──
// emoji 默认以彩色呈现，和文本字形图标（▶ ◈ ⚙ …）视觉重量对不上，
// 不同系统渲染差异也大。
// 注意不能只查 U+1F000 以上：✨(U+2728)、⚡(U+26A1) 这些 BMP 区的字符
// 同样是 Emoji_Presentation，会渲染成彩色 —— 之前的检查就是这么漏掉的。
const EMOJI_RANGES = [
    [0x231A, 0x231B], [0x23E9, 0x23EC], [0x23F0, 0x23F0], [0x23F3, 0x23F3],
    [0x25FD, 0x25FE], [0x2614, 0x2615], [0x2648, 0x2653], [0x267F, 0x267F],
    [0x2693, 0x2693], [0x26A1, 0x26A1], [0x26AA, 0x26AB], [0x26BD, 0x26BE],
    [0x26C4, 0x26C5], [0x26CE, 0x26CE], [0x26D4, 0x26D4], [0x26EA, 0x26EA],
    [0x26F2, 0x26F3], [0x26F5, 0x26F5], [0x26FA, 0x26FA], [0x26FD, 0x26FD],
    [0x2705, 0x2705], [0x270A, 0x270B], [0x2728, 0x2728], [0x274C, 0x274C],
    [0x274E, 0x274E], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
    [0x27B0, 0x27B0], [0x27BF, 0x27BF], [0x2B1B, 0x2B1C], [0x2B50, 0x2B50],
    [0x2B55, 0x2B55], [0x1F000, 0x1FAFF], [0xFE0F, 0xFE0F]
];
function isEmojiChar(ch) {
    const code = ch.codePointAt(0);
    return EMOJI_RANGES.some(function (range) { return code >= range[0] && code <= range[1]; });
}
['index.html', 'src/app/index.js'].forEach(function (file) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const hits = [...new Set([...text].filter(isEmojiChar))];
    check(file + ' 不含 emoji（图标统一用 SVG）', hits.length === 0,
        '发现: ' + hits.join(' '));
});
check('侧边栏图标使用内联 SVG', /class="sidebar-icon"><svg/.test(html));
check('SVG 图标用 currentColor 以跟随 hover/active 配色',
    /class="sidebar-icon"><svg[\s\S]{0,400}?fill="currentColor"/.test(html));
check('按钮图标走统一的 uiIconLabel', /function uiIconLabel\(/.test(appSource));
console.log('   图标统一为单色 SVG，无 emoji');

// ── 5. UXP 兼容红线 ──
const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(function (m) { return m[1]; });
const cssText = styleBlocks.join('\n');

// 注释里提到 display:grid 不算违规，扫描前先剥掉注释
const cssNoComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
const gridHits = [...cssNoComments.matchAll(/display\s*:\s*grid/gi)];
check('index.html 未使用 CSS Grid（UXP 不渲染）', gridHits.length === 0,
    gridHits.length + ' 处 display:grid');

// 红线是「声明块内部不能有注释」（UXP 报 CssSyntaxError: Unknown word），
// 规则之间的注释是允许的。
let inlineComment = 0;
cssText.replace(/\{[^{}]*\}/g, function (rule) {
    const found = rule.slice(1, -1).match(/\/\*/g);
    if (found) inlineComment += found.length;
    return rule;
});
check('样式声明块内没有 /* */ 注释', inlineComment === 0,
    inlineComment + ' 处块内注释（UXP 报 CssSyntaxError: Unknown word）');

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi)]
    .filter(function (m) { return m[0].replace(/<[^>]*>/g, '').trim().length > 0; });
check('无内联 <script>（UXP 拒绝执行）', inlineScripts.length === 0,
    inlineScripts.length + ' 处内联脚本');

// 允许「隐藏的原生 input + 自绘滑块」这种载体写法（class 带 hidden-native 或 aria-hidden），
// 只拦截真正参与渲染的原生 range。
const rangeInputs = [...html.matchAll(/<input[^>]+type=["']range["'][^>]*>/gi)]
    .filter(function (m) { return !/aria-hidden=["']true["']/.test(m[0]); });
check('没有可见的原生 input[type=range]', rangeInputs.length === 0,
    rangeInputs.length + ' 处可见 range 输入');

// ── 4. 圆环槽位：ring-bridge / index.html / index.js 三处必须对得上 ──
//
// 槽位的唯一定义在 ring-bridge 的 SLOT_IDS，HTML 里的控件 id 是拼出来的，
// index.js 里的取值也是拼出来的。任何一处改名而另两处没跟，都是静默失效
// （设置页空白、改了没反应），所以在这里钉死。
const bridgeSource = fs.readFileSync(
    path.join(ROOT, 'src', 'features', 'ring-bridge', 'ring-bridge.js'), 'utf8');

const slotMatch = bridgeSource.match(/var SLOT_IDS = \[([^\]]+)\]/);
check('能定位 ring-bridge 的 SLOT_IDS', !!slotMatch);
const slotIds = slotMatch ? slotMatch[1].split(',').map(function (s) {
    return s.trim().replace(/^'|'$/g, '');
}).filter(Boolean) : [];

// 4a. HTML 里每个槽位都要有三个控件
const missingIds = [];
slotIds.forEach(function (id) {
    ['ringSlotLabel_', 'ringSlotAction_', 'ringSlotHint_'].forEach(function (prefix) {
        if (html.indexOf('id="' + prefix + id + '"') < 0) missingIds.push(prefix + id);
    });
});
check('圆环槽位控件 id 与 SLOT_IDS 一致', missingIds.length === 0,
    '缺少：' + missingIds.join(', '));

// 4b. index.js 必须按同样的前缀去取
['ringSlotLabel_', 'ringSlotAction_', 'ringSlotHint_'].forEach(function (prefix) {
    check('index.js 使用拼接前缀 ' + prefix, appSource.indexOf("'" + prefix + "'") >= 0);
});

// 4c. 默认动作必须都在动作表里，否则设置页下拉会选不中（空白）
const actionsBlock = bridgeSource.match(/var ACTIONS = \[([\s\S]*?)\n    \];/);
check('能定位 ring-bridge 的 ACTIONS', !!actionsBlock);
const actionValues = actionsBlock
    ? [...actionsBlock[1].matchAll(/value:\s*'([^']+)'/g)].map(function (m) { return m[1]; })
    : [];

const defaultsBlock = bridgeSource.match(/var DEFAULT_ACTIONS = \{([^}]+)\}/);
check('能定位 ring-bridge 的 DEFAULT_ACTIONS', !!defaultsBlock);
const defaultActions = defaultsBlock
    ? [...defaultsBlock[1].matchAll(/(\w+):\s*'([^']+)'/g)].map(function (m) { return { slot: m[1], action: m[2] }; })
    : [];

const missingDefaults = defaultActions.filter(function (entry) {
    return actionValues.indexOf(entry.action) < 0;
});
check('每个槽位的默认动作都在动作表里', missingDefaults.length === 0,
    missingDefaults.map(function (e) { return e.slot + ' → ' + e.action; }).join(', '));
check('每个槽位都定义了默认动作',
    defaultActions.length === slotIds.length,
    '槽位 ' + slotIds.length + ' 个，默认动作 ' + defaultActions.length + ' 个');

// 4d. 动作表里的值，插件必须认得（params/presets/close 由圆环侧处理，tab: 是通用分支）
const handledActions = new Set(
    [...bridgeSource.matchAll(/case '(\w+)':/g)].map(function (m) { return m[1]; }));
const RING_SIDE = ['params', 'presets', 'close'];
const orphanActions = actionValues.filter(function (value) {
    if (RING_SIDE.indexOf(value) >= 0) return false;      // 圆环侧自己处理
    if (value.indexOf('tab:') === 0) return false;        // handleCommand 的通用分支处理
    return !handledActions.has(value);
});
check('动作表里没有插件不认的指令', orphanActions.length === 0,
    '未处理：' + orphanActions.join(', '));

// 4e. 切页动作的目标页必须是侧栏真实存在的 tab
// tab 名可能含数字（img2img），别用 [a-zA-Z]+ —— 会把真实存在的 tab 判成不存在
const realTabs = new Set(
    [...html.matchAll(/data-tab="([a-zA-Z0-9]+)"/g)].map(function (m) { return m[1]; }));
const badTabs = actionValues
    .filter(function (v) { return v.indexOf('tab:') === 0; })
    .map(function (v) { return v.slice(4); })
    .filter(function (tab) { return !realTabs.has(tab); });
check('切页动作指向的 tab 都真实存在', badTabs.length === 0,
    '不存在的 tab：' + badTabs.join(', '));

// ── 5. 设置页折叠分组：每个开关按钮都必须包在 .settings-group 里 ──
//
// 绑定代码是 toggle.closest('.settings-group')，拿不到就直接 return ——
// 少写一层 <section class="settings-group"> 的后果是**标题能看见但点不动**，
// 而且没有任何报错。这个坑真踩过（「15. 圆环按钮」整组展不开）。
//
// 注意只能查 #settings 里面：教程页那 12 个折叠块用的是另一套绑定，
// 不套 .settings-group，全文档扫会误报。
const settingsStart = html.indexOf('<div id="settings"');
let settingsBlock = '';
if (settingsStart >= 0) {
    // 从 #settings 开始做一次 div 配平，切出它自己的范围
    let depth = 0;
    const re = /<div\b[^>]*>|<\/div>/g;
    re.lastIndex = settingsStart;
    let m;
    while ((m = re.exec(html)) !== null) {
        depth += (m[0] === '</div>') ? -1 : 1;
        if (depth === 0) { settingsBlock = html.slice(settingsStart, m.index + m[0].length); break; }
    }
}
check('能切出设置页区块', settingsBlock.length > 0);

const togglePositions = [...settingsBlock.matchAll(/<button[^>]*class="settings-group-toggle"/g)]
    .map(function (m) { return m.index; });
const sectionOpens = [...settingsBlock.matchAll(/<section class="settings-group"/g)]
    .map(function (m) { return m.index; });
const sectionCloses = [...settingsBlock.matchAll(/<\/section>/g)]
    .map(function (m) { return m.index; });

const orphanToggles = togglePositions.filter(function (pos) {
    const prevOpen = sectionOpens.filter(function (p) { return p < pos; }).pop();
    const prevClose = sectionCloses.filter(function (p) { return p < pos; }).pop();
    if (prevOpen === undefined) return true;
    if (prevClose === undefined) return false;
    return prevClose > prevOpen;
});
check('设置页每个分组开关都包在 .settings-group 里（否则点不开）', orphanToggles.length === 0,
    orphanToggles.length + ' 个开关不在 .settings-group 内');

// 挂进 organizeSettingsPage 的 order/titles，否则不会被排序和重新编号
check('圆环按钮分组带 data-group="ring"', /data-group="ring"/.test(html));
check('organizeSettingsPage 认得 ring 分组',
    /'ring'\]/.test(appSource) && /ring:\s*'[^']*圆环按钮/.test(appSource));

// ── 6. resolved 标记：助手与插件之间的一个隐式契约 ──
//
// 圆环发指令时带 resolved:true，表示「这个动作我按规则解析过了」。
// 插件靠它跳过那层「兼容旧版助手」的二次翻译 —— 老助手只发槽位 id，
// 插件得自己查配置翻译；新助手发的是解析好的动作，其中有些恰好和槽位 id
// 同名（generate / chat / close…），不跳过的话会被插件配置反过来覆盖，
// 用户在助手偏好设置里关掉「采用插件下发的扇区动作」就形同虚设。
//
// 这两条任何一条被误删，功能就会静默退化 —— 不会有报错，只是设置不生效。
check('resolveSlotAction 接受并优先处理 resolved 标记',
    /function resolveSlotAction\(action, alreadyResolved\)/.test(bridgeSource) &&
    /if \(alreadyResolved\) return action;/.test(bridgeSource));

check('handleCommand 把 message.resolved 传给 resolveSlotAction',
    /resolveSlotAction\(message\.action, message\.resolved === true\)/.test(bridgeSource));

// 旧版助手不带这个字段，插件必须照旧翻译 —— 向后兼容不能被"优化"掉
check('未带 resolved 时仍然走兼容翻译',
    /if \(SLOT_IDS\.indexOf\(action\) < 0\) return action;/.test(bridgeSource));

// ── 7. 圆环对话：三处接线必须都在 ──
//
// 圆环里点「对话 → 快捷提问」到气泡出字，中间要经过
// 设置页(textarea) → ring-bridge(解析+指令) → index.js(驱动面板的对话)。
// 任何一处少写，症状都是「点了没反应」而且不报错。
check('设置页有快捷提问输入框', /id="ringChatQuestions"/.test(html));
check('index.js 读写了快捷提问配置',
    /function readRingChatQuestions\(/.test(appSource) &&
    /function writeRingChatQuestions\(/.test(appSource) &&
    /initRingChatQuestions\(\)/.test(appSource));

check('index.js 暴露了圆环要用的对话接口',
    /window\.HuanmengChat = \{/.test(appSource) &&
    /window\.applyRingChatModel = function/.test(appSource) &&
    /ask: async function|ask: function/.test(appSource));

check('ring-bridge 把 chat 状态放进 state',
    /chat: buildChatState\(\)/.test(bridgeSource) &&
    /function buildChatState\(/.test(bridgeSource));

check('ring-bridge 认得 chatAsk / chatNew / chatModel',
    /case 'chatAsk':/.test(bridgeSource) &&
    /case 'chatNew':/.test(bridgeSource) &&
    /case 'chatModel':/.test(bridgeSource));

// 中间任何一环都要有出口，否则用户看到的是「点了没反应」
check('ring-bridge 把提问结果推给圆环',
    /pushChat\('thinking'/.test(bridgeSource) &&
    /pushChat\('reply'/.test(bridgeSource) &&
    /pushChat\('error'/.test(bridgeSource));

// ── 8. 设置保存：表单外的配置键不能被抹掉 ──
//
// saveSettings() 是**按表单字段重建**整个 settings 的（那个 Object.assign
// 没有第二个参数），而圆环槽位 / 快捷提问这些配置根本不在表单里。
// Config.saveSettings 里少一句合并，用户点一次「保存全部设置」就丢一次配置，
// 而且完全没有提示 —— 只会觉得「我的圆环设置怎么自己变回去了」。
check('Config.saveSettings 保留表单外的配置键',
    /saveSettings\(settings\)\s*\{[\s\S]{0,800}?config\.settings = Object\.assign\(\{\}, config\.settings, settings\)/
        .test(appSource));

console.log('\n' + pass + '/' + total + ' 通过');
process.exit(pass === total ? 0 : 1);
