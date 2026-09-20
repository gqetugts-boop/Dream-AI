// ============================================================
//  main.swift — 入口
//
//  以「配件程序」方式运行：不占 Dock 图标、不进 ⌘Tab，
//  只在菜单栏留一个 ◎。
//
//  带 --doctor 时不启动界面，只跑一遍自检并打印结果然后退出。
//  这样终端里也能体检，不必去点菜单。
//
//  带 --dump-menu 时也不启动界面，只把「圆环会画成什么样、每个扇区点了发什么指令」
//  打印出来。圆环是画出来的，「某一项为什么没出现」在界面上看不出来。
// ============================================================

import AppKit

if CommandLine.arguments.contains("--doctor") {
    let findings = Doctor.report()
    print(Doctor.text(findings, runtime: .empty))
    exit(findings.contains { $0.level == .fail } ? 1 : 0)
}

if CommandLine.arguments.contains("--dump-menu") {
    exit(MenuDump.run(CommandLine.arguments))
}

// 图像提取的自检。那段逻辑跨了十几家渠道、出错时只是安静地说
// 「无法从响应中提取图像」，光看代码验不出来。
if CommandLine.arguments.contains("--selftest") {
    exit(ImageExtract.runSelfTest())
}

// 真的出一张图，验证「提交任务 → 轮询 → 提取图像 → 存盘」整条链路。
// 会消耗一点额度（nano-banana-fast 很便宜），但这是唯一能确认独立生图可用的办法。
if CommandLine.arguments.contains("--image-test") {
    let config = RingConfig.load()
    guard config.api.isUsable else {
        print("✗ 还没有配置接口密钥（先跑 --chat-test 看提示）")
        exit(1)
    }
    let index = CommandLine.arguments.firstIndex(of: "--image-test") ?? 0
    let rest = Array(CommandLine.arguments.dropFirst(index + 1)).filter { !$0.hasPrefix("--") }
    let prompt = rest.first ?? "一只在窗台上晒太阳的橘猫，柔和自然光"
    // 第二个位置参数是参考图路径 —— 传了就测「以图生图」那条路
    let imagePath = rest.count > 1 ? rest[1] : nil

    var reference: [String] = []
    if let imagePath {
        guard let dataURL = ImageSource.dataURL(from: URL(fileURLWithPath: imagePath)) else {
            print("✗ 读不出这张图：\(imagePath)")
            exit(1)
        }
        reference = [dataURL]
        let kb = dataURL.count * 3 / 4 / 1024
        print("参考图：\(imagePath)（编码后约 \(kb) KB）")
    }

    print("接口：\(config.api.resolvedBaseUrl)")
    print("模型：\(GrsClient.imageModelName(config.api.imgModel)) · \(config.api.imageSize)")
    print("提示词：\(prompt)")
    print("存到：\(config.api.resolvedOutputFolder)\n")

    // ⚠️ 这里**不能**用 semaphore.wait() 把主线程堵住：
    // onProgress 是 @MainActor 的，回调要排到主队列上执行，
    // 主线程一堵就是死锁。改成让主线程跑 run loop，任务结束时自己 exit。
    Task {
        var exitCode: Int32 = 1
        do {
            let engine = StandaloneEngine()
            let url = try await engine.generate(prompt: prompt, api: config.api,
                                                images: reference) { stage in
                print("  \(stage)")
            }
            let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
            print("✓ 出图成功：\(url.path)（\(bytes / 1024) KB）")
            exitCode = 0
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            print("✗ 失败：\(message)")
        }
        exit(exitCode)
    }
    RunLoop.main.run()
}

