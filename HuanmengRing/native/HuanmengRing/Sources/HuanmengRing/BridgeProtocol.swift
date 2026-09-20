// ============================================================
//  BridgeProtocol.swift — 与 UXP 插件的消息协议 + 圆环菜单构建
//
//  插件是 WebSocket 客户端，本程序是服务端。
//  插件连上后推一条 state，之后每次参数变化再推一条。
//  圆环只负责显示和选择，所有真实动作都由插件执行。
// ============================================================

import Foundation

// MARK: - 插件上报的状态

/// 一个下拉选项。合并后参数直接镜像主插件的 DOM 控件，
/// 所以选项也是「值 + 显示文本」的原样搬运。
struct BridgeOption: Decodable {
    let value: String
    let text: String?
}

struct BridgePresetItem: Decodable {
    let name: String
    let prompt: String?
}

struct BridgePresetGroup: Decodable {
    let category: String
    let items: [BridgePresetItem]
}

struct BridgeParams: Decodable {
    let model: String?
    let resolution: String?
    let count: Int?
}

struct BridgeDocument: Decodable {
    let open: Bool?
    let name: String?
    let hasSelection: Bool?
    let selectionWidth: Int?
    let selectionHeight: Int?
}

struct BridgeOptions: Decodable {
    let model: [BridgeOption]?
    let resolution: [BridgeOption]?
    let count: [Int]?
}

/// 插件下发的槽位定义：这个槽位叫什么、点了干什么。
///
/// 槽位 id 是稳定标识（generate / params / presets / chat / readSelection / close），
/// 不能改；action 才是「点了干什么」，由用户在插件面板里配置。
struct BridgeSector: Decodable {
    let id: String
    let action: String?
    let label: String?
}

/// 插件告知「它能执行哪些动作」，用来填偏好设置里的动作下拉框。
/// 动作清单的唯一定义在插件侧（ring-bridge.js 的 ACTIONS），
/// 圆环不该自己再维护一份 —— 那样迟早会对不上。
struct BridgeActionOption: Decodable {
    let value: String
    let label: String?
    let hint: String?
}

/// 一条快捷提问。标题显示在扇区里，prompt 才是真正发出去的内容。
struct BridgeChatQuestion: Decodable {
    let label: String
    let prompt: String?
}

/// 对话状态。圆环上的「对话」子菜单全靠它填：
/// 模型列表、快捷提问、以及有没有回复可看。
struct BridgeChat: Decodable {
    let model: String?
    let models: [BridgeOption]?
    let questions: [BridgeChatQuestion]?
    let busy: Bool?
    let hasReply: Bool?
    let lastQuestion: String?
    /// 插件只发截断版（state 每几秒推一次，全文塞进去是浪费）。
    /// 完整回复走 type=chat 的推送，助手那边单独留一份。
    let lastReply: String?
}

struct BridgeStatePayload: Decodable {
    let document: BridgeDocument?
    let params: BridgeParams?
    let options: BridgeOptions?
    let presets: [BridgePresetGroup]?
    let chat: BridgeChat?
    /// 旧的扇区名称通道，键是稳定 id。仍然支持 —— 老版本插件只推这个。
    let labels: [String: String]?
    /// 新的槽位表：每个槽位的动作 + 名称
    let sectors: [BridgeSector]?
    /// 插件支持的动作清单
    let actions: [BridgeActionOption]?
}

/// 程序内使用的可变状态快照
struct RingState {
    var documentOpen = false
    var documentName = ""
    var hasSelection = false
    var selectionWidth = 0
    var selectionHeight = 0

    var model = ""
    var resolution = "auto"
    var count = 1

    var modelOptions: [BridgeOption] = []
    var resolutionOptions: [BridgeOption] = []
    var countOptions: [Int] = [1, 2, 3, 4]
    var presets: [BridgePresetGroup] = []
    /// 插件下发的扇区名称。插件不推这个字段时保持为空，不影响任何现有行为。
    var labels: [String: String] = [:]
    /// 插件下发的槽位动作，键是槽位 id
    var sectorActions: [String: String] = [:]
    /// 插件支持的动作清单（value / label / hint），用来填偏好设置的下拉框
    var pluginActions: [BridgeActionOption] = []

