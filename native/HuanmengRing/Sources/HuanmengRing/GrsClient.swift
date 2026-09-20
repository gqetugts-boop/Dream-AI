// ============================================================
//  GrsClient.swift — 助手自己调 GRS 接口（不依赖 Photoshop 插件）
//
//  协议是从主插件里搬过来的，两边必须一致，否则会出现
//  「面板里能出图、圆环里说不出图」这种最难查的问题。
//
//  对话：POST {base}/v1/chat/completions   {model, stream:false, messages}
//        model 要去掉 "grs/" 前缀（面板里存的是 grs/gpt-5.4，发出去的是 gpt-5.4）
//
//  生图：**两步**，这是 GRS 的特点
//        1. POST {base}/v1/api/generate  {model, prompt, aspectRatio, imageSize, replyType:"json"}
//           → 直接给图，或者给一个任务 id
//        2. 有 id 就 POST {base}/v1/draw/result {id} 轮询，2.5 秒一次，最多 120 次（5 分钟）
//
//  超时和重试都按插件那边的参数来：请求 180 秒、轮询单次 60 秒、
//  5xx 重试 3 次。改这些之前先想清楚为什么原来这么定。
// ============================================================

import Foundation

enum GrsError: LocalizedError {
    case missingKey
    case http(Int, String)
    case noImage(String)
    case failed(String)
    case cancelled
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .missingKey: return "还没有配置 GRS 密钥（偏好设置 → 接口）"
        case .http(let code, let body): return "请求失败 \(code)：\(body)"
        case .noImage(let why): return why
        case .failed(let why): return why
        case .cancelled: return "已取消"
        case .badResponse(let why): return "响应解析失败：\(why)"
        }
    }

    /// 把接口返回的英文错误码翻成人话（和插件里的措辞保持一致）
    static func friendly(_ status: Int, _ body: String) -> String {
        if body.contains("invalid_api_key") { return "API密钥无效，请检查您的API密钥" }
        if body.contains("quota_exceeded") { return "API配额已用尽，请稍后再试" }
        if body.contains("rate_limit_exceeded") { return "请求频率过高，请稍后再试" }
        return "请求失败: \(status) - \(body.prefix(300))"
    }
}

struct GrsClient {

    let api: RingAPI
    private let session: URLSession

