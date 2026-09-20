// ============================================================
//  Doctor.swift — 自检
//
//  目标：出问题时不用猜、不用看日志、不用问人，直接告诉用户
//  「哪儿不对」和「点哪里能修」。
//
//  两个出口：
//    · 菜单栏「自检…」→ 弹窗，给普通使用者看
//    · 命令行 --doctor → 打印，给排查问题时用
//
//  这里的每一项检查都是**能实际验证的**，不做「可能存在风险」这种
//  没法行动的提示。宁可少报，也不报没法处理的。
// ============================================================

import AppKit
import ApplicationServices

struct DoctorFinding {
    enum Level {
        case ok, warn, fail

        var mark: String {
            switch self {
            case .ok: return "✅"
            case .warn: return "⚠️"
            case .fail: return "❌"
            }
        }
    }

    let level: Level
    let title: String
    let detail: String

    /// 有没有需要用户动手的地方
    var needsAction: Bool { level != .ok }
}

/// 只有程序自己知道的运行时信息。
/// 两个来源：正在运行的助手直接传进来，或者命令行去读它写的状态文件。
struct DoctorRuntime {
    var bridgeConnected = false
    var stateDecodeFailures = 0
    var tapActive = false
    var hotkeyRegistered = false
    var hotkeyDisplay = ""

    /// 辅助功能权限。
    /// nil = 真的不知道（命令行跑，且助手没在运行、没有状态文件）。
    /// **绝不能**在这种情况下现场调 AXIsProcessTrusted() ——
    /// 那读到的是终端自己的权限，会给出一个可能是反的结论（踩过）。
    var trusted: Bool?

    /// 数据是否来自运行中的助手。false 时有些项只能现测。
    var live = false

    static let empty = DoctorRuntime()
}

enum Doctor {

    // MARK: - 各项检查

    static func report(runtime: DoctorRuntime = .empty) -> [DoctorFinding] {
        var effective = runtime

        // 命令行模式：去读助手写的状态文件，拿到**当事进程**的真实情况。
        // 读不到就只能承认不知道，不能猜。
        if !runtime.live, let snapshot = StatusFile.read() {
            effective = DoctorRuntime(
                bridgeConnected: snapshot.bridgeConnected,
                stateDecodeFailures: snapshot.stateDecodeFailures,
                tapActive: snapshot.tapActive,
                hotkeyRegistered: snapshot.hotkeyOK,
                hotkeyDisplay: snapshot.hotkey,
                trusted: snapshot.trusted,
                live: true
            )
        }

        var findings: [DoctorFinding] = []
        findings.append(checkPermission(runtime: effective))
        findings.append(checkPort(runtime: effective))
        findings.append(checkPhotoshop())
        findings.append(checkPlugin())
        findings.append(checkSatellite(runtime: effective))
        findings.append(checkHotkey(runtime: effective))
        findings.append(checkConfig())
        return findings
    }

    // 1. 辅助功能权限
    private static func checkPermission(runtime: DoctorRuntime) -> DoctorFinding {
        guard let trusted = runtime.trusted else {
            return DoctorFinding(
                level: .warn,
                title: "辅助功能权限：无法判定",
                detail: "助手当前没有在运行，读不到它的权限状态。\n"
                      + "（从终端直接调 AXIsProcessTrusted() 读的是**终端自己**的权限，"
                      + "跟助手没关系，所以这里不做这种无效推断。）\n"
                      + "启动助手后：菜单栏 ◎ → 「辅助功能权限：已授权 ✓」就是好了。")
        }

        guard trusted else {
            return DoctorFinding(
                level: .warn,
                title: "辅助功能权限未授权（助手进程的读数是未授权）",
                detail: "⌥右键唤出用不了，但 ⌥⌘R 快捷键不受影响、可以正常用。\n"
                      + "要开 ⌥右键：点菜单栏的「⚠️ 点这里授予辅助功能权限」，会直接跳到系统设置页。\n\n"
                      + "列表里找 **HuanmengRing**（文件名）或 **幻梦圆环**（显示名）——\n"
                      + "这个 App 两个名字不一致，系统设置显示哪个取决于它取哪一个，别只找一个。\n\n"
                      + "列表里根本没有、或者开关勾上又弹回去，按顺序做：\n"
                      + "  1. 把「系统设置」整个退出（⌘Q）再打开 ——\n"
                      + "     那个列表是窗口打开时加载的，新登记的程序不会自己冒出来\n"
                      + "  2. 点菜单栏 ◎ →「⚠️ 点这里授予辅助功能权限」\n"
                      + "     （别从终端跑 --request-permission：系统可能把请求算在终端头上）\n"
                      + "  3. 还不行就  tccutil reset Accessibility com.huanmeng.ring  再重来一次")
        }

        return DoctorFinding(
            level: runtime.tapActive ? .ok : .warn,
            title: "辅助功能权限已授权",
            detail: runtime.tapActive
                ? "⌥右键唤出可用。"
                : "权限有了但监听没起来 —— 退出助手重开一次即可。")
    }