// 用配置里的密钥真的调一次对话接口，验证地址/鉴权/报文格式是否都对。
// 出问题时用户能自己跑这条命令定位，不用去翻日志。
if CommandLine.arguments.contains("--chat-test") {
    let config = RingConfig.load()
    guard config.api.isUsable else {
        print("✗ 还没有配置接口密钥。")
        print("  插件开着的时候：菜单栏 ◎ →「从插件导入接口配置」")
        print("  或者直接编辑 \(RingConfig.configPath) 里的 api.grsApiKey")
        exit(1)
    }

    print("接口：\(config.api.resolvedBaseUrl)")
    print("模型：\(GrsClient.chatModelName(config.api.chatModel))")
    print("密钥：…\(config.api.grsApiKey.suffix(4))")
    print("正在调用…\n")

    let semaphore = DispatchSemaphore(value: 0)
    var exitCode: Int32 = 1
    Task {
        do {
            let client = GrsClient(api: config.api)
            let reply = try await client.chat([["role": "user", "content": "用一句话打个招呼"]])
            print("✓ 接口通了，模型回答：")
            print("  \(reply)")
            exitCode = 0
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            print("✗ 失败：\(message)")
        }
        semaphore.signal()
    }
    semaphore.wait()
    exit(exitCode)
}

// 只做一件事：让系统把本程序**登记进**辅助功能列表，并弹出授权框，然后退出。
//
// 为什么需要单独一个命令：一个程序在「辅助功能」列表里出现的前提，
// 是它**至少请求过一次**权限（AXIsProcessTrustedWithOptions）。没请求过就是
// 压根不在列表里 —— 用户在列表里翻来覆去找不到，会以为程序坏了。
// 而助手平时是登录时由 launchd 静默拉起的，那一次弹框很容易被错过；
// 想再要一次弹框，跑这个就行，不用重启助手、不占 8799 端口。
if CommandLine.arguments.contains("--request-permission") {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
    AltRightClickTap.requestPermission()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
        // 弹框里点「打开系统设置」也能到，但用户常常顺手点掉，所以这边补一次直达
        AltRightClickTap.openAccessibilitySettings()
        print("已请求授权并打开系统设置。")
        print("")
        print("在「隐私与安全性 → 辅助功能」里找 **HuanmengRing** —— 打开它的开关。")
        print("（列表里显示的是文件名，不是显示名「幻梦圆环」。）")
        print("")
        print("⚠️ 列表里没有？")
        print("   1. 先把「系统设置」整个退出（⌘Q）再打开 ——")
        print("      那个列表是窗口打开那一刻加载的，新登记的程序不会自己冒出来")
        print("   2. 从终端跑这条命令时，系统可能把请求算在**终端**头上而不是助手头上。")
        print("      最可靠的是点菜单栏 ◎ →「⚠️ 点这里授予辅助功能权限」")
        exit(0)
    }
    app.run()
}

let application = NSApplication.shared
let appDelegate = AppDelegate()
application.delegate = appDelegate
application.setActivationPolicy(.accessory)

// 调试用：走一遍「在气泡里按回车生成」的完整代码路径（含 UI）。
// 用户报「一回车就退出」，GUI 我点不了，但这条能跑、能复现。
if let index = CommandLine.arguments.firstIndex(of: "--simulate-generate") {
    let rest = Array(CommandLine.arguments.dropFirst(index + 1)).filter { !$0.hasPrefix("--") }
    let prompt = rest.first ?? "一只在窗台上晒太阳的橘猫，柔和自然光"
    let imagePath = rest.count > 1 ? rest[1] : nil
    print("▶ 模拟：在气泡里输入「\(prompt)」并按回车")
    if let imagePath {
        print("  参考图：\(imagePath)")
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
        if let imagePath, let dataURL = ImageSource.dataURL(from: URL(fileURLWithPath: imagePath)) {
            appDelegate.debugSetReferenceImage(dataURL, name: URL(fileURLWithPath: imagePath).lastPathComponent)
        }
        appDelegate.debugSimulateGenerate(prompt: prompt)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 150) {
        print("✓ 撑过 150 秒没有异常退出")
        exit(0)
    }
}

application.run()
