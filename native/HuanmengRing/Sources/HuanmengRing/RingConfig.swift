// ============================================================
//  RingConfig.swift — 圆环配置模型与持久化
//
//  三层结构：
//      原始 JSON（跨平台交换格式，见 SPEC-ring-config.md）
//        → RingConfig（Codable，本文件上半部分）
//        → RingStyle（解析结果，含 NSColor，供 RingView 直接消费）
//
//  设计约束：
//  1. 颜色一律以 "#RRGGBB" / "#RRGGBBAA" 字符串存储 —— 平台中立，
//     将来的 Windows 版可以直接照抄同一份 JSON。
//  2. 所有字段都有默认值，且读取时用 decodeIfPresent 兜底：
//     配置文件缺键、只写一部分、甚至整份文件不存在，都能正常启动。
//  3. 默认值逐项等于改造前的硬编码值，不配置时外观与改造前一致。
// ============================================================

import AppKit

// MARK: - 颜色工具

extension NSColor {

    /// 从 "#RGB" / "#RRGGBB" / "#RRGGBBAA" 解析。无法解析时返回 nil，由调用方给兜底色。
    convenience init?(hexString: String) {
        var text = hexString.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if text.hasPrefix("#") { text.removeFirst() }
        // #RGB → #RRGGBB
        if text.count == 3 {
            text = text.map { "\($0)\($0)" }.joined()
        }
        guard text.count == 6 || text.count == 8,
              let value = UInt64(text, radix: 16) else { return nil }

        let hasAlpha = text.count == 8
        let r, g, b, a: UInt64
        if hasAlpha {
            r = (value >> 24) & 0xFF
            g = (value >> 16) & 0xFF
            b = (value >> 8) & 0xFF
            a = value & 0xFF
        } else {
            r = (value >> 16) & 0xFF
            g = (value >> 8) & 0xFF
            b = value & 0xFF
            a = 255
        }
        // 与改造前一致，用 calibrated 色彩空间，避免换色后整体观感偏移
        self.init(calibratedRed: CGFloat(r) / 255,
                  green: CGFloat(g) / 255,
                  blue: CGFloat(b) / 255,
                  alpha: CGFloat(a) / 255)
    }

    /// 解析失败时的兜底：返回给定色，保证绘制不会因为一个错别字整块消失
    static func fromHex(_ text: String, fallback: NSColor) -> NSColor {
        NSColor(hexString: text) ?? fallback
    }

    /// 转成 "#RRGGBBAA"，供偏好设置里的取色器回写。
    ///
    /// 必须直接读自身分量，**不能先 usingColorSpace(.sRGB)**：
    /// init?(hexString:) 是用 calibratedRed 构造的，若这里转去 sRGB 读，
    /// 每次「存盘 → 读回」颜色都会漂一点，取色器多改几次就明显偏色。
    /// 下面这个读法保证 hex → NSColor → hex 是恒等变换。
    var hexStringWithAlpha: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        // NSColor.getRed 返回 Void（失败会抛 ObjC 异常），不能用返回值判断，
        // 所以先看色彩空间模型：calibrated / sRGB / P3 都是 .rgb，可以直读。
        if colorSpace.colorSpaceModel == .rgb {
            getRed(&r, green: &g, blue: &b, alpha: &a)
        } else {
            let c = usingColorSpace(.sRGB) ?? .white
            c.getRed(&r, green: &g, blue: &b, alpha: &a)
        }
        return String(format: "#%02X%02X%02X%02X",
                      Int((r * 255).rounded()), Int((g * 255).rounded()),
                      Int((b * 255).rounded()), Int((a * 255).rounded()))
    }
}

// MARK: - 外观

