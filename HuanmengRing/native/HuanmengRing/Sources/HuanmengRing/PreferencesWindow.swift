// ============================================================
//  PreferencesWindow.swift — 偏好设置界面
//
//  用 SwiftUI 写表单，通过 NSHostingView 嵌进普通 NSWindow。
//  之所以不用纯 AppKit：这里面有 40+ 个控件，手写 NSStackView 布局
//  要 800 行以上，而这层 UI 是 Mac 专属的（Windows 版会另写一份，
//  只共享 ~/.huanmeng-ring.json 的 schema，见 SPEC-ring-config.md）。
//
//  关于激活：App 是 .accessory 策略且从不 NSApp.activate，
//  所以打开这个窗口必须显式激活，否则窗口拿不到键盘焦点。
//  项目里其它窗口（圆环、Toast）都是非激活式的，这里是唯一的例外。
// ============================================================

import SwiftUI
import AppKit

// MARK: - 实时预览

/// 把 RingView 包给 SwiftUI 用。喂固定的一层菜单，样式一变就重画。
private struct RingPreviewView: NSViewRepresentable {
    let style: RingStyle

    static let level = RingLevel(title: "预览", segments: [
        RingSegment(label: "生成"),
        RingSegment(label: "参数"),
        RingSegment(label: "预设"),
        RingSegment(label: "对话"),
        RingSegment(label: "读选区"),
        RingSegment(label: "关闭")
    ])

    func makeNSView(context: Context) -> RingView {
        let view = RingView(frame: NSRect(x: 0, y: 0, width: 220, height: 220))
        view.level = Self.level
        view.style = style
        view.startAnimation()
        return view
    }

    func updateNSView(_ view: RingView, context: Context) {
        view.style = style
        if view.level == nil { view.level = Self.level }
    }
}

// MARK: - 取色行

private struct HexColorRow: View {
    let title: String
    @Binding var hex: String

    var body: some View {
        HStack(spacing: 8) {
            ColorPicker(title, selection: Binding(
                get: { NSColor(hexString: hex).map { Color($0) } ?? Color.gray },
                set: { hex = NSColor($0).hexStringWithAlpha }
            ), supportsOpacity: true)
            TextField("", text: $hex)
                .font(.system(size: 11, design: .monospaced))
                .frame(width: 100)
                .textFieldStyle(.roundedBorder)
        }
    }
}

// MARK: - 主界面

private struct PreferencesView: View {
    @State var config: RingConfig
    /// 插件下发的动作清单。插件没连上时为空，这时用下面的兜底列表。
    let pluginActions: [BridgeActionOption]
    let onChange: (RingConfig) -> Void

    /// 下拉框里的一个动作选项。
    /// 用结构体而不是元组：SwiftUI 的 ForEach 要 Identifiable，
    /// 而元组不支持 keyPath 取成员。
    private struct ActionOption: Identifiable {
        let value: String
        let label: String
        var id: String { value }
    }

    /// 动作下拉的选项。
    ///
    /// 优先用插件下发的清单 —— 动作的唯一定义在插件侧（ring-bridge.js 的 ACTIONS），
    /// 助手自己再维护一份迟早会对不上。下面这份兜底只保证「插件没连上时也能改设置」，
    /// 所以 value 必须和插件那边逐字对应；漏了哪项，断线时那一项就会从下拉里消失。
    private var actionOptions: [ActionOption] {
        if !pluginActions.isEmpty {
            return pluginActions.map { ActionOption(value: $0.value, label: $0.label ?? $0.value) }
        }
        return [
            ActionOption(value: "generate", label: "生成"),
            ActionOption(value: "params", label: "参数菜单"),
            ActionOption(value: "presets", label: "预设菜单"),
            ActionOption(value: "readSelection", label: "读取选区"),
            ActionOption(value: "openChat", label: "对话"),
            ActionOption(value: "tab:img2img", label: "切到「生成」"),
            ActionOption(value: "tab:apps", label: "切到「快速」"),
            ActionOption(value: "tab:toolbox", label: "切到「工具箱」"),
            ActionOption(value: "tab:runninghub", label: "切到「应用」"),
            ActionOption(value: "tab:gallery", label: "切到「画廊」"),
            ActionOption(value: "tab:generationCenter", label: "切到「生成中心」"),
            ActionOption(value: "tab:logs", label: "切到「记录」"),
            ActionOption(value: "tab:settings", label: "切到「设置」"),
            ActionOption(value: "clearPrompt", label: "清空提示词"),
            ActionOption(value: "close", label: "关闭圆环")
        ]
    }

