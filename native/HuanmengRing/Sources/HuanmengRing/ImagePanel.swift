// ============================================================
//  ImagePanel.swift — 出图结果的浮窗
//
//  没有 Photoshop 的时候，图总得有个地方看。这个窗口就是干这个的：
//  显示刚出的图（按屏幕缩放）、能拖、能存、能打开所在文件夹。
//
//  和对话气泡一样是 borderless + nonactivating 面板，
//  canBecomeKey 必须显式覆写 —— 不覆写连按钮都点不动（同一类坑）。
//
//  这里用标准 NSButton 而不是自绘：这是个有明确按钮的正常窗口，
//  自绘除了多写一百行没有任何好处。圆环那边不铺底板是设计选择，
//  这条规矩不该传染到所有窗口上。
// ============================================================

import AppKit

private final class ResultPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// 背景板：负责「按住拖动窗口」。
/// 按钮和图片是它的子视图，点在它们身上不会走到这里 ——
/// 所以拖空白处是移动窗口、拖图片是……也是移动窗口（图片没有别的用途），
/// 点按钮才是按钮。
private final class DragBackdrop: NSView {
    var onDragBegan: (() -> Void)?
    var onDragMoved: (() -> Void)?
    var onDragEnded: (() -> Void)?

    override func mouseDown(with event: NSEvent) { onDragBegan?() }
    override func mouseDragged(with event: NSEvent) { onDragMoved?() }
    override func mouseUp(with event: NSEvent) { onDragEnded?() }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class ImagePanelController {

    private var panel: NSPanel
    private var imageView: NSImageView
    private var titleLabel: NSTextField
    private var pathLabel: NSTextField
    private var saveButton: NSButton
    private var revealButton: NSButton
    private var closeButton: NSButton
    private var backdrop: DragBackdrop

    /// 当前显示的文件（「保存」和「打开文件夹」都用它）
    private var currentURL: URL?
    private var manualTopLeft: NSPoint?
    private var dragStart: NSPoint?
    private var dragOrigin: NSPoint?

    var isVisible: Bool { panel.isVisible }

    init() {
        let frame = NSRect(x: 0, y: 0, width: 520, height: 460)
        panel = ResultPanel(contentRect: frame,
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered,
                            defer: false)
        backdrop = DragBackdrop(frame: frame)
        imageView = NSImageView(frame: .zero)
        titleLabel = NSTextField(labelWithString: "生成结果")
        pathLabel = NSTextField(labelWithString: "")
        saveButton = NSButton(title: "另存为…", target: nil, action: nil)
        revealButton = NSButton(title: "打开文件夹", target: nil, action: nil)
        closeButton = NSButton(title: "关闭", target: nil, action: nil)

        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovable = false
        panel.contentView = backdrop

        backdrop.wantsLayer = true
        backdrop.layer?.backgroundColor = NSColor(calibratedWhite: 0.09, alpha: 0.97).cgColor
        backdrop.layer?.cornerRadius = 14
        backdrop.layer?.borderWidth = 1
        backdrop.layer?.borderColor = NSColor(calibratedWhite: 1, alpha: 0.14).cgColor

        titleLabel.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        titleLabel.textColor = NSColor(calibratedWhite: 1, alpha: 0.85)
        pathLabel.font = NSFont.systemFont(ofSize: 10)
        pathLabel.textColor = NSColor(calibratedWhite: 1, alpha: 0.42)
        pathLabel.lineBreakMode = .byTruncatingMiddle

        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter

        for button in [saveButton, revealButton, closeButton] {
            button.bezelStyle = .rounded
            button.font = NSFont.systemFont(ofSize: 11)
        }
        saveButton.target = self
        saveButton.action = #selector(saveAs)
        revealButton.target = self
        revealButton.action = #selector(reveal)
        closeButton.target = self
        closeButton.action = #selector(close)

        for view in [imageView, titleLabel, pathLabel, saveButton, revealButton, closeButton] {
            backdrop.addSubview(view)
        }

        backdrop.onDragBegan = { [weak self] in self?.dragBegan() }
        backdrop.onDragMoved = { [weak self] in self?.dragMoved() }
        backdrop.onDragEnded = { [weak self] in self?.dragEnded() }
    }

    // MARK: - 显示

    func show(image: NSImage, fileURL: URL?, relativeTo anchorFrame: NSRect) {
        currentURL = fileURL
        imageView.image = image
        if let fileURL {
            titleLabel.stringValue = "生成结果 · \(Self.fileSize(fileURL))"
            pathLabel.stringValue = fileURL.path
        } else {
            titleLabel.stringValue = "生成结果"
            pathLabel.stringValue = ""
        }

        layout(anchor: anchorFrame)
        panel.orderFrontRegardless()
        // 只把窗口拿到 key，不激活 App —— 看图不需要抢键盘，
        // 这点和对话气泡不同（那边要输入法）
        panel.makeKeyAndOrderFront(nil)
    }

    func dismiss() {
        guard panel.isVisible else { return }
        manualTopLeft = nil
        panel.orderOut(nil)
    }

    private static func fileSize(_ url: URL) -> String {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let bytes = (attributes?[.size] as? NSNumber)?.doubleValue ?? 0
        return bytes > 1024 * 1024
            ? String(format: "%.1f MB", bytes / 1024 / 1024)
            : String(format: "%.0f KB", bytes / 1024)
    }

    // MARK: - 布局

    private func layout(anchor: NSRect) {
        let screen = NSScreen.screens.first { $0.frame.intersects(anchor) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        // 窗口不超过屏幕的 70%，也不小于 360×320
        let width = min(max(anchor.width * 2.2, 380), min(720, visible.width * 0.7))
        let height = min(max(visible.height * 0.6, 320), visible.height * 0.8)

        let pad: CGFloat = 14
        let bar: CGFloat = 26
        let buttonRow: CGFloat = 26

        titleLabel.frame = NSRect(x: pad, y: height - pad - 16, width: width - pad * 2, height: 16)
        pathLabel.frame = NSRect(x: pad, y: height - pad - 32, width: width - pad * 2, height: 14)
        imageView.frame = NSRect(x: pad, y: pad + buttonRow + 8,
                                 width: width - pad * 2,
                                 height: height - pad * 2 - bar - 6 - buttonRow - 8)

        closeButton.frame = NSRect(x: width - pad - 72, y: pad, width: 72, height: buttonRow - 2)
        revealButton.frame = NSRect(x: width - pad - 72 - 96, y: pad, width: 92, height: buttonRow - 2)
        saveButton.frame = NSRect(x: width - pad - 72 - 96 - 84, y: pad, width: 80, height: buttonRow - 2)

        var origin = CGPoint(x: anchor.midX - width / 2, y: anchor.minY - 12 - height)
        if let topLeft = manualTopLeft {
            origin = CGPoint(x: topLeft.x, y: topLeft.y - height)
        } else if origin.y < visible.minY {
            let above = anchor.maxY + 12
            origin.y = (above + height <= visible.maxY) ? above : visible.minY + 8
        }
        origin.x = min(max(origin.x, visible.minX + 8), max(visible.minX, visible.maxX - width - 8))
        origin.y = min(max(origin.y, visible.minY + 8), max(visible.minY, visible.maxY - height - 8))

        panel.setFrame(NSRect(origin: origin, size: CGSize(width: width, height: height)), display: true)
        backdrop.frame = NSRect(origin: .zero, size: CGSize(width: width, height: height))
    }

    // MARK: - 拖动（和对话气泡同一套：左上角锚点 + 抖动阈值）

    @objc private func close() { dismiss() }

    /// 由 backdrop 的鼠标事件调用
    func dragBegan() {
        dragStart = NSEvent.mouseLocation
        dragOrigin = panel.frame.origin
    }

    func dragMoved() {
        guard let start = dragStart, let origin = dragOrigin else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - start.x
        let dy = now.y - start.y
        if abs(dx) + abs(dy) < 3 { return }

        var target = NSPoint(x: origin.x + dx, y: origin.y + dy)
        if let visible = (panel.screen ?? NSScreen.main)?.visibleFrame {
            let size = panel.frame.size
            target.x = min(max(target.x, visible.minX), max(visible.minX, visible.maxX - size.width))
            target.y = min(max(target.y, visible.minY), max(visible.minY, visible.maxY - size.height))
        }
        panel.setFrameOrigin(target)
    }

    func dragEnded() {
        defer { dragStart = nil; dragOrigin = nil }
        guard dragStart != nil else { return }
        manualTopLeft = NSPoint(x: panel.frame.origin.x, y: panel.frame.origin.y + panel.frame.height)
    }

    // MARK: - 动作

    @objc private func reveal() {
        guard let url = currentURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @objc private func saveAs() {
        guard let url = currentURL else { return }
        let dialog = NSSavePanel()
        dialog.nameFieldStringValue = url.lastPathComponent
        dialog.canCreateDirectories = true
        dialog.title = "保存图片"
        NSApp.activate(ignoringOtherApps: true)
        if dialog.runModal() == .OK, let target = dialog.url {
            try? FileManager.default.copyItem(at: url, to: target)
        }
    }
}