    // 对话
    var chatModel = ""
    var chatModels: [BridgeOption] = []
    var chatQuestions: [BridgeChatQuestion] = []
    var chatBusy = false
    var chatHasReply = false
    var chatLastQuestion = ""
    var chatLastReply = ""

    /// 独立模式能不能干活（助手自己配了接口密钥）。
    /// 由 AppDelegate 从配置里填 —— 菜单得知道「没插件时点生成会发生什么」。
    var standaloneReady = false
    /// 上次当参考图的那张图叫什么（显示在「用上次的图」那一项上）
    var lastImageName = ""

    var connected = false

    mutating func apply(_ payload: BridgeStatePayload) {
        if let doc = payload.document {
            documentOpen = doc.open ?? false
            documentName = doc.name ?? ""
            hasSelection = doc.hasSelection ?? false
            selectionWidth = doc.selectionWidth ?? 0
            selectionHeight = doc.selectionHeight ?? 0
        }
        if let params = payload.params {
            if let value = params.model { model = value }
            if let value = params.resolution { resolution = value }
            if let value = params.count { count = value }
        }
        if let options = payload.options {
            if let value = options.model, !value.isEmpty { modelOptions = value }
            if let value = options.resolution, !value.isEmpty { resolutionOptions = value }
            if let value = options.count, !value.isEmpty { countOptions = value }
        }
        if let groups = payload.presets { presets = groups }

        if let chat = payload.chat {
            if let value = chat.model { chatModel = value }
            if let value = chat.models, !value.isEmpty { chatModels = value }
            if let value = chat.questions { chatQuestions = value }
            if let value = chat.busy { chatBusy = value }
            if let value = chat.hasReply { chatHasReply = value }
            if let value = chat.lastQuestion { chatLastQuestion = value }
            if let value = chat.lastReply { chatLastReply = value }
        }
        // labels 未下发时保留上一次的值：插件可能只在名称变化时才推，
        // 每帧都清空会导致名称闪回默认值。
        if let incoming = payload.labels { labels = incoming }

        // 槽位表：动作和名称一起下发。
        // 同样「没推就保留上一次」—— 插件可能只在改动时才推这一项。
        if let incoming = payload.sectors {
            var actions: [String: String] = [:]
            var names: [String: String] = [:]
            for sector in incoming {
                if let action = sector.action, !action.isEmpty { actions[sector.id] = action }
                if let label = sector.label, !label.isEmpty { names[sector.id] = label }
            }
            if !actions.isEmpty { sectorActions = actions }
            if !names.isEmpty { labels = names }
        }
        // 动作清单整体替换：它是插件的完整能力列表，不存在「只推一部分」
        if let incoming = payload.actions { pluginActions = incoming }
    }

    /// 用**助手自己那份配置**填满菜单要用的数据。
    ///
    /// 插件的 state 是插件推来的；插件不在时得有人填，否则模型、预设、
    /// 快捷提问全是空的 —— 那几格就会变灰。
    ///
    /// 放在这里而不是 AppDelegate 里，是为了让 `--dump-menu --offline`
    /// 走同一套逻辑：调试工具显示的东西必须和真实行为一致，
    /// 否则它就是在骗人（之前吃过这个亏）。
    mutating func fillStandalone(api: RingAPI,
                                 presets: [PresetItem],
                                 hasReply: Bool,
                                 lastReply: String) {
        model = api.imgModel
        resolution = api.imageSize
        count = api.imageCount
        modelOptions = RingState.imageModelOptions
        resolutionOptions = [BridgeOption(value: "1K", text: "1K"),
                             BridgeOption(value: "2K", text: "2K"),
                             BridgeOption(value: "4K", text: "4K")]
        countOptions = [1, 2, 3, 4]

        chatModel = api.chatModel
        chatModels = (api.chatModels.isEmpty ? [api.chatModel] : api.chatModels)
            .map { BridgeOption(value: $0, text: $0) }

        let questions = api.chatQuestions.isEmpty ? RingAPI.builtinQuestions : api.chatQuestions
        chatQuestions = questions.compactMap { pair in
            guard pair.count >= 2, !pair[1].isEmpty else { return nil }
            let label = pair[0].isEmpty ? String(pair[1].prefix(5)) : pair[0]
            return BridgeChatQuestion(label: label, prompt: pair[1])
        }
        chatHasReply = hasReply
        chatLastReply = lastReply

        // 预设按分类分组，顺序按首次出现（和插件那边一致）
        var order: [String] = []
        var buckets: [String: [BridgePresetItem]] = [:]
        for item in presets {
            if buckets[item.category] == nil {
                buckets[item.category] = []
                order.append(item.category)
            }
            buckets[item.category]?.append(BridgePresetItem(name: item.name, prompt: item.prompt))
        }
        self.presets = order.map { BridgePresetGroup(category: $0, items: buckets[$0] ?? []) }
    }

