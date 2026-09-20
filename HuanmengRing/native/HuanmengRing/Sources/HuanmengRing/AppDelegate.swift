// ============================================================
//  AppDelegate.swift — 串联：菜单栏 / 快捷键 / 事件 tap / 圆环 / 桥接
// ============================================================

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, BridgeServerDelegate {

    private var statusItem: NSStatusItem?
    private var stateLabel: NSMenuItem?
    private var permissionLabel: NSMenuItem?
    private var showItem: NSMenuItem?

    /// 配置必须先于所有部件加载 —— ring / bridge / hotkey 的初始值都从它来。
    /// 所以 ring、bridge、hotkeyConfig 用 lazy：它们在 config 就绪后才第一次被访问。
    private var config = RingConfig.load()

    private let hotkey = HotkeyManager()
    private let tap = AltRightClickTap()
    private var hotkeyRegistered = false
    private let toast = ToastController()
    private lazy var ring = RingController(config: config)
    /// 圆环下方的对话气泡。中文输入法要求真文本控件，所以它是独立窗口
    private lazy var chat = ChatPanelController()
    /// 没有插件时，助手自己干活的那套
    private let engine = StandaloneEngine()
    /// 出图结果的浮窗
    private lazy var results = ImagePanelController()
    /// 等下一张截图的监听器
    private let screenshotter = ScreenshotWatcher()
    /// 当前挂着的参考图（data URL）和它的显示名。
    /// 独立出图时用 —— 插件模式下参考图由插件自己管（选区）。
    private var referenceImage: String?
    private var referenceName = ""
    /// 当前套着哪个预设。只为显示 —— 提示词已经填进输入框了，
    /// 但用户需要看见「参考图 + 预设」两个都挂着
    private var appliedPresetName = ""
    /// 助手自己留一份完整回复。state 里那份是截断过的（每秒都在推，不能塞全文），
    /// 圆环上的「看回复」要显示的是全文
    private var lastChatQuestion = ""
    private var lastChatReply = ""
    /// 完整聊天记录（插件推一份、这里留一份）。用来支持「看对话」——
    /// state 里那个 lastReply 是截断过的，看历史得用全文。
    private var lastChatHistory: [ChatTurn] = []
    /// 正在等插件回 history（帮手的记录是空的，比如助手刚重启过）
    private var chatWantsHistory = false
    private lazy var bridge = BridgeServer(port: UInt16(max(1, min(65535, config.bridge.port))))
    private lazy var hotkeyConfig = HotkeyConfig.parse(config.effectiveHotkey) ?? HotkeyConfig()
    private lazy var preferences = PreferencesWindowController()

    private var state = RingState()
    /// 配置落盘的防抖计时器（拖滑块时不要每帧写盘）
    private var saveTimer: Timer?

    /// 等辅助功能授权用的轮询。授权是系统设置那边异步发生的，
    /// 没有回调可挂，只能轮询 —— 但这样用户就不用「授权完再重启一次」了。
    private var permissionTimer: Timer?
    /// state 解码失败次数。这是判断「旧卫星插件在抢连接」的**实证**，
    /// 比去翻目录猜靠谱得多。
    private var stateDecodeFailures = 0

    // MARK: - 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupStatusItem()
        setupRing()
        setupChat()
        setupHotkey()
        // ⌥右键监听要在偏好设置里能关掉。关掉时连辅助功能权限都不去申请 ——
        // 没有这个功能就不该弹系统授权框。
        if config.interaction.altRightClick { setupTap() }
        bridge.delegate = self
        bridge.start()

        // 菜单要用它决定「生成」那一格画成什么（子菜单还是不可用）
        state.standaloneReady = config.api.isUsable
        applyStandaloneParams()

        showFirstRunHintIfNeeded()

        // 立刻写一次状态文件。没有这一步的话，「刚启动、插件还没连上」这段
        // 时间里状态文件还是上一次运行留下的残留（pid 已经死了），
        // 于是 `--doctor` 只能回答「无法判定」，用户跑来问「我到底授权了没」。
        publishStatus()
    }

    /// 第一次跑（还没有配置文件）时，用一句人话告诉用户怎么唤出。
    /// 只做一次 —— 之后配置文件存在了就不再打扰。
    private func showFirstRunHintIfNeeded() {
        guard !FileManager.default.fileExists(atPath: RingConfig.configPath) else { return }
        // 先把默认配置落盘，这样「第一次」只会发生这一次
        config.save()

        let hotkeyText = hotkeyConfig.display
        toast.show(.success("幻梦圆环已就绪 · 按 \(hotkeyText) 或 ⌥右键唤出", nil))
    }

    // MARK: - 配置

    /// 偏好设置改动后调用：立即生效 + 延迟存盘。
    /// 拖动滑块时这个回调每秒会触发几十次，直接写盘太浪费，
    /// 所以应用是即时的、落盘做 0.6 秒防抖。
    /// 端口的改动要重启才生效 —— 重开监听会断掉插件连接，不值得为它做热切换。
    func applyConfig(_ newConfig: RingConfig) {
        let portChanged = newConfig.bridge.port != config.bridge.port
        let tapToggled = newConfig.interaction.altRightClick != config.interaction.altRightClick
        config = newConfig
        ring.apply(config: config)

        // ⌥右键的两个开关要**立刻生效**，不能等重启 ——
        // 用户刚勾上就会去试，没反应会以为坏了。
        // 但也不能每次配置变动都重装 tap（拖滑块时一秒几十次），所以只在真变了时动。
        tap.photoshopOnly = config.interaction.altRightClickPhotoshopOnly
        // 菜单要知道「没插件时点了会怎样」——没密钥就该显示成不可用
        state.standaloneReady = config.api.isUsable
        state.lastImageName = referenceName
        applyStandaloneParams()
        if tapToggled {
            if config.interaction.altRightClick {
                setupTap()
            } else {
                tap.stop()
                NSLog("[幻梦圆环] ⌥右键已关闭")
            }
        }

        refreshMenu()

        saveTimer?.invalidate()
        saveTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: false) { [weak self] _ in
            self?.config.save()
        }

        if portChanged {
            NSLog("[幻梦圆环] 桥接端口改为 \(config.bridge.port)，重启助手后生效")
        }
    }

    /// 立即落盘。退出前和关窗时调用，避免防抖窗口期内丢改动。
    func flushConfig() {
        saveTimer?.invalidate()
        saveTimer = nil
        config.save()
    }

    /// 供偏好设置读取当前配置
    func currentConfig() -> RingConfig { config }

    func applicationWillTerminate(_ notification: Notification) {
        flushConfig()
        permissionTimer?.invalidate()
        hotkey.unregister()
        tap.stop()
        bridge.stop()
        // 状态文件删掉，免得 pid 被复用时自检读到上一次的残影
        StatusFile.remove()
    }

    // MARK: - 菜单栏

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem?.button {
            button.title = "◎"
            button.toolTip = "幻梦圆环"
        }

        let menu = NSMenu()
        let show = NSMenuItem(title: "显示圆环（\(hotkeyConfig.display)）",
                              action: #selector(showRingFromMenu), keyEquivalent: "")
        show.target = self
        menu.addItem(show)
        showItem = show

        // 作用范围跟着配置说，别写死"画布上" —— 独立使用时根本没有画布
        let scope = config.interaction.altRightClickPhotoshopOnly ? "（仅 Photoshop）" : ""
        let hintItem = NSMenuItem(title: "按住 ⌥ 再点右键也可以唤出\(scope)",
                                  action: nil, keyEquivalent: "")
        hintItem.isEnabled = false
        menu.addItem(hintItem)

        menu.addItem(.separator())

        stateLabel = NSMenuItem(title: state.summary, action: nil, keyEquivalent: "")
        stateLabel?.isEnabled = false
        menu.addItem(stateLabel!)

        permissionLabel = NSMenuItem(title: permissionTitle(),
                                     action: #selector(requestPermission), keyEquivalent: "")
        permissionLabel?.target = self
        menu.addItem(permissionLabel!)

        menu.addItem(.separator())
        let doctorItem = NSMenuItem(title: "自检…", action: #selector(runDoctor), keyEquivalent: "")
        doctorItem.target = self
        menu.addItem(doctorItem)

        let prefsItem = NSMenuItem(title: "偏好设置…", action: #selector(openPreferences), keyEquivalent: ",")
        prefsItem.target = self
        menu.addItem(prefsItem)

        // 独立工作要用自己的密钥。让用户填两遍太蠢了 —— 插件开着的时候一键拉过来。
        let importItem = NSMenuItem(title: "从插件导入接口配置",
                                    action: #selector(importConfigFromPlugin), keyEquivalent: "")
        importItem.target = self
        menu.addItem(importItem)

        let revealItem = NSMenuItem(title: "打开配置文件", action: #selector(revealConfigFile), keyEquivalent: "")
        revealItem.target = self
        menu.addItem(revealItem)

        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "退出幻梦圆环", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem?.menu = menu
    }

    private func permissionTitle() -> String {
        AltRightClickTap.isTrusted
            ? "辅助功能权限：已授权 ✓"
            : "⚠️ 点这里授予「辅助功能权限」（⌥右键需要）"
    }

    /// 自检结果用弹窗给，不用去终端看日志 —— 出问题时用户第一个动作
    /// 应该是「点一下自检」，而不是「打开终端」。
    @objc private func runDoctor() {
        let runtime = DoctorRuntime(
            bridgeConnected: state.connected,
            stateDecodeFailures: stateDecodeFailures,
            tapActive: tap.isRunning,
            hotkeyRegistered: hotkeyRegistered,
            hotkeyDisplay: hotkeyConfig.display,
            trusted: AltRightClickTap.isTrusted,
            live: true
        )
        let findings = Doctor.report(runtime: runtime)

        let alert = NSAlert()
        alert.messageText = findings.contains { $0.level == .fail }
            ? "发现需要处理的问题"
            : (findings.contains { $0.level == .warn } ? "基本正常，有几点要注意" : "一切正常")
        alert.informativeText = Doctor.text(findings, runtime: runtime)
        alert.alertStyle = findings.contains { $0.level == .fail } ? .critical : .informational
        alert.addButton(withTitle: "好")

        // 没授权的话，顺手给一个直达按钮，省得用户再回菜单找
        if !AltRightClickTap.isTrusted {
            alert.addButton(withTitle: "去授权…")
        }

        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        if response == .alertSecondButtonReturn {
            AltRightClickTap.openAccessibilitySettings()
        }
    }

    private func refreshMenu() {
        stateLabel?.title = state.summary
        permissionLabel?.title = permissionTitle()
        showItem?.title = "显示圆环（\(hotkeyConfig.display)）"
        publishStatus()
    }

    /// 把当前状态写给自检看。每次状态变化都调一次 ——
    /// 这样命令行 `--doctor` 拿到的就是**助手自己**的真实情况，
    /// 而不是「终端有没有辅助功能权限」这种答非所问的结论。
    private func publishStatus() {
        StatusFile.write(
            trusted: AltRightClickTap.isTrusted,
            tapActive: tap.isRunning,
            hotkey: hotkeyConfig.display,
            hotkeyOK: hotkeyRegistered,
            bridgeConnected: state.connected,
            stateDecodeFailures: stateDecodeFailures
        )
    }

    @objc private func openPreferences() {
        // 把插件下发的动作清单带进去填下拉框。插件没连上时是空的，
        // 偏好设置会用自己那份兜底列表，照样能改。
        preferences.show(config: config, pluginActions: state.pluginActions) { [weak self] updated in
            self?.applyConfig(updated)
        }
    }

    @objc private func revealConfigFile() {
        let path = RingConfig.configPath
        if !FileManager.default.fileExists(atPath: path) {
            // 文件还不存在时先写一份默认的，否则访达会打开一个空目录
            RingConfig().save()
        }
        NSWorkspace.shared.selectFile(path, inFileViewerRootedAtPath: "")
    }

    // MARK: - 各部件装配


    private var clickMonitor: Any?

    private func setupRing() {
        ring.onCommit = { [weak self] segment in
            guard let self else { return }
            self.perform(segment.action)
        }
        ring.onCancel = { NSLog("[幻梦圆环] 已关闭") }
        ring.onVisibilityChange = { [weak self] visible in
            guard let self else { return }
            // 圆环收了，气泡也不该孤零零留在屏幕上
            if !visible { self.chat.dismiss() }
            self.refreshInputOwnership()
        }
    }

    /// 键盘和点击的归属。
    ///
    /// 平时归圆环：键盘交给事件 tap 处理，因为只有 tap 能把按键吞掉，
    /// 全局监听只能旁观，Esc 会同时漏给 Photoshop。
    ///
    /// **气泡一开就全归气泡**：
    ///   · 输入法要用数字键选候选词、用 Esc 取消组字，被 tap 吞掉就打不出中文
    ///   · 输入法的候选窗属于别的进程，点它会被全局点击监听当成
    ///     「点了 Photoshop」而把圆环收掉
    /// 这两条都是实测会直接让中文输入不可用的，不是理论风险。
    private func refreshInputOwnership() {
        let chatOpen = chat.isVisible
        let ringOpen = ring.isVisible
        tap.captureKeys = ringOpen && !chatOpen
        if chatOpen || !ringOpen {
            removeSessionMonitors()
        } else {
            installSessionMonitors()
        }
    }

    /// 圆环常驻期间挂上的全局监听。
    /// 指针跟踪由 RingController 按帧轮询，不在这里。键盘走 AltRightClickTap。
    private func installSessionMonitors() {
        // 点击落在圆环窗口之外 = 点到了 Photoshop，视为取消。
        // 窗口内的点击由窗口自己处理，不会触发全局监听。
        guard clickMonitor == nil else { return }
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] _ in
            self?.ring.cancel()
        }
    }

    // MARK: - 对话气泡

    private func setupChat() {
        chat.onSubmit = { [weak self] text in
            guard let self else { return }
            // 输入法那边负责组字，这里拿到的已经是定稿的文字（含中文）
            if self.chat.purpose == .prompt {
                self.startLocalGeneration(prompt: text)
                return
            }
            self.lastChatQuestion = text

            // 有插件就走插件：那边的对话记录和面板是同一份，而且只有它
            // 能把结果放回文档。没插件才用助手自己那套 —— 这就是「独立可用」。
            guard self.state.connected else {
                self.startLocalChat(question: text)
                return
            }
            // 先用本地那份记录把气泡撑起来（立刻有反馈），
            // 插件随后推的 thinking 会带上权威的一份并覆盖它
            self.chat.showThinking(relativeTo: self.ring.frame, question: text,
                                   history: self.lastChatHistory)
            self.bridge.send(["type": "command", "action": "chatAsk", "resolved": true,
                              "payload": ["prompt": text]])
        }
        // 气泡开合会改变键盘归属（见 refreshInputOwnership）
        chat.onVisibilityChange = { [weak self] _ in
            self?.refreshInputOwnership()
        }
    }

    // MARK: - 独立模式（没有插件时助手自己干活）

    /// 没有插件时的对话：走助手自己的引擎，聊天记录存在本地。
    /// 界面复用同一个气泡 —— 用户在意的不是谁在回答，而是能不能用。
    private func startLocalChat(question: String) {
        guard config.api.isUsable else {
            chat.showReply(relativeTo: ring.frame,
                           history: engine.history + [ChatTurn(role: "user", text: question)],
                           question: question,
                           text: "还没有配置接口密钥。\n\n"
                               + "菜单栏 ◎ →「从插件导入接口配置」（PS 插件开着的时候），\n"
                               + "或者点「偏好设置 → 接口」自己填。",
                           isError: true)
            return
        }

        chat.showThinking(relativeTo: ring.frame, question: question,
                          history: engine.history + [ChatTurn(role: "user", text: question)])

        Task { @MainActor in
            do {
                let reply = try await engine.ask(question, api: config.api)
                lastChatHistory = engine.history
                lastChatReply = reply
                lastChatQuestion = question
                chat.showReply(relativeTo: ring.frame, history: engine.history,
                               question: question, text: reply, isError: false)
                statusItem?.button?.title = "◎"
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                chat.showReply(relativeTo: ring.frame, history: engine.history,
                               question: question, text: message, isError: true)
                statusItem?.button?.title = "✕"
            }
            publishStatus()
        }
    }

    // MARK: - 参考图（独立出图用）

    /// 选一个图片文件
    private func pickReferenceImage() {
        guard let url = ImageSource.pickFile() else { return }   // 取消
        guard let dataURL = ImageSource.dataURL(from: url) else {
            toast.show(.failure("这个文件读不出图片：\(url.lastPathComponent)"))
            return
        }
        referenceImage = dataURL
        referenceName = url.lastPathComponent
        state.lastImageName = referenceName
        pushRingState()
        showPromptBar()
    }

    /// 等用户截一张图。
    ///
    /// **不自己去调 screencapture** —— 那要「屏幕录制」权限。
    /// 用户本来就有顺手的截图方式（⇧⌘4 / 微信 / Snipaste…），
    /// 只要它落盘助手就能收，不用再教一套操作、也不用再求一次授权。
    private func waitForScreenshot() {
        // 第一次用得先说清楚去哪儿截；之后再点就直接等，不再啰嗦
        let folder = ScreenshotWatcher.screenshotFolder
        chat.showNotice(relativeTo: ring.frame,
                        title: "等待截图…",
                        detail: "用 ⇧⌘4 截一张（存到 \(folder.path)）\n"
                              + "助手会自动接住，然后你写提示词就行。\n\n"
                              + "Esc 取消")

        screenshotter.onCapture = { [weak self] url in
            guard let self else { return }
            guard let dataURL = ImageSource.dataURL(from: url) else {
                self.toast.show(.failure("截图读不出来：\(url.lastPathComponent)"))
                return
            }
            self.referenceImage = dataURL
            self.referenceName = url.lastPathComponent
            self.state.lastImageName = self.referenceName
            self.pushRingState()
            self.toast.show(.success("已捕获截图", nil))
            self.showPromptBar()
        }
        screenshotter.onTimeout = { [weak self] in
            self?.toast.show(.failure("等截图超时了（2 分钟）"))
        }
        screenshotter.start()
    }

    /// 提示行：把当前挂着的「参考图 / 预设」都说清楚。
    ///
    /// 之前只显示其中一个 —— 用户截了图再选预设，就以为预设把图顶掉了
    /// （或者反过来）。两个都挂上时得看得见。
    private func promptBarNote() -> String {
        var parts: [String] = []
        if !referenceName.isEmpty { parts.append("参考图：\(referenceName)") }
        if !appliedPresetName.isEmpty { parts.append("预设：\(appliedPresetName)") }
        if parts.isEmpty { return "" }
        // 单独一张参考图时补一句：还可以回圆环选预设
        if appliedPresetName.isEmpty {
            return parts.joined(separator: " · ") + " · Esc 回圆环可选预设"
        }
        return parts.joined(separator: " · ")
    }

    /// 重新弹输入条。
    /// - Parameter prefill: nil = 保留用户已经打进去的文字（默认）；
    ///                      传值 = 覆盖（套预设时就是要覆盖）
    private func showPromptBar(prefill: String? = nil) {
        chat.showInput(relativeTo: ring.frame,
                       purpose: .prompt,
                       prefill: prefill ?? chat.currentInput,
                       note: promptBarNote())
    }

    private func clearReferenceImage() {
        referenceImage = nil
        referenceName = ""
        state.lastImageName = ""
        pushRingState()
    }

    /// 独立模式的数据填充：模型、预设、对话模型与快捷提问都来自助手自己那份配置。
    /// 具体怎么填在 RingState.fillStandalone 里 —— 放那儿是为了让
    /// `--dump-menu --offline` 也走同一套，调试显示的和真实行为不会各说各话。
    private func applyStandaloneParams() {
        guard !state.connected else { return }
        state.fillStandalone(api: config.api,
                             presets: PresetStore.shared.items,
                             hasReply: !engine.history.isEmpty,
                             lastReply: engine.history.last?.text ?? "")
    }


    /// 把圆环上选的参数写回助手自己的配置（没插件时走这条）
    private func applyStandaloneParam(_ key: String, _ value: String) {
        switch key {
        case "model": config.api.imgModel = value
        case "resolution": config.api.imageSize = value
        case "count": config.api.imageCount = max(1, min(4, Int(value) ?? 1))
        default: return
        }
        config.save()
        applyStandaloneParams()
        toast.show(.success("已设置：\(value)", nil))
        // 圆环正开着的话，让勾选状态立刻跟上
        ring.refreshLevel(MenuBuilder.currentLevel(state: state, config: config))
    }

    /// 菜单内容变了（参考图、密钥可用性）就重推一次，
    /// 下次唤出圆环时才是最新的
    private func pushRingState() {
        // 圆环每次唤出都会重新构建菜单，这里只要保证 state 是新的就行；
        // 若圆环正开着，让它重画一次
        ring.refreshLevel(MenuBuilder.rootLevel(state: state, config: config))
    }

    /// 调试入口：`--simulate-generate` 用它走一遍**和「在气泡里按回车」完全相同**
    /// 的代码路径（含全部 UI 回调）。GUI 我没法点，但这条能跑。
    func debugSimulateGenerate(prompt: String) {
        startLocalGeneration(prompt: prompt)
    }

    /// 调试入口：预置一张参考图（--simulate-generate 的第二个参数）
    func debugSetReferenceImage(_ dataURL: String, name: String) {
        referenceImage = dataURL
        referenceName = name
        state.lastImageName = name
        applyStandaloneParams()
    }

    /// 没有插件时的生图：助手自己调接口、自己存盘、自己弹窗显示。
    private func startLocalGeneration(prompt: String) {
        guard config.api.isUsable else {
            toast.show(.failure("还没有配置接口密钥"))
            return
        }

        chat.showThinking(relativeTo: ring.frame, question: "生图：\(prompt)",
                          history: engine.history + [ChatTurn(role: "user", text: "生图：\(prompt)")])
        statusItem?.button?.title = "◐"

        Task { @MainActor in
            let api = config.api
            // 一次出多张 = 挨个调（GRS 一次只回一张）。
            // 费额度，所以张数是用户自己选的，菜单里也标着「×N 张」
            let total = max(1, min(4, api.imageCount))
            var saved: [URL] = []
            do {
                for index in 1...total {
                    let suffix = total > 1 ? "（第 \(index)/\(total) 张）" : ""
                    let url = try await engine.generate(prompt: prompt, api: api,
                                                        images: self.referenceImage.map { [$0] } ?? []) { stage in
                        // busy：这只是中间态。不加的话 showReply 会用 engine.history
                        // 整份替换聊天记录（这份里还没有当前这一问），进度文字会被整个丢掉；
                        // 而且它每次都 present()，等于每 2.5 秒把焦点从 Photoshop 抢回来一次
                        self.chat.updatePendingReply(history: self.engine.history,
                                                     question: "生图：\(prompt)",
                                                     text: stage + suffix, isError: false,
                                                     busy: true)
                    }
                    saved.append(url)
                }
                statusItem?.button?.title = "●"
                lastChatHistory = engine.history
                // 多张只弹最后一张 —— 一股脑弹四个窗更烦人，
                // 其余的都在同一个文件夹里，点「打开文件夹」就能看到
                if let last = saved.last, let image = NSImage(contentsOf: last) {
                    chat.dismiss()
                    results.show(image: image, fileURL: last, relativeTo: ring.frame)
                }
                toast.show(.success(total > 1 ? "已生成 \(total) 张" : "已生成并保存", nil))
                publishStatus()
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                statusItem?.button?.title = "✕"
                chat.showReply(relativeTo: ring.frame, history: engine.history,
                               question: "生图：\(prompt)", text: message, isError: true)
                publishStatus()
            }
        }
    }

    /// 从插件拉一份接口配置过来。省得用户在助手这边把密钥再填一遍。
    @objc private func importConfigFromPlugin() {
        guard state.connected else {
            toast.show(.failure("插件没连上 —— 先在 Photoshop 里打开幻梦AI 插件"))
            return
        }
        bridge.send(["type": "command", "action": "exportConfig", "resolved": true])
        // 预设单独要一份（体积大，分开发）
        bridge.send(["type": "command", "action": "exportPresets", "resolved": true])
        toast.show(.running("正在向插件要配置和预设…"))
    }

    /// 插件把配置推回来了
    private func applyImportedConfig(_ payload: [String: Any]) {
        let key = (payload["grsApiKey"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            toast.show(.failure("插件那边也没填 GRS 密钥"))
            return
        }

        config.api.grsApiKey = key
        if let region = payload["grsRegion"] as? String, !region.isEmpty {
            config.api.grsRegion = region
        }
        if let model = payload["imgModel"] as? String, !model.isEmpty {
            config.api.imgModel = model
        }
        if let size = payload["imageSize"] as? String, !size.isEmpty {
            config.api.imageSize = size
        }
        if let chatModel = payload["chatModel"] as? String, !chatModel.isEmpty {
            config.api.chatModel = chatModel
        }
        if let systemPrompt = payload["systemPrompt"] as? String, !systemPrompt.isEmpty {
            config.api.systemPrompt = systemPrompt
        }
        // 对话模型清单和快捷提问也一起拉过来 —— 助手没有自己的型号表，
        // 内置那份只是兜底
        if let models = payload["chatModels"] as? [String], !models.isEmpty {
            config.api.chatModels = models
        }
        if let questions = payload["chatQuestions"] as? [[String]], !questions.isEmpty {
            config.api.chatQuestions = questions
        }
        applyStandaloneParams()
        flushConfig()
        toast.show(.success("已导入接口配置", nil))
        applyStandaloneParams()
        NSLog("[幻梦圆环] 已从插件导入接口配置：模型 \(config.api.imgModel) / \(config.api.chatModel)，密钥 …\(key.suffix(4))")
    }

    private func removeSessionMonitors() {
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
    }

    private func perform(_ action: RingAction?) {
        guard let action else { return }
        switch action {
        case .closeRing:
            ring.cancel()
        case .command(let name):
            // 插件不在的时候，「生成」由助手自己干 —— 这就是独立可用的那一半。
            // 提示词用气泡收，和打字提问同一个输入条。
            if !state.connected {
                switch name {
                case "chatNew":
                    engine.reset()
                    applyStandaloneParams()
                    toast.show(.success("已清空聊天记录", nil))
                    return
                case "generateText":
                    // 纯文字 = 不要参考图。但**别把已经打好的提示词清了** ——
                    // 用户可能是先套了预设、再决定不带图
                    clearReferenceImage()
                    showPromptBar()
                    return
                // generate 是兜底路径（比如从偏好设置里把「生成」指派到了别的槽位）
                case "generateWithLast", "generate":
                    // 参考图已经挂在 referenceImage 上，直接写提示词。
                    // 同样带上已经打好的字，别清空。
                    showPromptBar()
                    return
                default:
                    break
                }
            }
            // resolved: true 告诉插件「这个动作助手已经解析过了，别再解析一次」。
            //
            // 为什么需要：插件侧有一层兼容旧版助手的 resolveSlotAction ——
            // 老助手只会发槽位 id（generate / chat / close…），插件得自己翻译。
            // 但新助手发的是**已经解析好的动作**，其中有些恰好和槽位 id 同名，
            // 插件会把它当成槽位 id 再查一次自己的配置，把用户在助手偏好设置里
            // 关掉「采用插件下发的扇区动作」后做的改动覆盖掉。
            //
            // 旧版助手不发这个字段，插件照旧翻译 —— 向后兼容不受影响。
            bridge.send(["type": "command", "action": name, "resolved": true])
        // 带参数的指令：对话提问、切对话模型。payload 原样交给插件，
        // 助手不需要知道里面是什么 —— 以后插件加新指令这边不用动。
        case .commandWith(let name, let payload):
            bridge.send(["type": "command", "action": name, "resolved": true, "payload": payload])

        // 圆环本地就能办的事，不发给插件
        case .local(let what):
            handleLocal(what)

        // setParam / applyPreset 必须把参数包在 payload 里。
        // 插件侧 ring-bridge.js 的 handleCommand 统一读 message.payload，
        // 之前这里发的是扁平字段，导致圆环里选模型/分辨率/数量/预设**静默失效**：
        // applyParam({}) 空转，applyPreset 拿到 undefined 报「找不到预设」。
        case .setParam(let key, let value):
            // 没插件时参数写进助手自己的配置 —— 那边没人接这条指令
            if !state.connected {
                applyStandaloneParam(key, value)
                return
            }
            bridge.send(["type": "command", "action": "setParam",
                         "payload": ["key": key, "value": value]])
        case .applyPreset(let name):
            if !state.connected {
                // 助手的预设：把提示词直接送进输入条，写不写随用户
                guard let preset = PresetStore.shared.find(name) else {
                    toast.show(.failure("找不到预设：\(name)"))
                    return
                }
                appliedPresetName = preset.name
                // 套预设就是要**覆盖**输入框 —— 但同时挂着的参考图必须留着，
                // 「截个图 + 套个预设」正是最常见的用法
                showPromptBar(prefill: preset.prompt)
                return
            }
            bridge.send(["type": "command", "action": "applyPreset",
                         "payload": ["name": name]])
        }
    }

    /// 圆环本地动作。
    ///
    /// 注意这里用的是 `ring.frame` 而不是「现在鼠标在哪」：
    /// 提交动作时圆环已经收起来了，但窗口的 frame 还停在刚才的位置，
    /// 气泡出现在圆环刚才在的地方才符合直觉。
    private func handleLocal(_ what: RingLocal) {
        switch what {
        case .textInput:
            chat.showInput(relativeTo: ring.frame)

        case .importImage:
            pickReferenceImage()

        case .screenshot:
            waitForScreenshot()

        case .showReply:
            // 优先用助手手里那份完整记录；没有（助手刚重启过）就找插件要，
            // 插件那边才是唯一事实 —— 它答完就把整份 history 推回来
            if !lastChatHistory.isEmpty {
                chat.showConversation(relativeTo: ring.frame, history: lastChatHistory)
                return
            }
            guard state.chatHasReply || !lastChatReply.isEmpty else {
                toast.show(.failure("还没有对话可看"))
                return
            }
            chatWantsHistory = true
            bridge.send(["type": "command", "action": "chatHistory", "resolved": true])
            // 插件没连上或者太老不认这个指令时，别让用户对着空气等
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                guard let self, self.chatWantsHistory else { return }
                self.chatWantsHistory = false
                let text = self.lastChatReply.isEmpty ? self.state.chatLastReply : self.lastChatReply
                guard !text.isEmpty else {
                    self.toast.show(.failure("还没有对话可看"))
                    return
                }
                let question = self.lastChatQuestion.isEmpty ? self.state.chatLastQuestion : self.lastChatQuestion
                self.chat.showConversation(relativeTo: self.ring.frame, history: [
                    ChatTurn(role: "user", text: question),
                    ChatTurn(role: "assistant", text: text),
                ])
            }
        }
    }

    private func setupHotkey() {
        hotkeyRegistered = hotkey.register(keyCode: hotkeyConfig.keyCode,
                                           modifiers: hotkeyConfig.modifiers) { [weak self] in
            self?.showRing(dragMode: false)
        }
        if !hotkeyRegistered {
            NSLog("[幻梦圆环] 快捷键注册失败，仍可用 ⌥右键唤出")
        }
    }

    /// 没授权时每 1.5 秒看一眼，一旦用户在系统设置里勾上了就立刻启用，
    /// 不用重启助手。菜单栏那一行也会跟着自动变。
    private func startWatchingForPermission() {
        guard permissionTimer == nil else { return }
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            guard AltRightClickTap.isTrusted else { return }

            self.permissionTimer?.invalidate()
            self.permissionTimer = nil
            self.setupTap()
            self.refreshMenu()
            self.toast.show(.success("辅助功能权限已生效，⌥右键可以用了", nil))
            NSLog("[幻梦圆环] 检测到辅助功能权限已授予，⌥右键监听已启用")
        }
    }

    private func setupTap() {
        // 先同步配置：这个函数也会在「偏好设置刚改完」时被调用，
        // 每次都用最新配置，免得 tap 里留着旧值
        tap.photoshopOnly = config.interaction.altRightClickPhotoshopOnly

        // ⌥右键唤出后圆环就留在原地：不用一直按着 Option，也不用按着右键。
        // 选完（左键点扇区 / 数字键）或按 Esc 才消失。
        // 松开的那个右键事件仍然吞掉，否则 Photoshop 会弹出它自己的右键菜单。
        tap.onDown = { [weak self] point in
            guard let self else { return }
            if self.ring.isVisible {
                self.ring.cancel()   // 再按一次视为收起
            } else {
                self.showRing(at: point, dragMode: false)
            }
        }
        tap.onDrag = { [weak self] point in
            self?.ring.updatePointer(screenPoint: point)
        }
        tap.onUp = { _ in
            // 故意不提交：提交交给左键点击或数字键
        }
        tap.onEscape = { [weak self] in
            // Esc 无论在第几层都直接关掉整个圆环
            guard let self, self.config.interaction.escapeToClose else { return }
            self.ring.cancel()
        }
        tap.onDigit = { [weak self] digit in
            guard let self, self.config.interaction.keyboardSelect,
                  digit <= self.ring.segmentCount else { return }
            self.ring.commitIndex(digit - 1)
        }
        tap.onBack = { [weak self] in
            guard let self, self.ring.canGoBack else { return }
            self.ring.goBack()
        }

        if !AltRightClickTap.isTrusted {
            NSLog("[幻梦圆环] 尚未获得辅助功能权限，⌥右键暂不可用（快捷键不受影响）")
            // 必须先激活再弹框。本程序是 .accessory，不进 Dock、不抢焦点，
            // 系统授权框会被别的窗口盖住 —— 用户根本看不见，只会觉得「点了没反应」。
            // 只在这一次授权流程里抢焦点，之后就还回去。
            NSApp.activate(ignoringOtherApps: true)
            AltRightClickTap.requestPermission()
            startWatchingForPermission()
            return
        }
        if !tap.start() {
            NSLog("[幻梦圆环] 事件监听启动失败，当前只能用快捷键唤出")
            startWatchingForPermission()
        }
    }

    // MARK: - 唤出

    private func currentLevel() -> RingLevel {
        // 判断收在 MenuBuilder.currentLevel 里，和 --dump-menu 共用一套逻辑。
        // 原先这里写的是「没插件就显示占位菜单」—— 那是助手还只会当遥控器时的规矩，
        // 结果是 PS 一关整个圆环就废了（独立模式白做）。
        MenuBuilder.currentLevel(state: state, config: config)
    }

    private func showRing(at point: CGPoint? = nil, dragMode: Bool) {
        let target: CGPoint
        if let point {
            target = point          // ⌥右键：永远在鼠标处
        } else if config.interaction.summonAtCursor {
            target = NSEvent.mouseLocation
        } else if let screen = NSScreen.main {
            target = CGPoint(x: screen.frame.midX, y: screen.frame.midY)
        } else {
            target = NSEvent.mouseLocation
        }
        ring.show(at: target, level: currentLevel(), dragMode: dragMode)
    }

    @objc private func showRingFromMenu() {
        showRing(dragMode: false)
    }

    /// 两件事都要做，缺一不可：
    ///   1. 弹系统授权框 —— 只有弹过这个框，系统才会把本程序**登记进**
    ///      辅助功能列表。少了这一步，列表里根本找不到 HuanmengRing，
    ///      用户点开系统设置只会看到一堆别的程序，以为程序坏了。
    ///   2. 打开系统设置页 —— 框里点「打开系统设置」也能到，但用户常常
    ///      顺手点掉，所以这边补一次直达。
    @objc private func requestPermission() {
        NSApp.activate(ignoringOtherApps: true)
        AltRightClickTap.requestPermission()
        startWatchingForPermission()
        refreshMenu()

        // 名字就是 **HuanmengRing**（文件名），不是 Info.plist 里的显示名
        // 「幻梦圆环」—— 用户实测确认过：列表里显示的是文件名。
        // 别再"想当然地更正"成中文名：那会把人指到错的地方，
        // 用户按显示名去找会说「列表里根本没有」。
        // （教训：这个 App 文件名和显示名不一致，以用户实际看到的为准。）
        toast.show(.running("在「辅助功能」里找 HuanmengRing → 打开开关"))

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            AltRightClickTap.openAccessibilitySettings()
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - BridgeServerDelegate

    func bridgeDidChangeConnection(connected: Bool) {
        // 握手和连接状态回调可能都报一次同样的状态，这里去重，
        // 免得日志里同一件事打印两遍、也免得菜单栏反复重画。
        guard state.connected != connected else { return }
        state.connected = connected

        // 连接状态直接反映在菜单栏图标上：实心 ◎ 已连接，空心 ○ 等待插件。
        // 插件侧会静默重连，这里不需要弹任何提示。
        if statusItem?.button?.title != "◐" {
            statusItem?.button?.title = connected ? "◎" : "○"
        }
        refreshMenu()
        NSLog(connected ? "[幻梦圆环] 插件已连接" : "[幻梦圆环] 插件已断开，等待重连")
    }

    func bridgeDidReceive(_ message: [String: Any]) {
        guard let type = message["type"] as? String else { return }
        switch type {
        case "state":
            guard let payloadDict = message["payload"],
                  let data = try? JSONSerialization.data(withJSONObject: payloadDict) else {
                NSLog("[幻梦圆环] state 缺少 payload")
                return
            }
            do {
                let payload = try JSONDecoder().decode(BridgeStatePayload.self, from: data)
                state.apply(payload)
                refreshMenu()
            } catch {
                stateDecodeFailures += 1
                // 把具体字段错误打出来。多数情况是**旧的卫星插件还连着**，
                // 它发的是老协议（例如 resolution 是字符串数组而不是对象数组）。
                // 前几次说清楚原因和怎么做，之后就不再刷屏了 ——
                // 每帧打一遍同样的错误会把有用的日志淹掉。
                if stateDecodeFailures == 1 {
                    NSLog("""
                    [幻梦圆环] state 解析失败：\(error)
                        → 几乎可以肯定是**旧的卫星插件还挂在 UDT 里**，它连着同一个端口、发的是老协议。
                        → 处理：在 UDT 里 Unload 掉 com.huanmeng.ai.satellite / .probe，只留 com.huanmeng.ai.retouch。
                        → 菜单栏 → 自检… 可以随时复查。
                    """)
                } else if stateDecodeFailures % 50 == 0 {
                    NSLog("[幻梦圆环] state 解析失败累计 \(stateDecodeFailures) 次，仍然是旧卫星插件的问题")
                }
            }
        case "progress":
            handleProgress(message)
        case "chat":
            handleChat(message)
        case "config":
            // 插件把配置推回来了（用户点了「从插件导入」）
            guard let payload = message["payload"] as? [String: Any] else { break }
            switch message["action"] as? String {
            case "export":
                applyImportedConfig(payload)
            case "presets":
                // 预设单独一条消息推来（可能有上百条，不塞进 config 里）
                if let items = payload["items"] as? [[String: Any]] {
                    let count = PresetStore.shared.replaceAll(with: items)
                    applyStandaloneParams()
                    toast.show(.success("已导入 \(count) 条预设", nil))
                }
            default:
                break
            }
        case "log":
            if let text = message["message"] as? String {
                NSLog("[幻梦圆环·插件] \(text)")
            }
        default:
            break
        }
    }

    /// 对话推送。和生成用的 progress 分开，因为对话要显示的是**正文**，
    /// 塞进右下角那条提示里根本看不完。
    ///
    /// 三种事件：
    ///   thinking —— 圆环里点了快捷提问。气泡在这时候才弹出来，
    ///               用户才知道问题真的发出去了（等接口可能要十几秒）
    ///   reply    —— 收到回复，正文显示在气泡里
    ///   error    —— 失败原因也显示在气泡里，比一闪而过的提示条好读
    private func handleChat(_ message: [String: Any]) {
        let action = message["action"] as? String ?? ""
        let payload = message["payload"] as? [String: Any] ?? [:]
        let question = payload["question"] as? String ?? ""
        let history = parseHistory(payload["history"])

        switch action {
        case "thinking":
            lastChatQuestion = question
            // 打字提问时气泡已经开着，这里不会重复弹；
            // 快捷提问时气泡还没开，这才是它出现的地方
            if !chat.isVisible {
                chat.showThinking(relativeTo: ring.frame, question: question, history: history)
            } else {
                chat.updatePendingReply(history: history, question: question,
                                        text: "正在回复…", isError: false)
            }
        case "reply":
            let text = payload["text"] as? String ?? ""
            lastChatQuestion = question
            lastChatReply = text
            lastChatHistory = history
            chat.updatePendingReply(history: history, question: question, text: text, isError: false)
        case "error":
            let text = payload["message"] as? String ?? "提问失败"
            lastChatQuestion = question
            lastChatReply = ""
            lastChatHistory = history
            chat.updatePendingReply(history: history, question: question, text: text, isError: true)
        case "history":
            // 「看对话」时找插件要的那一份
            guard chatWantsHistory else { return }
            chatWantsHistory = false
            lastChatHistory = history
            chat.showConversation(relativeTo: ring.frame, history: history)
        default:
            break
        }
    }

    /// 把插件推的 history 数组转成聊天记录。
    /// 格式：`[{"role": "user"|"assistant", "text": "..."}]`
    private func parseHistory(_ raw: Any?) -> [ChatTurn] {
        guard let items = raw as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let text = item["text"] as? String, !text.isEmpty else { return nil }
            let role = item["role"] as? String ?? "assistant"
            return ChatTurn(role: role, text: text, isError: role == "assistant" && text.hasPrefix("发送失败"))
        }
    }

    /// 生成反馈：菜单栏图标 + 右下角浮动提示
    private func handleProgress(_ message: [String: Any]) {
        let phase = message["state"] as? String ?? "running"
        let text = message["message"] as? String ?? ""

        switch phase {
        case "running":
            statusItem?.button?.title = "◐"
            toast.show(.running(text))
        case "success", "done":
            statusItem?.button?.title = "●"
            toast.show(.success(text.isEmpty ? "生成完成" : text, decodeThumbnail(message["thumbnail"])))
        case "failure", "error":
            statusItem?.button?.title = "✕"
            toast.show(.failure(text.isEmpty ? "生成失败" : text))
        default:
            statusItem?.button?.title = "◎"
            toast.hide()
        }
    }

    /// 插件回传的是 data:image/...;base64，解成 NSImage 给提示窗显示
    private func decodeThumbnail(_ raw: Any?) -> NSImage? {
        guard let text = raw as? String,
              let commaIndex = text.firstIndex(of: ",") else { return nil }
        let base64 = String(text[text.index(after: commaIndex)...])
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else { return nil }
        return NSImage(data: data)
    }
}
