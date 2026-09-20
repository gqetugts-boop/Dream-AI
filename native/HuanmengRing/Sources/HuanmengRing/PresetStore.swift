// ============================================================
//  PresetStore.swift — 助手自己的预设库
//
//  以前预设只有插件有（`assets/presets/yushe.json`，二十多个分类）。
//  助手没插件时这一格就是空的、点不动 —— 而「选个预设直接出图」
//  恰恰是独立使用时最顺手的用法。
//
//  所以助手自己也存一份：`~/.huanmeng-presets.json`，格式和插件那份对齐
//  （category / name / prompt），插件连着的时候可以一键全量拉过来覆盖。
//
//  为什么单独一个文件而不是塞进主配置：
//    1. 预设是**内容**，可能几十上百条；主配置是**设置**，改坏了要恢复默认。
//       混在一起，每次读个热键都要把全部预设反序列化一遍。
//    2. 用户在插件里更新了预设，覆盖这个文件就行，不碰设置。
// ============================================================

import Foundation

/// 一条预设
struct PresetItem {
    var category: String
    var name: String
    var prompt: String

    var dictionary: [String: String] {
        ["category": category, "name": name, "prompt": prompt]
    }

    init(category: String, name: String, prompt: String) {
        self.category = category
        self.name = name
        self.prompt = prompt
    }

    init?(_ raw: [String: Any]) {
        let name = (raw["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = (raw["prompt"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !prompt.isEmpty else { return nil }
        self.category = (raw["category"] as? String)?.trimmingCharacters(in: .whitespaces)
            .nilIfEmpty ?? "未分类"
        self.name = name
        self.prompt = prompt
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

final class PresetStore {

    static let shared = PresetStore()

    private(set) var items: [PresetItem] = []

    /// 内置预设的版本号。**每次改动打包进去的那份 presets.json 就 +1** ——
    /// 用户那边靠它判断「要不要把新的内置预设装进去」。
    /// 1 = 最早那 8 条手写的；2 = 打包了插件的全部预设。
    private static let seedVersion = 2

    private let path: String = NSString(string: "~/.huanmeng-presets.json").expandingTildeInPath

    private init() {
        load()
    }

    // MARK: - 读写

    func load() {
        guard let data = FileManager.default.contents(atPath: path),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            // 还没有文件（或者还是最早的裸数组格式）：装一份内置的，
            // 别让用户面对一个空菜单
            seedBuiltIn()
            return
        }

        let seed = root["seed"] as? Int ?? 0
        if seed < Self.seedVersion {
            // 内置预设升级过（比如这次把插件的 68 条打进来了）。
            // 用户自己加的那些**保留**，内置的整体换新 —— 用名字去重。
            let mine = (root["items"] as? [[String: Any]] ?? []).compactMap { PresetItem($0) }
            let builtinNames = Set(Self.bundledPresets().map { $0.name })
            let keep = mine.filter { !builtinNames.contains($0.name) }
            seedBuiltIn(keeping: keep)
            return
        }
        items = (root["items"] as? [[String: Any]] ?? []).compactMap { PresetItem($0) }
    }

    /// 用插件推来的整份预设覆盖本地
    func replaceAll(with raw: [[String: Any]]) -> Int {
        let parsed = raw.compactMap { PresetItem($0) }
        guard !parsed.isEmpty else { return 0 }
        items = parsed
        save()
        return parsed.count
    }

    private func save() {
        let payload: [String: Any] = ["seed": Self.seedVersion,
                                      "items": items.map { $0.dictionary }]
        guard let data = try? JSONSerialization.data(withJSONObject: payload,
                                                     options: [.prettyPrinted]) else {
            return
        }
        do {
            try data.write(to: URL(fileURLWithPath: path))
        } catch {
            NSLog("[幻梦圆环] 预设写入失败：\(error.localizedDescription)")
        }
    }

    /// 按分类分组，顺序按第一次出现的先后（和插件那边一致）
    func grouped() -> [(category: String, items: [PresetItem])] {
        var order: [String] = []
        var buckets: [String: [PresetItem]] = [:]
        for item in items {
            if buckets[item.category] == nil {
                buckets[item.category] = []
                order.append(item.category)
            }
            buckets[item.category]?.append(item)
        }
        return order.map { ($0, buckets[$0] ?? []) }
    }

    func find(_ name: String) -> PresetItem? {
        items.first { $0.name == name }
    }

    var count: Int { items.count }

    // MARK: - 内置默认

    /// 装内置预设。优先用**打包进来的那份**（插件里的全部预设已经迁进来了），
    /// 读不到才退回下面那几条手写的兜底。
    ///
    /// 打包的那份在 App 的 Resources/presets.json ——
    /// 这样换台电脑装上就自带全部预设，不用先连插件导一次。
    /// 要更新它：把新的 yushe.json 拷到 Resources/presets.json，
    /// 并把 seedVersion +1（用户那边的旧内置预设才会被换掉）。
    static func bundledPresets() -> [PresetItem] {
        let candidates: [URL?] = [
            Bundle.main.url(forResource: "presets", withExtension: "json"),
            Bundle.main.bundleURL.appendingPathComponent("presets.json"),
            // 开发时直接跑 .build/debug 里的可执行文件，旁边没有资源，
            // 就顺着可执行文件位置往上找源码树
            Bundle.main.bundleURL
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("HuanmengRing/Resources/presets.json"),
        ]
        for case let url? in candidates {
            guard let data = try? Data(contentsOf: url),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                continue
            }
            let parsed = raw.compactMap { PresetItem($0) }
            if !parsed.isEmpty { return parsed }
        }
        return []
    }

    /// 装一份内置的。`keeping` 是用户自己加的、要保留的那些。
    private func seedBuiltIn(keeping: [PresetItem] = []) {
        let bundled = Self.bundledPresets()
        if !bundled.isEmpty {
            items = bundled + keeping
            save()
            NSLog("[幻梦圆环] 已装内置预设 \(bundled.count) 条\(keeping.isEmpty ? "" : "，另保留自建 \(keeping.count) 条")")
            return
        }

        // 读不到打包的那份（比如在开发环境直接跑可执行文件）——
        // 用下面这几条兜底，总比空菜单强
        let seeds: [(String, String, String)] = [
            ("人像", "自然磨皮", "轻微磨皮，保留皮肤纹理和毛孔，不要塑料感；眼睛和眉毛保持锐利。"),
            ("人像", "通透肤色", "统一肤色，去掉偏黄偏红，提亮暗部，让皮肤通透有光泽但不失质感。"),
            ("人像", "眼神光", "增强眼神光和瞳孔的高光，让眼睛更有神，不要改变眼型。"),
            ("风光", "通透风景", "增加层次和通透感，压暗高光提亮暗部，让远景更清晰但不生硬。"),
            ("风光", "黄昏氛围", "调成温暖的黄昏色调，加强天空的橙紫渐变，地面压暗成剪影感。"),
            ("通用", "电影感", "电影感调色：低饱和、青橙对比、轻微暗角，高光柔和过渡。"),
            ("通用", "日系清新", "日系清新风格：提亮、降饱和、偏青绿，画面通透柔和。"),
            ("通用", "黑白质感", "转黑白并加强中间调对比，突出质感和纹理，不要死黑死白。"),
        ]
        items = seeds.map { PresetItem(category: $0.0, name: $0.1, prompt: $0.2) } + keeping
        save()
        NSLog("[幻梦圆环] 没找到打包的预设，已装兜底的 \(seeds.count) 条（\(path)）")
    }
}
