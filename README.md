# 幻梦圆环

Photoshop 画布上的**圆环菜单**助手 —— macOS 原生应用。

按 `⌥⌘R`（或在 PS 里按住 `⌥` 点右键），圆环出现在鼠标位置，
选完即走，不用打开面板、不占画布空间。

## 为什么是原生应用而不是 UXP 插件

纯 UXP 做不到这件事，三条硬限制同时封死（均已实测确认）：

1. `entrypoints` 只有 `command` / `panel` 两种类型，**没有 `modal`**，
   写进去整个插件加载失败；UXP 也没有 `window.open`
2. 面板没有任何定位 / 无边框 / 置顶 API，**UI 无法超出面板边界**
3. **没有任何全局鼠标或键盘 API**，Adobe 员工在开发者论坛明确确认：
   "the core UXP APIs don't support keyboard shortcuts"，按键只能在面板获得焦点时捕获

所以画布上的浮层必须由一个独立的原生进程来画。
Adobe 官方自己的 `desktop-helper-sample` 就是这个架构（UXP 插件 + 外部进程 + WebSocket）。

**先例**：Radial（macOS 独立 App，画布上弹饼菜单）、RadialZ（ZBrush）。
**但 Photoshop 上此前没有任何人做出来过** —— Adobe 官方功能请求 0 回复 3 票，
GitHub 搜 `photoshop pie menu` 零结果。

## 组成

```text
幻梦圆环.app（Swift / AppKit）
   │  WebSocket 服务端 127.0.0.1:8799
   │  下发：generate / setParam / applyPreset / readSelection / openChat
   │  上报：state（文档、参数、选项、预设）  progress（进度、结果缩略图）
   ▼
幻梦AI 修图插件（UXP，客户端）
     真正的生成、PS 操作、参数与预设都在主插件里
```

UXP 只有 WebSocket **客户端**、开不了监听端口（实测确认），所以服务端由助手来当。

## 交互

| 操作 | 效果 |
| --- | --- |
| `⌥⌘R` | 在鼠标位置唤出圆环 |
| PS 里 `⌥` + 右键 | 同样唤出（只在 PS 前台时拦截，普通右键完全不受影响） |
| 移动鼠标 | 高亮跟随，圆心显示当前项 |
| 左键点扇区 / 数字键 `1`-`9` | 选中执行 |
| 点带 `▸` 的扇区 | 进入下一级（悬停只高亮，不展开） |
| 点圆心 / `←` / `Delete` | 返回上一级 |
| `Esc` | 关闭整个圆环 |
| 再按一次 `⌥右键` | 收起 |

六个扇区：**生成 / 参数 / 预设 / 对话 / 读选区 / 关闭**。
（顺序、名称、显隐都可以在偏好设置里改，这里说的是内置默认。）

`Esc` 和数字键由 CGEventTap 吞掉，**不会漏给 Photoshop**
（PS 里 Esc 是「取消当前操作」，漏过去会误伤）。

## 构建与打包

```bash
bash native/build.sh run     # 构建并启动
bash native/package.sh       # 产出 dist/幻梦圆环-<版本>.dmg
bash native/autostart.sh install    # 开机自启（可选）
```

有 Apple Developer ID 的话，打包时传进去会自动用正式签名与公证：

```bash
SIGN_IDENTITY="Developer ID Application: XXX (TEAMID)" bash native/package.sh
```

没有也能分发，只是对方首次打开要在「隐私与安全性」里放行。

## 权限

需要 **辅助功能**（Accessibility）权限，用于 `⌥右键` 的 CGEventTap。
没有授权时只有快捷键可用 —— 属于预期降级，不会崩。

快捷键走 Carbon `RegisterEventHotKey`，**不需要任何权限**，
所以辅助功能没授权时圆环依然能唤出。

## 真机测试

前置：Photoshop + UXP Developer Tools 运行中，主插件已加载。

```bash
node tests/main-plugin-bridge-test.mjs   # 桥接 + 状态快照
node tests/ring-reconnect-test.mjs       # 断线自动重连（会杀掉再拉起助手）
```

## AppKit 踩过的坑

- **`nonactivatingPanel` 是必须的**：普通窗口在 App 不活跃时第一次点击只用来激活，
  点不到按钮，还会抢走 PS 焦点
- **全局监听拦不住按键**（只能旁观）→ Esc / 数字键必须走 CGEventTap 才能吞掉
- **`mouseMoved` 送达取决于窗口是不是 key** → 改用按帧轮询 `NSEvent.mouseLocation`
- **WebSocket 帧首字节必须 `0x80 | opcode`**。只写 opcode 会发出非终止帧，
  客户端一直等分片，`message` 事件永不触发
- **连接回调要按连接身份判断**：`existing.cancel()` 是异步的，旧连接稍后的
  `cancelled` 回调会把新连接抹掉，表现为插件每次重连都被踢
- **切换层级时必须重置 `hoverIndex`**：新一层块数更少时，
  旧索引会让 `drawHub()` 数组越界 → SIGTRAP 崩溃

## 目录

```text
native/
  HuanmengRing/                  Swift 包（SPM）
    Sources/HuanmengRing/
      main.swift                 入口 + 隐藏的调试 flag（--doctor 等）
      AppDelegate.swift          串联：菜单栏 / 快捷键 / 事件 tap / 圆环 / 桥接

      RingWindow.swift           无边框透明置顶窗口
      RingView.swift             扇形绘制、命中测试、动画
      RingModel.swift            菜单数据模型与几何
      RingConfig.swift           配置层（读写 ~/.huanmeng-ring.json）
      PreferencesWindow.swift    SwiftUI 首选项界面（外观/交互/内容/高级）

      BridgeProtocol.swift       与插件的消息协议 + 菜单构建
      BridgeServer.swift         零依赖 WebSocket 服务端
      HotkeyManager.swift        Carbon 全局热键
      AltRightClickTap.swift     ⌥右键 CGEventTap

      ChatPanel.swift            画布下方的对话气泡（含生成进度条）
      ToastWindow.swift          右下角浮动提示
      ImagePanel.swift           出图结果浮窗

      StandaloneEngine.swift     不连插件时的独立出图/对话
      GrsClient.swift            GRS 接口客户端
      PresetStore.swift          助手自己的预设库
      ImageSource.swift          文件选择 / 截图监听
      ImageExtract.swift         从各渠道响应里提取图片（宽松解析）
      StatusFile.swift           给 --doctor 读的运行状态
      Doctor.swift               环境自检
      MenuDump.swift             菜单快照（--dump-menu，用于测试与调试）

  build.sh / package.sh / autostart.sh / make-icon.sh / make-signing-cert.sh
  deploy/                       安装与卸载脚本
tests/                          真机桥接测试
dist/                           打包产物（不进版本库）
```