    /// 可选图像模型。**照抄主插件的 GRS 型号表**（index.js 的
    /// GRS_NANO_BANANA_MODELS / GRS_GPT_IMAGE_MODELS）—— 助手侧没有别的来源。
    /// 插件加了新型号而这里没跟上时，用户可以直接改配置里的 imgModel。
    static let imageModelOptions: [BridgeOption] = [
        "nano-banana-fast", "nano-banana", "nano-banana-2", "nano-banana-2-cl",
        "nano-banana-2-4k-cl", "nano-banana-pro", "nano-banana-pro-vt",
        "nano-banana-pro-cl", "nano-banana-pro-vip", "nano-banana-pro-4k-vip",
        "gpt-image-1", "gpt-image-1-mini",
    ].map { BridgeOption(value: $0, text: $0) }

    /// 圆环上显示的一行摘要，放在菜单栏提示里
    var summary: String {
        guard connected else { return "未连接插件" }
        var parts: [String] = []
        parts.append(documentOpen ? documentName : "无文档")
        if hasSelection { parts.append("选区 \(selectionWidth)×\(selectionHeight)") }
        if !model.isEmpty { parts.append(model) }
        return parts.joined(separator: " · ")
    }
}

// MARK: - 菜单构建

enum MenuBuilder {

    /// 模型名按兄弟项公共前缀缩写，和 UXP 版一致：
    /// nano-banana-fast / -2 / -pro 全写出来扇区里根本分不清。
    static func shortLabels(_ names: [String]) -> [String] {
        guard names.count > 1 else { return names }
        var prefix = names[0]
        for name in names {
            var index = 0
            let a = Array(prefix), b = Array(name)
            while index < a.count && index < b.count && a[index] == b[index] { index += 1 }
            prefix = String(a.prefix(index))
        }
        guard !prefix.isEmpty else { return names }

        let separators = Set("-_. ")
        let onBoundary = names.allSatisfy { name in
            name.count == prefix.count || separators.contains(Array(name)[prefix.count])
        }
        if !onBoundary {
            if let cut = prefix.lastIndex(where: { separators.contains($0) }) {
                prefix = String(prefix[..<cut])
            } else {
                prefix = ""
            }
        }
        guard !prefix.isEmpty else { return names }

        return names.map { name in
            var short = String(name.dropFirst(prefix.count))
            while let first = short.first, separators.contains(first) { short.removeFirst() }
            return short.isEmpty ? name : short
        }
    }

    /// 六个扇区的稳定 id 与内置默认名。
    /// id 是插件下发标签时的键，也是偏好设置里做重命名/排序/显隐的键 ——
    /// 不要改，改了会让已存的配置失效。
    static let defaultLabels: [String: String] = [
        "generate": "生成", "params": "参数", "presets": "预设",
        "chat": "对话", "readSelection": "读选区", "close": "关闭"
    ]

    /// 扇区最终显示的名字。优先级：
    ///   插件下发（需在偏好设置里开启）> 用户自定义 > 内置默认
    static func resolvedLabel(_ id: String, config: RingConfig, state: RingState) -> String {
        if config.content.usePluginLabels,
           let fromPlugin = state.labels[id], !fromPlugin.isEmpty {
            return fromPlugin
        }
        let custom = config.content.sectors.config(for: id).label
        return custom.isEmpty ? (defaultLabels[id] ?? id) : custom
    }

