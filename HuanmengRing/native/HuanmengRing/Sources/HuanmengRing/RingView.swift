// ============================================================
//  RingView.swift — 圆环绘制与交互（扇形切块版）
//
//  视觉对齐 Blender 的饼菜单：每个扇区是一块环形楔形，
//  选中时整块高亮并向外弹出，文字水平居中在楔形里。
//
//  坐标：isFlipped = true，y 轴向下。
//  角度沿用 pie.js 的约定：-90°（正上方）为 0 号扇区起点，顺时针递增。
//  注意翻转坐标系里 addArc(clockwise:) 的视觉方向是反的，
//  外弧用 clockwise:false（角度递增方向）扫过去，内弧再反向扫回来。
// ============================================================

import AppKit

final class RingView: NSView {

    // MARK: - 状态

    var level: RingLevel? {
        didSet {
            // 必须一起重置 hoverIndex。层级切换后块数会变少，
            // 旧索引再拿去访问新数组就会越界崩溃（实测过 SIGTRAP）。
            hoverIndex = -1
            rebuildAnimationState()
            needsDisplay = true
        }
    }

    private var stack: [RingLevel] = []
    private(set) var hoverIndex: Int = -1
    private var geometry: RingGeometry?

    var dragMode: Bool = false

    var onCommit: ((RingSegment) -> Void)?
    var onCancel: (() -> Void)?
    var onLevelChange: ((RingLevel) -> Void)?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    /// 面板是非激活式的，不返回 true 的话第一次点击会被吞掉
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: - 动画

    private var timer: Timer?
    /// 出现进度 0→1，驱动缩放与淡入
    private var appear: CGFloat = 0
    /// 每个扇区的高亮程度 0→1，让选中是渐变而不是硬切
    private var highlight: [CGFloat] = []
    private let frameInterval: TimeInterval = 1.0 / 60.0

    private func rebuildAnimationState() {
        highlight = Array(repeating: 0, count: level?.segments.count ?? 0)
    }

    /// 唤出时调用：重新播放缩放淡入
    func startAnimation() {
        appear = 0
        rebuildAnimationState()
        ensureTimerRunning()
    }

    /// 层级切换时调用：只让高亮重新渐入，不重播整个圆环的淡入，
    /// 否则每进一级整个环都会闪一下。
    private func pulseHighlight() {
        rebuildAnimationState()
        ensureTimerRunning()
    }

    private func ensureTimerRunning() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: frameInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    func stopAnimation() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        var settled = true
        let speed = style.hoverSpeed

        if appear < 1 {
            appear = min(1, appear + style.appearStep)
            settled = false
        }

        guard let current = level else { return }
        for index in 0..<highlight.count where index < current.segments.count {
            let target: CGFloat = (index == hoverIndex && !current.segments[index].disabled) ? 1 : 0
            let delta = target - highlight[index]
            if abs(delta) > 0.01 {
                highlight[index] += delta * speed
                settled = false
            } else {
                highlight[index] = target
            }
        }