    // 2. 桥接端口
    private static func checkPort(runtime: DoctorRuntime) -> DoctorFinding {
        let port = UInt16(max(1, min(65535, RingConfig.load().bridge.port)))
        let busy = isPortBusy(port)

        if runtime.bridgeConnected {
            return DoctorFinding(level: .ok, title: "插件已连接（端口 \(port)）",
                                 detail: "圆环和 Photoshop 插件之间的通道正常。")
        }
        if busy {
            // 命令行模式下不知道插件的连接状态，但可以查出来端口是不是**自己人**占的。
            // 助手在跑本来就该占着这个端口 —— 直接报 ❌ 是误报。
            if !runtime.live && otherHelperIsRunning() {
                return DoctorFinding(
                    level: .ok,
                    title: "端口 \(port) 被助手自己占用（正常）",
                    detail: "助手正在运行。是否连上 Photoshop 插件请看菜单栏 ◎ 菜单里那一行状态。")
            }
            return DoctorFinding(
                level: .fail,
                title: "端口 \(port) 被占用，但插件没连上",
                detail: "多半是还有另一个圆环助手在跑，或者旧的卫星插件占着这个端口。\n"
                      + "处理：退出所有圆环助手（菜单栏 → 退出），在 UDT 里 Unload 掉旧卫星插件，"
                      + "然后重开助手。")
        }
        return DoctorFinding(
            level: .warn,
            title: "插件未连接（端口 \(port) 空闲）",
            detail: "助手在等插件连过来，但端口上什么都没有 —— 说明 Photoshop 里的插件没在跑。\n"
                  + "处理：在 UDT 里 Load「Dream-ps-ai」，然后在 PS 里打开「插件 → 幻梦AI 修图插件」。")
    }

    // 3. Photoshop
    private static func checkPhotoshop() -> DoctorFinding {
        let running = NSRunningApplication
            .runningApplications(withBundleIdentifier: "com.adobe.Photoshop")
            .contains { !$0.isTerminated }

        return running
            ? DoctorFinding(level: .ok, title: "Photoshop 正在运行", detail: "")
            : DoctorFinding(level: .warn, title: "Photoshop 没有运行",
                            detail: "圆环本身能用，但所有操作都要靠插件执行，先用不到。")
    }

    // 4. 插件目录
    private static func checkPlugin() -> DoctorFinding {
        guard let manifest = locatePluginManifest() else {
            return DoctorFinding(
                level: .warn,
                title: "没找到插件目录",
                detail: "助手和插件通常是并排的两个文件夹（HuanmengRing / Dream-ps-ai）。\n"
                      + "移动过目录的话，在 UDT 里重新 Add Plugin 指到 Dream-ps-ai 就行。")
        }
        return DoctorFinding(level: .ok, title: "插件目录正常",
                             detail: manifest.deletingLastPathComponent().path)
    }

    // 5. 旧卫星插件
    //
    //  这一项基于**实证**而不是猜目录：旧卫星插件发的是老协议，
    //  连上来会让 state 解码失败。解码失败次数 > 0 就基本可以确诊。
    private static func checkSatellite(runtime: DoctorRuntime) -> DoctorFinding {
        if runtime.stateDecodeFailures > 0 {
            return DoctorFinding(
                level: .fail,
                title: "检测到 \(runtime.stateDecodeFailures) 次状态解析失败",
                detail: "几乎可以肯定是旧的「卫星插件」还挂在 UDT 里、连着同一个端口。\n"
                      + "它会和主插件抢连接，表现为圆环显示「未连接」或参数不对。\n"
                      + "处理：在 UDT 里 Unload 掉 com.huanmeng.ai.satellite / .probe，"
                      + "只保留 com.huanmeng.ai.retouch。")
        }

        let leftovers = satelliteStorageDirs()
        if !leftovers.isEmpty {
            return DoctorFinding(
                level: .ok,
                title: "没有旧卫星插件在抢连接",
                detail: "磁盘上还留着 \(leftovers.count) 个旧卫星插件的存储目录，"
                      + "那只是历史数据，不影响使用。")
        }
        return DoctorFinding(level: .ok, title: "没有旧卫星插件残留", detail: "")
    }

    // 6. 快捷键
    private static func checkHotkey(runtime: DoctorRuntime) -> DoctorFinding {
        let config = RingConfig.load()
        let display = HotkeyConfig.parse(config.effectiveHotkey)?.display ?? "⌥⌘R"

        guard runtime.live else {
            // 命令行模式：真的去注册一次试试。注册完立刻注销，
            // 进程马上就退，不会留下任何影响 —— 但能如实回答「这个组合是不是被占了」。
            return probeHotkey(display: display, text: config.effectiveHotkey)
        }

        if runtime.hotkeyRegistered {
            return DoctorFinding(level: .ok,
                                 title: "快捷键 \(runtime.hotkeyDisplay) 已注册",
                                 detail: "不需要任何系统权限。")
        }
        return DoctorFinding(
            level: .warn,
            title: "快捷键注册失败",
            detail: "多半是别的程序占了这个组合。\n"
                  + "处理：菜单栏 → 偏好设置 → 交互 → 全局热键，换一个组合（例如 ctrl+alt+r）。")
    }

