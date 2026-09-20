# 幻梦圆环 · 配置与桥接规格

> 这份文档是跨平台实现的唯一依据。macOS 版（Swift/AppKit）和将来的 Windows 版
> 各自独立实现，只通过**同一份 JSON 配置**和**同一套 WebSocket 协议**互操作。
>
> 两份实现不需要共享代码，但必须共享本文档描述的语义。改动协议或配置结构时，
> 先改这份文档。

- 配置文件：`~/.huanmeng-ring.json`（Windows 建议 `%USERPROFILE%\.huanmeng-ring.json`，保持一致便于同步）
- 桥接：WebSocket，`ws://127.0.0.1:<port>`，默认 **8799**，只绑回环
- 文档版本：跟随 `config.version`

---

## 一、配置文件结构

顶层是一个 JSON 对象。**除 `config` 外的键由使用者自由支配**——实现方在写盘时
必须保留自己不认识的键，不要整份覆盖。

```json
{
  "hotkey": "ctrl+alt+cmd+r",
  "config": {
    "version": 1,
    "appearance": { ... },
    "interaction": { ... },
    "content": { ... },
    "bridge": { ... }
  }
}
```

| 键 | 说明 |
|---|---|
| `hotkey` | **旧格式**，快捷键字符串。为兼容早期版本保留，`config.interaction.hotkey` 为空时才生效。写盘时应与生效值保持同步 |
| `config` | 全部设置。**缺任何一个字段都必须能正常启动**——按各字段的默认值补齐 |

**容错要求**：配置文件不存在、JSON 语法错误、类型不对、只写了一半——四种情况都必须
回退到默认值继续运行，不能启动失败。macOS 版的做法是每个字段单独 `decodeIfPresent ?? default`。

---

## 二、可配置字段

### 2.1 `appearance` — 外观

| 字段 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `ringSize` | number | `340` | 200–900 | 圆环窗口边长（点/px）。圆环外径由它推导，见第三节 |
| `bandRatio` | number | `0.44` | 0.15–0.85 | 环带内径 ÷ 外径。越小环带越厚 |
| `gapRatio` | number | `0.06` | 0–0.5 | 扇区之间的角度间隙，占单块角度的比例 |
| `gapMax` | number | `0.014` | ≥0 | 上述间隙的弧度上限 |
| `popDistance` | number | `7` | 0–40 | 悬停时扇区向外弹出的距离 |
| `opacity` | number | `1.0` | 0.1–1 | 整个圆环的不透明度 |
| `disabledWedgeAlpha` | number | `0.4` | 0.05–1 | 禁用扇区的填充透明度 |
| `disabledEdgeAlpha` | number | `0.35` | 0.05–1 | 禁用扇区的描边透明度 |
| `appearScale` | number | `0.86` | 0.3–1 | 唤出动画的起始缩放（→1） |
| `appearStep` | number | `0.18` | 0.02–1 | 出现动画每帧推进量（60fps） |
| `hoverSpeed` | number | `0.28` | 0.02–1 | 高亮渐变每帧推进比例 |
| `labelFontSize` | number | `9.5` | 6–24 | 扇区文字字号 |
| `labelLineHeight` | number | `11` | 7–30 | 扇区文字行高 |
| `hubTitleFontSize` | number | `12` | 7–28 | 圆心主标题字号 |
| `hubSubFontSize` | number | `9` | 6–22 | 圆心副标题字号 |
| `shadowEnabled` | bool | `true` | | 合并轮廓投影 |
| `shadowBlur` | number | `10` | 0–40 | 投影模糊半径 |
| `shadowOffsetY` | number | `3` | -20–20 | 投影垂直偏移 |
| `shadowAlpha` | number | `0.55` | 0–1 | 投影浓度 |
| `colors` | object | 见下 | | 配色 |

**超出范围的处理**：实现方应钳制到范围内，而不是报错或忽略。

### 2.2 `appearance.colors` — 配色

全部为 `"#RRGGBB"` 或 `"#RRGGBBAA"` 字符串（也接受 `"#RGB"`，缺 alpha 补 `FF`）。
解析失败时回退到**该字段自己的默认色**（不是统一回退成白色，那样一个错别字会让整块扇区变白、更难排查）。

> **色彩空间注意**：这些十六进制值写入的是**数值本身**，不是经过色彩空间转换的结果。
> macOS 版用 `NSColor(calibratedRed:...)` 构造、也直接读自身分量回写，保证
> `hex → 颜色 → hex` 是恒等变换（否则每次存盘读回都会漂一点，取色器改几次就明显偏色）。
> Windows 版按 sRGB 处理即可，两边观感差异很小。

