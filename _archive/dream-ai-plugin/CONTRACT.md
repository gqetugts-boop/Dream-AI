# Dream AI 插件 · 内部接口契约

本文件是各模块之间的唯一约定来源。新增模块必须遵守这里定义的命名空间、事件、
DOM 结构与 i18n 键规则，否则会在集成阶段返工。

## 1. 加载方式与命名空间

- **没有构建步骤**。`index.html` 用普通 `<script src>` 按固定顺序加载，所有模块都是
  IIFE，挂到全局 `window.DreamAI.<Namespace>`。
- UXP 对 ES Module 支持不稳定，**禁止**使用 `import` / `export`。
- 代码风格：ES5 语法（`var` / `function`），便于直接跑在 UXP 的 JS 引擎上；
  允许 `Promise`、`Array.prototype.map/filter`、模板字符串之外的一切 ES5。
- 每个文件顶部写中文注释块，说明「职责 / 输入 / 输出 / 边界」。
- 模块首行做幂等保护：`if (DreamAI.Xxx) return;`，避免重复加载互相覆盖。

## 2. 已实现的公共设施

| 命名空间 | 文件 | 用途 |
| --- | --- | --- |
| `DreamAI.host` | `src/boot/host.js` | 宿主探测：`isUxp` / `hasPhotoshop` / `modules.photoshop` / `modules.fs` |
| `DreamAI.util` | `src/boot/util.js` | `el()` 构造 DOM、`clamp`、`deepMerge`、`request`、`requestJson`、`withTimeout`、`createSerializer`、`sleep`、`uid`、`formatBytes`、`bindRange` 等 |
| `DreamAI.I18n` | `src/i18n/i18n.js` | `t()` / `ta()` / `to()` / `add()` / `apply()` / `setLang()` |
| `DreamAI.Store` | `src/core/store.js` | `read(domain, defaults)` / `write(domain, patch, defaults)` / `subscribe` |
| `DreamAI.bus` | `src/core/bus.js` | `on` / `once` / `off` / `emit` |
| `DreamAI.logbus` | `src/core/logbus.js` | `debug/info/success/warn/error` + `list/filter/toText` |
| `DreamAI.Theme` | `src/core/theme.js` | `get()` / `set()` / `toggle()`，写 `<body data-theme>` |
| `DreamAI.PhotoEncode` | `src/core/photo-encode.js` | `encodePng` / `encodeJpeg` / `resizeImage` / `zlibCompress` |

`DreamAI.util.el(tag, attrs, children)` 的 `attrs` 支持 `class`、`text`、`dataset`、
`style`（对象）、`onclick` 之类的 `on*` 事件、`value`，其余走 `setAttribute`。

## 3. i18n 约定

- 键名格式：`<域>.<名称>`，小写驼峰，例如 `ws.render`、`tools.glow.title`。
- 通用词条放 `src/i18n/zh-CN.js` 与 `src/i18n/en-US.js`；
  **功能模块自有的词条必须在本模块文件里追加**，两套语言都要写：

```js
DreamAI.I18n.add('zh-CN', { 'tools.glow.title': '辉光' });
DreamAI.I18n.add('en-US', { 'tools.glow.title': 'Glow' });
```

- 词条值可以是字符串、数组（`ta()`）、对象（`to()`）。
- 插值统一用 `{name}` 占位，调用 `t('a.b', { name: 'x' })`。
- **禁止**在 JS 里硬编码任何面向用户的中文或英文文案。
- `tests/run-tests.mjs` 会校验中英键集合完全一致，缺键即测试失败。

## 4. 事件

| 事件 | 载荷 | 触发方 |
| --- | --- | --- |
| `selection:change` | `{ sample }` | `photo-io` |
| `task:created` | `{ task }` | `task-queue` |
| `task:update` | `{ task }` | `task-queue` |
| `task:finished` | `{ task }` | `task-queue` |
| `result:ready` | `{ task, images }` | `task-queue` |
| `lang:change` | `{ lang }` | `i18n` |
| `theme:change` | `{ theme }` | `theme` |
| `store:change` | `{ domain, value }` | `store` |
| `status:message` | `{ text, tone }` | 任意模块 |
| `log:entry` | `{ entry }` | `logbus` |
| `gallery:change` | `{}` | `gallery` |