    /// 每个槽位的内置默认动作。没配置过时用它，也就是说
    /// 「不配置时行为和改造前完全一样」。
    /// 值必须和插件侧 ring-bridge.js 的 DEFAULT_ACTIONS 保持一致。
    ///
    /// 注意 chat 槽位对应的是 openChat 指令（不是 "chat"）——
    /// 后缀不一致是历史原因，别顺手「统一」掉，那是协议，两边都得改。
    static let defaultActions: [String: String] = [
        "generate": "generate",
        "params": "params",
        "presets": "presets",
        // 对话从「切到面板的对话页」升级成圆环上直接展开的子菜单。
        // 插件侧 DEFAULT_ACTIONS 必须同步改成 chatMenu，否则
        // 「采用插件下发的扇区动作」一开就会被打回 openChat。
        "chat": "chatMenu",
        "readSelection": "readSelection",
        "close": "close"
    ]

    /// 扇区最终执行的动作。优先级和标签完全一致：
    ///   插件下发（需在偏好设置里开启）> 用户自定义 > 内置默认
    static func resolvedAction(_ id: String, config: RingConfig, state: RingState) -> String {
        if config.content.usePluginActions,
           let fromPlugin = state.sectorActions[id], !fromPlugin.isEmpty {
            return fromPlugin
        }
        let custom = config.content.sectors.config(for: id).action
        return custom.isEmpty ? (defaultActions[id] ?? id) : custom
    }

    /// 按动作造一个扇区。
    ///
    /// 这是整个改造的核心：槽位不再写死行为，而是看它被指派了什么动作。
    /// params / presets 要展开子菜单、close 是圆环本地行为，这三个由圆环自己处理；
    /// **其余动作一律当命令转发给插件** —— 圆环不需要知道 "tab:gallery" 是什么意思。
    /// 这样插件以后加新动作，助手一行都不用改。
    private static func segment(for action: String, state: RingState) -> RingSegment {
        switch action {
        case "generate":
            // 插件在：一键出图，和原来一样
            if state.connected {
                return RingSegment(label: "", hint: "按当前参数出图",
                                   action: .command("generate"))
            }
            // 插件不在：助手自己出图。这里**不能再写成 disabled: !connected** ——
            // 那样独立模式下这一格是灰的，点不动，等于把独立出图整个藏起来了
            // （之前就是这么错的：功能写了，但只能从命令行跑到）。
            guard state.standaloneReady else {
                return RingSegment(label: "", hint: "没插件也没配密钥", disabled: true)
            }
            return RingSegment(label: "", hint: "选图片来源",
                               children: standaloneGenerateSegments(state: state))

        case "params":
            // 插件不在时用助手自己那份配置 —— 参数在两种模式下是同一件事，
            // 不该因为「谁在干活」而变成灰的
            return RingSegment(label: "",
                               hint: state.model.isEmpty ? "模型/尺寸/张数" : state.model,
                               children: parameterSegments(state: state),
                               disabled: !state.connected && !state.standaloneReady)

        case "presets":
            // 预设不是插件专有的 —— 助手自己也有一份（PresetStore），
            // 所以这里不能写死 disabled: !connected
            return RingSegment(label: "",
                               hint: state.presets.isEmpty ? "未加载" : "\(state.presets.count) 个分类",
                               children: presetCategorySegments(state: state),
                               disabled: state.presets.isEmpty)

        // 对话子菜单：模型、快捷提问、打字提问全在这儿。
        // 内容由插件下发（模型列表和快捷提问都来自面板设置），
        // 主插件的对话流程本来就会把回复记进聊天记录，这里不另起一套。
        case "chatMenu":
            // 对话也不是插件专有的：没插件时助手自己调接口，
            // 模型和快捷提问来自 config.api。所以这里同样不能只看 connected。
            return RingSegment(label: "",
                               hint: state.chatBusy
                                   ? "正在等回复…"
                                   : (state.chatModel.isEmpty ? "模型 / 提问 / 打字" : state.chatModel),
                               children: chatSegments(state: state),
                               disabled: !state.connected && !state.standaloneReady)

        case "readSelection":
            if state.connected {
                return RingSegment(label: "",
                                   hint: state.hasSelection ? "\(state.selectionWidth)×\(state.selectionHeight)" : "整图",
                                   disabled: !state.documentOpen,
                                   action: .command("readSelection"))
            }
            // 没插件时没有「选区」可读 —— 但"把一张图弄进来当输入"这件事是一样的，
            // 只是来源从 PS 选区换成了文件/截图。同一格，换个来源。
            guard state.standaloneReady else {
                return RingSegment(label: "", hint: "没插件也没配密钥", disabled: true)
            }
            return RingSegment(label: "", hint: "选一张图当参考",
                               children: [
                                   RingSegment(label: "导入图片", hint: "选一个文件",
                                               action: .local(.importImage)),
                                   RingSegment(label: "截屏", hint: "等你截图后自动收",
                                               action: .local(.screenshot)),
                               ])

        // 圆环本地就把自己关了，不会发到插件
        case "close":
            return RingSegment(label: "", hint: "或按 Esc", action: .closeRing)

        default:
            return RingSegment(label: "",
                               hint: actionHint(action, state: state),
                               disabled: !state.connected,
                               action: .command(action))
        }
    }