| 字段 | 默认 | 用途 |
|---|---|---|
| `wedgeFill` | `#33333BF5` | 扇区底色（偶数位） |
| `wedgeFillAlt` | `#2B2B33F5` | 扇区底色（奇数位） |
| `wedgeEdge` | `#5C5C5CD9` | 扇区描边 |
| `hoverFill` | `#4278C2FF` | 悬停填充 |
| `hoverEdge` | `#85BDFFFF` | 悬停描边 |
| `hubFill` | `#1F1F24FA` | 圆心填充 |
| `hubEdge` | `#4770A8FF` | 圆心描边 |
| `text` | `#F0F0F0FF` | 扇区文字 |
| `textDim` | `#999999FF` | 次级文字（子菜单三角标） |
| `textFaint` | `#6B6B6BFF` | 弱化文字（禁用扇区、圆心副标题） |
| `accent` | `#61E094FF` | 勾选标记 |

### 2.3 `interaction` — 交互

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `hotkey` | string | `""` | 形如 `"ctrl+alt+cmd+r"`。修饰键别名：`cmd`/`command`、`alt`/`option`/`opt`、`ctrl`/`control`、`shift`；最后一段是单个字母。**留空则用顶层 `hotkey`** |
| `altRightClick` | bool | `true` | 画布上按住 Alt 再右键唤出 |
| `hoverHighlight` | bool | `true` | 鼠标移到扇区上就高亮 |
| `keyboardSelect` | bool | `true` | 数字键 1–9 直选第 n 个扇区 |
| `escapeToClose` | bool | `true` | Esc 关闭整个圆环 |
| `summonAtCursor` | bool | `true` | true=鼠标位置唤出；false=主屏中心 |
| `showChildMarker` | bool | `true` | 有子菜单的扇区在外缘画三角标 |
| `showDirectionLine` | bool | `true` | 从圆心指向当前扇区的指示线 |
| `popOnHover` | bool | `true` | 悬停时扇区向外弹出 |

**快捷键字符串解析规则**：按 `+` 分割，大小写不敏感，逐段匹配修饰键；
不认识的段当作主键（取单个字母）。解析失败时回退到默认 `⌥⌘R` 并记录日志。

### 2.4 `content` — 内容

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `usePluginLabels` | bool | `true` | 采用插件下发的扇区名称（见协议 `sectors` / `labels`）。插件没下发时自动回落到 `sectors` 里的自定义名 |
| `usePluginActions` | bool | `true` | 采用插件下发的扇区**动作**。关掉则永远用下面的自定义动作 / 内置默认 |
| `sectors` | object | 六个扇区 | 键为稳定 id，见下 |

> `usePluginLabels` 和 `usePluginActions` 是**两个独立的开关**：
> 你可能想用插件给的名字、但自己决定点了干什么，反之亦然。

`sectors` 下每个键的值：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `label` | string | 见下 | 自定义名称。空字符串视为未设置，回落到内置默认名 |
| `visible` | bool | `true` | 是否显示 |
| `order` | number | 0–5 | 显示顺序，升序。从正上方开始顺时针排列 |
| `action` | string | `""` | 这个扇区被点了以后干什么。空字符串视为未设置，回落到该槽位的内置默认动作（见下） |

**六个槽位的内置默认动作**（即「不配置时行为和改造前完全一样」）：

| 槽位 id | 默认值 | 说明 |
|---|---|---|
| `generate` | `generate` | 转发给插件 |
| `params` | `params` | **圆环自己处理** —— 展开模型/比例/数量子菜单 |
| `presets` | `presets` | **圆环自己处理** —— 展开分类 → 预设子菜单 |
| `chat` | `chatMenu` | **圆环自己处理** —— 展开对话子菜单。**注意槽位叫 `chat` 而指令叫 `chatMenu`**，后缀不一致是历史原因，别「统一」掉 |
| `readSelection` | `readSelection` | 转发给插件 |
| `close` | `close` | **圆环本地处理** —— 收起圆环，不会发给插件 |

**动作的解析规则**：`params` / `presets` / `chatMenu` 由圆环展开子菜单，
`close` 是圆环本地行为，**其余动作一律当成命令原样转发给插件**
（圆环不需要知道 `tab:gallery` 是什么意思）。这样插件以后新增动作，助手一行都不用改。

