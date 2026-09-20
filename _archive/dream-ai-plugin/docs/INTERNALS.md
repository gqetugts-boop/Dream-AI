# Dream AI 插件 · 运行时内部接口

`CONTRACT.md` 定的是"模块怎么写"，本文件定的是"模块之间传什么数据"。
所有跨模块的对象形状以本文件为准。

## 1. 全局状态 App

`src/boot/app.js` 暴露 `DreamAI.App`：

```js
DreamAI.App = {
    state,                 // 只读快照，见下
    get(key),              // 点路径读取，如 App.get('selection.width')
    set(key, value),       // 点路径写入，触发对应事件
    patch(object),         // 批量写入
    settings,              // 当前设置对象（= App.state.settings）
    saveSettings(patch),   // 合并写入 Store 的 settings 域并广播
    activeTaskId,          // 当前正在运行的任务 id，无则为 null
    ready                  // 初始化完成的 Promise
}
```

`App.state` 形状：

```js
{
    selection: null | {                 // 最近一次读取的 Photoshop 选区
        dataUrl: 'data:image/png;base64,...',
        width: 1024, height: 768,       // 像素尺寸（已按采样上限缩放）
        bounds: { left, top, right, bottom, width, height },  // 文档坐标
        documentId: 123,                // 来源文档，回写前校验是否仍打开
        documentName: '未命名-1',
        bitDepth: 8,
        colorProfile: 'sRGB IEC61966-2.1',
        sampledAt: 1712345678901
    },
    references: [                       // 最多 4 张
        { id, dataUrl, width, height, source: 'selection'|'upload', addedAt }
    ],
    settings: { /* 见第 4 节 */ },
    workbench: {                        // 生图工作台界面状态
        mode: 'txt2img'|'img2img'|'edit',
        prompt: '', negativePrompt: '',
        providerId: 'openai', modelId: '',
        size: '1024x1024', count: 1, quality: 'standard', style: '',
        seed: null, steps: null, cfg: null,
        useSelection: true, colorMatchOnReturn: true,
        autoReturn: true, blendScreen: false, returnFeather: 0
    },
    activePageId: 'workbench'
}
```

`selection` 与 `references` 变化时分别广播 `selection:change` 与 `references:change`。

## 2. Provider 接口

每个文件通过 `DreamAI.Providers.register(descriptor)` 注册：

```js
{
    id: 'openai',                       // 唯一 id，同时用作 settings.channels 的键
    labelKey: 'settings.channelOpenAI', // i18n 键
    order: 20,
    needsKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-image-1',
    supports: { txt2img: true, img2img: true, edit: true, models: true, chat: false, balance: false },

    // 全部方法返回 Promise，失败时 reject 一个 Error（message 已本地化）
    listModels(ctx) -> [{ id, labelKey? }]
    generate(ctx, request) -> { images: [{ dataUrl, width, height, seed? }], raw }
    edit(ctx, request)     -> { images: [...] }
    chat(ctx, request)     -> { text, raw }        // 可选
    checkBalance(ctx)      -> { display }          // 可选
    test(ctx)              -> { ok, models }       // 可选，默认用 listModels 实现
}
```

`ctx` 由调用方构造：

```js
{
    baseUrl,        // 已规范化（去掉末尾斜杠；需要 /v1 的由 provider 自己处理）
    apiKey,
    modelId,
    timeout,        // 毫秒
    log(level, message, meta),   // 转发到 DreamAI.logbus
    fetchJson(url, options),     // DreamAI.util.requestJson 的绑定版本
    signal                       // AbortSignal | null
}
```

`request` 形状（生图/编辑统一）：

```js
{
    prompt: '...',
    negativePrompt: '',            // 不支持的渠道忽略
    mode: 'txt2img'|'img2img'|'edit',
    size: '1024x1024',             // 也接受 { width, height }
    count: 1,
    seed: null,
    quality: 'standard'|'hd'|null,
    style: null,
    images: [                      // img2img / edit 时的输入图，data URL
        { dataUrl, role: 'init'|'reference'|'mask' }
    ],
    extra: {}                      // provider 私有参数
}
```