struct RingPalette: Codable {
    /// 扇区底色，奇偶交替
    var wedgeFill = "#33333BF5"
    var wedgeFillAlt = "#2B2B33F5"
    /// 扇区描边
    var wedgeEdge = "#5C5C5CD9"
    /// 悬停高亮
    var hoverFill = "#4278C2FF"
    var hoverEdge = "#85BDFFFF"
    /// 圆心
    var hubFill = "#1F1F24FA"
    var hubEdge = "#4770A8FF"
    /// 文字三档
    var text = "#F0F0F0FF"
    var textDim = "#999999FF"
    var textFaint = "#6B6B6BFF"
    /// 勾选标记
    var accent = "#61E094FF"

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = RingPalette()
        wedgeFill = try c.decodeIfPresent(String.self, forKey: .wedgeFill) ?? d.wedgeFill
        wedgeFillAlt = try c.decodeIfPresent(String.self, forKey: .wedgeFillAlt) ?? d.wedgeFillAlt
        wedgeEdge = try c.decodeIfPresent(String.self, forKey: .wedgeEdge) ?? d.wedgeEdge
        hoverFill = try c.decodeIfPresent(String.self, forKey: .hoverFill) ?? d.hoverFill
        hoverEdge = try c.decodeIfPresent(String.self, forKey: .hoverEdge) ?? d.hoverEdge
        hubFill = try c.decodeIfPresent(String.self, forKey: .hubFill) ?? d.hubFill
        hubEdge = try c.decodeIfPresent(String.self, forKey: .hubEdge) ?? d.hubEdge
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? d.text
        textDim = try c.decodeIfPresent(String.self, forKey: .textDim) ?? d.textDim
        textFaint = try c.decodeIfPresent(String.self, forKey: .textFaint) ?? d.textFaint
        accent = try c.decodeIfPresent(String.self, forKey: .accent) ?? d.accent
    }
}

struct RingAppearance: Codable {
    /// 圆环窗口边长（点）。圆环半径由它推导，见 SPEC 的几何公式
    var ringSize = 340.0
    /// 环带内径 / 外径
    var bandRatio = 0.44
    /// 扇区之间的角度间隙占单块角度的比例，以及其上限（弧度）
    var gapRatio = 0.06
    var gapMax = 0.014
    /// 悬停时扇区向外弹出的距离（点）
    var popDistance = 7.0
    /// 整个圆环的不透明度
    var opacity = 1.0
    /// 禁用态扇区的不透明度
    var disabledWedgeAlpha = 0.4
    var disabledEdgeAlpha = 0.35
    /// 出现动画：从 appearScale 倍放大到 1 倍；appearStep 是每帧推进量
    var appearScale = 0.86
    var appearStep = 0.18
    /// 高亮渐变的每帧推进比例
    var hoverSpeed = 0.28
    /// 文字
    var labelFontSize = 9.5
    var labelLineHeight = 11.0
    var hubTitleFontSize = 12.0
    var hubSubFontSize = 9.0
    /// 合并轮廓投影
    var shadowEnabled = true
    var shadowBlur = 10.0
    var shadowOffsetY = 3.0
    var shadowAlpha = 0.55
    var colors = RingPalette()

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = RingAppearance()
        ringSize = try c.decodeIfPresent(Double.self, forKey: .ringSize) ?? d.ringSize
        bandRatio = try c.decodeIfPresent(Double.self, forKey: .bandRatio) ?? d.bandRatio
        gapRatio = try c.decodeIfPresent(Double.self, forKey: .gapRatio) ?? d.gapRatio
        gapMax = try c.decodeIfPresent(Double.self, forKey: .gapMax) ?? d.gapMax
        popDistance = try c.decodeIfPresent(Double.self, forKey: .popDistance) ?? d.popDistance
        opacity = try c.decodeIfPresent(Double.self, forKey: .opacity) ?? d.opacity
        disabledWedgeAlpha = try c.decodeIfPresent(Double.self, forKey: .disabledWedgeAlpha) ?? d.disabledWedgeAlpha
        disabledEdgeAlpha = try c.decodeIfPresent(Double.self, forKey: .disabledEdgeAlpha) ?? d.disabledEdgeAlpha
        appearScale = try c.decodeIfPresent(Double.self, forKey: .appearScale) ?? d.appearScale
        appearStep = try c.decodeIfPresent(Double.self, forKey: .appearStep) ?? d.appearStep
        hoverSpeed = try c.decodeIfPresent(Double.self, forKey: .hoverSpeed) ?? d.hoverSpeed
        labelFontSize = try c.decodeIfPresent(Double.self, forKey: .labelFontSize) ?? d.labelFontSize
        labelLineHeight = try c.decodeIfPresent(Double.self, forKey: .labelLineHeight) ?? d.labelLineHeight
        hubTitleFontSize = try c.decodeIfPresent(Double.self, forKey: .hubTitleFontSize) ?? d.hubTitleFontSize
        hubSubFontSize = try c.decodeIfPresent(Double.self, forKey: .hubSubFontSize) ?? d.hubSubFontSize
        shadowEnabled = try c.decodeIfPresent(Bool.self, forKey: .shadowEnabled) ?? d.shadowEnabled
        shadowBlur = try c.decodeIfPresent(Double.self, forKey: .shadowBlur) ?? d.shadowBlur
        shadowOffsetY = try c.decodeIfPresent(Double.self, forKey: .shadowOffsetY) ?? d.shadowOffsetY
        shadowAlpha = try c.decodeIfPresent(Double.self, forKey: .shadowAlpha) ?? d.shadowAlpha
        colors = try c.decodeIfPresent(RingPalette.self, forKey: .colors) ?? d.colors
    }
}

