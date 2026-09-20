# 幻梦AI Photoshop 插件

面向 Photoshop UXP 的 AI 修图、生成、回图与本地创意工具面板。

## 职责

- 提供图像生成、任务等待/重试、生成记录和提示词预设界面。
- 连接 GRS、火山引擎、grok2api、Sub2API、xAI、Firefly、New API 与 RunningHub。
- 读取 Photoshop 选区，并将结果校色后放回当前文档。
- 提供辉光、粒子 VFX、示波器、灯光和常用 Photoshop 工具。

## 第三方组件

本插件包含第三方作品，署名与许可证见同目录的 [`NOTICE`](NOTICE) 与
[`LICENSE-Apache-2.0.txt`](LICENSE-Apache-2.0.txt)。
本插件整体按 GPL-3.0 分发；第三方组件版权归各自作者所有。

## 不负责

- 不在界面文件中维护供应商私有服务实现。
- 版本化提示词预设放在 `assets/presets/`，不在 `src/app/` 里维护。
  例外：`src/features/reference-ui/tile-hemisynth.prompts.js` 内嵌了半合成提示词
  （base64 分块存储，运行时解码），与上面的约定不一致，属历史遗留。
- 不把发布产物当作业务源码依赖。

## 目录

```text
Dream-ps-ai/
├── index.html                         # UXP 面板入口；视图模板 + 内联样式
├── manifest.json                      # Photoshop UXP 清单
├── manifest.webmanifest               # H5 / PWA 清单
├── sw.js                              # H5 Service Worker（离线预缓存清单）
├── src/
│   ├── app/
│   │   └── index.js                   # 应用启动、任务和 Provider 编排（单体）
│   ├── theme.js                       # 亮/暗主题切换（独立文件，UXP 禁内联脚本）
│   ├── features/
│   │   ├── color-match/
│   │   │   └── color-match.service.js # 纯图像颜色校准能力
│   │   ├── gallery/
│   │   │   └── gallery-store.js       # 画廊存储（UXP 文件系统 / IndexedDB）
│   │   ├── glow/
│   │   │   └── glow-engine.js         # 多尺度辉光与保护性合成
│   │   ├── photoshop-core/
│   │   │   └── ps-lock.js             # executeAsModal 串行队列
│   │   ├── reference-ui/
│   │   │   └── tile-hemisynth.prompts.js # 半合成提示词（内嵌 base64）
│   │   ├── ring-bridge/
│   │   │   └── ring-bridge.js         # 与幻梦圆环助手的 WebSocket 桥接（客户端）
│   │   └── space-fx/
│   │       └── space-fx-engine.js     # 热浪、气流、刀光位移特效
│   ├── sw-register.js                 # H5/PWA 引导（UXP 下自动跳过）
│   └── styles/                        # 仅 reference-tile-*.css 被 index.html 引入；
│                                      # 主体样式内联在 index.html 的 <style> 中
├── assets/
│   ├── donation/                      # 关于页赞赏码
│   └── presets/
│       └── yushe.json                 # 版本化提示词预设
├── icons/                             # UXP 图标资产（manifest.json 声明 D/N 两套主题）
├── tests/
│   ├── feature-services.test.js       # 校色、辉光、空间特效单元测试
│   ├── gallery-store.test.js          # 画廊存储单元测试
│   └── uxp-live-smoke.mjs             # Adobe UXP 宿主加载/回写冒烟测试
├── server/presets/                    # 提示词同步服务端（纯静态，见其 README）
├── NOTICE                             # 第三方署名（Apache-2.0 第 4(d) 条）
├── LICENSE-Apache-2.0.txt             # 第三方组件许可证全文
├── H5-部署说明.md
└── 使用教程.html                       # 用户教程
```

## 依赖方向

- `index.html` 按固定顺序用 `<script src>` 加载 `src/features/*` 与 `src/theme.js`，
  最后加载 `src/app/index.js`。**没有构建步骤，不使用 ES Module。**
- `src/app/index.js` 是单体入口，通过 `window.<命名空间>` 消费各 feature。
- `src/features/photoshop-core/ps-lock.js` 是唯一通过 `require()` 加载的 core 模块。
- `src/features/color-match` 不访问 Provider、Photoshop 文档或 UI 状态。
- `src/app` 可以编排 feature、Provider 和 UXP Host 能力。
- `assets` 只保存数据资产，不依赖业务源码。
- `server/` 是**独立交付物**，不参与插件运行 —— 它是给「设置 → 提示词同步服务器」
  提供内容用的静态站点，细节见 `server/presets/README.md`。

## 本地网关配置

| 项目 | 插件默认地址 | 插件中填写的密钥 | 主要用途 |
| --- | --- | --- | --- |
| grok2api | `http://127.0.0.1:8000` | 后台 Client Keys 创建的 `g2a_...` | Grok Imagine 文生图、图片编辑与模型列表 |
| Sub2API | `http://127.0.0.1:8080` | 用户后台创建的 `sk-...` | 聚合订阅账号并提供 Grok 图片生成/编辑接口 |
| New API | `http://127.0.0.1:3000` | New API 中创建的渠道令牌 | 统一 OpenAI 兼容网关；生图模型映射名需在设置中单独填写 |

三个地址都可以填写根地址或带 `/v1` 的地址，插件会在请求前规范化。`g2a_...`、Sub2API 的 `sk-...`、xAI 官方 Key 和服务管理员密码互不通用。连接检测统一读取 `/v1/models`；生图使用 `/v1/images/generations`，有原图或参考图时使用 `/v1/images/edits`。

## 后续落包约定

新功能放在 `src/features/<feature>/`，同一功能的界面、服务、Host 适配和样式应成套放置。旧入口只在实际修改相关业务时逐步拆分，避免纯目录整理造成高风险重构。

## 验证

```bash
node --check src/app/index.js
node --check src/features/color-match/color-match.service.js
node --check src/features/gallery/gallery-store.js
node --check src/features/glow/glow-engine.js
node --check src/features/photoshop-core/ps-lock.js
node --check src/features/reference-ui/tile-hemisynth.prompts.js
node --check src/features/ring-bridge/ring-bridge.js
node --check src/features/space-fx/space-fx-engine.js
node --check src/sw-register.js
node --check sw.js
node tests/feature-services.test.js
node tests/gallery-store.test.js
```

Photoshop 与 Adobe UXP Developer Tools 已运行并加载面板时，还可以执行：

```bash
node tests/uxp-live-smoke.mjs
```

该测试通过 Adobe 本机调试服务确认面板上下文、四个算法模块和 15 个工具入口；存在活动文档时，会创建 8×8 临时像素层调用 `imaging.putPixels`，随后立即删除该图层。
