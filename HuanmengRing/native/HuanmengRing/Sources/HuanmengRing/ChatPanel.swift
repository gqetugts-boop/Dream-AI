// ============================================================
//  ChatPanel.swift — 圆环下方的对话气泡
//
//  两种形态：
//    · 输入条（矮）：只有一个输入框，问一句就走
//    · 对话窗（高）：上面是来回的聊天记录（可滚动），下面还是那个输入框
//  发过一句之后自动变成对话窗，之后就一直能看见上下文 —— 这是「长对话」的做法。
//
//  为什么不把它画进圆环里：
//    1. 圆环中间的洞只有一百多个点，写一句中文问题根本不够
//    2. **中文输入法需要一个真正的文本控件，而且那个控件必须在 key window 上**。
//       圆环是 nonactivating 面板、文字全靠 CoreGraphics 自己画，
//       输入法（TSM / IMK）根本挂不上去 —— 这就是之前只能打英文的原因。
//       用标准 NSTextField / NSTextView 之后，拼音、双拼、手写、emoji、
//       听写这些系统输入法能力全部照常可用，一行输入法代码都不用自己写。
//
//  聊天记录从哪来：**插件推过来的**（type=chat 的 history 字段），
//  不是这里自己攒的。面板里那份 chatHistory 才是唯一事实 ——
//  两边各攒一份迟早会分叉，用户会看到「圆环里问的、面板里没有」。
//
//  键盘归属：气泡开着的时候它是唯一的键盘入口。
//    · 事件 tap 的 captureKeys 必须让出去，否则 Esc / 数字键会被它吞掉，
//      输入法收不到候选词选择键（数字键选词是最常用的）
//    · 全局点击监听也要摘掉 —— 不然点一下输入法的候选窗，
//      会被当成「点了 Photoshop」把整个圆环收掉
// ============================================================

import AppKit

/// 一轮对话。role 用插件的说法："user" / "assistant"。
struct ChatTurn {
    let role: String
    let text: String
    var isError: Bool = false
    /// 还在等回复的占位（画得淡一点，并表示「正在想」）
    var isPending: Bool = false

    var isUser: Bool { role == "user" }
}

/// 对话气泡的窗口。
///
/// **`canBecomeKey` 必须显式覆写成 true。**
/// `.borderless` 面板的这个属性默认是 `false`（实测确认，不是推测），
/// 不改的话窗口永远拿不到 key —— 拿不到 key 就没有输入法、也收不到键盘事件，
/// 用户看到的是「光标在那闪，打什么都没反应」。
/// 圆环那个面板同样覆写了，原因一模一样。
private final class ChatPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class ChatPanelController: NSObject, NSTextFieldDelegate, NSTextViewDelegate {

    /// 单条消息的渲染上限。聊天记录本身可滚动，这个只是防呆 ——
    /// 真碰到几万字的回复，全部排版会卡住输入。
    private static let messageLimit = 20000

    // MARK: - 外观常量

    private let padding: CGFloat = 14
    private let hintHeight: CGFloat = 15
    private let inputHeight: CGFloat = 20
    private let gapBelowRing: CGFloat = 12
    /// 对话窗里聊天记录区的高度上限（屏幕可见高度的比例 / 绝对上限）
    private let transcriptScreenRatio: CGFloat = 0.45
    private let transcriptMaxHeight: CGFloat = 460
    private let transcriptMinHeight: CGFloat = 150
    /// 生成中那条不确定态进度条。3pt —— 再粗抢戏，再细在 2x 屏上就糊了
    private let progressHeight: CGFloat = 3
    private let progressGap: CGFloat = 8
    /// 高亮扫过一遍的秒数
    private let progressCycle: TimeInterval = 1.8

    // MARK: - 部件

    private var panel: NSPanel
    private var bubble: BubbleView
    private var inputField: NSTextField
    private var transcriptScroll: NSScrollView
    private var transcriptView: NSTextView
    private var hintField: NSTextField

    // MARK: - 状态

    /// 聊天记录。push 里带了 history 就整份替换（以插件为准），
    /// 没带（老版本插件、或者本地刚追加）就在这里维护。
    private var transcript: [ChatTurn] = []
    /// 是否显示聊天记录区。没发过消息时是 false —— 只问一句就走的话，
    /// 弹出一个大空窗很碍事。
    private var expanded = false