    /// 改一个字段就立刻推给外面（存盘 + 应用到圆环）。
    /// 传值而不是传引用，所以这里必须手动触发回写。
    private func push() { onChange(config) }

    private func bind<T>(_ keyPath: WritableKeyPath<RingConfig, T>) -> Binding<T> {
        Binding(get: { config[keyPath: keyPath] },
                set: { config[keyPath: keyPath] = $0; push() })
    }

    var body: some View {
        VStack(spacing: 0) {
            RingPreviewView(style: RingStyle(config))
                .frame(width: 220, height: 220)
                .background(Color(nsColor: .underPageBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.top, 14)
                .padding(.bottom, 6)

            Text("实时预览 · 改动立即生效")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .padding(.bottom, 10)

            TabView {
                appearanceTab.tabItem { Text("外观") }
                interactionTab.tabItem { Text("交互") }
                contentTab.tabItem { Text("内容") }
                advancedTab.tabItem { Text("高级") }
            }
            .padding(.horizontal, 12)
        }
        .frame(width: 460, height: 640)
    }

    // MARK: 外观

    private var appearanceTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                group("尺寸") {
                    slider("环大小", bind(\.appearance.ringSize), 200...900, format: "%.0f pt")
                    slider("环带厚度", bind(\.appearance.bandRatio), 0.15...0.85, format: "%.2f")
                    slider("扇区间隙", bind(\.appearance.gapRatio), 0...0.3, format: "%.2f")
                    slider("弹出距离", bind(\.appearance.popDistance), 0...20, format: "%.0f pt")
                    slider("整体不透明度", bind(\.appearance.opacity), 0.2...1, format: "%.2f")
                }

                group("动画") {
                    slider("出现缩放", bind(\.appearance.appearScale), 0.4...1, format: "%.2f")
                    slider("出现速度", bind(\.appearance.appearStep), 0.02...0.6, format: "%.2f")
                    slider("高亮渐变速度", bind(\.appearance.hoverSpeed), 0.02...0.8, format: "%.2f")
                }

                group("文字") {
                    slider("扇区字号", bind(\.appearance.labelFontSize), 6...18, format: "%.1f")
                    slider("圆心主标题", bind(\.appearance.hubTitleFontSize), 7...20, format: "%.0f")
                    slider("圆心副标题", bind(\.appearance.hubSubFontSize), 6...16, format: "%.0f")
                }

                group("投影") {
                    Toggle("启用投影", isOn: bind(\.appearance.shadowEnabled))
                    slider("模糊半径", bind(\.appearance.shadowBlur), 0...40, format: "%.0f")
                    slider("垂直偏移", bind(\.appearance.shadowOffsetY), -20...20, format: "%.0f")
                    slider("浓度", bind(\.appearance.shadowAlpha), 0...1, format: "%.2f")
                }

                group("配色") {
                    HStack(spacing: 6) {
                        ForEach(Array(Self.palettePresets.enumerated()), id: \.offset) { _, preset in
                            Button(preset.name) {
                                config.appearance.colors = preset.palette
                                push()
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                    HexColorRow(title: "扇区底色 A", hex: bind(\.appearance.colors.wedgeFill))
                    HexColorRow(title: "扇区底色 B", hex: bind(\.appearance.colors.wedgeFillAlt))
                    HexColorRow(title: "扇区描边", hex: bind(\.appearance.colors.wedgeEdge))
                    HexColorRow(title: "悬停填充", hex: bind(\.appearance.colors.hoverFill))
                    HexColorRow(title: "悬停描边", hex: bind(\.appearance.colors.hoverEdge))
                    HexColorRow(title: "圆心填充", hex: bind(\.appearance.colors.hubFill))
                    HexColorRow(title: "圆心描边", hex: bind(\.appearance.colors.hubEdge))
                    HexColorRow(title: "文字", hex: bind(\.appearance.colors.text))
                    HexColorRow(title: "次级文字", hex: bind(\.appearance.colors.textDim))
                    HexColorRow(title: "弱化文字", hex: bind(\.appearance.colors.textFaint))
                    HexColorRow(title: "勾选标记", hex: bind(\.appearance.colors.accent))
                }
            }
            .padding(14)
        }
    }

    // MARK: 交互

    private var interactionTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                group("唤出") {
                    HStack {
                        Text("快捷键")
                        Spacer()
                        TextField("如 ctrl+alt+cmd+r", text: bind(\.interaction.hotkey))
                            .frame(width: 160)
                            .textFieldStyle(.roundedBorder)
                    }
                    Text("留空则沿用配置文件顶层的 hotkey。改完需重启助手生效。")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                    Toggle("按住 ⌥ 再右键唤出", isOn: bind(\.interaction.altRightClick))
                    Toggle("只在 Photoshop 里响应 ⌥右键",
                           isOn: bind(\.interaction.altRightClickPhotoshopOnly))
                    Text("不勾选 = 任何程序里都能唤出（独立使用时需要这个）"
                         + "；勾上 = 只在 PS 前台时响应。\n"
                         + "普通右键（不带 ⌥）任何情况下都不会被抢。")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                    Toggle("在鼠标位置唤出（关闭则居中）", isOn: bind(\.interaction.summonAtCursor))
                }

                group("操作") {
                    Toggle("鼠标悬停即高亮", isOn: bind(\.interaction.hoverHighlight))
                    Toggle("悬停时扇区向外弹出", isOn: bind(\.interaction.popOnHover))
                    Toggle("数字键 1-9 直选", isOn: bind(\.interaction.keyboardSelect))
                    Toggle("Esc 关闭圆环", isOn: bind(\.interaction.escapeToClose))
                }

                group("提示") {
                    Toggle("子菜单三角标", isOn: bind(\.interaction.showChildMarker))
                    Toggle("方向指示线", isOn: bind(\.interaction.showDirectionLine))
                }
            }
            .padding(14)
        }
    }

    // MARK: 内容

    private var contentTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                group("来源") {
                    Toggle("采用插件下发的扇区名称", isOn: bind(\.content.usePluginLabels))
                    Text("开启后，Photoshop 插件可以改写扇区名称；插件没下发时自动回落到下面自定义的名字。")
                        .font(.system(size: 10)).foregroundStyle(.secondary)

                    Toggle("采用插件下发的扇区动作", isOn: bind(\.content.usePluginActions))
                    Text("开启后，插件面板里配的「哪个按钮干什么」会覆盖下面的选择。"
                          + "想完全由这里说了算就关掉它。")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }

                group("扇区") {
                    Text("顺序按数值从小到大顺时针排列，从正上方开始。"
                          + "动作选「默认」时，该槽位干它本来该干的事。")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                    sectorRow("生成", \.content.sectors.generate)
                    sectorRow("参数", \.content.sectors.params)
                    sectorRow("预设", \.content.sectors.presets)
                    sectorRow("对话", \.content.sectors.chat)
                    sectorRow("读选区", \.content.sectors.readSelection)
                    sectorRow("关闭", \.content.sectors.close)
                }
            }
            .padding(14)
        }
    }

    private func sectorRow(_ title: String,
                           _ keyPath: WritableKeyPath<RingConfig, RingSectorConfig>) -> some View {
        HStack(spacing: 6) {
            Text(title).frame(width: 44, alignment: .leading)

            TextField("名称", text: bind(keyPath.appending(path: \.label)))
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 64)

            Picker("", selection: bind(keyPath.appending(path: \.action))) {
                Text("默认").tag("")
                Divider()
                ForEach(actionOptions) { option in
                    Text(option.label).tag(option.value)
                }
            }
            .labelsHidden()
            .frame(width: 118)
            .help("点击这个扇区时执行什么。「默认」= 该槽位本来的行为")

            Stepper(value: bind(keyPath.appending(path: \.order)), in: 0...99) {
                Text("序 \(config[keyPath: keyPath].order)").font(.system(size: 10))
            }
            .frame(width: 84)

            Toggle("", isOn: bind(keyPath.appending(path: \.visible)))
                .labelsHidden()
                .help("是否显示这个扇区")
        }
    }

    // MARK: 高级

    private var advancedTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                group("桥接") {
                    HStack {
                        Text("端口")
                        Spacer()
                        TextField("", value: bind(\.bridge.port), format: .number)
                            .frame(width: 90)
                            .textFieldStyle(.roundedBorder)
                    }
                    Text("改动需重启助手生效。插件侧也用的是这个端口。")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }

                group("配置文件") {
                    Text(RingConfig.configPath)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    HStack(spacing: 8) {
                        Button("在访达中显示") {
                            if !FileManager.default.fileExists(atPath: RingConfig.configPath) {
                                config.save()
                            }
                            NSWorkspace.shared.selectFile(RingConfig.configPath,
                                                          inFileViewerRootedAtPath: "")
                        }
                        Button("导出…") { exportConfig() }
                        Button("导入…") { importConfig() }
                    }
                }

                group("恢复") {
                    Button("恢复全部默认设置", role: .destructive) {
                        config = RingConfig.resetToDefaults()
                        push()
                    }
                    Text("会重写配置文件，但保留顶层的 hotkey。")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            .padding(14)
        }
    }

    private func exportConfig() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "huanmeng-ring-config.json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if let data = try? JSONEncoder().encode(config) {
            try? data.write(to: url)
        }
    }

    private func importConfig() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url,
              let data = try? Data(contentsOf: url),
              let loaded = try? JSONDecoder().decode(RingConfig.self, from: data) else { return }
        config = loaded
        push()
    }

    // MARK: 小组件

    @ViewBuilder
    private func group<Content: View>(_ title: String,
                                      @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 12, weight: .semibold))
            content()
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private func slider(_ title: String, _ value: Binding<Double>,
                        _ range: ClosedRange<Double>, format: String) -> some View {
        HStack(spacing: 8) {
            Text(title).frame(width: 96, alignment: .leading)
            Slider(value: value, in: range)
            Text(String(format: format, value.wrappedValue))
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 58, alignment: .trailing)
        }
    }

    // MARK: 配色预设

    static let palettePresets: [(name: String, palette: RingPalette)] = {
        var dark = RingPalette()

        var contrast = RingPalette()
        contrast.wedgeFill = "#1A1A1FFF"
        contrast.wedgeFillAlt = "#0D0D10FF"
        contrast.wedgeEdge = "#B0B0B8FF"
        contrast.hoverFill = "#F0F0F5FF"
        contrast.hoverEdge = "#FFFFFFFF"
        contrast.text = "#FFFFFFFF"
        contrast.hubFill = "#000000FF"
        contrast.hubEdge = "#FFFFFFFF"

        var warm = RingPalette()
        warm.wedgeFill = "#3A2E28FF"
        warm.wedgeFillAlt = "#2E241F00"
        warm.wedgeEdge = "#8A6A55FF"
        warm.hoverFill = "#D97742FF"
        warm.hoverEdge = "#FFB37AFF"
        warm.hubFill = "#2A1F1AFF"
        warm.hubEdge = "#A5744FFF"
        warm.accent = "#FFC26BFF"

        var cool = RingPalette()
        cool.wedgeFill = "#22303FFF"
        cool.wedgeFillAlt = "#1A2532FF"
        cool.wedgeEdge = "#4E6E8CFF"
        cool.hoverFill = "#3E8FD0FF"
        cool.hoverEdge = "#8FD2FFFF"
        cool.hubFill = "#16202BFF"
        cool.hubEdge = "#3E7BA8FF"
        cool.accent = "#66E0FFFF"

        var ghost = RingPalette()
        ghost.wedgeFill = "#FFFFFF26"
        ghost.wedgeFillAlt = "#FFFFFF14"
        ghost.wedgeEdge = "#FFFFFF5C"
        ghost.hoverFill = "#FFFFFFB3"
        ghost.hoverEdge = "#FFFFFFFF"
        ghost.hubFill = "#00000099"
        ghost.hubEdge = "#FFFFFF80"
        ghost.text = "#FFFFFFFF"

        _ = dark
        return [("默认", RingPalette()), ("高对比", contrast), ("暖色", warm),
                ("冷色", cool), ("半透明", ghost)]
    }()
}