// MARK: - 交互

struct RingInteraction: Codable {
    /// 全局热键，形如 "ctrl+alt+cmd+r"；空字符串表示不改写顶层 hotkey
    var hotkey = ""
    /// 画布上按住 ⌥ 再右键唤出
    var altRightClick = true
    /// ⌥右键**只在 Photoshop 前台时**才拦截？
    ///
    /// 默认 false = 任何程序里都能用 ⌥右键唤出。
    /// 这是刻意的：助手现在是个独立软件，PS 根本没开的时候也得能唤出。
    /// （当初限制成只在 PS 里，是因为那时助手只是 PS 的遥控器。）
    ///
    /// 带 ⌥ 的右键本来就是个很冷门的组合，抢过来影响很小；
    /// **普通右键始终原样透传**，这个限制从来没变过。
    /// 真觉得被干扰了，偏好设置 → 交互 里可以勾回"只在 Photoshop 里"。
    var altRightClickPhotoshopOnly = false
    /// 鼠标移到扇区上就高亮。关掉后只有按住拖动才高亮
    var hoverHighlight = true
    /// 数字键 1-9 直选
    var keyboardSelect = true
    /// Esc 关闭整个圆环
    var escapeToClose = true
    /// true = 在鼠标位置唤出；false = 屏幕中心
    var summonAtCursor = true
    /// 鼠标滑过就吸附到圆心？false 时需要在圆心点击才返回上一级
    var showChildMarker = true
    /// 半径方向指示线
    var showDirectionLine = true
    /// 悬停时是否让扇区向外弹出
    var popOnHover = true

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = RingInteraction()
        hotkey = try c.decodeIfPresent(String.self, forKey: .hotkey) ?? d.hotkey
        altRightClick = try c.decodeIfPresent(Bool.self, forKey: .altRightClick) ?? d.altRightClick
        altRightClickPhotoshopOnly = try c.decodeIfPresent(Bool.self, forKey: .altRightClickPhotoshopOnly)
            ?? d.altRightClickPhotoshopOnly
        hoverHighlight = try c.decodeIfPresent(Bool.self, forKey: .hoverHighlight) ?? d.hoverHighlight
        keyboardSelect = try c.decodeIfPresent(Bool.self, forKey: .keyboardSelect) ?? d.keyboardSelect
        escapeToClose = try c.decodeIfPresent(Bool.self, forKey: .escapeToClose) ?? d.escapeToClose
        summonAtCursor = try c.decodeIfPresent(Bool.self, forKey: .summonAtCursor) ?? d.summonAtCursor
        showChildMarker = try c.decodeIfPresent(Bool.self, forKey: .showChildMarker) ?? d.showChildMarker
        showDirectionLine = try c.decodeIfPresent(Bool.self, forKey: .showDirectionLine) ?? d.showDirectionLine
        popOnHover = try c.decodeIfPresent(Bool.self, forKey: .popOnHover) ?? d.popOnHover
    }
}

// MARK: - 内容

struct RingSectorConfig: Codable {
    var label: String
    var visible: Bool
    /// 显示顺序，越小越靠前，从正上方顺时针排
    var order: Int
    /// 这个扇区被点了以后干什么。
    /// 留空 = 用该槽位的内置默认动作（见 MenuBuilder.defaultActions），
    /// 也就是「没配置过时行为和改造前完全一样」。
    /// 插件下发同名动作时会覆盖这里 —— 优先级和标签一致。
    var action: String