返回值里的 `dataUrl` 必须是可直接放进 `<img>` 或写给 Photoshop 的 base64 data URL；
如果上游返回的是裸 base64 或远程 URL，provider 负责统一。

## 3. 任务对象

`DreamAI.TaskQueue` 维护任务列表，任务形状：

```js
{
    id: 'task_xxxxx',
    state: 'queued'|'running'|'uploading'|'polling'|'returning'|'done'|'failed'|'canceled'|'timeout'|'skipped',
    title: '',                 // 已本地化，用于列表展示
    providerId, modelId,
    mode: 'txt2img'|'img2img'|'edit'|'local',
    prompt: '',
    progress: 0,               // 0-100，未知时用 -1
    createdAt, startedAt, finishedAt,
    images: [ { dataUrl, width, height } ],
    error: null,               // 已本地化的错误文案
    meta: {}                   // 任意附加上下文（尺寸、耗时、回写图层名等）
}
```

`DreamAI.TaskQueue` API：

```js
enqueue(spec) -> task        // spec 见下，立即返回任务对象
cancel(taskId) -> boolean
list() -> [task]             // 新到旧
get(taskId) -> task | null
clearFinished() -> number    // 返回清理条数
runningCount() -> number
subscribe(handler) -> unsubscribe
```

`enqueue` 的 `spec`：

```js
{
    title, providerId, modelId, mode, prompt,
    images,                     // 输入图
    autoReturn: true,           // 完成后是否回写 Photoshop
    returnOptions: {            // 回写参数，见第 5 节
        blendMode: 'normal'|'screen', feather: 0, colorMatch: true,
        colorMatchMethod: 'meanStd', layerName: '', useSelectionBounds: true
    },
    executor: async (task, helpers) => ({ images })   // 可选：自定义执行函数，
                                                      // 不传时用 provider.generate/edit
    timeout: 600000
}
```

任务完成后如果 `autoReturn` 为真，队列调用 `DreamAI.PhotoReturn.place()`，
并把结果写入 `task.meta.returned`（回写的图层名）。回写失败不能把任务标记为 failed，
只在 `task.meta.returnError` 里记录原因。

## 4. settings 形状

```js
{
    language: 'zh-CN'|'en-US',
    theme: 'light'|'dark',
    uiScale: 1,
    activeChannelId: 'openai',        // 生图默认渠道
    activeChatChannelId: 'openai',
    channels: {
        openai:  { baseUrl, apiKey, model: '', extra: {} },
        xai:     { baseUrl: 'https://api.x.ai/v1', apiKey, model: '' },
        grok:    { baseUrl: 'http://127.0.0.1:8000/v1', apiKey, model: '' },
        custom:  { baseUrl, apiKey, model: '' },
        native:  { model: 'photoshop-generative' }
    },
    modelCache: { openai: ['gpt-image-1', ...] },   // listModels 结果缓存
    systemPrompt: { positive: '', negative: '' },
    chatSystemPrompt: { positive: '', negative: '' },
    behavior: {
        autoReturn: true,
        colorMatchOnReturn: true,
        colorMatchMethod: 'meanStd',
        returnFeather: 0,
        returnBlendMode: 'normal',
        pollInterval: 3000,
        requestTimeout: 300000,
        maxConcurrent: 1,
        referenceMax: 4,
        sampleMaxEdge: 1536,          // 读取选区时的最长边上限
        promptMaxLength: 5000
    },
    gallery: { mode: 'count', maxCount: 30, maxDays: 30 },
    advanced: { debugLog: false }
}
```

设置读写一律 `App.settings` + `App.saveSettings(patch)`，禁止直接写 Store。

## 5. PhotoIO / PhotoReturn 接口