> 老助手只发槽位 id，不认识子菜单这回事。插件侧对 `action == "chat"`
> （没带 `resolved` 的旧协议）保留「切到对话页」的老行为 —— 这层兼容不能删，
> 否则老版本的助手点「对话」只会得到一句「需要在圆环上展开」。

**动作优先级**：插件下发（需 `usePluginActions` 为真）> `sectors[id].action` > 上表的内置默认。

**六个稳定 id 及默认名**（id 不可更改，改了会让已存配置失效）：

| id | 默认名 | 行为 |
|---|---|---|
| `generate` | 生成 | 发 `command: "generate"` |
| `params` | 参数 | 进入二级菜单（模型 / 分辨率 / 数量） |
| `presets` | 预设 | 进入二级菜单（预设分类 → 条目） |
| `chat` | 对话 | 进入二级菜单（模型 / 快捷提问 / 打字提问 / 看回复 / 新对话 / 打开面板） |
| `readSelection` | 读选区 | 发 `command: "readSelection"` |
| `close` | 关闭 | 只收起圆环，不发消息 |

**标签优先级**：插件下发 > `sectors[id].label` > 内置默认名。

**边界**：六个扇区全被隐藏时必须回退成显示全部——空菜单会让圆环画不出来。

### 2.5 `bridge` — 桥接

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `port` | number | `8799` | WebSocket 监听端口。改动需重启助手生效 |

---

## 三、圆环几何

所有半径以**视图中心为原点**，单位与 `ringSize` 一致。

设视图边长 `S = clamp(ringSize, 200, 900)`：

```
外半径 outer = max(40, S/2 - 12)          // 留 12 的边距
   若 S/2 - 12 < 60，改用 S/2 - 4        // 小尺寸下边距收紧
内半径 inner = outer * bandRatio
环带中径     = (outer + inner) / 2
```

**扇区排布**：共 `n` 个扇区时，单块角度 `step = 2π / n`。
第 `i` 块的中心角 `mid = -π/2 + i * step`（`-π/2` 即正上方，顺时针递增）。

**间隙**：`gap = min(gapMax, step * gapRatio)`，
则第 `i` 块的角度范围是 `[mid - step/2 + gap, mid + step/2 - gap]`。

**扇区中心坐标**（y 轴向下）：
```
x = cx + ringRadius * cos(mid)
y = cy + ringRadius * sin(mid)
```

**命中测试**：设点击点相对圆心的距离为 `d`：
1. `d < inner` → 返回 `-1`（落在圆心 = 返回上一级 / 关闭）
2. `d > outer + 6` → 返回 `nil`（环外，不响应）
3. 否则：
   ```
   angle = atan2(dy, dx) + π/2 + step/2
   while angle < 0 { angle += 2π }
   index = floor(angle / step) % n
   ```

**弹出**：悬停时该扇区的 `outer` 增加 `popDistance`，同时其文字锚点的半径也增加同样的值。

---

## 四、桥接协议

原生端是 **WebSocket 服务端**，插件是客户端，连 `ws://127.0.0.1:<port>`。
文本帧，JSON 编码。

### 4.1 原生端 → 插件

握手成功后原生端主动发一次：

```json
{ "type": "hello", "server": "huanmeng-ring", "version": "0.1.0" }
```

扇区被确认时：

```json
{ "type": "command", "action": "generate",     "resolved": true }
{ "type": "command", "action": "openChat",     "resolved": true }
{ "type": "command", "action": "readSelection","resolved": true }
{ "type": "command", "action": "tab:gallery",  "resolved": true }
{ "type": "command", "action": "setParam",  "payload": { "key": "model", "value": "nano-banana-pro" } }
{ "type": "command", "action": "applyPreset", "payload": { "name": "电影感" } }

{ "type": "command", "action": "chatAsk",   "resolved": true, "payload": { "prompt": "这张图怎么调" } }
{ "type": "command", "action": "chatModel", "resolved": true, "payload": { "value": "grs/gpt-5.4" } }
{ "type": "command", "action": "chatNew",   "resolved": true }
```

**对话指令**（`chatAsk` / `chatModel` / `chatNew`）由原生端的「对话」子菜单发出，
插件侧落到面板自己的对话流程上（同一份聊天记录，不另起一套）。
`chatAsk` 的 `prompt` 就是用户的问题原文，**中文原样传输**——
原生端负责拿到文本（输入法在它那边），插件不做任何编码转换。

> 原生端不要自己去调对话接口。聊天记录、选区图片这些上下文组装只有插件那份逻辑，
> 从外面重放一遍迟早会走偏 —— 发指令驱动面板自己的按钮才是对的。