## 5. DOM 与样式约定

- 页面由 JS 渲染，`index.html` 只提供外壳（顶栏 / 导航 / 舞台 / 状态条 / 抽屉 / 模态 / toast）。
- 页面注册：`DreamAI.Router.register({ id, group, labelKey, build })`，
  其中 `build()` 返回 `{ el, mount?, unmount?, refresh? }`。
- 所有交互控件用 `src/ui/widgets.js` 的工厂函数产出，**不要手写 class**：

| 工厂 | 说明 |
| --- | --- |
| `W.page(titleKey)` | 页面外壳 |
| `W.card(titleKey, options)` | 可折叠卡片，`options.collapsed` 初始折叠 |
| `W.field(labelKey, control, hintKey)` | 标签 + 控件 + 提示 |
| `W.row(left, right)` | 左右两列行 |
| `W.button(labelKey, options)` | `options.variant` = primary/ghost/danger/quiet |
| `W.select(options, value)` | 选项 `[{value,labelKey}]` |
| `W.input(options)` / `W.textarea(options)` / `W.checkbox(labelKey)` |
| `W.slider({ min, max, step, value, onInput })` | 自绘滑块，返回值对象 `{ el, set }` |
| `W.chip(labelKey, options)` | 标签页式切换按钮 |
| `W.pill(text, tone)` | 状态徽章，`tone` = idle/running/ok/warn/error |
| `W.grid(children, columns)` | 用 flex 百分比实现的网格（UXP 不用 CSS Grid） |
| `W.imageSlot()` | 参考图槽位 |
| `W.logoText()` | 空态说明文案 |
| `W.selectionPreview()` | 选区预览块 |

- CSS 变量全部来自 `src/ui/tokens.css`，禁止写死颜色值。
- UXP 兼容红线：
  1. 不用 CSS Grid，只用 flexbox；
  2. `input[type=range]` 全局隐藏，滑块一律用 `W.slider`；
  3. 不依赖 `position: fixed` 的复杂层叠，抽屉/模态用绝对定位 + 显隐；
  4. 不使用内联 `<script>`；
  5. 需要覆盖宿主默认样式的地方加 `!important`。

## 6. 状态与持久化域

| 域 | 内容 |
| --- | --- |
| `settings` | 全局设置（渠道密钥、默认参数、系统提示词、行为开关） |
| `workbench` | 生图工作台最后状态（模式、提示词、参数、参考图元数据） |
| `references` | 参考图数据（data URL 数组，最多 4 张） |
| `taskHistory` | 任务记录（最多 80 条） |
| `gallery.meta` | 画廊索引（图片二进制另存） |
| `engines.comfy` | ComfyUI 连接与工作流 |
| `engines.forge` | Forge/SD WebUI 连接与参数 |
| `tools.glow` | 辉光面板参数 |
| `tools.vfx` | 位移特效参数 |
| `tools.scope` | 示波器参数 |
| `chat.history` | 对话记录 |

## 7. 错误与状态规范

- 对外可抛错误统一 `new Error(已本地化文案)`，调用方负责 `DreamAI.logbus.error()`。
- 需要在状态条显示的进度：`DreamAI.bus.emit('status:message', { text, tone })`。
- 任何会写 Photoshop 文档的操作必须经过 `DreamAI.psLock`（串行队列），
  避免多个任务同时 `executeAsModal` 导致宿主卡死。

## 8. 测试要求

- 纯算法模块（不碰 DOM/宿主）必须能在 Node 下加载，供 `tests/run-tests.mjs` 直接调用。
- 新增算法模块时同步在测试里补最少一个正常用例 + 一个边界用例。
- 提交前至少跑：`node tests/run-tests.mjs`。
