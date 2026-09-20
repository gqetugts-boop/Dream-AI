// ============================================================
//  MenuDump.swift — `--dump-menu`：把圆环当前会画出来的菜单打印成文本
//
//  为什么值得单独做：圆环是画出来的，不是窗口控件 ——
//  「某个扇区为什么没出现 / 点下去发的是什么指令」在界面上看不出来，
//  只能靠肉眼试。这个命令把菜单结构和每个扇区的动作原样打出来，
//  改完动作配置、接了新指令之后，一条命令就能确认接线对不对。
//
//  用法：
//    HuanmengRing --dump-menu                 用内置的样例状态
//    HuanmengRing --dump-menu state.json      用插件真实推过的 state 报文
//                                             （{"payload": {...}} 或直接是 payload）
// ============================================================

import Foundation

enum MenuDump {

    static func run(_ arguments: [String]) -> Int32 {
        // arguments[0] 是可执行文件自己的路径，它也不以 -- 开头，
        // 不排掉的话会被当成状态文件路径，然后报「读不出状态文件 /path/to/HuanmengRing」
        let pathArguments = arguments
        let path = arguments.dropFirst().first { !$0.hasPrefix("--") }

        var state = RingState()
        if let path {
            guard let loaded = loadState(from: path) else {
                print("读不出状态文件：\(path)")
                print("  期望是插件推的 {\"type\":\"state\",\"payload\":{…}}，或者直接是那个 payload 对象。")
                return 1
            }
            state = loaded
        } else {
            state = sampleState()
            print("（用的是内置样例状态；想看真实数据：--dump-menu <state.json>）\n")
        }

        let config = RingConfig.load()
        // --offline：模拟「插件没连上」。
        // 独立模式的那几格（生成子菜单、助手自己出图）只有在这个状态下才画得出来，
        // 不测它就会出现「功能写了但圆环上点不到」——那个坑真踩过。
        if arguments.contains("--offline") {
            state.connected = false
            state.standaloneReady = config.api.isUsable
            // 用真实数据填满（预设库、配置里的模型、快捷提问），
            // 和 App 走同一个 fillStandalone —— 否则打出来的是样例，
            // 看的人会以为「预设怎么只有 1 个分类」
            if !pathArguments.contains("--sample") {
                state.fillStandalone(api: config.api,
                                     presets: PresetStore.shared.items,
                                     hasReply: false,
                                     lastReply: "")
            }
            print("（模拟：插件未连接，独立模式可用=\(state.standaloneReady)）")
            print("（预设 \(state.presets.count) 个分类、模型 \(state.model)、对话模型 \(state.chatModel)）\n")
        } else {
            state.connected = true
        }
        // 走和 App 完全相同的入口 —— 直接调 rootLevel 会绕开
        // 「什么情况下该显示占位菜单」那层判断，那个 bug 就是这么漏掉的
        let level = MenuBuilder.currentLevel(state: state, config: config)
        printTree(level, indent: "")
        return 0
    }

    // MARK: - 输出

    private static func printTree(_ level: RingLevel, indent: String) {
        print("\(indent)\(level.title)  [\(level.segments.count) 项]")
        for (index, segment) in level.segments.enumerated() {
            var flags: [String] = []
            if segment.disabled { flags.append("禁用") }
            if segment.checked { flags.append("✓") }
            let suffix = flags.isEmpty ? "" : "  ← " + flags.joined(separator: " ")
            print("\(indent)  \(index + 1). \(segment.label)  — \(segment.hint)\(suffix)")
            print("\(indent)      动作: \(describe(segment.action))")
            if let children = segment.children {
                printTree(RingLevel(title: "(展开)", segments: children), indent: indent + "     ")
            }
        }
    }

    private static func describe(_ action: RingAction?) -> String {
        guard let action else { return "（无 —— 点了不会有反应）" }
        switch action {
        case .command(let name):
            return "发指令 \(name)"
        case .commandWith(let name, let payload):
            let body = payload.keys.sorted().map { "\($0)=\(payload[$0] ?? "")" }.joined(separator: ", ")
            return "发指令 \(name) {\(body)}"
        case .setParam(let key, let value):
            return "发指令 setParam {\(key)=\(value)}"
        case .applyPreset(let name):
            return "发指令 applyPreset {name=\(name)}"
        case .closeRing:
            return "圆环本地：收起"
        case .local(let what):
            switch what {
            case .textInput: return "圆环本地：打开输入条（支持中文输入法）"
            case .showReply: return "圆环本地：显示上一条回复"
            case .importImage: return "圆环本地：选一个图片文件当参考图"
            case .screenshot: return "圆环本地：等你截图后自动收"
            }
        }
    }

    // MARK: - 状态来源

    private static func loadState(from path: String) -> RingState? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

        // 接受两种：整条 websocket 报文，或者只有 payload
        let payloadDict = (root["payload"] as? [String: Any]) ?? root
        guard let payloadData = try? JSONSerialization.data(withJSONObject: payloadDict),
              let payload = try? JSONDecoder().decode(BridgeStatePayload.self, from: payloadData) else {
            return nil
        }
        var state = RingState()
        state.apply(payload)
        return state
    }

    /// 内置样例：内容齐全，能看出每个字段最终变成什么
    private static func sampleState() -> RingState {
        var state = RingState()
        state.documentOpen = true
        state.documentName = "样例.psd"
        state.hasSelection = true
        state.selectionWidth = 1024
        state.selectionHeight = 768

        state.model = "nano-banana-fast"
        state.resolution = "2K"
        state.count = 2
        state.modelOptions = [
            BridgeOption(value: "nano-banana-fast", text: "Nano Banana Fast"),
            BridgeOption(value: "nano-banana-pro", text: "Nano Banana Pro")
        ]
        state.resolutionOptions = [
            BridgeOption(value: "1K", text: "1K"),
            BridgeOption(value: "2K", text: "2K")
        ]
        state.presets = [
            BridgePresetGroup(category: "人像", items: [
                BridgePresetItem(name: "电影感", prompt: "cinematic lighting, 35mm")
            ])
        ]

        state.chatModel = "grs/gpt-5.4"
        state.chatModels = [
            BridgeOption(value: "grs/gpt-5.4", text: "GPT-5.4"),
            BridgeOption(value: "grs/gpt-5.4-mini", text: "GPT-5.4 mini")
        ]
        state.chatQuestions = [
            BridgeChatQuestion(label: "调色思路", prompt: "给我一个适合这张照片的调色思路。"),
            BridgeChatQuestion(label: "光影诊断", prompt: "分析这张照片的光影问题。")
        ]
        state.chatHasReply = true
        state.chatLastReply = "先压高光…"
        return state
    }
}