    /// 动作的说明文字。插件下发过就用它的，没下发就留空 —— 不自己编词。
    private static func actionHint(_ action: String, state: RingState) -> String {
        state.pluginActions.first { $0.value == action }?.hint ?? ""
    }

    static func rootLevel(state: RingState, config: RingConfig = RingConfig()) -> RingLevel {
        // 先按配置的顺序/显隐把槽位拼出来，动作和标签再逐项解析 ——
        // 三个来源（插件下发 / 用户自定义 / 内置默认）各自只有一处判定逻辑。
        //
        // 不再有「回写」块：主插件的生成流程本来就会自动把结果放回文档，
        // 单独再给一个回写入口只会让人以为要手动点两次。
        var segments: [RingSegment] = []
        for entry in config.content.sectors.all {
            let action = resolvedAction(entry.id, config: config, state: state)
            var segment = segment(for: action, state: state)
            segment.label = resolvedLabel(entry.id, config: config, state: state)
            segments.append(segment)
        }

        // 兜底：用户可能把六个扇区全关了。空菜单会让圆环整个画不出来
        // （RingView.draw 在 segments 为空时直接 return），看起来像助手挂了。
        if segments.isEmpty {
            // 按内置顺序恢复，不能遍历字典 —— 字典顺序是随机的，
            // 恢复出来的扇区排列每次都不一样
            for id in ["generate", "params", "presets", "chat", "readSelection", "close"] {
                var segment = segment(for: defaultActions[id] ?? id, state: state)
                segment.label = defaultLabels[id] ?? id
                segments.append(segment)
            }
        }

        return RingLevel(title: "圆环", segments: segments)
    }

    /// 参数直接镜像主插件的下拉控件：选项和当前值都是从那边搬过来的，
    /// 所以圆环上看到的永远和面板一致，不会各说各话。
    private static func parameterSegments(state: RingState) -> [RingSegment] {
        var segments: [RingSegment] = []

        let modelValues = state.modelOptions.map { $0.value }
        let modelLabels = shortLabels(modelValues)
        segments.append(RingSegment(
            label: "模型 \(state.model.isEmpty ? "未选" : state.model)",
            hint: "\(state.modelOptions.count) 个可选",
            children: zip(state.modelOptions, modelLabels).map { option, label in
                RingSegment(
                    label: label,
                    hint: option.text ?? option.value,
                    checked: option.value == state.model,
                    action: .setParam(key: "model", value: option.value))
            }))

        segments.append(RingSegment(
            label: "分辨率 \(state.resolution)",
            hint: "输出尺寸档位",
            children: state.resolutionOptions.map { option in
                RingSegment(label: option.text ?? option.value,
                            checked: option.value == state.resolution,
                            action: .setParam(key: "resolution", value: option.value))
            }))

        segments.append(RingSegment(
            label: "数量 \(state.count)",
            hint: "一次生成几张",
            children: state.countOptions.map { option in
                RingSegment(label: "\(option) 张", checked: option == state.count,
                            action: .setParam(key: "count", value: String(option)))
            }))

        return segments
    }