    init(label: String, visible: Bool = true, order: Int, action: String = "") {
        self.label = label
        self.visible = visible
        self.order = order
        self.action = action
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        visible = try c.decodeIfPresent(Bool.self, forKey: .visible) ?? true
        order = try c.decodeIfPresent(Int.self, forKey: .order) ?? 99
        // 老配置文件没有这个键，缺了要能正常启动
        action = try c.decodeIfPresent(String.self, forKey: .action) ?? ""
    }
}

struct RingSectors: Codable {
    var generate = RingSectorConfig(label: "生成", order: 0)
    var params = RingSectorConfig(label: "参数", order: 1)
    var presets = RingSectorConfig(label: "预设", order: 2)
    var chat = RingSectorConfig(label: "对话", order: 3)
    var readSelection = RingSectorConfig(label: "读选区", order: 4)
    var close = RingSectorConfig(label: "关闭", order: 5)

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = RingSectors()
        generate = try c.decodeIfPresent(RingSectorConfig.self, forKey: .generate) ?? d.generate
        params = try c.decodeIfPresent(RingSectorConfig.self, forKey: .params) ?? d.params
        presets = try c.decodeIfPresent(RingSectorConfig.self, forKey: .presets) ?? d.presets
        chat = try c.decodeIfPresent(RingSectorConfig.self, forKey: .chat) ?? d.chat
        readSelection = try c.decodeIfPresent(RingSectorConfig.self, forKey: .readSelection) ?? d.readSelection
        close = try c.decodeIfPresent(RingSectorConfig.self, forKey: .close) ?? d.close
    }

    /// 按稳定 id 取配置
    func config(for id: String) -> RingSectorConfig {
        switch id {
        case "generate": return generate
        case "params": return params
        case "presets": return presets
        case "chat": return chat
        case "readSelection": return readSelection
        case "close": return close
        default: return RingSectorConfig(label: "", visible: false, order: 99)
        }
    }

    /// 扇区稳定 id → 配置。顺序由 RingSectorConfig.order 决定，不依赖字典顺序。
    var all: [(id: String, config: RingSectorConfig)] {
        [("generate", generate), ("params", params), ("presets", presets),
         ("chat", chat), ("readSelection", readSelection), ("close", close)]
            .filter { $0.1.visible }
            .sorted { $0.1.order < $1.1.order }
    }
}

struct RingContent: Codable {
    /// 采用插件下发的扇区标签。插件没下发时自动回落到下面的自定义标签。
    var usePluginLabels = true
    /// 采用插件下发的扇区动作。关掉则永远用下面自定义的动作 / 内置默认。
    /// 和 usePluginLabels 是两个独立的开关 —— 你可能想用插件的名字
    /// 但自己决定点了干什么，反之亦然。
    var usePluginActions = true
    var sectors = RingSectors()

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = RingContent()
        usePluginLabels = try c.decodeIfPresent(Bool.self, forKey: .usePluginLabels) ?? d.usePluginLabels
        // 老配置文件没有这个键，缺了要按默认（开）走
        usePluginActions = try c.decodeIfPresent(Bool.self, forKey: .usePluginActions) ?? d.usePluginActions
        sectors = try c.decodeIfPresent(RingSectors.self, forKey: .sectors) ?? d.sectors
    }
}

// MARK: - 桥接

struct RingBridge: Codable {
    var port = 8799
    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        port = try c.decodeIfPresent(Int.self, forKey: .port) ?? RingBridge().port
    }
}

// MARK: - API（助手独立干活时用的）

/// 助手自己的接口配置。
///
/// 为什么助手要单独存一份：不连插件的时候它得**自己会干活** ——
/// 自己提问、自己出图。插件那份配置存在 PS 的 localStorage 里，
/// 助手看不见也读不到，所以只能自己有一份。
/// 连着的时候可以用偏好设置里的「从插件导入」一键拉过来，省得填两遍。
///
/// ⚠️ 里面有明文 API 密钥。文件权限设成 600（只有本人可读）——
/// 和插件把它存在 localStorage 里是同一性质，但至少不要让别人顺手看到。
struct RingAPI: Codable {
    var grsApiKey = ""
    /// "domestic" = grsai.dakka.com.cn，"overseas" = grsaiapi.com
    var grsRegion = "domestic"
    /// 非空时覆盖 region 推导出来的地址（自建网关用）
    var grsBaseUrl = ""