    /// 当初贴着哪个圆环框摆的。模式切换时要按同一个锚点重新排版，
    /// 不能让气泡以自己为参照物 —— 那样会一次比一次往下跑
    private var anchor: NSRect = .zero
    /// 用户手动拖到哪儿了 —— 存的是**左上角**，不是窗口原点。
    ///
    /// 存左上角是因为窗口会在「输入条（矮）」和「对话窗（高）」之间切换。
    /// 存左下角的话，一变高就会往上长，把窗口顶到屏幕外面去；
    /// 存左上角则是往下长，位置稳定。非 nil 时排版一律用它，不再贴回圆环下面 ——
    /// 否则「拖开一点看画布」会被下一句回复弹回原位。
    /// 关掉气泡时清空：下一次重新开会回到圆环下方。
    private var manualTopLeft: NSPoint?
    /// 开气泡前谁在前台。关掉时要还回去 —— 输入法逼着我们抢了一次焦点
    private var previousApp: NSRunningApplication?
    private var dismissing = false

    /// 生成中（还没拿到终态）。驱动气泡里那条不确定态进度条。
    ///
    /// **不能拿 `transcript.last?.isPending` 代替这个标志位** —— 中间态走
    /// `replacePending` 之后 isPending 就没了，而 history 非空时 `showReply`
    /// 是整份替换 transcript、连判据一起抹掉。必须独立记。
    private var generating = false {
        didSet {
            guard generating != oldValue else { return }
            if generating {
                startProgressTimer()
            } else {
                stopProgressTimer()
                // 别让上一轮的矩形留在那儿被描一帧
                bubble.progressRect = .zero
            }
            bubble.needsDisplay = true
        }
    }
    private var progressTimer: Timer?
    /// 相位起点（单调时钟，见 tickProgress）
    private var progressEpoch: TimeInterval = 0

    /// 用户按了回车（内容已去掉首尾空白，非空）
    var onSubmit: ((String) -> Void)?
    /// 显示 / 隐藏通知。用来让事件 tap 让出键盘、摘掉全局点击监听
    var onVisibilityChange: ((Bool) -> Void)?

    var isVisible: Bool { panel.isVisible }

    /// 输入框里现在是什么。切来切去的时候要把它带上，
    /// 否则「先选了预设、再截个图」会把预设那段提示词清掉。
    var currentInput: String { inputField.stringValue }

    // MARK: - 构建

    override init() {
        let frame = NSRect(x: 0, y: 0, width: 460, height: 66)
        panel = ChatPanel(contentRect: frame,
                          styleMask: [.borderless, .nonactivatingPanel],
                          backing: .buffered,
                          defer: false)
        bubble = BubbleView(frame: frame)
        inputField = FirstMouseTextField(frame: .zero)
        transcriptScroll = NSScrollView(frame: .zero)
        transcriptView = FirstMouseTextView(frame: .zero)
        hintField = PassthroughLabel(labelWithString: "")

        super.init()

        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.contentView = bubble

        setupInputField()
        setupTranscriptView()

        hintField.font = NSFont.systemFont(ofSize: 10, weight: .regular)
        hintField.textColor = NSColor(calibratedWhite: 1, alpha: 0.42)
        hintField.lineBreakMode = .byTruncatingTail
        bubble.addSubview(transcriptScroll)
        bubble.addSubview(inputField)
        bubble.addSubview(hintField)

        bubble.onClick = { [weak self] in
            // 点在气泡空白处也算「回到输入框」，不然用户得精确点到那一行字上
            guard let self else { return }
            self.panel.makeKeyAndOrderFront(nil)
            self.panel.makeFirstResponder(self.inputField)
        }
        bubble.onMoved = { [weak self] origin, size in
            // 记住用户拖到的位置（换算成左上角），之后不再自动贴回圆环下方
            self?.manualTopLeft = NSPoint(x: origin.x, y: origin.y + size.height)
        }
    }

    private func setupInputField() {
        inputField.isBordered = false
        inputField.isBezeled = false
        inputField.drawsBackground = false
        inputField.isEditable = true
        inputField.isSelectable = true
        inputField.focusRingType = .none
        inputField.font = NSFont.systemFont(ofSize: 13, weight: .regular)
        inputField.textColor = .white
        inputField.placeholderString = "输入问题，回车发送…"
        inputField.delegate = self
        inputField.cell?.usesSingleLineMode = true
        inputField.cell?.wraps = false
        inputField.cell?.isScrollable = true
        inputField.cell?.lineBreakMode = .byClipping
    }