        needsDisplay = true
        if settled && appear >= 1 { stopAnimation() }
    }

    // MARK: - 外观

    /// 全部视觉参数都来自这里。默认值等于改造前的硬编码值，
    /// 所以不配置时外观与改造前一致。
    /// 赋值会触发重绘，偏好设置里的滑块才能实时预览。
    var style: RingStyle = .default {
        didSet {
            needsDisplay = true
            ensureTimerRunning()
        }
    }

    // MARK: - 绘制

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }

        // 不铺底板：窗口背景是透明的，圆环直接浮在 Photoshop 画布上。
        // 只画扇区和圆心，其余区域完全透出底下的图像。

        guard let current = level, !current.segments.isEmpty else { return }
        let base = RingGeometry(size: bounds.size, bandRatio: style.bandRatio)
        geometry = base

        // 出现动画：从 appearScale 倍放大到 1 倍
        let scale = style.appearScale + (1 - style.appearScale) * easeOut(appear)
        context.setAlpha(easeOut(appear) * style.opacity)

        let count = current.segments.count
        let step = 2 * Double.pi / Double(count)
        let gap = min(Double(style.gapMax), step * Double(style.gapRatio))
        let outer = base.outerRadius * scale
        let inner = base.innerRadius * scale

        // 没有底板之后，扇区直接压在图像上，暗部照片里边界会糊成一片。
        // 先把整个圆环的轮廓带投影铺一层，再画真正的扇区盖住它，
        // 这样只在最外缘留下柔和阴影，扇区之间不会出现内阴影。
        if style.shadowEnabled {
            context.saveGState()
            context.setShadow(offset: CGSize(width: 0, height: style.shadowOffsetY), blur: style.shadowBlur,
                              color: NSColor(calibratedWhite: 0, alpha: style.shadowAlpha).cgColor)
            let silhouette = CGMutablePath()
            for index in 0..<count {
                let mid = -Double.pi / 2 + Double(index) * step
                silhouette.addPath(wedgePath(center: base.center, inner: inner, outer: outer,
                                             start: CGFloat(mid - step / 2 + gap),
                                             end: CGFloat(mid + step / 2 - gap)))
            }
            silhouette.addEllipse(in: CGRect(x: base.center.x - inner, y: base.center.y - inner,
                                             width: inner * 2, height: inner * 2))
            context.setFillColor(NSColor.black.cgColor)
            context.addPath(silhouette)
            context.fillPath()
            context.restoreGState()
        }

        for (index, segment) in current.segments.enumerated() {
            let mid = -Double.pi / 2 + Double(index) * step
            let intensity = disabledAwareHighlight(segment: segment, index: index)
            // 选中时向外弹出，形成「被拎出来」的手感
            let pop = style.popOnHover ? intensity * style.popDistance : 0
            let start = CGFloat(mid - step / 2 + gap)
            let end = CGFloat(mid + step / 2 - gap)

            let path = wedgePath(center: base.center, inner: inner, outer: outer + pop,
                                 start: start, end: end)
            context.addPath(path)

            var fill = index % 2 == 0 ? style.wedgeFill : style.wedgeFillAlt
            if segment.disabled { fill = fill.withAlphaComponent(style.disabledWedgeAlpha) }
            fill = blend(from: fill, to: style.hoverFill, amount: intensity)
            context.setFillColor(fill.cgColor)
            context.fillPath()

            context.addPath(path)
            var edge = segment.disabled ? style.wedgeEdge.withAlphaComponent(style.disabledEdgeAlpha) : style.wedgeEdge
            edge = blend(from: edge, to: style.hoverEdge, amount: intensity)
            context.setStrokeColor(edge.cgColor)
            context.setLineWidth(1 + intensity)
            context.strokePath()
        }

        // 文字与勾画在扇区之上，避免被后画的扇区压住
        for (index, segment) in current.segments.enumerated() {
            let mid = -Double.pi / 2 + Double(index) * step
            let intensity = disabledAwareHighlight(segment: segment, index: index)
            let radius = (inner + outer) / 2 + (style.popOnHover ? intensity * style.popDistance : 0)
            let anchor = CGPoint(x: base.center.x + radius * CGFloat(cos(mid)),
                                 y: base.center.y + radius * CGFloat(sin(mid)))
            let color = segment.disabled ? style.textFaint : blend(from: style.text, to: .white, amount: intensity)
            drawLabel(segment.label, at: anchor, maxWidth: CGFloat(step) * radius * 0.9, color: color)
            if segment.checked {
                drawCheck(at: CGPoint(x: anchor.x, y: anchor.y + 13))
            }
            // 子菜单只能靠点击进入，所以必须标出来哪些扇区带下一级，
            // 否则用户根本不知道能点进去。
            if segment.children != nil && style.showChildMarker {
                drawChildMarker(at: CGPoint(x: base.center.x + (outer - 9) * CGFloat(cos(mid)),
                                            y: base.center.y + (outer - 9) * CGFloat(sin(mid))),
                                angle: CGFloat(mid),
                                intensity: intensity)
            }
        }

        // 圆心
        fillCircle(context, center: base.center, radius: inner - 2,
                   fill: style.hubFill, stroke: blend(from: style.hubEdge, to: style.hoverEdge, amount: hubIntensity()),
                   lineWidth: 1)
        drawHub()

        // 方向指示线：常驻模式下也保留，让「现在指向哪一块」一目了然
        if hoverIndex >= 0 && style.showDirectionLine {
            let mid = -Double.pi / 2 + Double(hoverIndex) * step
            let target = CGPoint(x: base.center.x + (outer + 7) * CGFloat(cos(mid)),
                                 y: base.center.y + (outer + 7) * CGFloat(sin(mid)))
            context.setStrokeColor(style.hoverEdge.withAlphaComponent(0.45).cgColor)
            context.setLineWidth(2)
            context.move(to: base.center)
            context.addLine(to: target)
            context.strokePath()
        }

        context.setAlpha(1)
    }

    private func disabledAwareHighlight(segment: RingSegment, index: Int) -> CGFloat {
        segment.disabled ? 0 : (index < highlight.count ? highlight[index] : 0)
    }

    private func hubIntensity() -> CGFloat {
        hoverIndex < 0 ? 0.55 : 0
    }

    private func easeOut(_ value: CGFloat) -> CGFloat {
        1 - pow(1 - value, 3)
    }

    private func blend(from: NSColor, to: NSColor, amount: CGFloat) -> NSColor {
        guard amount > 0.001 else { return from }
        let a = from.usingColorSpace(.deviceRGB) ?? from
        let b = to.usingColorSpace(.deviceRGB) ?? to
        return NSColor(calibratedRed: a.redComponent + (b.redComponent - a.redComponent) * amount,
                       green: a.greenComponent + (b.greenComponent - a.greenComponent) * amount,
                       blue: a.blueComponent + (b.blueComponent - a.blueComponent) * amount,
                       alpha: a.alphaComponent + (b.alphaComponent - a.alphaComponent) * amount)
    }

    /// 环形楔形：外弧正向扫，内弧反向扫回来，闭合。
    private func wedgePath(center: CGPoint, inner: CGFloat, outer: CGFloat,
                           start: CGFloat, end: CGFloat) -> CGPath {
        let path = CGMutablePath()
        path.addArc(center: center, radius: outer, startAngle: start, endAngle: end,
                    clockwise: false)
        path.addArc(center: center, radius: inner, startAngle: end, endAngle: start,
                    clockwise: true)
        path.closeSubpath()
        return path
    }

    private func fillCircle(_ context: CGContext, center: CGPoint, radius: CGFloat,
                            fill: NSColor, stroke: NSColor, lineWidth: CGFloat) {
        guard radius > 0 else { return }
        let rect = CGRect(x: center.x - radius, y: center.y - radius,
                          width: radius * 2, height: radius * 2)
        context.setFillColor(fill.cgColor)
        context.fillEllipse(in: rect)
        context.setStrokeColor(stroke.cgColor)
        context.setLineWidth(lineWidth)
        context.strokeEllipse(in: rect)
    }

    /// 标签水平居中绘制，最多两行（UXP 版也是手动切行，不依赖自动换行）
    private func drawLabel(_ text: String, at center: CGPoint, maxWidth: CGFloat, color: NSColor) {
        guard !text.isEmpty else { return }
        let width = max(48, maxWidth)
        let perLine = max(3, Int(width / 6.2))
        var lines: [String]
        if text.count <= perLine {
            lines = [text]
        } else {
            let first = String(text.prefix(perLine))
            var rest = String(text.dropFirst(perLine))
            if rest.count > perLine { rest = String(rest.prefix(perLine - 1)) + "…" }
            lines = [first, rest]
        }

        let lineHeight = style.labelLineHeight
        var y = center.y - (lineHeight * CGFloat(lines.count)) / 2
        for line in lines {
            drawCentered(line,
                         rect: CGRect(x: center.x - width / 2, y: y, width: width, height: lineHeight),
                         font: NSFont.systemFont(ofSize: style.labelFontSize, weight: .medium),
                         color: color)
            y += lineHeight
        }
    }

    /// 指向圆心外侧的小三角，表示这个扇区还有下一级
    private func drawChildMarker(at point: CGPoint, angle: CGFloat, intensity: CGFloat) {
        let size: CGFloat = 4
        let path = CGMutablePath()
        // 三角形朝向径向外侧，直观表示「往外还有一层」
        path.move(to: CGPoint(x: point.x + size * cos(angle),
                              y: point.y + size * sin(angle)))
        path.addLine(to: CGPoint(x: point.x + size * cos(angle + 2.2),
                                 y: point.y + size * sin(angle + 2.2)))
        path.addLine(to: CGPoint(x: point.x + size * cos(angle - 2.2),
                                 y: point.y + size * sin(angle - 2.2)))
        path.closeSubpath()
        let color = blend(from: style.textDim, to: .white, amount: intensity)
        NSGraphicsContext.current?.cgContext.setFillColor(color.cgColor)
        NSGraphicsContext.current?.cgContext.addPath(path)
        NSGraphicsContext.current?.cgContext.fillPath()
    }

    private func drawCheck(at point: CGPoint) {
        let path = NSBezierPath()
        path.move(to: CGPoint(x: point.x - 4, y: point.y))
        path.line(to: CGPoint(x: point.x - 1, y: point.y + 3))
        path.line(to: CGPoint(x: point.x + 4, y: point.y - 3))
        path.lineWidth = 1.8
        style.accent.setStroke()
        path.stroke()
    }

    private func drawHub() {
        guard let geo = geometry else { return }
        let radius = geo.innerRadius - 2
        // 越界防护：绘制跑在 AppKit 的显示周期里，任何一次越界都是直接崩溃，
        // 不能指望调用方永远把 hoverIndex 维护正确。
        var hovered: RingSegment? = nil
        if hoverIndex >= 0, let segments = level?.segments, hoverIndex < segments.count {
            hovered = segments[hoverIndex]
        }
        let title = hovered?.label ?? (stack.isEmpty ? "圆环" : "返回")
        var sub = hovered?.hint ?? (stack.isEmpty ? "Esc 取消" : "点圆心返回")
        if let hovered, hovered.children != nil, sub.isEmpty { sub = "子菜单" }
        if sub.count > 22 { sub = String(sub.prefix(21)) + "…" }

        drawCentered(title,
                     rect: CGRect(x: geo.center.x - radius, y: geo.center.y - 16,
                                  width: radius * 2, height: 16),
                     font: NSFont.systemFont(ofSize: style.hubTitleFontSize, weight: .semibold),
                     color: style.text)
        drawCentered(sub,
                     rect: CGRect(x: geo.center.x - radius, y: geo.center.y + 1,
                                  width: radius * 2, height: 13),
                     font: NSFont.systemFont(ofSize: style.hubSubFontSize, weight: .regular),
                     color: style.textFaint)
    }

    private func drawCentered(_ text: String, rect: CGRect, font: NSFont, color: NSColor) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byTruncatingTail
        NSAttributedString(string: text, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: paragraph
        ]).draw(in: rect)
    }

    // MARK: - 命中与确认

    func hitTestRing(point: CGPoint) -> Int? {
        guard let current = level, let geo = geometry else { return nil }
        return geo.hitTest(point: point, count: current.segments.count)
    }

    func updatePointer(_ point: CGPoint) {
        setHover(hitTestRing(point: point) ?? -1)
    }

    private func setHover(_ index: Int) {
        let normalized = index >= 0 ? index : -1
        guard normalized != hoverIndex else { return }
        hoverIndex = normalized
        ensureTimerRunning()
    }

    @discardableResult
    func commitHover() -> Bool {
        commitIndex(hoverIndex)
    }

    /// 确认指定扇区。index < 0 表示圆心。
    /// 进入下一级只在这里发生 —— 悬停只负责高亮，不展开子菜单，
    /// 否则鼠标路过带子项的扇区时会误触发。
    @discardableResult
    func commitIndex(_ index: Int) -> Bool {
        guard let current = level else { return false }
        if index < 0 {
            if !stack.isEmpty { popLevel(); return true }
            onCancel?()
            return true
        }
        guard index < current.segments.count else { return false }
        let segment = current.segments[index]
        if segment.disabled { return false }
        if let children = segment.children, !children.isEmpty {
            stack.append(current)
            let next = RingLevel(title: segment.label, segments: children)
            pulseHighlight()
            level = next
            onLevelChange?(next)
            return true
        }
        onCommit?(segment)
        return true
    }

    func popLevel() {
        guard let previous = stack.popLast() else { return }
        pulseHighlight()
        level = previous
        onLevelChange?(previous)
    }

    var canGoBack: Bool { !stack.isEmpty }

    func resetLevels() {
        stack.removeAll()
        hoverIndex = -1
    }

    // MARK: - 鼠标（点击模式）

    override func mouseMoved(with event: NSEvent) {
        updatePointer(convert(event.locationInWindow, from: nil))
    }

    override func mouseUp(with event: NSEvent) {
        updatePointer(convert(event.locationInWindow, from: nil))
        commitHover()
    }
}