    var imgModel = "nano-banana-fast"
    /// 1K / 2K / 4K
    var imageSize = "1K"
    /// auto 或 1:1 / 4:3 / 16:9…
    var aspectRatio = "auto"
    /// 一次出几张（1-4）
    var imageCount = 1

    var chatModel = "grs/gpt-5.5"
    /// 圆环上列的对话模型。插件连着时会用插件那份覆盖（导入配置时一起拉），
    /// 没有插件时就用这份默认的 —— 不然「对话 → 模型」是空的、点不动。
    var chatModels = ["grs/gpt-5.5", "grs/gemini-3-pro", "grs/gemini-2.5-pro"]
    /// 快捷提问。格式 [[label, prompt], …]。
    /// 同样：插件连着时从插件导入，没插件时用这份内置的。
    var chatQuestions: [[String]] = []

    /// 出图的提示词被谁加料。留空就原样发出去 ——
    /// 插件里那套正/负面系统提示词是给修图场景调的，独立出图未必合适。
    var systemPrompt = ""

    /// 出图存到哪。留空 = ~/Pictures/幻梦AI
    var outputFolder = ""

    /// 内置的快捷提问。和插件里那六条对齐 —— 用户在助手侧和插件侧
    /// 看到的应该是同一套问题。要改就改配置文件（或从插件导入覆盖）。
    static let builtinQuestions: [[String]] = [
        ["调色思路", "给我一个适合这张照片的调色思路，按步骤说明每一步的目的和大致参数范围。"],
        ["光影诊断", "分析这张照片的光影问题，指出需要调整的局部区域和调整方向。"],
        ["人像精修", "针对这张人像列出精修步骤（磨皮、液化、肤色统一、眼神光），说明每一步的力度。"],
        ["构图建议", "从构图角度评价这张照片，指出可以裁剪或调整的地方。"],
        ["转黑白", "如果要把这张照片转成黑白，说明通道混合器各通道的配比和对比度设置建议。"],
        ["写提示词", "根据我接下来描述的画面，写一段用于 AI 生图的中文提示词。"],
    ]

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = RingAPI()
        grsApiKey = try c.decodeIfPresent(String.self, forKey: .grsApiKey) ?? d.grsApiKey
        grsRegion = try c.decodeIfPresent(String.self, forKey: .grsRegion) ?? d.grsRegion
        grsBaseUrl = try c.decodeIfPresent(String.self, forKey: .grsBaseUrl) ?? d.grsBaseUrl
        imgModel = try c.decodeIfPresent(String.self, forKey: .imgModel) ?? d.imgModel
        imageSize = try c.decodeIfPresent(String.self, forKey: .imageSize) ?? d.imageSize
        aspectRatio = try c.decodeIfPresent(String.self, forKey: .aspectRatio) ?? d.aspectRatio
        imageCount = try c.decodeIfPresent(Int.self, forKey: .imageCount) ?? d.imageCount
        chatModel = try c.decodeIfPresent(String.self, forKey: .chatModel) ?? d.chatModel
        chatModels = try c.decodeIfPresent([String].self, forKey: .chatModels) ?? d.chatModels
        chatQuestions = try c.decodeIfPresent([[String]].self, forKey: .chatQuestions) ?? d.chatQuestions
        systemPrompt = try c.decodeIfPresent(String.self, forKey: .systemPrompt) ?? d.systemPrompt
        outputFolder = try c.decodeIfPresent(String.self, forKey: .outputFolder) ?? d.outputFolder
    }

    /// 真正请求的地址。显式填了就用填的，否则按区域推。
    var resolvedBaseUrl: String {
        let manual = grsBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        if !manual.isEmpty { return manual }
        return grsRegion == "overseas" ? "https://grsaiapi.com" : "https://grsai.dakka.com.cn"
    }

    var resolvedOutputFolder: String {
        let manual = outputFolder.trimmingCharacters(in: .whitespacesAndNewlines)
        if !manual.isEmpty { return NSString(string: manual).expandingTildeInPath }
        return NSString(string: "~/Pictures/幻梦AI").expandingTildeInPath
    }

    /// 能不能独立干活（有没有密钥）
    var isUsable: Bool {
        !grsApiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private enum CodingKeys: String, CodingKey {
        case grsApiKey, grsRegion, grsBaseUrl, imgModel, imageSize,
             aspectRatio, imageCount, chatModel, chatModels, chatQuestions,
             systemPrompt, outputFolder
    }
}