    private func setupTranscriptView() {
        transcriptView.isRichText = false
        transcriptView.isEditable = false
        transcriptView.isSelectable = true
        transcriptView.drawsBackground = false
        transcriptView.textContainerInset = NSSize(width: 0, height: 2)
        transcriptView.isVerticallyResizable = true
        transcriptView.isHorizontallyResizable = false
        transcriptView.autoresizingMask = [.width]
        transcriptView.minSize = NSSize(width: 0, height: 0)
        transcriptView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude,
                                        height: CGFloat.greatestFiniteMagnitude)
        transcriptView.textContainer?.widthTracksTextView = true
        transcriptView.textContainer?.containerSize = NSSize(width: 0,
                                                             height: CGFloat.greatestFiniteMagnitude)
        transcriptView.delegate = self

        transcriptScroll.drawsBackground = false
        transcriptScroll.borderType = .noBorder
        transcriptScroll.hasVerticalScroller = true
        transcriptScroll.hasHorizontalScroller = false
        transcriptScroll.autohidesScrollers = true
        transcriptScroll.scrollerStyle = .overlay
        transcriptScroll.documentView = transcriptView
    }

    // MARK: - 对外接口

    /// 这个输入框现在是在收什么
    enum InputPurpose {
        case chat    // 问模型一句话
        case prompt  // 写一段生图提示词（没有插件时助手自己出图）
    }

    private(set) var purpose: InputPurpose = .chat

    /// 输入条形态：只有一个输入框，不显示聊天记录。
    /// 刚点「打字提问」时用这个 —— 还没说话就先弹一个大窗很碍事。
    func showInput(relativeTo ringFrame: NSRect, purpose: InputPurpose = .chat,
                   prefill: String = "", note: String = "") {
        anchor = ringFrame
        self.purpose = purpose
        expanded = false
        generating = false
        inputField.stringValue = prefill
        inputField.placeholderString = purpose == .chat ? "输入问题，回车发送…" : "描述你想要的画面…"
        // note 优先：带着参考图的时候，「已带参考图：xxx」比操作提示更该被看见
        hintField.stringValue = !note.isEmpty
            ? "\(note) · ⏎ 开始生成 · Esc 取消"
            : (purpose == .chat
                ? "⏎ 发送 · Esc 关闭 · 可直接用中文输入法"
                : "⏎ 开始生成 · Esc 取消 · 可直接用中文输入法")

        layout()
        present()
        // 焦点必须在 orderFront 之后设置，否则字段编辑器拿到的还是旧窗口
        panel.makeFirstResponder(inputField)
        if !prefill.isEmpty, let editor = inputField.currentEditor() {
            editor.selectedRange = NSRange(location: prefill.count, length: 0)
        }
    }

    /// 一条通知式的提示（等截图、等待中之类）。
    /// 不显示输入框 —— 这时候用户该去做别的事，不是打字。
    func showNotice(relativeTo ringFrame: NSRect, title: String, detail: String) {
        anchor = ringFrame
        expanded = true
        generating = false
        transcript = [ChatTurn(role: "assistant", text: "\(title)\n\(detail)")]
        hintField.stringValue = "Esc 取消"
        renderTranscript()
        layout()
        present()
    }

    /// 打开对话窗看历史（「看对话」菜单项）。
    /// history 为空时退回显示最后一条回复 —— 总比什么都不弹强。
    func showConversation(relativeTo ringFrame: NSRect, history: [ChatTurn]) {
        anchor = ringFrame
        transcript = history
        expanded = true
        generating = false
        hintField.stringValue = "⏎ 继续提问 · Esc 关闭"
        renderTranscript()
        layout()
        present()
        panel.makeFirstResponder(inputField)
    }

    /// 等回复。问题立刻进记录，回复位置先占一行「正在回复…」，
    /// 用户才知道真的发出去了（接口可能要十几秒）。
    func showThinking(relativeTo ringFrame: NSRect, question: String, history: [ChatTurn]) {
        anchor = ringFrame
        // 插件推的 history 里已经包含刚问的这句（它自己在推送前拼好的）；
        // 没带 history 的老版本插件就在这里补一条，免得用户看不到自己刚问的
        if history.isEmpty {
            if !question.isEmpty {
                transcript.append(ChatTurn(role: "user", text: question))
            }
        } else {
            transcript = history
        }
        transcript.append(ChatTurn(role: "assistant", text: "正在回复…", isPending: true))
        expanded = true
        // 等回复 = 不确定态，进度条起来。放在 layout() 之前，
        // 否则这一次排版算的还是没有进度条的高度
        generating = true
        hintField.stringValue = "正在等回复 · Esc 关闭"
        renderTranscript()
        layout()
        present()
        panel.makeFirstResponder(inputField)
    }

    /// 回复到了。history 非空就整份替换（以插件那份为准），
    /// 否则把本地那条「正在回复…」换成正文。
    func showReply(relativeTo ringFrame: NSRect, history: [ChatTurn],
                   question: String, text: String, isError: Bool) {
        anchor = ringFrame
        if !history.isEmpty {
            transcript = history
        } else {
            replacePending(text: text, isError: isError)
        }
        expanded = true
        // 终态：不管成功还是出错，进度条都收掉。
        // 注意成功路径 AppDelegate 是直接 chat.dismiss()，不走这儿 —— 那边另清
        generating = false
        hintField.stringValue = "⏎ 继续提问 · Esc 关闭"
        renderTranscript()
        layout()
        present()
    }

    /// 回复到了，而气泡还停在那句话上 —— 原地更新。
    /// 气泡已经被 Esc 关掉时不动它：用户主动关了，就不该被一个窗口突然弹回来。
    ///
    /// - Parameter busy: 这只是**中间态**（生图会一路推「提交任务… / 生成中… 12s」）。
    ///   中间态不能走 showReply：
    ///     · 那份 history 里还没有当前这一问，整份替换会把它和「正在回复…」一起抹掉，
    ///       连 text 都被丢掉 —— 进度文字以前就是这么没的；
    ///     · showReply 每次都 present()，里面是 `NSApp.activate(ignoringOtherApps:)`，
    ///       等于每 2.5 秒把用户的焦点从 Photoshop 抢回来一次。
    func updatePendingReply(history: [ChatTurn], question: String, text: String,
                            isError: Bool, busy: Bool = false) {
        guard isVisible else { return }

        if busy {
            replacePending(text: text, isError: isError, keepPending: true)
            renderTranscript()
            layout()
            return      // 不 present()：气泡本来就开着，别抢焦点
        }

        // 出错一定是终态。插件推的 error 也走这条路（AppDelegate 的 handleChat），
        // 不在这儿清的话，那一次失败之后进度条会一直转下去
        if isError { generating = false }
        showReply(relativeTo: anchor, history: history, question: question, text: text, isError: isError)
    }

    func dismiss() {
        guard panel.isVisible, !dismissing else { return }
        dismissing = true
        // 气泡一关，updatePendingReply 的 guard isVisible 会让终态永远不来。
        // 不在这儿停表的话定时器就再没人管了 —— 关着的窗口上 20fps 空转，
        // 而且下一轮打开时进度条会是「已经在转」的状态。
        // 生成成功那条路（AppDelegate）走的就是 dismiss()，没有 showReply —— 这是唯一的清理点
        generating = false
        // 手动拖的位置只在这一轮对话里有效：下次打开重新回到圆环下方。
        // （不这么做的话，隔几天再用会发现气泡出现在上次随手拖到的角落，
        //   而圆环在鼠标那边 —— 两个东西离得老远。）
        manualTopLeft = nil
        panel.orderOut(nil)
        onVisibilityChange?(false)
        restoreFocus()
        dismissing = false
    }

    // MARK: - 内容

    /// 把最后那条占位原地换掉（没有占位才补一条）。
    ///
    /// - Parameter keepPending: 中间态用。这一行还是「临时的」，下一个 stage 来了
    ///   继续换它 —— 否则（末条不是 pending 时本方法是 append）一轮生图能在记录里
    ///   堆出二十几条「生成中… Ns」（GrsClient 每 2.5 秒推一次，最多 120 次）。
    ///   保持 isPending 还有个附带好处：renderTranscript 会把它画淡，
    ///   和「正在回复…」的观感一致 —— 一行还在变的文字本来就该是淡的。
    private func replacePending(text: String, isError: Bool, keepPending: Bool = false) {
        let body = text.count > Self.messageLimit
            ? String(text.prefix(Self.messageLimit)) + "\n…（已截断，完整内容看面板）"
            : text
        if let last = transcript.last, last.isPending {
            transcript[transcript.count - 1] = ChatTurn(role: "assistant", text: body,
                                                       isError: isError, isPending: keepPending)
        } else {
            transcript.append(ChatTurn(role: "assistant", text: body,
                                       isError: isError, isPending: keepPending))
        }
    }

    private func renderTranscript() {
        let composed = NSMutableAttributedString()

        for (index, turn) in transcript.enumerated() {
            if index > 0 { composed.append(NSAttributedString(string: "\n")) }

            // 说话人前缀：短、有色、一眼能分出谁说的
            let roleText = turn.isUser ? "我  " : "助手  "
            let roleColor = turn.isUser
                ? NSColor(calibratedRed: 0.55, green: 0.78, blue: 1.0, alpha: 1)
                : NSColor(calibratedWhite: 1, alpha: 0.5)
            composed.append(NSAttributedString(string: roleText, attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                .foregroundColor: roleColor,
            ]))

            var bodyColor = NSColor.white
            if turn.isError { bodyColor = NSColor.systemRed }
            if turn.isPending { bodyColor = NSColor(calibratedWhite: 1, alpha: 0.45) }

            let body = turn.text.count > Self.messageLimit
                ? String(turn.text.prefix(Self.messageLimit)) + "\n…（已截断，完整内容看面板）"
                : turn.text

            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 2
            paragraph.paragraphSpacing = 10
            composed.append(NSAttributedString(string: body, attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .regular),
                .foregroundColor: bodyColor,
                .paragraphStyle: paragraph,
            ]))
        }

        transcriptView.textStorage?.setAttributedString(composed)
        scrollTranscriptToBottom()
    }

    /// 滚到底。必须等一次布局 —— 刚设完 textStorage 时排版还没算出来，
    /// 立刻 scrollRangeToVisible 会滚到错误的位置（停在中间）。
    private func scrollTranscriptToBottom() {
        let end = NSRange(location: (transcriptView.string as NSString).length, length: 0)
        DispatchQueue.main.async { [weak self] in
            guard let self, self.transcriptScroll.isHidden == false else { return }
            self.transcriptView.scrollRangeToVisible(end)
        }
    }

    // MARK: - 生成进度

    /// 气泡里那条进度条的相位来源。20fps，和 ToastWindow 那个转圈一个节奏。
    private func startProgressTimer() {
        guard progressTimer == nil else { return }
        progressEpoch = ProcessInfo.processInfo.systemUptime
        bubble.progressPhase = 0        // 不清的话第一帧会从上轮的随机位置冒出来

        // 尊重系统的「减弱动态效果」：停在正中，只留「有东西在等」的暗示，不流动
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            bubble.progressPhase = 0.5
            return
        }

        let timer = Timer(timeInterval: 1.0 / 20.0, repeats: true) { [weak self] _ in
            self?.tickProgress()
        }
        // .common **必须**：拖动窗口时 runloop 在 eventTracking 模式，
        // 不加这一句，用户一按住拖，进度条就当场冻住
        RunLoop.main.add(timer, forMode: .common)
        progressTimer = timer
    }

    private func stopProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = nil
    }

    /// 相位按**绝对时间**算，不是每帧累加。
    ///
    /// 生成期间主线程很忙：每 2.5 秒要重排一次聊天记录，还要跑网络回调，
    /// 定时器被挤晚是常态。累加的话晚一帧就少走一帧，看上去是「越走越慢、卡一下再跳」；
    /// 按时间算，晚到的那一帧画的仍然是此刻该在的位置 —— 掉帧只是掉帧，不是变速。
    ///
    /// 时钟用 systemUptime 而不是 Date()：单调（用户改系统时间、NTP 往回校都不会跳相位）、
    /// 每次 tick 不做日期换算、且不含睡眠时间。
    /// （GrsClient 里那个 Date() 是对的 —— 它要显示的是「用户感知的等待秒数」，墙钟才正确。）
    private func tickProgress() {
        // ⚠️ 必须再除以 cycle 归一化到 0..1：drawProgress 里是拿相位当
        // 「扫过整条轨道的百分比」用的，直接把秒数取模喂进去的话范围是 0..1.8，
        // 相位一过 1 整条高亮就跑到轨道右边外面去了 —— 看起来是「闪一下停一下」
        let elapsed = ProcessInfo.processInfo.systemUptime - progressEpoch
        let phase = elapsed.truncatingRemainder(dividingBy: progressCycle) / progressCycle
        bubble.progressPhase = CGFloat(phase)
    }

    // MARK: - 布局与呈现

    private func layout() {
        let ringFrame = anchor
        let screen = NSScreen.screens.first { $0.frame.intersects(ringFrame) } ?? NSScreen.main
        let visibleFrame = screen?.visibleFrame

        let width = min(max(ringFrame.width * 1.9, 420), 720)
        let innerWidth = width - padding * 2

        var transcriptHeight: CGFloat = 0
        if expanded {
            let available = (visibleFrame?.height ?? 900) * transcriptScreenRatio
            transcriptHeight = min(max(available, transcriptMinHeight), transcriptMaxHeight)
        }
        // 生成中，记录和输入框之间要多让出一条进度条的位置；
        // 不生成时这段就是原来那个 8pt 间距 —— 空闲时的样子和改造前一模一样
        let showProgress = expanded && generating
        let transcriptBlock: CGFloat = expanded
            ? (showProgress ? progressGap * 2 + progressHeight : 8)
            : 0
        let inputBlock = inputHeight + 6 + hintHeight
        let height = padding * 2 + transcriptHeight + transcriptBlock + inputBlock

        var y = padding
        if expanded {
            transcriptScroll.isHidden = false
            transcriptScroll.frame = NSRect(x: padding, y: y, width: innerWidth, height: transcriptHeight)
            // NSScrollView + NSTextView 的标准配方：宽度跟 clip 走、高度自由长
            let clipSize = transcriptScroll.contentSize
            transcriptView.frame = NSRect(origin: .zero, size: clipSize)
            transcriptView.minSize = NSSize(width: 0, height: clipSize.height)
            transcriptView.textContainer?.containerSize = NSSize(width: clipSize.width,
                                                                 height: CGFloat.greatestFiniteMagnitude)
            y += transcriptHeight
            if showProgress {
                y += progressGap
                // 左右和输入框对齐：这是「这一块在忙」的指示，不是装饰线
                bubble.progressRect = NSRect(x: padding, y: y,
                                             width: innerWidth, height: progressHeight)
                y += progressHeight + progressGap
            } else {
                bubble.progressRect = .zero
                y += 8
            }
        } else {
            transcriptScroll.isHidden = true
            bubble.progressRect = .zero
        }

        inputField.frame = NSRect(x: padding, y: y, width: innerWidth, height: inputHeight)
        y += inputHeight + 6
        hintField.frame = NSRect(x: padding, y: y, width: innerWidth, height: hintHeight)

        var origin: CGPoint
        if let topLeft = manualTopLeft {
            // 用户拖过就听用户的，从左上角往下长（切形态时上边缘不动）
            origin = CGPoint(x: topLeft.x, y: topLeft.y - height)
            // 只做一件事：别让它跑到屏幕外面（换分辨率、拖到边上时会遇到）
            if let visible = (panel.screen ?? screen)?.visibleFrame {
                origin.x = min(max(origin.x, visible.minX), max(visible.minX, visible.maxX - width))
                origin.y = min(max(origin.y, visible.minY), max(visible.minY, visible.maxY - height))
            }
        } else {
            origin = CGPoint(x: ringFrame.midX - width / 2,
                             y: ringFrame.minY - gapBelowRing - height)
            if let visible = visibleFrame {
                if origin.y < visible.minY {
                    // 圆环贴着屏幕下沿：翻到上面去，上下都放不下就贴边
                    let above = ringFrame.maxY + gapBelowRing
                    origin.y = (above + height <= visible.maxY) ? above : visible.minY + 8
                }
                origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - width - 8)
                origin.y = min(max(origin.y, visible.minY), visible.maxY - height)
            }
        }

        panel.setFrame(NSRect(origin: origin, size: CGSize(width: width, height: height)),
                       display: true)
        bubble.needsDisplay = true
    }

    private func present() {
        panel.orderFrontRegardless()
        focus()
        onVisibilityChange?(true)
    }

    /// 把键盘拿过来。两件事缺一不可：
    ///
    ///   1. **面板成为 key** —— ChatPanel 覆写了 canBecomeKey。
    ///      borderless 面板默认 false，不覆写就永远拿不到 key。
    ///   2. **激活本程序** —— 输入法（TSM）只往**当前活跃 App** 的 key window 挂。
    ///      非激活面板能让窗口在本地变成 key，但系统级的输入焦点还在 Photoshop 那边，
    ///      结果就是光标在那闪、打什么都没反应（更糟的情况是字母漏给 PS，触发它的快捷键）。
    ///      Spotlight / Alfred 这类「浮层里打字」的工具全都激活自己，就是这个原因。
    ///
    /// 代价是 Photoshop 会失去前台焦点 —— 这是输入法的硬性要求，绕不过去。
    /// 关掉气泡时 restoreFocus() 会把焦点还回去。
    private func focus() {
        if previousApp == nil {
            previousApp = NSWorkspace.shared.frontmostApplication
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(inputField)
    }

    private func restoreFocus() {
        guard let app = previousApp else { return }
        previousApp = nil
        guard app.bundleIdentifier != Bundle.main.bundleIdentifier else { return }
        if #available(macOS 14.0, *) {
            app.activate()
        } else {
            app.activate(options: [.activateIgnoringOtherApps])
        }
    }

    // MARK: - 键盘

    /// 回车 = 发送；Esc = 关掉气泡。
    ///
    /// **组字中的回车和 Esc 不是给我们的** —— 拼音还没上屏时，
    /// 回车是「选词」，Esc 是「取消这次组字」。这两个键这时候归输入法。
    private func handle(command selector: Selector, editor: NSTextView) -> Bool {
        if selector == #selector(NSResponder.insertNewline(_:)) {
            if editor.hasMarkedText() {
                // 把标记文字定下来（拼音字母原样留下），别把半截拼音发出去
                editor.unmarkText()
                return true
            }
            submit()
            return true
        }
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            // 组字中的 Esc 交给输入法，别把整个气泡关了
            if editor.hasMarkedText() { return true }
            dismiss()
            return true
        }
        return false
    }

    private func submit() {
        let text = inputField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        onSubmit?(text)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        handle(command: commandSelector, editor: textView)
    }

    func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        // 记录区是只读的：只认 Esc（关掉气泡），回车也不该在这里发送 ——
        // 用户在看历史时敲回车，多半是想继续提问，那就把焦点送回输入框
        if textView == transcriptView {
            if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
                dismiss()
                return true
            }
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                panel.makeFirstResponder(inputField)
                return true
            }
            return false
        }
        return handle(command: commandSelector, editor: textView)
    }

    func controlTextDidBeginEditing(_ notification: Notification) {
        // 字段编辑器是全窗口共用的，光标颜色/字号得每次进来重新设一遍，
        // 否则在某处被改过之后，这里的光标就变成看不见的黑点
        if let editor = notification.userInfo?["NSFieldEditor"] as? NSTextView {
            editor.insertionPointColor = .white
            editor.drawsBackground = false
            editor.font = NSFont.systemFont(ofSize: 13, weight: .regular)
            editor.textColor = .white
        }
    }
}

