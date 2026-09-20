// ============================================================
//  RingModel.swift — 圆环数据模型与几何计算
//
//  几何算法与 UXP 版 pie.js 保持一致：
//    扇区从正上方（-90°）起算，顺时针排列
//    命中测试靠 atan2 + 半径，不依赖任何命中 API
// ============================================================

import Foundation
import CoreGraphics

/// 圆环里的一个扇区
struct RingSegment {
    var label: String
    var hint: String = ""
    /// 有这个值时，悬停/点击会推进到下一层
    var children: [RingSegment]? = nil
    /// 不可用（例如缺密钥的渠道），画成半透明且不响应
    var disabled: Bool = false
    /// 右上角的小勾，表示当前生效项
    var checked: Bool = false
    /// 选中后回调给桥接层的指令
    var action: RingAction? = nil
}

/// 扇区触发的动作，由 BridgeServer 编码成 JSON 发给插件
enum RingAction {
    case command(String)
    /// 带参数的指令（对话提问、切对话模型…），payload 原样透传给插件。
    /// setParam / applyPreset 本可以并进来，但它们是老协议的一部分，
    /// 改掉要两边同时动，不值当。
    case commandWith(String, [String: String])
    case setParam(key: String, value: String)
    case applyPreset(name: String)
    /// 只收起圆环。退出助手放在菜单栏里，不该由圆环中的一个块完成——
    /// 用户点「关闭」是想关圆环，结果整个 App 退掉会很突然。
    case closeRing
    /// 圆环自己就能完成的动作，不发给插件
    case local(RingLocal)
}

/// 由助手本地处理的动作
enum RingLocal {
    /// 打开输入条。**必须用原生文本控件**，否则中文输入法挂不上去
    case textInput
    /// 把上一条回复重新弹出来
    case showReply
    /// 选一个图片文件当参考图
    case importImage
    /// 等用户截一张图当参考图
    case screenshot
}

/// 一层菜单
struct RingLevel {
    var title: String
    var segments: [RingSegment]
}

/// 圆环几何。所有半径都以视图中心为原点、单位为点（point）。
struct RingGeometry {
    let center: CGPoint
    let outerRadius: CGFloat
    let innerRadius: CGFloat

    var ringRadius: CGFloat { (outerRadius + innerRadius) / 2 }
    /// 环带厚度
    var bandWidth: CGFloat { outerRadius - innerRadius }

    /// bandRatio 由配置提供（环带内径 / 外径），默认值等于改造前的 0.44。
    init(size: CGSize, bandRatio: CGFloat = 0.44) {
        let cx = size.width / 2
        let cy = size.height / 2
        var maxRadius = min(size.width, size.height) / 2 - 12
        if maxRadius < 60 {
            maxRadius = min(size.width, size.height) / 2 - 4
        }
        outerRadius = max(40, maxRadius)
        innerRadius = outerRadius * bandRatio
        center = CGPoint(x: cx, y: cy)
    }

    /// 第 index 个扇区的圆心（视图坐标系，y 向下）
    func itemCenter(index: Int, count: Int) -> CGPoint {
        guard count > 0 else { return center }
        let step = 2 * Double.pi / Double(count)
        let angle = -Double.pi / 2 + Double(index) * step
        return CGPoint(
            x: center.x + ringRadius * CGFloat(cos(angle)),
            y: center.y + ringRadius * CGFloat(sin(angle))
        )
    }

    /// 命中测试。返回 nil 表示在环外；返回 -1 表示落在圆心（返回上一层 / 关闭）。
    func hitTest(point: CGPoint, count: Int) -> Int? {
        let dx = point.x - center.x
        let dy = point.y - center.y
        let distance = sqrt(dx * dx + dy * dy)
        if distance < innerRadius { return -1 }
        if distance > outerRadius + 6 { return nil }
        guard count > 0 else { return nil }

        let step = 2 * Double.pi / Double(count)
        var angle = atan2(Double(dy), Double(dx))
        // 把 -90° 对齐到 0，并挪半个扇区，让扇区中心落在边界内
        angle += Double.pi / 2 + step / 2
        while angle < 0 { angle += 2 * Double.pi }
        let index = Int(angle / step) % count
        return index
    }
}