// MARK: - 根配置

struct RingConfig: Codable {
    /// 配置结构版本，将来做迁移用
    var version = 1
    var appearance = RingAppearance()
    var interaction = RingInteraction()
    var content = RingContent()
    var bridge = RingBridge()
    var api = RingAPI()

    /// 顶层 hotkey（兼容旧格式）。只在 interaction.hotkey 为空时生效。
    var legacyHotkey = ""

    /// 生效的热键串
    var effectiveHotkey: String {
        interaction.hotkey.isEmpty ? legacyHotkey : interaction.hotkey
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = RingConfig()
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? d.version
        appearance = try c.decodeIfPresent(RingAppearance.self, forKey: .appearance) ?? d.appearance
        interaction = try c.decodeIfPresent(RingInteraction.self, forKey: .interaction) ?? d.interaction
        content = try c.decodeIfPresent(RingContent.self, forKey: .content) ?? d.content
        bridge = try c.decodeIfPresent(RingBridge.self, forKey: .bridge) ?? d.bridge
        api = try c.decodeIfPresent(RingAPI.self, forKey: .api) ?? d.api
    }

    private enum CodingKeys: String, CodingKey {
        case version, appearance, interaction, content, bridge, api
    }

    // MARK: 持久化

    static let configPath: String = NSString(string: "~/.huanmeng-ring.json").expandingTildeInPath

    /// 读取整份文件（含顶层 hotkey）。读失败返回空字典而不是抛错 ——
    /// 配置文件损坏不该让助手起不来。
    private static func readRoot() -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: configPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return json
    }

    static func load() -> RingConfig {
        let root = readRoot()
        var config = RingConfig()
        if let raw = root["config"] as? [String: Any],
           let data = try? JSONSerialization.data(withJSONObject: raw),
           let decoded = try? JSONDecoder().decode(RingConfig.self, from: data) {
            config = decoded
        }
        config.legacyHotkey = (root["hotkey"] as? String) ?? ""
        return config
    }

    /// 写回磁盘。保留文件里其它未知的键，避免把用户手写的注释性内容抹掉。
    func save() {
        var root = Self.readRoot()
        if let data = try? JSONEncoder().encode(self),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            root["config"] = object
        }
        // 顶层 hotkey 保持同步：老版本 build 只认这个键
        let hotkey = effectiveHotkey
        if !hotkey.isEmpty { root["hotkey"] = hotkey }

        guard let out = try? JSONSerialization.data(withJSONObject: root,
                                                    options: [.prettyPrinted, .sortedKeys]) else { return }
        do {
            try out.write(to: URL(fileURLWithPath: Self.configPath))
            // 里面有明文 API 密钥，别让同机器的其他账号读到。
            // 先写再改权限（写的时候文件可能还不存在，attachAttributes 会失败）。
            try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                                   ofItemAtPath: Self.configPath)
        } catch {
            NSLog("[幻梦圆环] 配置写入失败：\(error.localizedDescription)")
        }
    }

    /// 恢复默认：整份文件重写为默认配置，但保留顶层的 hotkey
    static func resetToDefaults() -> RingConfig {
        var config = RingConfig()
        config.legacyHotkey = (readRoot()["hotkey"] as? String) ?? ""
        config.save()
        return config
    }
}

// MARK: - 解析结果（RingView 直接消费）