// MARK: - 第一次点击就要生效的控件

/// 面板是非激活式的：默认情况下第一次点击只用来「激活窗口」，
/// 点不到控件上。用户看到的就是「点了输入框却没反应，得再点一次」。
private final class FirstMouseTextField: NSTextField {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private final class FirstMouseTextView: NSTextView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// 底部那行提示文字。
///
/// 它是个标签，自己不处理鼠标 —— 但**会吃掉**事件，导致「按住这一条拖不动窗口」。
/// 让它在命中测试里直接消失，事件就落到下面的气泡背景上，整块都能拖。
private final class PassthroughLabel: NSTextField {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// MARK: - 气泡背景

/// 圆角深色底 + 细描边。圆环本身不铺底板，但这个气泡上要写字，
/// 压着 Photoshop 的画布没有底就是不可读的。
private final class BubbleView: NSView {

    /// 没拖动、只是点了一下空白处
    var onClick: (() -> Void)?
    /// 拖完了，参数是窗口的新原点（屏幕坐标）和尺寸。控制器记下来，
    /// 之后切形态 / 下一轮问答都按这个位置摆，不会再跳回圆环下面。
    var onMoved: ((_ origin: NSPoint, _ size: NSSize) -> Void)?

    /// 按下时的鼠标屏幕坐标与窗口原点
    private var dragStart: NSPoint?
    private var dragOrigin: NSPoint?
    private var didDrag = false