「打字提问」和「看回复」是**原生端本地动作**，不发消息给插件：
前者要开一个真正的文本控件才能挂上输入法，后者是把本地存的那份回复再显示一遍。

> **`setParam` 与 `applyPreset` 的参数必须放在 `payload` 里。**
> 早期版本发的是扁平字段（顶层 `key`/`value`/`name`），插件侧读的是 `payload`，
> 导致圆环里选参数和预设静默失效——这是个已修复的真实 bug，实现时不要退回去。

`close` 扇区**不发消息**，只在原生端收起圆环。

**`resolved: true`（推荐新实现都带上）** 表示「这个动作原生端已经按 2.4 的规则解析过了」。

为什么需要这个标记：插件侧保留了一层**兼容旧版助手**的翻译 ——
老助手只会发槽位 id（`generate` / `chat` / `close`…），插件要自己查配置翻译。
但新助手发的是解析好的动作，其中有些**恰好和槽位 id 同名**，
不带标记的话插件会把它当槽位 id 再解析一次，
把用户关掉「采用插件下发的扇区动作」后在原生端做的选择覆盖掉。

旧版助手不发这个字段，插件照旧翻译 —— 向后兼容不受影响。

`action` 取值：见 2.4 的动作表，或插件在 `state.actions` 里下发的清单。
`setParam` 的 `key` 取值：`model` / `resolution` / `count`。

### 4.2 插件 → 原生端

**状态推送**（插件在连接后应立即推一次，之后每 4 秒兜底重推，状态变化时即时推）：

```json
{
  "type": "state",
  "payload": {
    "document": { "open": true, "name": "未命名-1", "hasSelection": true,
                  "selectionWidth": 1024, "selectionHeight": 768 },
    "params":   { "model": "nano-banana-pro", "resolution": "2K", "count": 1 },
    "options":  {
      "model":      [ { "value": "nano-banana-pro", "text": "…" } ],
      "resolution": [ { "value": "2K", "text": "2K" } ],
      "count":      [1, 2, 3, 4]
    },
    "presets":  [ { "category": "人像", "items": [ { "name": "电影感", "prompt": "…" } ] } ],

    "sectors": [
      { "id": "generate",     "action": "generate",     "label": "生成" },
      { "id": "params",       "action": "params",       "label": "参数" },
      { "id": "presets",      "action": "presets",      "label": "预设" },
      { "id": "chat",         "action": "chatMenu",     "label": "对话" },
      { "id": "readSelection","action": "readSelection","label": "读选区" },
      { "id": "close",        "action": "close",        "label": "关闭" }
    ],

    "chat": {
      "model": "grs/gpt-5.4",
      "models": [ { "value": "grs/gpt-5.4", "text": "GPT-5.4" } ],
      "questions": [
        { "label": "调色思路", "prompt": "给我一个适合这张照片的调色思路…" }
      ],
      "busy": false,
      "hasReply": true,
      "lastQuestion": "这张图怎么调",
      "lastReply": "先压高光…（截断版）"
    },

    "actions": [
      { "value": "generate", "label": "生成",     "hint": "按当前面板参数出图" },
      { "value": "params",   "label": "参数菜单",  "hint": "展开：模型 / 画质 / 比例 / 数量" },
      { "value": "presets",  "label": "预设菜单",  "hint": "展开：分类 → 预设" },
      { "value": "tab:gallery", "label": "切到「画廊」" },
      { "value": "close",    "label": "关闭圆环",  "hint": "只收起圆环，不退出助手" }
    ],

    "labels":   { "generate": "生成", "params": "参数", "presets": "预设",
                  "chat": "对话", "readSelection": "读选区", "close": "关闭" }
  }
}
```

| 字段 | 必需 | 缺省行为 |
|---|---|---|
| `document` | 否 | 整体覆盖；子字段缺失按 false/0 处理 |
| `params` | 否 | **只在字段非空时覆盖**当前值 |
| `options` | 否 | **只在数组非空时覆盖** |
| `presets` | 否 | 整体替换 |
| `sectors` | 否 | **逐个字段非空覆盖**。`action` 和 `label` 各自独立：某一项没推就保留上一次的值 |
| `actions` | 否 | 整体替换。这是插件的完整能力清单，不存在「只推一部分」 |
| `chat` | 否 | **逐字段覆盖**。没推的字段保留上一次的值 |
| `labels` | 否 | **兼容用的旧通道**，只带名称不带动作。新实现应优先读 `sectors` |