    init(api: RingAPI) {
        self.api = api
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 180
        config.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: config)
    }

    // MARK: - 对话

    /// messages: [(role, text)]，role 是 "system" / "user" / "assistant"
    func chat(_ messages: [[String: Any]]) async throws -> String {
        let key = api.grsApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw GrsError.missingKey }

        var body: [String: Any] = [
            "model": Self.chatModelName(api.chatModel),
            "stream": false,
            "messages": messages,
        ]
        if !api.systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            var withSystem = messages
            withSystem.insert(["role": "system", "content": api.systemPrompt], at: 0)
            body["messages"] = withSystem
        }

        let data = try await post(path: "/v1/chat/completions", body: body, key: key)
        guard let text = Self.extractChatText(data), !text.isEmpty else {
            throw GrsError.noImage("接口没返回文字内容。响应：\(Self.describe(data))")
        }
        return text
    }

    static func chatModelName(_ value: String) -> String {
        // "grs/gpt-5.4" → "gpt-5.4"；没有前缀就原样
        guard let slash = value.firstIndex(of: "/") else { return value }
        return String(value[value.index(after: slash)...])
    }

    /// 从对话响应里取正文（OpenAI 兼容格式为主，带若干兜底）
    static func extractChatText(_ object: Any) -> String? {
        guard let dict = object as? [String: Any] else { return nil }

        if let choices = dict["choices"] as? [[String: Any]], let first = choices.first {
            if let message = first["message"] as? [String: Any] {
                if let content = message["content"] as? String, !content.isEmpty { return content }
                if let parts = message["content"] as? [[String: Any]] {
                    let text = parts.compactMap { $0["text"] as? String }.joined()
                    if !text.isEmpty { return text }
                }
            }
            if let text = first["text"] as? String, !text.isEmpty { return text }
        }
        if let output = dict["output"] as? [String: Any],
           let text = output["text"] as? String, !text.isEmpty { return text }
        if let message = dict["message"] as? [String: Any],
           let content = message["content"] as? String, !content.isEmpty { return content }
        // 有些网关把内容直接放在 data 里
        if let data = dict["data"] as? [String: Any],
           let text = extractChatText(data), !text.isEmpty { return text }

        return nil
    }

    // MARK: - 生图

    /// 出图。返回图片字节。
    /// - Parameter onProgress: 阶段提示（"提交任务…" / "生成中（12s）"），给气泡和菜单栏用
    func generateImage(prompt: String,
                       images: [String] = [],
                       onProgress: @escaping @MainActor (String) async -> Void) async throws -> Data {
        let key = api.grsApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw GrsError.missingKey }

        let model = Self.imageModelName(api.imgModel)
        var body: [String: Any] = [
            "model": model,
            "prompt": prompt,
            "aspectRatio": api.aspectRatio.isEmpty ? "auto" : api.aspectRatio,
            "imageSize": api.imageSize.isEmpty ? "1K" : api.imageSize,
            "replyType": "json",
        ]
        // 带参考图就是「以图生图」。格式和插件一致：data URL 数组。
        // 只认 nano-banana / gpt-image 这一系（GRS 那边其它模型不吃这个字段）。
        if !images.isEmpty {
            body["images"] = images
        }

        await onProgress("提交任务…")
        let first = try await post(path: "/v1/api/generate", body: body, key: key)

        // 直接给图（有些模型同步返回）
        if let reference = ImageExtract.find(in: first) {
            await onProgress("下载图片…")
            return try await ImageExtract.data(from: reference, session: session)
        }

        // 首响可能就是终止态，带 id 也不该再轮询 ——
        // 否则一个已经失败的任务会白等 120 次 × 2.5 秒
        let payload = Self.unwrap(first)
        let status = Self.taskStatus(payload)
        if ["failed", "failure", "error", "cancelled", "canceled", "violation"].contains(status) {
            throw GrsError.failed(Self.failureReason(payload, status: status))
        }

        guard let taskId = Self.taskId(first) else {
            throw GrsError.noImage("接口返回了，但既没有图也没有任务 id。响应：\(Self.describe(first))")
        }

        await onProgress("生成中…")
        let result = try await poll(taskId: taskId, key: key, onProgress: onProgress)
        guard let reference = ImageExtract.find(in: result) else {
            throw GrsError.noImage("任务完成了但没找到图。响应：\(Self.describe(result))")
        }
        await onProgress("下载图片…")
        return try await ImageExtract.data(from: reference, session: session)
    }

    static func imageModelName(_ value: String) -> String {
        // 只去掉 "grs/" 这类渠道前缀，模型名本身原样
        guard let slash = value.firstIndex(of: "/") else { return value }
        let head = String(value[value.startIndex..<slash]).lowercased()
        let known = ["grs", "xai", "volcengine", "newapi", "firefly", "grok2api", "sub2api"]
        return known.contains(head) ? String(value[value.index(after: slash)...]) : value
    }

    /// 轮询直到出图 / 失败 / 超时。参数和插件一致：2.5 秒 × 120 次
    private func poll(taskId: String, key: String,
                      onProgress: @escaping @MainActor (String) async -> Void) async throws -> Any {
        let maxAttempts = 120
        let started = Date()

        for attempt in 0..<maxAttempts {
            if attempt > 0 {
                try await Task.sleep(nanoseconds: 2_500_000_000)
            }
            let elapsed = Int(Date().timeIntervalSince(started))
            await onProgress("生成中… \(elapsed)s")

            let result: Any
            do {
                result = try await post(path: "/v1/draw/result", body: ["id": taskId], key: key)
            } catch let error as GrsError {
                // 5xx 是服务端抖动，继续轮询；其它错误直接报
                if case .http(let code, _) = error, code >= 500 { continue }
                throw error
            }

            if ImageExtract.find(in: result) != nil { return result }

            let payload = Self.unwrap(result)
            let status = Self.taskStatus(payload)
            if ["failed", "failure", "error", "cancelled", "canceled", "violation"].contains(status) {
                throw GrsError.failed(Self.failureReason(payload, status: status))
            }
            if ["succeeded", "success", "completed", "done"].contains(status) {
                throw GrsError.noImage("任务显示已完成，但没返回可用图像")
            }
            // 其余状态（running / queued…）继续等
        }
        throw GrsError.failed("等待生成超时（5 分钟）")
    }

    // MARK: - HTTP

    private func post(path: String, body: [String: Any], key: String) async throws -> Any {
        let base = api.resolvedBaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: base + path) else {
            throw GrsError.badResponse("地址不合法：\(base + path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        var lastError: Error = GrsError.badResponse("未知错误")
        for attempt in 0..<3 {
            if attempt > 0 { try await Task.sleep(nanoseconds: 2_000_000_000) }
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw GrsError.badResponse("不是 HTTP 响应")
                }
                if http.statusCode >= 400 {
                    let text = String(data: data, encoding: .utf8) ?? ""
                    let error = GrsError.http(http.statusCode, GrsError.friendly(http.statusCode, text))
                    // 5xx 重试，4xx 是请求本身的问题，重试没意义
                    if http.statusCode >= 500 { lastError = error; continue }
                    throw error
                }
                guard let object = try? JSONSerialization.jsonObject(with: data) else {
                    throw GrsError.badResponse("返回的不是 JSON")
                }
                return object
            } catch let error as GrsError {
                if case .http(let code, _) = error, code < 500 { throw error }
                lastError = error
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    // MARK: - 响应结构

    /// 有些接口把真正的内容包在 data/result 里，剥一层再看状态和 id
    static func unwrap(_ object: Any) -> [String: Any] {
        guard var dict = object as? [String: Any] else { return [:] }
        for key in ["data", "result"] {
            if let inner = dict[key] as? [String: Any] {
                // 只有外层没有状态字段时才剥 —— 否则会把外层状态丢掉
                if dict["status"] == nil && dict["id"] == nil {
                    dict = inner.merging(dict.filter { $0.key != key }) { a, _ in a }
                }
            }
        }
        return dict
    }

    static func taskStatus(_ dict: [String: Any]) -> String {
        for key in ["status", "state", "task_status", "taskStatus"] {
            if let value = dict[key] as? String { return value.lowercased() }
            if let value = dict[key] as? Int { return String(value) }
        }
        return ""
    }

    static func failureReason(_ dict: [String: Any], status: String) -> String {
        for key in ["error", "failure_reason", "failureReason", "message", "msg"] {
            if let value = dict[key] as? String, !value.isEmpty { return value }
            if let value = dict[key] as? [String: Any], let message = value["message"] as? String {
                return message
            }
        }
        return status == "violation" ? "内容违规，已被拒绝生成" : "绘图任务失败"
    }

    static func taskId(_ object: Any) -> String? {
        let direct = ["id", "taskId", "task_id", "jobId", "job_id",
                      "requestId", "request_id", "recordId", "record_id"]
        let containers: [[String: Any]?] = [
            object as? [String: Any],
            (object as? [String: Any])?["data"] as? [String: Any],
            (object as? [String: Any])?["result"] as? [String: Any],
        ]
        for container in containers {
            guard let container else { continue }
            for key in direct {
                if let value = container[key] as? String, !value.isEmpty { return value }
            }
        }
        return nil
    }

    /// 出错时把响应的形状说清楚 —— 「无法提取图像」这种话对排查毫无帮助，
    /// 得让用户看到接口到底返回了什么
    static func describe(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]),
              let text = String(data: data, encoding: .utf8) else { return "（无法序列化）" }
        return text.count > 600 ? String(text.prefix(600)) + "…" : text
    }
}