    /// 不确定态进度条的绘制区域，由控制器在 layout() 里算好。
    /// 注意是**翻转坐标**（和 BubbleView 一致，y 自上而下）。`.zero` = 不画。
    ///
    /// 画在气泡自己身上，而不是做成子视图：整块底板都要能按住拖窗口
    /// （下面 mouseDown/mouseDragged 那一套），任何会被命中的子视图都会在
    /// 那一条上把 mouseDown 吃掉，症状是「按住进度条拖不动窗口」。
    /// PassthroughLabel 的 hitTest 返回 nil 就是为这个存在的。
    /// **别把它换成 NSProgressIndicator** —— 一样吃拖动，而且系统灰和这套手绘深色底不搭。
    var progressRect: NSRect = .zero {
        didSet { if progressRect != oldValue { needsDisplay = true } }
    }

    /// 扫光的相位，0..1 循环
    var progressPhase: CGFloat = 0 {
        didSet { if !progressRect.isEmpty { needsDisplay = true } }
    }

    private let accent = NSColor(calibratedRed: 0.38, green: 0.72, blue: 1.0, alpha: 1)

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: 1, dy: 1)
        let path = NSBezierPath(roundedRect: rect, xRadius: 14, yRadius: 14)
        NSColor(calibratedWhite: 0.09, alpha: 0.95).setFill()
        path.fill()
        NSColor(calibratedWhite: 1, alpha: 0.14).setStroke()
        path.lineWidth = 1
        path.stroke()
        drawProgress()
    }

