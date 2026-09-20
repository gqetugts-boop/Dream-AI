// ============================================================
//  HotkeyManager.swift — 全局快捷键（Carbon RegisterEventHotKey）
//
//  为什么用 Carbon 而不是 CGEventTap：
//    RegisterEventHotKey 不需要「辅助功能」权限，装完立刻可用。
//    这样即使你没授权，也还有一条能唤出圆环的路。
//  代价：快捷键会被本进程独占，如果和 Photoshop 的快捷键撞了，
//        PS 那边就收不到了 —— 所以默认值选了一个几乎不可能冲突的组合，
//        并且可以在 ~/.huanmeng-ring.json 里改。
// ============================================================

import AppKit
import Carbon.HIToolbox

final class HotkeyManager {

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var handler: (() -> Void)?

    private let signature: OSType = 0x484D5247 // 'HMRG'

    /// 注册全局快捷键。keyCode 用 Carbon 虚拟键码，modifiers 用 Carbon 修饰符。
    @discardableResult
    func register(keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void) -> Bool {
        unregister()
        self.handler = handler

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        let selfPointer = Unmanaged.passUnretained(self).toOpaque()

        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, userData -> OSStatus in
                guard let userData else { return OSStatus(eventNotHandledErr) }
                let manager = Unmanaged<HotkeyManager>.fromOpaque(userData).takeUnretainedValue()
                manager.handler?()
                return noErr
            },
            1, &eventType, selfPointer, &eventHandler)

        guard installStatus == noErr else {
            NSLog("[幻梦圆环] 安装热键事件处理器失败：\(installStatus)")
            return false
        }

        let hotKeyID = EventHotKeyID(signature: signature, id: 1)
        let registerStatus = RegisterEventHotKey(
            keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)

        guard registerStatus == noErr else {
            NSLog("[幻梦圆环] 注册热键失败：\(registerStatus)（可能已被其它程序占用）")
            return false
        }
        return true
    }

    func unregister() {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
        if let eventHandler {
            RemoveEventHandler(eventHandler)
            self.eventHandler = nil
        }
        handler = nil
    }

    deinit { unregister() }
}

/// 快捷键配置。默认 ⌥⌘R —— Photoshop 没有占用这个组合。
struct HotkeyConfig {
    var keyCode: UInt32 = UInt32(kVK_ANSI_R)
    var modifiers: UInt32 = UInt32(optionKey | cmdKey)
    var display: String = "⌥⌘R"

    /// 支持在 ~/.huanmeng-ring.json 里写 {"hotkey": "ctrl+alt+cmd+r"} 覆盖。
    /// 注意这是**旧格式**：新格式把热键放在 config.interaction.hotkey。
    /// 两者都在时以 config 里的为准（由 RingConfig.effectiveHotkey 决定），
    /// 这里保留只为读旧文件时仍然可用。
    static func load() -> HotkeyConfig {
        let path = NSString(string: "~/.huanmeng-ring.json").expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = json["hotkey"] as? String else {
            return HotkeyConfig()
        }
        return parse(text) ?? HotkeyConfig()
    }

    /// 解析 "ctrl+alt+cmd+r" 这类字符串。解析失败返回 nil，由调用方决定回退策略。
    static func parse(_ text: String) -> HotkeyConfig? {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        var config = HotkeyConfig()
        var carbonModifiers: UInt32 = 0
        var display: [String] = []
        let parts = text.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
        var letter: String?
        for part in parts {
            switch part {
            case "cmd", "command": carbonModifiers |= UInt32(cmdKey); display.append("⌘")
            case "alt", "option", "opt": carbonModifiers |= UInt32(optionKey); display.append("⌥")
            case "ctrl", "control": carbonModifiers |= UInt32(controlKey); display.append("⌃")
            case "shift": carbonModifiers |= UInt32(shiftKey); display.append("⇧")
            default: letter = part
            }
        }
        guard let letter, letter.count == 1,
              let scalar = letter.uppercased().unicodeScalars.first else {
            NSLog("[幻梦圆环] 无法解析 hotkey：\(text)")
            return nil
        }
        let keyCode = keyCodeForLetter(Character(scalar))
        if keyCode == 0 {
            NSLog("[幻梦圆环] 暂不支持这个按键：\(letter)")
            return nil
        }
        config.keyCode = keyCode
        config.modifiers = carbonModifiers
        config.display = display.joined() + letter.uppercased()
        return config
    }

    private static func keyCodeForLetter(_ character: Character) -> UInt32 {
        let map: [Character: Int] = [
            "A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D,
            "E": kVK_ANSI_E, "F": kVK_ANSI_F, "G": kVK_ANSI_G, "H": kVK_ANSI_H,
            "I": kVK_ANSI_I, "J": kVK_ANSI_J, "K": kVK_ANSI_K, "L": kVK_ANSI_L,
            "M": kVK_ANSI_M, "N": kVK_ANSI_N, "O": kVK_ANSI_O, "P": kVK_ANSI_P,
            "Q": kVK_ANSI_Q, "R": kVK_ANSI_R, "S": kVK_ANSI_S, "T": kVK_ANSI_T,
            "U": kVK_ANSI_U, "V": kVK_ANSI_V, "W": kVK_ANSI_W, "X": kVK_ANSI_X,
            "Y": kVK_ANSI_Y, "Z": kVK_ANSI_Z
        ]
        guard let code = map[character] else { return 0 }
        return UInt32(code)
    }
}