// MARK: - 窗口控制器

final class PreferencesWindowController {
    private var window: NSWindow?
    private var onChange: ((RingConfig) -> Void)?

    /// 打开（或聚焦）偏好设置窗口。
    /// 每次调用都重建 SwiftUI 视图，保证显示的是当前配置 ——
    /// 配置文件可能被用户手改过，不缓存旧状态更安全。
    func show(config: RingConfig,
              pluginActions: [BridgeActionOption] = [],
              onChange: @escaping (RingConfig) -> Void) {
        self.onChange = onChange

        let view = PreferencesView(config: config, pluginActions: pluginActions) { [weak self] updated in
            self?.onChange?(updated)
        }
        let hosting = NSHostingView(rootView: view)

        if let existing = window {
            existing.contentView = hosting
            activate(existing)
            return
        }

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 640),
                           styleMask: [.titled, .closable, .miniaturizable],
                           backing: .buffered,
                           defer: false)
        win.title = "幻梦圆环 · 偏好设置"
        win.contentView = hosting
        win.isReleasedWhenClosed = false
        win.center()
        window = win
        activate(win)
    }

    /// .accessory 策略下窗口默认拿不到键盘焦点，必须显式激活。
    /// 这是项目里唯一一处 NSApp.activate —— 圆环和 Toast 都刻意不抢焦点。
    private func activate(_ win: NSWindow) {
        NSApp.activate(ignoringOtherApps: true)
        win.makeKeyAndOrderFront(nil)
    }
}
