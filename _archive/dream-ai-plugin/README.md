# Dream AI 创意助手 · Photoshop UXP 插件

面向 Adobe Photoshop 的 AI 生图、选区修图、回图与本地创意工具面板。

- **双语界面**：内置简体中文与 English 两套完整词条，可随时切换（顶栏 `中 / EN`）。
- **不内置提示词库**：插件只提供提示词输入框，不预置任何"官方提示词"，写什么由你决定。
- **侧栏导航 + 莫兰迪配色**：左侧固定宽导航栏（图标在上、文字在下，按分组用分隔线区分），
  主区自适应；低饱和紫罗兰主色 + 褪色陶土强调色，亮/暗双主题。
- **四种服务渠道 + 两种本地引擎**：OpenAI 兼容网关、xAI 官方、自建 Grok 网关、
  Photoshop 原生生成式填充，以及 ComfyUI 与 Forge / SD WebUI。
- **本地算法工具箱**：辉光、位移特效、色彩融合、示波器，全部为自研 CPU 实现。
- **零依赖、零构建**：纯 UXP 原生脚本，不需要 npm、不需要打包步骤。

---

## 快速开始

### 1. 加载插件

1. 安装 **Adobe UXP Developer Tools**（Adobe Creative Cloud 里可获取）。
2. 打开 Photoshop（建议 24.0 及以上）。
3. 在 UXP Developer Tools 里 `Add Plugin` → 选择本目录下的 `manifest.json`。
4. 点击 `Load`，然后在 Photoshop 菜单 `增效工具 / Plugins` 里打开 **Dream AI 创意助手** 面板。

### 2. 配置渠道

打开面板 → 顶栏 `⚙` → **服务渠道**，逐个展开填写：

| 渠道 | 默认地址 | 密钥形态 | 说明 |
| --- | --- | --- | --- |
| Photoshop 原生 | — | 不需要 | 走 PS 自带生成式填充，需要 PS 版本支持 |
| OpenAI 兼容 | `https://api.openai.com/v1` | `sk-...` | 任何 OpenAI 兼容网关都能填在这里 |
| xAI 官方 | `https://api.x.ai/v1` | `xai-...` | xAI 图像与对话接口 |
| 自建 Grok 网关 | `http://127.0.0.1:8000/v1` | `g2a_...` | 本地自建网关，支持异步任务轮询 |

地址可以填根地址或带 `/v1` 的地址，插件会自行规范化。填好后点 **测试连接**，
通过后会显示可用模型数量，并自动缓存模型列表到工作台的模型下拉框。

### 3. 本地引擎

- **ComfyUI**：默认 `http://127.0.0.1:8188`。在 ComfyUI 里用
  *导出（API 格式）* 保存工作流 JSON，粘贴进插件即可；有 Photoshop 选区时会自动
  上传到 `/upload/image` 并注入 LoadImage 节点。
- **Forge / SD WebUI**：默认 `http://127.0.0.1:7860`，需要以 `--api` 启动 WebUI。

### 4. 第一个任务

1. 在 Photoshop 里画出选区（也可以不画，直接文生图）。
2. 打开 **生图** 页，点 **读取选区**。
3. 写提示词，选渠道与尺寸，点 **开始生成**。
4. 生成完成后会自动回写为新的像素图层；回写参数在 **回写 Photoshop** 卡片里调整。

---

## 目录结构