    /// 试注册一次。成功说明组合是空的。
    private static func probeHotkey(display: String, text: String) -> DoctorFinding {
        // 解析不出来就用内置默认值 —— 和 AppDelegate 的回退策略保持一致
        let parsed = HotkeyConfig.parse(text) ?? HotkeyConfig()
        let manager = HotkeyManager()
        let ok = manager.register(keyCode: parsed.keyCode, modifiers: parsed.modifiers) {}
        manager.unregister()

        return ok
            ? DoctorFinding(level: .ok, title: "快捷键 \(display) 可以注册", detail: "这个组合没被别的程序占用。")
            : DoctorFinding(level: .warn, title: "快捷键 \(display) 注册失败",
                            detail: "这个组合被别的程序占了。\n"
                                  + "处理：菜单栏 → 偏好设置 → 交互 → 全局热键，换一个组合（例如 ctrl+alt+r）。")
    }

    // 7. 配置文件
    private static func checkConfig() -> DoctorFinding {
        let path = RingConfig.configPath
        guard FileManager.default.fileExists(atPath: path) else {
            return DoctorFinding(level: .ok, title: "配置文件还没生成",
                                 detail: "第一次改动偏好设置时会自动创建：\(path)")
        }
        // 能 Load 出来就说明容错层没被触发到崩，再确认一下它确实解析成了对象
        guard let data = FileManager.default.contents(atPath: path),
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else {
            return DoctorFinding(
                level: .warn,
                title: "配置文件不是合法的 JSON 对象",
                detail: "助手会用默认值继续跑，但你的自定义设置没生效。\n"
                      + "处理：把 \(path) 删掉，它会重建一份干净的。")
        }
        return DoctorFinding(level: .ok, title: "配置文件正常", detail: path)
    }

    // MARK: - 输出

    static func text(_ findings: [DoctorFinding], runtime: DoctorRuntime) -> String {
        var lines: [String] = []
        for finding in findings {
            lines.append("\(finding.level.mark) \(finding.title)")
            if !finding.detail.isEmpty {
                for line in finding.detail.split(separator: "\n", omittingEmptySubsequences: false) {
                    lines.append("     \(line)")
                }
            }
        }
        let problems = findings.filter { $0.needsAction }.count
        lines.append("")
        lines.append(problems == 0
            ? "全部正常，可以直接用。唤出方式：⌥右键 或 \(runtime.hotkeyDisplay.isEmpty ? "⌥⌘R" : runtime.hotkeyDisplay)"
            : "有 \(problems) 项要处理，按上面的说明做一遍就行。")
        return lines.joined(separator: "\n")
    }

    // MARK: - 工具

    /// 端口上有没有人在监听。
    /// SO_REUSEADDR 允许绑到 TIME_WAIT 的端口，但绑不上正在 LISTEN 的端口，
    /// 所以 bind 失败就等于有人在听。
    static func isPortBusy(_ port: UInt16) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result != 0
    }

    /// 除了自己之外，还有没有别的助手实例在跑。
    /// 端口只能被一个进程绑住，所以「有人在跑」基本等价于「端口是自己人占的」。
    static func otherHelperIsRunning() -> Bool {
        let me = ProcessInfo.processInfo.processIdentifier
        return NSRunningApplication
            .runningApplications(withBundleIdentifier: "com.huanmeng.ring")
            .contains { $0.processIdentifier != me && !$0.isTerminated }
    }

    /// 从可执行文件往上找，定位并排的 Dream-ps-ai 插件目录。
    /// 不写死相对层级 —— 移动目录、换构建方式都不会找错。
    static func locatePluginManifest() -> URL? {
        var dir = Bundle.main.bundleURL
        for _ in 0..<8 {
            dir = dir.deletingLastPathComponent()
            if dir.path == "/" { break }
            let candidate = dir.appendingPathComponent("Dream-ps-ai/manifest.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    /// 旧卫星插件在 UXP 存储里的残留目录。
    ///
    /// 目录层级是 PluginsStorage/<宿主>/<版本>/<Developer|External>/<插件id> ——
    /// 写死层数容易数错一层，结果是**永远返回空**、自检永远说「没有残留」，
    /// 这种假阴性比不检查还糟。所以这里直接递归找，只认名字前缀。
    static func satelliteStorageDirs() -> [URL] {
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Adobe/UXP/PluginsStorage")
        guard FileManager.default.fileExists(atPath: base.path) else { return [] }

        var found: [URL] = []
        guard let walker = FileManager.default.enumerator(
            at: base,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles],
            errorHandler: { _, _ in true }
        ) else { return [] }

        for case let url as URL in walker {
            // 层数上限只是防止意外扫到巨型目录，正常 4 层就到底了
            guard walker.level <= 5 else { walker.skipDescendants(); continue }
            guard url.lastPathComponent.hasPrefix("com.huanmeng.ai.satellite") else { continue }
            found.append(url)
            walker.skipDescendants()   // 命中了就不必往里走
        }
        return found
    }
}
