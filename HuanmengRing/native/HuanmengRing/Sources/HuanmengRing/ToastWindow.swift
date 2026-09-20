// ============================================================
//  ToastWindow.swift — 生成进度 / 结果的浮动反馈
//
//  圆环选完就关了，进度没法画在圆环上，所以单开一个小窗：
//    运行中  停留在屏幕右下角，转圈 + 文案
//    成功    显示结果缩略图，几秒后自动淡出
//    失败    显示错误文案，停久一点
//
//  同样是 nonactivating 面板，不会抢走 Photoshop 的焦点。
// ============================================================

import AppKit

enum ToastState {
    case running(String)
    case success(String, NSImage?)
    case failure(String)
}

final class ToastView: NSView {

    var state: ToastState = .running("") {
        didSet { needsDisplay = true }
    }
    var spinnerPhase: CGFloat = 0 {
        didSet { if case .running = state { needsDisplay = true } }
    }

    override var isFlipped: Bool { true }

    private let background = NSColor(calibratedRed: 0.11, green: 0.11, blue: 0.13, alpha: 0.96)
    private let border = NSColor(calibratedWhite: 0.34, alpha: 1)
    private let textColor = NSColor(calibratedWhite: 0.93, alpha: 1)
    private let dimColor = NSColor(calibratedWhite: 0.62, alpha: 1)
    private let accent = NSColor(calibratedRed: 0.38, green: 0.72, blue: 1.0, alpha: 1)
    private let okColor = NSColor(calibratedRed: 0.36, green: 0.86, blue: 0.56, alpha: 1)
    private let errColor = NSColor(calibratedRed: 0.90, green: 0.44, blue: 0.44, alpha: 1)

    override func draw(_ dirtyRect: NSRect) {
        let rounded = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 10, yRadius: 10)
        background.setFill()
        rounded.fill()
        border.setStroke()
        rounded.lineWidth = 1
        rounded.stroke()

        switch state {
        case .running(let message):
            drawSpinner(at: CGPoint(x: 22, y: bounds.midY))
            drawText(message.isEmpty ? "生成中…" : message,
                     rect: CGRect(x: 42, y: bounds.midY - 8, width: bounds.width - 52, height: 16),
                     color: textColor)
        case .success(let message, let image):
            if let image, image.size.width > 0, image.size.height > 0 {
                // 按比例居中，直接 draw(in:) 会把图拉变形
                let side = bounds.height - 20
                let scale = min(side / image.size.width, side / image.size.height)
                let drawWidth = image.size.width * scale
                let drawHeight = image.size.height * scale
                image.draw(in: CGRect(x: 10 + (side - drawWidth) / 2,
                                      y: 10 + (side - drawHeight) / 2,
                                      width: drawWidth, height: drawHeight),
                           from: .zero, operation: .sourceOver, fraction: 1)
                drawText(message,
                         rect: CGRect(x: side + 18, y: bounds.midY - 8, width: bounds.width - side - 28, height: 16),
                         color: okColor)
            } else {
                drawText(message,
                         rect: CGRect(x: 14, y: bounds.midY - 8, width: bounds.width - 28, height: 16),
                         color: okColor)
            }
        case .failure(let message):
            drawText(message,
                     rect: CGRect(x: 14, y: bounds.midY - 8, width: bounds.width - 28, height: 16),
                     color: errColor)
        }
    }

    /// 一个不依赖图片资源的转圈指示器
    private func drawSpinner(at center: CGPoint, radius: CGFloat = 7) {
        let segments = 8
        for index in 0..<segments {
            let angle = CGFloat(index) / CGFloat(segments) * 2 * .pi + spinnerPhase
            let alpha = 0.15 + 0.85 * (CGFloat(index) / CGFloat(segments))
            let point = CGPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
            accent.withAlphaComponent(alpha).setFill()
            NSBezierPath(ovalIn: CGRect(x: point.x - 1.6, y: point.y - 1.6, width: 3.2, height: 3.2)).fill()
        }
    }

    private func drawText(_ text: String, rect: CGRect, color: NSColor) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
            .foregroundColor: color,
            .paragraphStyle: paragraph
        ]).draw(in: rect)
    }
}

final class ToastPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class ToastController {

    private var window: ToastPanel
    private var view: ToastView
    private var spinnerTimer: Timer?
    private var dismissTimer: Timer?
    private var phase: CGFloat = 0

    private let width: CGFloat = 232
    private let baseHeight: CGFloat = 44

    init() {
        let frame = NSRect(x: 0, y: 0, width: width, height: baseHeight)
        window = ToastPanel(contentRect: frame,
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered,
                            defer: false)
        window.isFloatingPanel = true
        window.becomesKeyOnlyIfNeeded = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        window.ignoresMouseEvents = true
        view = ToastView(frame: frame)
        window.contentView = view
    }

    func show(_ state: ToastState) {
        dismissTimer?.invalidate()
        dismissTimer = nil

        var height = baseHeight
        if case .success(_, let image) = state, image != nil { height = 96 }

        view.state = state
        window.setContentSize(NSSize(width: width, height: height))
        view.frame = NSRect(x: 0, y: 0, width: width, height: height)
        positionAtCorner()
        window.orderFrontRegardless()

        switch state {
        case .running:
            startSpinner()
        case .success:
            stopSpinner()
            dismissTimer = Timer.scheduledTimer(withTimeInterval: 4.5, repeats: false) { [weak self] _ in
                self?.hide()
            }
        case .failure:
            stopSpinner()
            dismissTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
                self?.hide()
            }
        }
    }

    func hide() {
        stopSpinner()
        dismissTimer?.invalidate()
        dismissTimer = nil
        window.orderOut(nil)
    }

    private func startSpinner() {
        guard spinnerTimer == nil else { return }
        spinnerTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 20.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.phase += 0.35
            self.view.spinnerPhase = self.phase
        }
        RunLoop.main.add(spinnerTimer!, forMode: .common)
    }

    private func stopSpinner() {
        spinnerTimer?.invalidate()
        spinnerTimer = nil
    }

    private func positionAtCorner() {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let origin = CGPoint(x: visible.maxX - width - 24, y: visible.minY + 24)
        window.setFrameOrigin(origin)
    }
}