```text
dream-ai-plugin/
├── manifest.json                 # UXP 清单（面板入口、权限、图标）
├── index.html                    # 面板外壳：顶栏 / 导航 / 舞台 / 状态条 / 抽屉 / 模态
├── CONTRACT.md                   # 模块编写约定（命名空间、i18n 键、UXP 兼容红线）
├── docs/INTERNALS.md             # 运行时数据契约（状态、任务、Provider、页面）
├── src/
│   ├── boot/
│   │   ├── host.js               # 宿主探测（UXP / 浏览器）
│   │   ├── util.js               # 通用工具（DOM 构造、请求、并发、限时）
│   │   └── app.js                # 引导：装配状态、模块、路由、事件
│   ├── core/
│   │   ├── store.js              # 命名空间化持久化
│   │   ├── bus.js                # 事件总线
│   │   ├── logbus.js             # 环形日志缓冲
│   │   ├── theme.js              # 亮/暗主题
│   │   ├── ps-lock.js            # Photoshop 模态操作串行锁
│   │   ├── photo-encode.js       # 自研 PNG / JPEG 编码 + DEFLATE
│   │   ├── photo-io.js           # 选区读取、像素抓取、常用操作
│   │   └── photo-return.js       # 结果回写（校色 / 蒙版 / 混合模式）
│   ├── i18n/                     # 中英词条与运行时
│   ├── ui/
│   │   ├── tokens.css            # 莫兰迪设计变量
│   │   ├── layout.css            # 外壳骨架与 UXP 兼容层
│   │   ├── widgets.css           # 控件样式
│   │   ├── pages.css             # 页面级组合样式
│   │   ├── widgets.js            # 控件工厂（自绘下拉 / 滑块 / 色板）
│   │   ├── router.js             # 页面注册与懒加载
│   │   ├── shell.js              # 状态条 / 轻提示 / 模态 / 抽屉
│   │   └── pages/                # 11 个页面
│   ├── providers/                # 服务渠道适配层
│   ├── local/                    # ComfyUI 与 Forge 客户端
│   ├── tools/                    # 本地算法与对应面板
│   └── features/                 # 任务队列、画廊、批处理、色彩引擎
├── assets/
│   └── icons/                    # 插件图标（由 scripts/make-icons.mjs 生成）
├── scripts/make-icons.mjs        # 图标生成脚本
├── tests/
│   ├── run-tests.mjs             # 纯逻辑单元测试
│   └── ui-smoke.mjs              # 界面装配冒烟测试
└── 使用教程.html                 # 图文教程（浏览器直接打开）
```

---

## 开发与验证

没有构建步骤，改完文件在 UXP Developer Tools 里点 `Reload` 即可（Web 预览下刷新页面）。

```bash
# 单元测试：编码、色彩、辉光、特效、示波器、i18n、存储
node tests/run-tests.mjs

# 只跑某一组
node tests/run-tests.mjs glow-core

# 界面装配冒烟测试：按 index.html 顺序加载全部脚本，校验命名空间、
# 页面注册与词条完整性
node tests/ui-smoke.mjs

# 重新生成图标
node scripts/make-icons.mjs
```

新增模块前请先读 `CONTRACT.md`（怎么写的约定）与 `docs/INTERNALS.md`（模块之间传什么数据）。

---

## 设计说明

### 布局

外壳是"左侧栏 + 右主区"两栏结构，没有横向导航：

```text
┌────────┬──────────────────────────────┐
│ 品牌    │ 顶栏：当前页名 / 设置          │
│ ────── ├──────────────────────────────┤
│ 生图    │                              │
│ 对话    │ 页面舞台（唯一滚动容器）         │
│ 工具箱  │ 只纵向滚动，横向永不出现滚动条     │
│ 特效    │                              │
│ ────── ├──────────────────────────────┤
│ ComfyUI│ 状态条：状态点 / 文案 / 进度      │
│ Forge  │                              │
│ ────── │                              │
│ 画廊    │                              │
│ 批处理  │                              │
│ ────── │                              │
│ 语言/主题/日志                        │
└────────┴──────────────────────────────┘
```

侧栏固定 **72px**（`--sidebar-w`，窄面板下不低于 72px），主区 `flex: 1 + min-width: 0`，
所以在 Photoshop 里把面板拖到任意宽度都不会把内容挤出去。
导航分 create / engine / asset 三个分组，组间用细分隔线区分；
设置与关于不进侧栏，由顶栏的设置按钮直接进入，避免侧栏在竖排时被挤成两屏。

