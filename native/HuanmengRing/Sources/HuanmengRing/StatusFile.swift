// ============================================================
//  StatusFile.swift — 把助手的真实运行状态写到一个文件里
//
//  为什么需要它：
//    命令行跑 `--doctor` 时，AXIsProcessTrusted() 读到的是**终端自己**的权限，
//    不是助手的（TCC 按「责任进程」判定）。终端通常早就被授权过，
//    于是命令行报「已授权」而菜单栏同时报「未授权」—— 这个假阳性真的发生过，
//    白白浪费了一轮排查。
//
//    助手把状态写出来，自检就能读到**当事进程**的真实情况，
//    不用再猜、也不用让用户来回描述症状。
//
//  文件：~/.huanmeng-ring-status.json
//  里面带 pid，自检会先确认这个进程还活着，避免读到上次崩溃前的残留。
// ============================================================

import AppKit
import ApplicationServices

enum StatusFile {

    static var path: String {
        NSHomeDirectory() + "/.huanmeng-ring-status.json"
    }

    struct Snapshot {
        var pid: Int32 = 0
        var trusted = false
        var tapActive = false
        var hotkey = ""
        var hotkeyOK = false
        var bridgeConnected = false
        var stateDecodeFailures = 0
        var running = false
        var updatedAt = ""
    }

    /// 助手每次状态有变化就调一次。写失败一律吞掉 ——
    /// 这只是个诊断附件，绝不能因为它出错而影响助手本身。
    static func write(trusted: Bool, tapActive: Bool,
                      hotkey: String, hotkeyOK: Bool,
                      bridgeConnected: Bool, stateDecodeFailures: Int) {
        let snapshot: [String: Any] = [
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "trusted": trusted,
            "tapActive": tapActive,
            "hotkey": hotkey,
            "hotkeyOK": hotkeyOK,
            "bridgeConnected": bridgeConnected,
            "stateDecodeFailures": stateDecodeFailures,
            "running": true,
            "updatedAt": ISO8601DateFormatter().string(from: Date()),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted]) else {
            return
        }
        try? data.write(to: URL(fileURLWithPath: path))
    }

    /// 读回状态。pid 已经不在运行了就当没有 —— 否则会拿着上次崩溃前的残留下结论。
    static func read() -> Snapshot? {
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = json["pid"] as? Int
        else { return nil }

        // kill(pid, 0) 只探测进程在不在，不发信号
        guard kill(Int32(pid), 0) == 0 else { return nil }

        var snapshot = Snapshot()
        snapshot.pid = Int32(pid)
        snapshot.trusted = json["trusted"] as? Bool ?? false
        snapshot.tapActive = json["tapActive"] as? Bool ?? false
        snapshot.hotkey = json["hotkey"] as? String ?? ""
        snapshot.hotkeyOK = json["hotkeyOK"] as? Bool ?? false
        snapshot.bridgeConnected = json["bridgeConnected"] as? Bool ?? false
        snapshot.stateDecodeFailures = json["stateDecodeFailures"] as? Int ?? 0
        snapshot.running = true
        snapshot.updatedAt = json["updatedAt"] as? String ?? ""
        return snapshot
    }

    static func remove() {
        try? FileManager.default.removeItem(atPath: path)
    }
}