```js
DreamAI.PhotoIO = {
    isAvailable() -> boolean,
    readSelection(options) -> Promise<selection>        // 形状同第 1 节
    capture(options) -> Promise<selection>              // readSelection 的别名
    getForegroundColor() -> Promise<{ r, g, b, hex }>,
    deselect() -> Promise<void>,
    duplicateLayer() -> Promise<void>,
    invertSelection() -> Promise<void>,
    fillSelectionWithForeground() -> Promise<void>,
    freeTransform() -> Promise<void>,
    mergeVisible() -> Promise<void>,
    flattenImage() -> Promise<void>,
    selectDocument(documentId) -> Promise<void>
}

DreamAI.PhotoReturn = {
    isAvailable() -> boolean,
    place(image, options) -> Promise<{ layerName, layerId, bounds }>
    // image: data URL 或 { data, width, height, channels }
    // options: {
    //   bounds, documentId, layerName, blendMode: 'normal'|'screen',
    //   feather: 0, shrink: 0, group: '', colorMatch: false,
    //   colorMatchMethod: 'meanStd', colorMatchReference: dataUrl
    // }
}
```

`PhotoReturn.place` 内部必须：
1. 取 `DreamAI.psLock` 串行执行；
2. 用 `executeAsModal` 包住全部文档操作；
3. 目标文档按 id 查找，找不到就抛错（禁止贴到别的文档）；
4. 需要时先做校色（用 `DreamAI.ColorEngine`），再编码 PNG（用 `DreamAI.PhotoEncode`）；
5. 通过 `createPixelLayer` + `imaging.createImageDataFromBuffer` + `imaging.putPixels` 落图；
6. `screen` 混合时用 `batchPlay` 设置图层混合模式。

## 6. 本地引擎接口

```js
DreamAI.ComfyUI = {
    loadConfig() -> config,
    saveConfig(patch) -> config,
    testConnection(ctx) -> { ok, device },
    validateWorkflow(json) -> { ok, nodeCount, reason },
    extractParams(workflow) -> [{ nodeId, key, label, value }],
    run(ctx, request) -> { images, promptId }
}

DreamAI.Forge = {
    loadConfig() -> config,
    saveConfig(patch) -> config,
    testConnection(ctx) -> { ok, models, samplers },
    listModels(ctx), listSamplers(ctx), listLoras(ctx), listControlNets(ctx),
    run(ctx, request) -> { images },
    progress(ctx) -> { percent },
    interrupt(ctx) -> void
}
```

`ctx`：`{ baseUrl, apiToken, timeout, log, signal, onProgress(percent) }`。
两个模块的 HTTP 请求统一走 `DreamAI.util.request` / `requestJson`。

## 7. 页面接口

```js
DreamAI.Router.register({
    id: 'workbench',
    group: 'create',              // create | engine | asset | system
    labelKey: 'nav.workbench',
    order: 10,
    build(ctx) {
        // ctx: { page, card, field, row, button, select, input, textarea, checkbox,
        //        slider, chip, pill, grid, imageSlot, spacer, divider, t, ta, to }
        return {
            el,                       // 必填：页面根节点
            mount(),                  // 可选：页面被激活
            unmount(),                // 可选：页面被切换走
            refresh()                 // 可选：数据变化时刷新
        };
    }
});
```

`build` 每页只调用一次，后续切换只调用 `mount`/`unmount`，所以
**事件监听必须在 `unmount` 里解绑**，否则会重复触发。

## 8. 功能模块（features/）