窄面板适配断点：

| 面板宽度 | 处理 |
| --- | --- |
| ≤ 440px | 缩小间距与内边距 |
| ≤ 400px | 两列参数栅格降为单列；参考图槽位改整宽单列 |
| ≤ 360px | 隐藏顶栏品牌名与状态条次要信息 |
| ≤ 320px | 收起日志入口文字；侧栏宽度保持不变 |

### 圆角

**全部容器与滑块都是"方圆形"**：最大圆角 18px，控件级 4–8px，
没有任何胶囊（999px）或正圆（50%）外壳。状态点、进度条、徽标、缩略图角标
都是小方圆块。

### 元素标准相对位置

以面板左上角为原点，x 向右、y 向下，单位 px。`W` = 面板宽，`H` = 面板高。
完整版同内容也写在 `src/ui/layout.css` 文件头，改布局前先读那段。

```text
① .app-shell      x=0        y=0        w=W        h=H        主轴 row
② .app-sidebar    x=0        y=0        w=72       h=H        min=max=width，不压缩
     内距 10/6 → 内容宽 56
     品牌 .sidebar-logo     y=10    h=34  w=34  左缘 x=17（水平居中）
     导航 .sidebar-scroll   y=52    h=H-148     唯一可滚动区
     工具 .sidebar-footer   y=H-44  h=44
     tab .sidebar-tab       w=56    min-h=46   图标在上、标签在下（可折两行）
③ .app-main       x=72       y=0        w=W-72     h=H        主轴 column
     顶栏 .app-topbar       y=0     h=46
     舞台 .app-stage        y=46    h=H-72      唯一可滚动区，横向不滚
     状态条 .app-statusbar  y=H-26  h=26
④ 舞台内部逐级收敛
     舞台内容宽 SW = W - 72 - 2*page-pad
     .page            w = min(SW, 760)，水平居中
     .card            内容区 = 卡片宽 - 2*12 - 2
     两列栅格单列宽   = (内容区 - 10) / 2，< 132px 降为单列
     .row 标签+控件   宽 > 400 左 40% / 右 60%；≤ 400 改上下两行
     参考图槽位        宽 > 400 每行 2 个（单个 = (内容区-8)/2）、高 132；
                       ≤ 400 改整宽单列、高 112
```

各档面板宽度下的实测收敛（`node tests/ui-smoke.mjs` 会打印这张表）：

| 面板 | 侧栏 | 舞台 | 页面 | 卡片内容 | 两列单列 | 槽位单宽 |
| --- | --- | --- | --- | --- | --- | --- |
| 300 | 72 | 214 | 214 | 188 | 89（降单列） | 90（降单列） |
| 360 | 72 | 274 | 274 | 248 | 119（降单列） | 120 |
| 460 | 72 | 364 | 364 | 338 | 164 | 165 |
| 900 | 72 | 804 | 760 | 734 | 362 | 363 |

**侧栏标签的硬规则**：只折行、绝不截断。中文标签最多 3 字（工具箱/批处理），
按 9px 字号约 27px，而侧栏可用宽 62px —— 有 2 倍以上余量；`.sidebar-tab-label`
明确写了 `text-overflow: clip`，禁止出现 `工...` 这种省略号。
`ComfyUI` 这类长英文词用 `overflow-wrap: anywhere` 断行。

**踩过的坑：内联样式键必须转 kebab-case**

`element.style.setProperty()` 只接受 `background-color` 这种 kebab-case 属性名。
传 `backgroundColor`（camelCase）**不报错、也不生效**，是静默失败。项目里曾有
31 处 camelCase 内联样式因此被完全忽略（马赛克背景色、卡片对齐、日志配色等）。

`DreamAI.util.el()` 现在会统一转换，两种写法都能用：

