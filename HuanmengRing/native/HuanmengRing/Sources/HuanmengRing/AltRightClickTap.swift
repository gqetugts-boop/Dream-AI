// ============================================================
//  AltRightClickTap.swift — 拦截「⌥ + 右键」唤出圆环
//
//  为什么带修饰键：全局吞掉普通右键会让 Photoshop 的原生右键菜单
//  （图层右键、画笔硬度调整）全部失效，日常没法用。
//  只有按住 Option 的右键才被接管，普通右键原样透传。
//
//  权限：CGEventTap 需要「辅助功能」(Accessibility) 授权。
//  未授权时 tap 创建失败，此时只有快捷键能用 —— 属于预期降级。
//
//  拖拽闭环：rightMouseDown 唤出后，后续的 rightMouseDragged /
//  rightMouseUp 也要一并吞掉并转发，否则圆环收不到移动就变成了死菜单。
// ============================================================

import AppKit
import ApplicationServices

final class AltRightClickTap {

    /// 圆环是否正被本次右键手势持有。只有持有期间才继续吞掉 drag/up。
    var isEngaged = false

    /// 圆环是否正在显示。为 true 时吞掉 Esc / 数字 / 删除键，
    /// 避免这些按键同时漏给 Photoshop（PS 里 Esc 会取消当前操作）。
    var captureKeys = false

    /// ⌥右键只在 Photoshop 前台时才拦截？
    ///
    /// 默认 false = 任何程序里都能唤出 —— 助手现在是个独立软件，
    /// Photoshop 没开的时候也得能唤出来。当初限制成只在 PS 里，
    /// 是因为那时助手只是 PS 的遥控器。
    /// 注意：**普通右键（不带 ⌥）任何情况下都原样透传**，这条从没变过。
    var photoshopOnly = false

    /// macOS 虚拟键码 → 数字。键盘上排 1-9。
    private static let digitKeyCodes: [Int64: Int] = [
        18: 1, 19: 2, 20: 3, 21: 4, 23: 5, 22: 6, 26: 7, 28: 8, 25: 9
    ]

    var onDown: ((CGPoint) -> Void)?
    var onDrag: ((CGPoint) -> Void)?
    var onUp: ((CGPoint) -> Void)?
    var onEscape: (() -> Void)?
    var onDigit: ((Int) -> Void)?
    var onBack: (() -> Void)?

    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// 监听是不是真的在跑（授权了但 tap 没起来是另一种故障）
    var isRunning: Bool { tap != nil }

    /// 弹出系统授权引导。
    /// 这一步还会把本程序登记进「辅助功能」列表 —— 不弹过这个框的话，
    /// 系统设置里根本找不到 HuanmengRing，用户想手动勾都没得勾。
    static func requestPermission() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    /// 直接跳到「隐私与安全性 → 辅助功能」那一页。
    /// 让用户在系统设置里自己翻三层菜单，是这套流程里最容易劝退的一步。
    static func openAccessibilitySettings() {
        let target = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        guard let url = URL(string: target) else { return }
        NSWorkspace.shared.open(url)
    }

    @discardableResult
    func start() -> Bool {
        guard tap == nil else { return true }

        let mask = (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDragged.rawValue)
            | (1 << CGEventType.rightMouseUp.rawValue)
            | (1 << CGEventType.keyDown.rawValue)

        let selfPointer = Unmanaged.passUnretained(self).toOpaque()

        guard let created = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: { _, type, event, userInfo in
                guard let userInfo else { return Unmanaged.passUnretained(event) }
                let manager = Unmanaged<AltRightClickTap>.fromOpaque(userInfo).takeUnretainedValue()
                return manager.handle(type: type, event: event)
            },
            userInfo: selfPointer
        ) else {
            NSLog("[幻梦圆环] 无法创建事件 tap：请在「系统设置 → 隐私与安全性 → 辅助功能」里授权")
            return false
        }

        tap = created
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        NSLog("[幻梦圆环] ⌥右键监听已启动")
        return true
    }

    func stop() {
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            if let runLoopSource {
                CFRunLoopRemoveSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
            }
        }
        tap = nil
        runLoopSource = nil
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let passThrough = Unmanaged.passUnretained(event)

        // 系统在超时或用户输入后会停用 tap，必须显式重新启用，
        // 否则监听会静默失效（这是 CGEventTap 最常见的坑）。
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return passThrough
        }

        if type == .keyDown {
            guard captureKeys else { return passThrough }
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            if code == 53 {
                DispatchQueue.main.async { self.onEscape?() }
                return nil
            }
            if code == 51 || code == 123 {
                DispatchQueue.main.async { self.onBack?() }
                return nil
            }
            if let digit = Self.digitKeyCodes[code] {
                DispatchQueue.main.async { self.onDigit?(digit) }
                return nil
            }
            return passThrough
        }

        switch type {
        case .rightMouseDown:
            let flags = event.flags
            // 必须带 ⌥；不带 ⌥ 的普通右键一律透传（否则会抢掉所有软件的右键菜单）
            guard flags.contains(.maskAlternate) else { return passThrough }
            // 可选：只在 PS 里拦。默认不限制 —— 独立使用时 PS 根本没开
            if photoshopOnly && !isPhotoshopFrontmost() { return passThrough }
            isEngaged = true
            let point = NSEvent.mouseLocation
            DispatchQueue.main.async { self.onDown?(point) }
            return nil

        case .rightMouseDragged:
            guard isEngaged else { return passThrough }
            let point = NSEvent.mouseLocation
            DispatchQueue.main.async { self.onDrag?(point) }
            return nil

        case .rightMouseUp:
            guard isEngaged else { return passThrough }
            isEngaged = false
            let point = NSEvent.mouseLocation
            DispatchQueue.main.async { self.onUp?(point) }
            return nil

        default:
            return passThrough
        }
    }

    private func isPhotoshopFrontmost() -> Bool {
        guard let bundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else {
            return false
        }
        return bundleID == "com.adobe.Photoshop"
    }
}