**`chat`** 是「对话」子菜单的全部内容来源。`questions` 为空时该扇区显示为不可用；
`models` 为空时模型那一项不可用。`lastReply` 是**截断版**——
state 每几秒推一次，全文塞进去是浪费；完整正文走下面的 `type: "chat"` 推送，
原生端要自己留一份（用来支持「看回复」）。

**`sectors[].id`** 是槽位稳定标识（六个，见 2.4），**不可更改**。
`action` 是「点了干什么」，取值见 `actions[].value`；圆环按 2.4 的规则解析。

**`actions`** 让助手不用自己维护一份动作清单来做偏好设置的下拉框 ——
动作的唯一定义在插件侧。助手应当在没收到 `actions`（例如未连接）时
使用自己的一份兜底列表，保证断线也能改设置。

**进度推送**：

```json
{ "type": "progress", "state": "running|success|failure", "message": "…", "thumbnail": "<base64>" }
```

`thumbnail` 可选，是裸 base64（不带 `data:` 前缀），原生端解码后显示在浮动提示里。

**对话推送**（只在对话流程里发，和 `progress` 分开）：

```json
{ "type": "chat", "action": "thinking", "payload": { "question": "这张图怎么调", "history": [ … ] } }
{ "type": "chat", "action": "reply",    "payload": { "question": "这张图怎么调",
                                                   "text": "先压高光…（全文）", "history": [ … ] } }
{ "type": "chat", "action": "error",    "payload": { "question": "这张图怎么调",
                                                   "message": "请先在设置中配置API密钥", "history": [ … ] } }
{ "type": "chat", "action": "history",  "payload": { "history": [ … ] } }
```

**`history`** 是**完整聊天记录**，原生端拿它渲染「长对话」的来回：

```json
[ { "role": "user", "text": "你好" },
  { "role": "assistant", "text": "你好，有什么可以帮你的？" } ]
```

- 原生端**不要自己攒一份**：插件那份（和面板「对话」页同一个数组）才是唯一事实。
  两边各攒一份迟早分叉，用户会看到「圆环里问的、面板里没有」。
- `thinking` 的 `history` 里应当**已经包含刚问的这句问题**（插件推送前拼好），
  否则用户在等回复时会看不到自己刚问了什么。
- 只推最近若干条（插件侧上限 40 条、单条 8000 字），显示层不需要完整历史。
- 原生端**不要自作主张把气泡弹回来**：用户按 Esc 关掉了，回复到了也不该突然出现。

`action: "history"` 是**原生端主动索取**用的（对应指令 `chatHistory`）：
助手刚重启过时本地没有记录，「看对话」会先要一份再显示。

为什么不用 `progress`：对话要显示的是**正文**，右下角那种一行提示条根本看不完。
`thinking` 由原生端负责把气泡弹出来（快捷提问时气泡还没开），
`reply` / `error` 由原生端填进已经开着的气泡；气泡已经被用户关掉时就别硬弹回来。

**日志**：`{ "type": "log", "message": "…" }`

**心跳**：客户端可发标准 WebSocket ping 帧，服务端回 pong。服务端**不主动** ping。

### 4.3 连接与重连

- 原生端只绑 `127.0.0.1`，不暴露局域网
- 新连接到来时替换旧连接（旧连接的回调要忽略，否则会误清新连接的状态）
- 重连由**客户端**负责：指数退避 800ms → 15s，上限 15s

---

## 五、配色预设

macOS 版在偏好设置里提供五套预设，键名与 2.2 一致：

| 名称 | 说明 |
|---|---|
| 默认 | 深灰蓝，见 2.2 的默认值 |
| 高对比 | 纯黑白，边缘亮 |
| 暖色 | 棕橙调 |
| 冷色 | 蓝青调 |
| 半透明 | 全白半透明，压在照片上不挡视线 |

预设只是一次性写入颜色字段，套用后仍可逐个微调——不需要在配置文件里记录"当前用了哪套预设"。

---

## 六、实现检查清单

改动配置或协议的实现方，提交前确认：

- [ ] 删掉配置文件后能正常启动，且外观与默认值一致
- [ ] 配置文件只写一半字段时，缺失字段用默认值补齐而不是报错
- [ ] 配色字段写错（比如 `"red"`）时该颜色回退到默认，其余部分照常绘制
- [ ] `setParam` / `applyPreset` 的参数在 `payload` 里
- [ ] 六个扇区全隐藏时会回退成显示全部
- [ ] 写盘时保留不认识的顶层键
- [ ] 配置里超出范围的数值被钳制，而不是崩溃