```js
el('div', { style: { backgroundColor: '#fff', 'max-width': '80%' } })
```

单元测试里有对应断言，谁要是改回去会直接失败。

**防错位的四条硬约束**（改样式时不要破坏）：

1. 所有 flex 子项都要有 `min-width: 0`，否则 `nowrap` 内容会把父容器撑宽；
2. 固定宽度只出现在侧栏和图标上，其余一律百分比/弹性；
3. 舞台 `overflow-x: hidden`，且每一级都必须给下一级算准可用宽度；
4. 圆角一律方圆形 ≤18px。

`tests/ui-smoke.mjs` 会把上面这些写成断言（侧栏宽度、`min-width:0`、按钮收缩
约束、`.image-slot` 禁止 `aspect-ratio`、禁止 999px/50% 圆角……），跑一遍就能
确认没改坏。

### 配色

莫兰迪低饱和雾感取向，全部颜色集中在 `src/ui/tokens.css`：

| 变量 | 浅色 | 暗色 | 用途 |
| --- | --- | --- | --- |
| `--bg-app` | `#EFEDE8` | `#22202A` | 主区底色（米粉灰，非纯白） |
| `--bg-sidebar` | `#F7F4F0` | `#26242F` | 侧栏底色 |
| `--bg-surface` | `#FCFBF9` | `#2A2833` | 卡片与面板 |
| `--accent` | `#8E7BA8` | `#B6A4CC` | 主色（低饱和紫罗兰） |
| `--alt` | `#C98B72` | `#D8A18A` | 强调色（褪色陶土） |
| `--text-strong` | `#2B2733` | `#F3F0F5` | 标题 |
| `--danger` | `#A96A6A` | `#D29595` | 危险操作（灰化的砖红） |

暗色主题只覆盖颜色变量，不改结构也不改尺寸。

### UXP 兼容取舍

- 不使用 CSS Grid，全部用 flex + 百分比宽度；侧栏固定宽 + 主区 `min-width: 0`，
  两栏都各自独立滚动，不靠 `position: fixed` 撑布局。
- 原生 `input[type=range]`、`input[type=color]` 在 UXP 里无法可靠改样式，
  因此全局隐藏，改由控件工厂自绘（`W.slider` / `W.colorPicker`）。
- 原生下拉弹层无法控制配色，改为行内展开面板（`W.select`）。
- 所有文档写操作串行化到 `DreamAI.psLock` 队列，避免多个任务同时
  `executeAsModal` 把宿主卡死。
- 不使用内联 `<script>`，所有逻辑都在外部文件里按顺序加载。

### 日志为什么做成页面

日志原来只放在右下角抽屉里，而抽屉是 `position: absolute` 的覆盖层 ——
宿主里覆盖层一旦被裁切或压到下层，用户就完全看不到日志，排查问题时反而
失去唯一的线索。现在侧栏的 **活动日志** 是主区里的一个正常页面（跟着文档流走），
抽屉保留但降级为次要入口，两者读同一份 `logbus` 缓冲。

页面里能按级别与关键字过滤、显示缓冲占用、一键复制（复制失败会把内容塞进
模态让你手动选择）。

### 排查"点了没反应"

从界面到 Photoshop 之间跨了四层：**界面 → PhotoIO → psLock → UXP 宿主**。
任何一层静默失败都会表现成"点了没反应"，所以这条链路每一步都写日志：

```text
请求读取选区
选区边界：DOM 方式成功 | 10,20,110,220 (100x200)
抓取像素：请求 100x200（选区 100x200）
选区读取成功 100x200 · 图像 39.7 KB
```

失败时同样有明确记录：

| 日志 | 含义 |
| --- | --- |
| `选区边界：DOM 方式失败 …` ×3 + `三路探测均未返回矩形` | 没有选区，或选区 API 不可用 |
| `getPixels with componentSize:8 failed, retrying raw depth` | 16/32 位文档，已自动降级读取 |
| `读取选区失败：…`（带 stack 前三行） | 宿主调用抛错，看 stack 定位 |

