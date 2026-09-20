// ============================================================
//  make-icon.swift — 画 App 图标（1024×1024 PNG）
//
//  为什么是画出来的而不是拿图生图生成的：
//    1. 生成的那张右下角带「AI生成」水印，裁掉很别扭
//    2. 更要紧的是**配色对不上** —— 图标应该和圆环本身长一样，
//       而圆环的颜色是 RingPalette 里那套值。直接用同一份数字画，
//       图标和实际界面才是同一个东西。
//    3. 想改（换个高亮色、换段数）改一行就行，不用重新生成。
//
//  用法：swift native/make-icon.swift <输出路径.png> [尺寸]
//  然后由 make-icon.sh 切成 iconset 打成 .icns
// ============================================================

import AppKit
import CoreGraphics

let args = CommandLine.arguments
let outPath = args.count > 1 ? args[1] : "icon.png"
let size = args.count > 2 ? (Double(args[2]) ?? 1024) : 1024

// 和 RingPalette 的默认值一致
func hex(_ value: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: alpha)
}

let wedgeFill = hex(0x33333B)
let wedgeFillAlt = hex(0x2B2B33)
let wedgeEdge = hex(0x5C5C5C, alpha: 0.85)
let hoverFill = hex(0x4278C2)
let hoverEdge = hex(0x85BDFF)
let hubFill = hex(0x1F1F24)

let ctx = CGContext(data: nil,
                    width: Int(size), height: Int(size),
                    bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

// macOS 图标的规矩：不画满，四周留出约 9% 的边距
let margin = size * 0.09
let squircle = CGRect(x: margin, y: margin, width: size - margin * 2, height: size - margin * 2)
let radius = squircle.width * 0.2237   // 苹果那个「超椭圆」的近似圆角比例

// ---- 底板：深色渐变 ----
let plate = CGPath(roundedRect: squircle, cornerWidth: radius, cornerHeight: radius, transform: nil)
ctx.saveGState()
ctx.addPath(plate)
ctx.clip()
let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                          colors: [hex(0x26262E), hex(0x15151A)] as CFArray,
                          locations: [0, 1])!
ctx.drawLinearGradient(gradient,
                       start: CGPoint(x: 0, y: squircle.maxY),
                       end: CGPoint(x: 0, y: squircle.minY),
                       options: [])
ctx.restoreGState()

// 板上沿一道极淡的高光，让它在深色背景里也有体积感
ctx.saveGState()
ctx.addPath(plate)
ctx.clip()
ctx.setStrokeColor(hex(0xFFFFFF, alpha: 0.06))
ctx.setLineWidth(size * 0.004)
ctx.addPath(plate)
ctx.strokePath()
ctx.restoreGState()

// ---- 圆环本体 ----
// 几何照抄 RingGeometry：从正上方（-90°）起算，顺时针
let center = CGPoint(x: size / 2, y: size / 2)
let outer = size * 0.315
let inner = outer * 0.44          // bandRatio 默认值
let count = 6
let step = 2 * Double.pi / Double(count)
let gap = 0.020                   // 弧度间隙，和界面上的观感一致

// ⚠️ 坐标系和界面那边是**反的**：CGContext 原点在左下、y 向上，
// 而 RingView 是翻转坐标系（y 向下）。所以界面上的「-90° = 正上方」
// 在这里要写成 +90°。第一版就是照抄了 -90°，结果高亮块跑到底下去了。
//
// 角度递减 = 屏幕上的顺时针。
func wedge(mid: Double, outerRadius: CGFloat) -> CGPath {
    let path = CGMutablePath()
    let start = CGFloat(mid + step / 2 - gap)
    let end = CGFloat(mid - step / 2 + gap)
    path.addArc(center: center, radius: outerRadius, startAngle: start, endAngle: end, clockwise: true)
    path.addArc(center: center, radius: inner, startAngle: end, endAngle: start, clockwise: false)
    path.closeSubpath()
    return path
}

// 高亮那一块稍微向外弹出，和悬停时的效果呼应
let pop = size * 0.012

// 投影**整圈一起画一次**，再盖上真正的扇区。
// 每块各画各的投影时，后画的那块会把阴影投在先画的那块上，
// 接缝处留下一条条黑边（第一版就是这样，看起来像裂开的）。
let silhouette = CGMutablePath()
for index in 0..<count {
    let mid = Double.pi / 2 - Double(index) * step
    silhouette.addPath(wedge(mid: mid, outerRadius: outer + (index == 0 ? pop : 0)))
}
silhouette.addEllipse(in: CGRect(x: center.x - inner, y: center.y - inner,
                                 width: inner * 2, height: inner * 2))
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -size * 0.008),
              blur: size * 0.022,
              color: hex(0x000000, alpha: 0.6))
ctx.addPath(silhouette)
ctx.setFillColor(hex(0x000000))
ctx.fillPath()
ctx.restoreGState()

for index in 0..<count {
    // 0 号在正上方，顺时针排
    let mid = Double.pi / 2 - Double(index) * step
    let highlighted = (index == 0)
    let path = wedge(mid: mid, outerRadius: outer + (highlighted ? pop : 0))

    ctx.addPath(path)
    ctx.setFillColor(highlighted ? hoverFill : (index % 2 == 0 ? wedgeFill : wedgeFillAlt))
    ctx.fillPath()

    ctx.addPath(path)
    ctx.setStrokeColor(highlighted ? hoverEdge : wedgeEdge)
    ctx.setLineWidth(size * (highlighted ? 0.006 : 0.0035))
    ctx.strokePath()
}

// ---- 圆心 ----
let hub = CGRect(x: center.x - inner + size * 0.004, y: center.y - inner + size * 0.004,
                 width: (inner - size * 0.004) * 2, height: (inner - size * 0.004) * 2)
ctx.setFillColor(hubFill)
ctx.fillEllipse(in: hub)
ctx.setStrokeColor(hoverEdge.copy(alpha: 0.5)!)
ctx.setLineWidth(size * 0.0035)
ctx.strokeEllipse(in: hub)

// ---- 导出 ----
guard let image = ctx.makeImage() else {
    FileHandle.standardError.write("✗ 画不出图\n".data(using: .utf8)!)
    exit(1)
}
let rep = NSBitmapImageRep(cgImage: image)
rep.size = NSSize(width: size, height: size)
guard let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("✗ PNG 编码失败\n".data(using: .utf8)!)
    exit(1)
}
do {
    try png.write(to: URL(fileURLWithPath: outPath))
    print("✓ \(outPath)（\(Int(size))×\(Int(size))）")
} catch {
    FileHandle.standardError.write("✗ 写文件失败：\(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
