// ============================================================
//  StandaloneEngine.swift — 插件不在的时候，助手自己干活
//
//  一直以来的定位是「遥控器」：助手只负责显示菜单，真正的活全在 Photoshop
//  插件那边干。所以 PS 一关，助手就成了一块什么都点不动的饼。
//
//  这里补上另一半：没有插件时助手自己对话、自己出图、自己存盘。
//  有插件时**优先走插件** —— 那边的对话记录和面板是同一份，
//  而且只有它能读选区、能把图放回文档。
//
//  聊天记录单独存一个文件（~/.huanmeng-ring-chat.json），权限 600。
//  为什么不和主配置放一起：主配置是「设置」，改坏了要恢复默认；
//  聊天记录是「数据」，天天在长。混在一起的话，任何一次配置读写
//  都要把整段对话序列化一遍。
// ============================================================

import AppKit
import Foundation

final class StandaloneEngine {

    /// 一轮对话，和 ChatTurn 对齐但独立存 —— 那个是显示层的类型
    private(set) var history: [ChatTurn] = []
    private(set) var busy = false

    private let chatPath: String = NSString(string: "~/.huanmeng-ring-chat.json").expandingTildeInPath
    /// 喂给模型的历史轮数。太多会顶掉上下文窗口，太少又记不住刚才说的话。
    private let contextTurns = 20

    init() {
        loadHistory()
    }

    // MARK: - 对话

    /// 问一句。历史里会记下这一问一答。
    func ask(_ question: String, api: RingAPI) async throws -> String {
        guard !busy else { throw GrsError.failed("上一条还在等回复") }
        busy = true
        defer { busy = false }

        history.append(ChatTurn(role: "user", text: question))
        saveHistory()

        let client = GrsClient(api: api)
        let messages = buildMessages()
        let reply = try await client.chat(messages)

        history.append(ChatTurn(role: "assistant", text: reply))
        saveHistory()
        return reply
    }

    /// 把历史压成接口要的 messages 格式，只带最近若干轮
    private func buildMessages() -> [[String: Any]] {
        let recent = history.suffix(contextTurns)
        return recent.map { turn in
            ["role": turn.isUser ? "user" : "assistant", "content": turn.text]
        }
    }

    func reset() {
        history.removeAll()
        saveHistory()
    }

    /// 记一条助手自己产生的消息（比如出图成功），让对话里留个痕
    func note(_ text: String) {
        history.append(ChatTurn(role: "assistant", text: text))
        saveHistory()
    }

    // MARK: - 出图

    /// 出图并保存。返回存到哪儿了。
    func generate(prompt: String, api: RingAPI, images: [String] = [],
                  onProgress: @escaping @MainActor (String) async -> Void) async throws -> URL {
        let client = GrsClient(api: api)
        let data = try await client.generateImage(prompt: prompt, images: images,
                                                  onProgress: onProgress)
        let url = try save(data, folder: api.resolvedOutputFolder)
        history.append(ChatTurn(role: "user", text: "生图：\(prompt)"))
        history.append(ChatTurn(role: "assistant", text: "已保存到 \(url.path)"))
        saveHistory()
        return url
    }

    private func save(_ data: Data, folder: String) throws -> URL {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: folder, withIntermediateDirectories: true)

        // 文件名用时间戳，不覆盖 —— 同一个提示词出两张是很正常的事
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let name = "幻梦-\(formatter.string(from: Date())).png"
        let url = URL(fileURLWithPath: folder).appendingPathComponent(name)

        // 接口给什么格式就存什么格式，先认文件头再定扩展名，
        // 免得把 JPEG 存成 .png（有些工具按扩展名解码会失败）
        var target = url
        if data.count > 3, [UInt8](data.prefix(3)) == [0xFF, 0xD8, 0xFF] {
            target = url.deletingPathExtension().appendingPathExtension("jpg")
        }
        try data.write(to: target)
        return target
    }

    // MARK: - 持久化

    private func loadHistory() {
        guard let data = FileManager.default.contents(atPath: chatPath),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return
        }
        history = array.compactMap { item in
            guard let text = item["text"] as? String, !text.isEmpty else { return nil }
            let role = item["role"] as? String ?? "assistant"
            return ChatTurn(role: role, text: text)
        }
    }

    private func saveHistory() {
        // 显示层不需要无限长的历史，落盘也只留最近这些
        let recent = history.suffix(200).map { ["role": $0.role, "text": $0.text] }
        guard let data = try? JSONSerialization.data(withJSONObject: Array(recent),
                                                     options: [.prettyPrinted]) else { return }
        do {
            try data.write(to: URL(fileURLWithPath: chatPath))
            try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                                   ofItemAtPath: chatPath)
        } catch {
            NSLog("[幻梦圆环] 对话记录写入失败：\(error.localizedDescription)")
        }
    }
}