/// RingConfig 的解析结果。颜色与数值在这里一次性转好，
/// 绘制时不再做十六进制解析 —— draw 跑在 60fps 的显示周期里。
struct RingStyle {
    var wedgeFill: NSColor
    var wedgeFillAlt: NSColor
    var wedgeEdge: NSColor
    var hoverFill: NSColor
    var hoverEdge: NSColor
    var hubFill: NSColor
    var hubEdge: NSColor
    var text: NSColor
    var textDim: NSColor
    var textFaint: NSColor
    var accent: NSColor

    var bandRatio: CGFloat
    var gapRatio: CGFloat
    var gapMax: CGFloat
    var popDistance: CGFloat
    var opacity: CGFloat
    var disabledWedgeAlpha: CGFloat
    var disabledEdgeAlpha: CGFloat
    var appearScale: CGFloat
    var appearStep: CGFloat
    var hoverSpeed: CGFloat
    var labelFontSize: CGFloat
    var labelLineHeight: CGFloat
    var hubTitleFontSize: CGFloat
    var hubSubFontSize: CGFloat

    var shadowEnabled: Bool
    var shadowBlur: CGFloat
    var shadowOffsetY: CGFloat
    var shadowAlpha: CGFloat

    var showChildMarker: Bool
    var showDirectionLine: Bool
    var popOnHover: Bool

    static let `default` = RingStyle(RingConfig())

    init(_ config: RingConfig) {
        let a = config.appearance
        let c = a.colors
        // 配色写错时回退到「该字段的默认色」，不是统一回退成白色。
        // 回退成白色的话，一个取色器里手滑输错就会让整块扇区变白，
        // 视觉上比保持原样难排查得多。
        let d = RingPalette()
        func resolve(_ value: String, _ fallbackHex: String) -> NSColor {
            NSColor(hexString: value) ?? NSColor(hexString: fallbackHex) ?? .white
        }
        wedgeFill = resolve(c.wedgeFill, d.wedgeFill)
        wedgeFillAlt = resolve(c.wedgeFillAlt, d.wedgeFillAlt)
        wedgeEdge = resolve(c.wedgeEdge, d.wedgeEdge)
        hoverFill = resolve(c.hoverFill, d.hoverFill)
        hoverEdge = resolve(c.hoverEdge, d.hoverEdge)
        hubFill = resolve(c.hubFill, d.hubFill)
        hubEdge = resolve(c.hubEdge, d.hubEdge)
        text = resolve(c.text, d.text)
        textDim = resolve(c.textDim, d.textDim)
        textFaint = resolve(c.textFaint, d.textFaint)
        accent = resolve(c.accent, d.accent)

        bandRatio = CGFloat(min(max(a.bandRatio, 0.15), 0.85))
        gapRatio = CGFloat(min(max(a.gapRatio, 0), 0.5))
        gapMax = CGFloat(max(a.gapMax, 0))
        popDistance = CGFloat(min(max(a.popDistance, 0), 40))
        opacity = CGFloat(min(max(a.opacity, 0.1), 1))
        disabledWedgeAlpha = CGFloat(min(max(a.disabledWedgeAlpha, 0.05), 1))
        disabledEdgeAlpha = CGFloat(min(max(a.disabledEdgeAlpha, 0.05), 1))
        appearScale = CGFloat(min(max(a.appearScale, 0.3), 1))
        appearStep = CGFloat(min(max(a.appearStep, 0.02), 1))
        hoverSpeed = CGFloat(min(max(a.hoverSpeed, 0.02), 1))
        labelFontSize = CGFloat(min(max(a.labelFontSize, 6), 24))
        labelLineHeight = CGFloat(min(max(a.labelLineHeight, 7), 30))
        hubTitleFontSize = CGFloat(min(max(a.hubTitleFontSize, 7), 28))
        hubSubFontSize = CGFloat(min(max(a.hubSubFontSize, 6), 22))

        shadowEnabled = a.shadowEnabled
        shadowBlur = CGFloat(min(max(a.shadowBlur, 0), 40))
        shadowOffsetY = CGFloat(min(max(a.shadowOffsetY, -20), 20))
        shadowAlpha = CGFloat(min(max(a.shadowAlpha, 0), 1))

        showChildMarker = config.interaction.showChildMarker
        showDirectionLine = config.interaction.showDirectionLine
        popOnHover = config.interaction.popOnHover
    }
}