    // MARK: - 不确定态进度条

    /// 轨道 + 一条扫过去的高亮。**不表示百分比** —— 生图接口只回「生成中… 12s」，
    /// 拿不到真实进度，画个假百分比是在骗人。
    private func drawProgress() {
        guard progressRect.height > 0, progressRect.width > 1 else { return }

        let track = NSBezierPath(roundedRect: progressRect,
                                 xRadius: progressRect.height / 2,
                                 yRadius: progressRect.height / 2)
        // 比描边的 0.14 更淡：它是背景，不该比输入框还抢眼
        NSColor(calibratedWhite: 1, alpha: 0.10).setFill()
        track.fill()

        // 高亮带比轨道长，两端各留一截在轨道外、再用轨道裁掉 ——
        // 它扫进来、扫出去都是渐隐的，不会「啪」地出现/消失；
        // 循环接头（phase 0 ↔ 1）那一瞬间高亮正好全在轨道外，所以看不出接缝
        let band = progressRect.width * 0.35
        let originX = progressRect.minX - band + (progressRect.width + band) * progressPhase
        guard let sweep = NSGradient(colors: [accent.withAlphaComponent(0),
                                              accent.withAlphaComponent(0.9),
                                              accent.withAlphaComponent(0)]) else { return }

        NSGraphicsContext.saveGraphicsState()
        track.addClip()
        sweep.draw(in: NSRect(x: originX, y: progressRect.minY,
                              width: band, height: progressRect.height),
                   angle: 0)
        NSGraphicsContext.restoreGraphicsState()
    }