    /// 独立模式下的「生成」子菜单：先问一句「要不要参考图」。
    ///
    /// 为什么不像插件那样一键就出图：没有插件的时候，「出图」有两种完全不同的活
    /// —— 纯文字生图，和以图生图（改图、换风格、按参考图重画）。
    /// 助手没有选区可读，只能问用户。
    static func standaloneGenerateSegments(state: RingState) -> [RingSegment] {
        var segments: [RingSegment] = [
            RingSegment(label: "纯文字", hint: "只用提示词出图",
                        action: .command("generateText")),
            RingSegment(label: "导入图片", hint: "选一个文件当参考图",
                        action: .local(.importImage)),
            // 用系统截图（⇧⌘4 之类）—— 助手不自己去截，
            // 那需要「屏幕录制」权限，而用户本来就有自己顺手的截图方式
            RingSegment(label: "截屏", hint: "等你截图后自动收",
                        action: .local(.screenshot)),
        ]
        if !state.lastImageName.isEmpty {
            segments.append(RingSegment(
                label: "用上次的图",
                hint: state.lastImageName,
                action: .command("generateWithLast")))
        }
        return segments
    }

    /// 对话子菜单的内容。
    ///
    /// 「打字提问」和「看回复」是圆环本地动作（不发给插件）：
    /// 前者要开一个真正的文本控件才能挂上中文输入法，
    /// 后者是把助手手里那份回复原样再显示一遍。
    static func chatSegments(state: RingState) -> [RingSegment] {
        var segments: [RingSegment] = []

        segments.append(RingSegment(
            label: "模型 \(state.chatModel.isEmpty ? "未选" : state.chatModel)",
            hint: "\(state.chatModels.count) 个可选",
            children: zip(state.chatModels, shortLabels(state.chatModels.map { $0.value })).map { option, label in
                RingSegment(
                    label: label,
                    hint: option.text ?? option.value,
                    checked: option.value == state.chatModel,
                    action: .commandWith("chatModel", ["value": option.value]))
            },
            disabled: state.chatModels.isEmpty))

        segments.append(RingSegment(
            label: "快捷提问",
            hint: state.chatQuestions.isEmpty ? "未设置" : "\(state.chatQuestions.count) 条",
            children: state.chatQuestions.map { question in
                RingSegment(
                    label: question.label,
                    hint: String((question.prompt ?? "").prefix(28)),
                    action: .commandWith("chatAsk", ["prompt": question.prompt ?? question.label]))
            },
            disabled: state.chatQuestions.isEmpty))

        segments.append(RingSegment(
            label: "打字提问",
            hint: "支持中文输入法",
            action: .local(.textInput)))

        if state.chatHasReply {
            segments.append(RingSegment(
                label: "看对话",
                hint: String(state.chatLastReply.prefix(20)),
                action: .local(.showReply)))
        }

        segments.append(RingSegment(
            label: "新对话",
            hint: "清空聊天记录",
            action: .command("chatNew")))

        // 「打开面板」是插件的页面，没插件时点它没有任何反应 ——
        // 与其给一个点了没用的格子，不如不给
        if state.connected {
            segments.append(RingSegment(
                label: "打开面板",
                hint: "切到对话页",
                action: .command("openChat")))
        }

        return segments
    }

    private static func presetCategorySegments(state: RingState) -> [RingSegment] {
        state.presets.map { group in
            RingSegment(
                label: group.category,
                hint: "\(group.items.count) 条",
                children: group.items.map { item in
                    RingSegment(
                        label: item.name,
                        hint: String((item.prompt ?? "").prefix(28)),
                        action: .applyPreset(name: item.name))
                })
        }
    }

    /// 当前该用哪个菜单。
    ///
    /// **这里是唯一一处判断**：App 和 --dump-menu 都走它，
    /// 免得调试命令和真实行为各说各话（之前就是分开写的，
    /// 结果「没插件时整个圆环废掉」这个 bug 在 dump 里看不见）。
    static func currentLevel(state: RingState, config: RingConfig) -> RingLevel {
        // 插件没连上、助手自己也没配密钥 —— 那才是真的什么都干不了
        if !state.connected && !state.standaloneReady {
            return placeholderLevel()
        }
        return rootLevel(state: state, config: config)
    }

    /// 插件还没连上时的占位菜单，用来确认圆环本身工作正常
    static func placeholderLevel() -> RingLevel {
        RingLevel(title: "圆环", segments: [
            RingSegment(label: "未连接", hint: "等待插件", disabled: true),
            RingSegment(label: "插件", hint: "请确认已加载", disabled: true),
            RingSegment(label: "关闭", hint: "收起圆环", action: .closeRing)
        ])
    }
}
