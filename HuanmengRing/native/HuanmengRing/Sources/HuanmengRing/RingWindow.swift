// ============================================================
//  RingWindow.swift — 无边框透明置顶窗口 + 唤出控制器
//
//  关键点：
//    · styleMask 用 .borderless，backgroundColor 透明、isOpaque=false
//    · level 用 .screenSaver，才能盖在 Photoshop 和全屏窗口之上
//    · collectionBehavior 带上 .canJoinAllSpaces / .fullScreenAuxiliary，
//      否则 PS 进全屏模式后圆环不会出现
//    · 不调用 NSApp.activate，避免抢走 Photoshop 的焦点
// ============================================================

import AppKit

/// .nonactivatingPanel 是关键：普通窗口在不活跃状态下第一次点击
/// 只会用来激活 App，点不到按钮上；而且激活会抢走 Photoshop 的焦点。
final class RingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class RingController {

    /// 窗口边长。圆环外径由视图尺寸推导，留 12pt 边距。
    /// 由配置驱动，偏好设置里改「环大小」会即时生效。
    private var windowSize: CGFloat = 340

    /// 窗口边长的允许范围。太小会让环带挤成一条，太大在小屏上会超出可见区域。
    static let ringSizeRange: ClosedRange<CGFloat> = 200...900

    private var window: RingPanel
    private(set) var ringView: RingView
    private(set) var isVisible = false
    private var pointerTimer: Timer?

    var onCommit: ((RingSegment) -> Void)?
    var onCancel: (() -> Void)?
    /// 显隐变化通知，用来挂/摘 Esc 的全局监听
    var onVisibilityChange: ((Bool) -> Void)?

    init(config: RingConfig) {
        let size = min(max(CGFloat(config.appearance.ringSize), Self.ringSizeRange.lowerBound),
                       Self.ringSizeRange.upperBound)
        windowSize = size
        let frame = NSRect(x: 0, y: 0, width: size, height: size)
        window = RingPanel(contentRect: frame,
                           styleMask: [.borderless, .nonactivatingPanel],
                           backing: .buffered,
                           defer: false)
        window.isFloatingPanel = true
        window.becomesKeyOnlyIfNeeded = true
        ringView = RingView(frame: frame)
        ringView.style = RingStyle(config)

        window.contentView = ringView
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        window.ignoresMouseEvents = false
        window.acceptsMouseMovedEvents = true
        window.isMovable = false

        ringView.onCommit = { [weak self] segment in
            self?.hide()
            self?.onCommit?(segment)
        }
        ringView.onCancel = { [weak self] in
            self?.hide()
            self?.onCancel?()
        }
    }

    /// 应用新配置。偏好设置里每次改动都会调到这里，所以必须便宜、可重入。
    /// 尺寸变化时保持窗口中心不动 —— 否则正在显示时改大小，圆环会在屏幕上跳一下。
    func apply(config: RingConfig) {
        ringView.style = RingStyle(config)

        let size = min(max(CGFloat(config.appearance.ringSize), Self.ringSizeRange.lowerBound),
                       Self.ringSizeRange.upperBound)
        guard abs(size - windowSize) > 0.5 else { return }
        windowSize = size

        let center = CGPoint(x: window.frame.midX, y: window.frame.midY)
        var frame = window.frame
        frame.size = CGSize(width: size, height: size)
        frame.origin = CGPoint(x: center.x - size / 2, y: center.y - size / 2)
        window.setFrame(frame, display: true)
        // contentView 的 frame 由 AppKit 跟着窗口走，但保险起见显式同步一次
        ringView.frame = NSRect(x: 0, y: 0, width: size, height: size)
        ringView.needsDisplay = true
    }

    /// 在屏幕坐标处唤出圆环。screenPoint 用 NSEvent.mouseLocation 的坐标系（原点在左下）。
    func show(at screenPoint: CGPoint, level: RingLevel, dragMode: Bool) {
        ringView.resetLevels()
        ringView.dragMode = dragMode
        ringView.level = level

        let origin = clampedOrigin(for: screenPoint)
        window.setFrameOrigin(origin)
        window.orderFrontRegardless()
        ringView.startAnimation()
        startPointerTracking()
        if !isVisible {
            isVisible = true
            onVisibilityChange?(true)
        }

        // 让指针立刻高亮到当前方向，打开即有反馈
        updatePointer(screenPoint: screenPoint)
    }

    func hide() {
        guard isVisible else { return }
        ringView.stopAnimation()
        stopPointerTracking()
        window.orderOut(nil)
        isVisible = false
        onVisibilityChange?(false)
    }

    /// 换掉当前这一层菜单（参考图变了、密钥可用了之类）。
    /// 圆环没开着就什么都不做 —— 下次唤出本来就会重新构建。
    func refreshLevel(_ level: RingLevel) {
        guard isVisible else { return }
        ringView.level = level
    }

    /// 键盘直选：按数字键直接命中第 n 个扇区
    @discardableResult
    func commitIndex(_ index: Int) -> Bool {
        guard isVisible else { return false }
        return ringView.commitIndex(index)
    }

    /// 窗口在屏幕上的位置。对话气泡靠它定位（贴着圆环下方出现），
    /// 圆环收起后这个值仍然有效 —— 气泡正好出现在圆环刚才在的地方。
    var frame: NSRect { window.frame }

    var segmentCount: Int { ringView.level?.segments.count ?? 0 }
    var canGoBack: Bool { ringView.canGoBack }
    func goBack() { ringView.popLevel() }

    /// 把屏幕坐标换算成视图坐标并更新高亮
    func updatePointer(screenPoint: CGPoint) {
        guard isVisible else { return }
        let windowPoint = window.convertFromScreen(
            NSRect(origin: screenPoint, size: .zero)).origin
        let viewPoint = ringView.convert(windowPoint, from: nil)
        ringView.updatePointer(viewPoint)
    }

    /// 用当前鼠标位置刷新高亮。
    ///
    /// 不用 mouseMoved 事件，是因为它是否送达取决于窗口是不是 key，
    /// 而我们的面板是 nonactivating、App 也不活跃，这条链路不可靠。
    /// 直接按帧轮询 NSEvent.mouseLocation 最稳，代价可以忽略。
    func refreshPointerFromMouseLocation() {
        guard isVisible else { return }
        updatePointer(screenPoint: NSEvent.mouseLocation)
    }

    private func startPointerTracking() {
        guard pointerTimer == nil else { return }
        pointerTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.refreshPointerFromMouseLocation()
        }
        RunLoop.main.add(pointerTimer!, forMode: .common)
    }

    private func stopPointerTracking() {
        pointerTimer?.invalidate()
        pointerTimer = nil
    }

    func commit() {
        guard isVisible else { return }
        ringView.commitHover()
    }

    func cancel() {
        guard isVisible else { return }
        hide()
        onCancel?()
    }

    /// 圆环贴着屏幕边缘时往回挪，别让窗口跑出可见区域
    private func clampedOrigin(for screenPoint: CGPoint) -> CGPoint {
        var x = screenPoint.x - windowSize / 2
        var y = screenPoint.y - windowSize / 2

        let screen = NSScreen.screens.first { $0.frame.contains(screenPoint) }
            ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            x = min(max(x, visible.minX), visible.maxX - windowSize)
            y = min(max(y, visible.minY), visible.maxY - windowSize)
        }
        return CGPoint(x: x, y: y)
    }
}