日志页（侧栏 **活动日志**）还带级别过滤、关键字搜索、一键复制，
复制失败会把内容塞进模态让你手动选中 —— 方便把日志整段发出来。

### 宿主能力边界（实测）

这个 UXP 版本的渲染能力比预期弱很多，实测结论：

| 能力 | 结果 |
| --- | --- |
| `getContext('2d')` | 返回一个对象，但**没有任何像素写入方法**（枚举方法列表为空） |
| `ctx.putImageData` | 不存在 |
| `ctx.createImageData` | 返回空 |
| `ctx.drawImage` | 不存在 |
| `new ImageData(...)` | 不存在 |
| `<img src="data:image/png;base64,...">` | 元素在、`display:block`、数据有效，**但不渲染** |
| Photoshop 原生 `imaging.*` | **可用**（选区读取、回写全靠它） |

也就是说：**这个宿主没法显示图片**。所以预览做了三级方案：

```text
① canvas + putImageData/new ImageData   ← 宿主支持就用这个，画质无损
② <img src="data:...">                  ← 退一步
③ CSS 马赛克（div 背景色拼缩略图）        ← 宿主渲染不了图片时的保底
```

**另一个实测差异：图片元素必须静态声明。** 参考插件里能正常显示的预览
（`previewImage`、`comfyInputPreview`、`forgeInputPreview`）**全部**是
`index.html` 里静态写好的 `<img>`，而它运行时 `createElement('img')` 的那几处
是画廊缩略图。所以本项目在 `index.html` 里预置了一个 **静态图片池**（20 个 `<img>`，放在流外
不可见），预览框与参考图槽位初始化时"借"节点来用，用完归还 —— 而不是现场创建。

第 ③ 级只需要 `backgroundColor`，不碰 image/canvas，所以在 UXP 里能用：
把图像降采样成 15×34 个方块、每块取平均色，画质粗糙但足以确认
"选区读到了、内容大概是什么"。实测梯度方向与源图一致，尺寸自动适配预览框。

**预览只是便利功能**。完整分辨率的图像走 Photoshop 原生 API 回写到文档，
不经过这条渲染链路，所以不受影响。

### 预览：照参考插件的方案

预览**完全按参考插件（zhuangai）的做法实现**，不做任何额外加工：

```text
容器 .preview-frame        固定高度 + overflow hidden + 居中
图片 .preview-image        静态声明在 index.html 的图片池里，默认 display:none
有图 容器加 data-has-image 由 CSS 把图片显成 display:block; width:100%
```

三条要点，都是被实际现象逼出来的：

1. **元素必须静态声明。** 参考插件里能显示的预览全是 `index.html` 里写好的
   `<img>`；运行时 `createElement('img')` 创建的图片在 UXP 里不渲染。
   本项目因此预置了 **20 个静态 `<img>` 的图片池**，预览框与参考图槽位按需借用。
   **并且选区预览的 PNG 用 UXP 兼容编码：RGB（无 alpha）+ filter None + store 块
   （不压缩）** —— 这是照参考插件 `encodePNGFromRGB` 的写法。UXP 对 RGBA/压缩
   PNG 解码有问题（元素 loaded 但不渲染），而 RGB store 块格式能显示。
   代价是图大（683×1536 约 3MB），但预览不落盘、只在内存里，可接受。
2. **显示时必须 `width: 100%`，不能是 `auto`。** 这是最隐蔽的一条：`width:auto`
   会让图片按固有尺寸铺开，683×1536 的选区远超预览框后被 `overflow: hidden`
   裁掉 —— 元素在、日志也报 `loaded`，但屏幕上什么都没有。参考插件那条
   `#previewImage { width: 100% !important }` 正是解这个的。