### 8.1 Gallery（`DreamAI.Gallery`）
```js
init() -> void
list() -> [item]                                     // 新到旧
add(dataUrl, metadata) -> Promise<item>
remove(id) -> Promise<boolean>
prune(policy) -> Promise<{ kept, removed }>
saveToPhotoshop(id) -> Promise<{ layerName }>        // 走 PhotoReturn
download(dataUrl, fileName) -> void
getDataUrl(id) -> Promise<string>
policy() -> { mode, maxCount, maxDays }
```
`item` 形状：`{ id, createdAt, dataUrl?, width, height, prompt, providerId, modelId, mode, source, storage }`。
二进制存储优先级：IndexedDB → localStorage（小图）→ UXP 数据目录 `dream-ai-gallery/<id>.png`。
索引持久化域：`gallery.meta`。变化时广播 `gallery:change`。

### 8.2 TaskQueue（`DreamAI.TaskQueue`）
```js
init() -> void
enqueue(spec) -> task
cancel(taskId) -> boolean
retry(taskId) -> task | null
list() -> [task]
get(taskId) -> task | null
clearFinished() -> number
runningCount() -> number
activeId() -> string | null
subscribe(handler) -> unsubscribe
```
见第 3 节的 spec / task 形状。并发上限取 `settings.behavior.maxConcurrent`。
任务历史持久化域：`taskHistory`（最多 80 条，只存元数据与缩略图，不存全尺寸图）。

### 8.3 Batch（`DreamAI.Batch`）
```js
init() -> void
add(item) -> item            // { prompt, negativePrompt, providerId, modelId, size, count, note, source }
list() -> [item]
remove(id) -> boolean
clear() -> number
start() -> Promise<{ ok, fail }>
stop() -> void
isRunning() -> boolean
subscribe(handler) -> unsubscribe
```
`start()` 串行执行队列，每项通过 `TaskQueue.enqueue` 提交并等待结束。

### 8.4 关于提示词

插件**不内置提示词库**：没有预设页面、没有随包发布的提示词资产、没有"官方推荐提示词"。
理由与约束：

- 提示词属于使用者的创作内容，产品侧不应该替用户预设风格倾向；
- 因此 `src/features/` 下不存在 presets 模块，`assets/` 下也不存在任何提示词 JSON；
- 需要保存常用提示词时，走用户自建：`DreamAI.Store` 的 `custom-prompts` 域，
  形状 `{ items: [{ id, name, prompt, negativePrompt, size, note, createdAt }] }`，上限 50 条；
- 任何新功能都不得重新引入内置提示词资产；如需示例文案，只能放在文档里由用户自己复制。

## 9. 工具 UI 模块

`src/tools/glow.js` → `DreamAI.GlowTool`，`src/tools/vfx.js` → `DreamAI.VfxTool`，
`src/tools/scope.js`（已有算法核心，UI 在页面里直接调用 `DreamAI.Scope`）。

```js
DreamAI.GlowTool.buildPanel(ctx) -> { el, dispose? }    // 辉光面板
DreamAI.VfxTool.buildPanel(ctx) -> { el, dispose? }     // 位移特效面板
```
`ctx` = `{ selection, W, sync(), getSelection() }`；`selection` 为第 1 节形状或 null。
面板内部对选区的读取统一调用 `DreamAI.PhotoIO.readSelection()`，
执行写入统一调用 `DreamAI.PhotoReturn.place(image, options)`。

## 10. 页面清单（已注册 id）

| id | group | labelKey | 归属文件 |
| --- | --- | --- | --- |
| `workbench` | create | nav.workbench | src/ui/pages/workbench.js |
| `chat` | create | nav.chat | src/ui/pages/chat.js |
| `toolbox` | create | nav.toolbox | src/ui/pages/toolbox.js |
| `vfx` | create | nav.vfx | src/ui/pages/vfx.js |
| `comfyui` | engine | nav.comfyui | src/ui/pages/comfyui.js |
| `forge` | engine | nav.forge | src/ui/pages/forge.js |
| `gallery` | asset | nav.gallery | src/ui/pages/gallery.js |
| `batch` | asset | nav.batch | src/ui/pages/batch.js |
| `settings` | system | nav.settings | src/ui/pages/settings.js |
| `about` | system | nav.about | src/ui/pages/about.js |