    // MARK: - 按住拖动

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        dragStart = NSEvent.mouseLocation
        dragOrigin = window.frame.origin
        didDrag = false
        // 这里**不**触发 onClick：等松手时看有没有拖动过再决定是「点击」还是「拖动」
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let start = dragStart, let origin = dragOrigin else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - start.x
        let dy = now.y - start.y

        // 手抖几个点不该被当成拖动 —— 不然「点一下回到输入框」会变得很难点
        if !didDrag && abs(dx) + abs(dy) < 3 { return }
        didDrag = true

        var target = NSPoint(x: origin.x + dx, y: origin.y + dy)
        // 别让它被拖到屏幕外面去：整块保持在可见区域内
        if let visible = (window.screen ?? NSScreen.main)?.visibleFrame {
            let size = window.frame.size
            target.x = min(max(target.x, visible.minX), max(visible.minX, visible.maxX - size.width))
            target.y = min(max(target.y, visible.minY), max(visible.minY, visible.maxY - size.height))
        }
        window.setFrameOrigin(target)
    }

    override func mouseUp(with event: NSEvent) {
        defer {
            dragStart = nil
            dragOrigin = nil
            didDrag = false
        }
        if didDrag {
            if let frame = window?.frame { onMoved?(frame.origin, frame.size) }
        } else {
            // 点空白处也能回到输入框 —— 这个面板是非激活式的，
            // 不自己处理的话第一次点击会被系统吃掉
            onClick?()
        }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