3. **高度要留上限（240px）。** 参考插件对它 110px 高的小卡片用
   `max-height: none` 没问题；我们的预览区更高，不加限制图片会把页面撑到
   1500px 高（实测过）。

`object-fit: contain` 保证图像内容按原比例缩放、两侧留白，不裁切不变形。

### 回写链路### 回写链路### 回写链路

```text
选区 ──► PhotoIO.readSelection
              │  三路降级读边界 + imaging.getPixels + 最长边采样上限
              ▼
       Provider / 本地引擎 生成
              ▼
   可选校色（ColorEngine，Lab 统计迁移 / 直方图 / 柔光）
              ▼
   PhotoEncode.encodePng（自带 sRGB 块，避免解码端按未标记色域处理）
              ▼
 PhotoReturn.place：psLock → executeAsModal → createPixelLayer
                    → createImageDataFromBuffer → putPixels → 蒙版/混合模式
```

---

## 验证状态

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 纯逻辑单元测试 | `node tests/run-tests.mjs` | 60 通过 / 0 失败 |
| 界面装配冒烟 | `node tests/ui-smoke.mjs` | 全部通过（46 脚本 / 11 页面 / 233 词条） |
| 语法检查 | `node --check`（全部 JS） | 46/46 通过 |
| 资源引用 | README 里的脚本自检 | 脚本、样式、图标引用全部存在 |

单元测试覆盖：PNG/JPEG 编码、自研 DEFLATE 压缩与解压（与 Node `zlib` 双向交叉验证）、
PNG 解码往返（含 RGB/RGBA、5 种行滤镜、zlib 容器剥离）、
色彩空间与四种校色算法、辉光金字塔与屏幕混合、位移特效场与位移图编码、
示波器四种统计、i18n 键对齐与插值、存储与事件总线、任务队列状态机与并发、
画廊读写与保留策略、批处理队列、ComfyUI 工作流校验与参数抽取、Forge 配置。
界面冒烟测试会按 `index.html` 的真实顺序加载全部脚本，构建并挂载每一个页面，
校验引导链路（外壳显示、首屏激活、状态条就位）与顶栏控件点击。

### 尚未在本机验证的部分

以下功能依赖真实宿主，本机没有 Photoshop 环境，**未做实机验证**，需要你加载后确认：

- 选区读取的三路降级链、16/32 位文档的像素归一化；
- 回写链路（`createPixelLayer` → `createImageDataFromBuffer` → `putPixels`）
  与图层蒙版/混合模式设置；
- Photoshop 原生生成式填充渠道（依赖 PS 版本的 `generativeFill` 能力）；
- ComfyUI / Forge 的真实服务联调（逻辑已用打桩 `fetch` 验证过请求体与解析）。

如果实机运行遇到问题，可以先看底部状态条右侧的活动日志（点圆点打开），
里面会记录每一步的宿主调用与失败原因。把日志内容发给我就能定位。

## 已知边界

- **浏览器预览**：可以打开 `index.html` 查看界面与切换语言，但所有依赖 Photoshop
  的功能（读选区、回写、原生渠道）不可用，界面会给出对应提示。
- **原生生成式填充**：依赖 Photoshop 版本的 `generativeFill` 能力，版本不支持时
  会明确报错而不是静默失败。
- **二进制响应**：服务端直接返回图片 URL 时，插件会尝试下载并转成 data URL；
  若宿主环境的网络层无法还原字节，会退化为把 URL 交给回写流程并记录日志。
- **图片编码**：PNG / JPEG 编码器为自研实现（不依赖 Canvas 与 WASM），
  已用 zlib 与图像解码器交叉验证；JPEG 为 Baseline 4:2:0，适合回写与预览。

## 许可

本插件为独立实现，未复制任何第三方插件的源码或素材。
图标与全部文案均为本项目原创；插件不内置任何提示词库，提示词只由使用者自己编写。
