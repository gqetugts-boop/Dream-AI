// ============================================================
//  ImageSource.swift — 给「出图」找一张参考图
//
//  两条路：
//    · 导入文件：NSOpenPanel 选一张
//    · 截屏    ：**等用户自己截**（⇧⌘4 之类），助手盯着截图目录收
//
//  为什么截屏不做成「助手自己调 screencapture」：
//  那需要「屏幕录制」权限 —— 又一个系统授权框要走。用户已经有自己顺手的
//  截图习惯（系统截图、微信、Snipaste…），**只要它落盘，助手就能收**，
//  不用再教用户一套新操作，也不用再求一次权限。
//  （代价：截图工具只把图放剪贴板的话收不到 —— 这个在提示里说清楚。）
// ============================================================

import AppKit
import Foundation

enum ImageSource {

    /// 单张参考图的体积上限。截图动辄 3000+ 像素宽，原样 base64 上去
    /// 请求会大得离谱（而且模型也会自己缩），先缩到长边这么多像素再发。
    static let maxDimension: CGFloat = 2048

    // MARK: - 文件 → data URL

    /// 把一张图片转成接口要的 data URL。
    /// 需要长边超过 `maxDimension` 时按比例缩小；缩不了就返回原图。
    static func dataURL(from url: URL) -> String? {
        guard let image = NSImage(contentsOf: url) else { return nil }
        return dataURL(from: image)
    }

    static func dataURL(from image: NSImage) -> String? {
        guard let scaled = resized(image, maxDimension: maxDimension),
              let tiff = scaled.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            return nil
        }
        return "data:image/png;base64," + png.base64EncodedString()
    }

    /// 等比缩放到长边不超过 maxDimension。已经够小就原样返回。
    static func resized(_ image: NSImage, maxDimension: CGFloat) -> NSImage? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let longest = max(size.width, size.height)
        guard longest > maxDimension else { return image }

        let scale = maxDimension / longest
        let target = NSSize(width: (size.width * scale).rounded(),
                            height: (size.height * scale).rounded())

        let result = NSImage(size: target)
        result.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        image.draw(in: NSRect(origin: .zero, size: target),
                   from: NSRect(origin: .zero, size: size),
                   operation: .copy, fraction: 1.0)
        result.unlockFocus()
        return result
    }

    // MARK: - 选文件

    /// 弹一个文件选择框。取消返回 nil。
    static func pickFile() -> URL? {
        let panel = NSOpenPanel()
        panel.title = "选一张图作为参考"
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.png, .jpeg, .heic, .tiff, .gif, .webP, .bmp]

        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK else { return nil }
        return panel.url
    }
}

// MARK: - 等下一张截图

/// 盯着截图目录，出现新图片就交出来。
///
/// 为什么用轮询而不是 FSEvents：截图落盘是「先建文件、再写内容」，
/// FSEvents 会在文件还是 0 字节时就报出来，还得再做一轮等待。
/// 0.7 秒轮询一次，逻辑简单、行为可预测，代价可以忽略。
final class ScreenshotWatcher {

    /// 截图保存目录。系统设置里改过的话要读 com.apple.screencapture
    static var screenshotFolder: URL {
        let task = Process()
        task.launchPath = "/usr/bin/defaults"
        task.arguments = ["read", "com.apple.screencapture", "location"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !path.isEmpty {
                return URL(fileURLWithPath: NSString(string: path).expandingTildeInPath)
            }
        } catch {
            // 读不到就用默认值，不是错误
        }
        return URL(fileURLWithPath: NSString(string: "~/Desktop").expandingTildeInPath)
    }

    private var timer: Timer?
    private var known: Set<String> = []
    private var folder: URL = ScreenshotWatcher.screenshotFolder

    /// 找到了新图（主线程回调）
    var onCapture: ((URL) -> Void)?
    /// 超时没等到（主线程回调）
    var onTimeout: (() -> Void)?

    /// 最多等这么久。截个图不该让人等 3 分钟。
    private let timeout: TimeInterval = 120

    private var startedAt = Date()

    var isRunning: Bool { timer != nil }

    func start() {
        guard timer == nil else { return }
        folder = Self.screenshotFolder
        startedAt = Date()
        known = Set(imageFiles(in: folder).map { $0.path })

        timer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        if Date().timeIntervalSince(startedAt) > timeout {
            stop()
            onTimeout?()
            return
        }
        for url in imageFiles(in: folder) where !known.contains(url.path) {
            // 刚建出来的文件可能还在写。等它稳定下来再交出去 ——
            // 不然会拿到一张只有上半截的图，而且下面还会再触发一次。
            guard isStable(url) else { continue }
            known.insert(url.path)
            stop()
            onCapture?(url)
            return
        }
    }

    private func imageFiles(in folder: URL) -> [URL] {
        let manager = FileManager.default
        guard let items = try? manager.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]) else { return [] }

        let extensions = ["png", "jpg", "jpeg", "heic", "tiff", "gif", "webp"]
        return items.filter { extensions.contains($0.pathExtension.lowercased()) }
    }

    /// 文件大小连续两次采样一样 = 写完了
    private func isStable(_ url: URL) -> Bool {
        func size() -> Int? {
            (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue
        }
        guard let first = size(), first > 0 else { return false }
        usleep(120_000)
        guard let second = size() else { return false }
        return first == second
    }
}
