// ============================================================
//  ImageExtract.swift — 从各家接口的响应里把图片抠出来
//
//  这是整个对接里最容易出错的一环：十几家渠道，返回结构一个比一个随意 ——
//  有的给 data[0].url，有的给 results[0].content（裸 base64），
//  有的把图塞在 result.output[0].image.url 里，还有的返回 markdown 文本。
//  所以这里不做「按 schema 解析」，而是**把整个 JSON 翻一遍找像图片的东西**。
//
//  这套逻辑是从主插件的 extractImageFromResponse 搬过来的，行为要对齐：
//  插件那边踩过的坑（域名白名单、裸 base64、URL 尾部的中文标点）
//  这里一个都不能少，否则会出现「面板里能出图、圆环里说不出图」这种鬼问题。
//
//  自检：`HuanmengRing --selftest` 会拿各家的真实响应形状跑一遍
// ============================================================

import Foundation

enum ImageExtract {

    /// 从一段 JSON 里找图片。返回 URL 字符串或 data: URL。
    static func find(in object: Any) -> String? {
        var candidates: [String] = []
        collect(object, into: &candidates)

        // 再对整个 JSON 文本扫一遍：有些渠道把图放在 markdown 正文里
        // （`![img](https://…)`），按字段找是找不到的
        if let data = try? JSONSerialization.data(withJSONObject: object),
           let serialized = String(data: data, encoding: .utf8) {
            // ⚠️ 先把 \/ 还原成 /。
            // **这是个真踩过的坑**：Swift 的 JSONSerialization 会把斜杠转义成 \/，
            // 而 JS 的 JSON.stringify 不会 —— 插件那边同一条正则照搬过来，
            // 匹配会在第一个反斜杠处停住，`https://cdn.example.com/a.webp`
            // 被截成 `https://cdn.example.com`，下载直接 404。
            // 自检里那条「转义的斜杠」用例就是为它留的。
            let normalized = serialized.replacingOccurrences(of: "\\/", with: "/")
            candidates.append(contentsOf: scanText(normalized))
        }

        for candidate in candidates {
            let clean = normalize(candidate)
            if isLikelyImage(clean) { return clean }
        }
        return nil
    }

    /// 候选值归一化：剥掉尾部标点，裸 base64 补成 data URL。
    ///
    /// 补 data URL 这一步比插件那边多做了一层 —— 插件只对字段名叫
    /// b64_json / 含 base64 的做转换，于是「base64 塞在 content 或 data 里」
    /// 的渠道（Gemini 的 inlineData 就是这样）在插件里也找不到图。
    /// 这里统一处理：先看它是不是真图片（解码头几个字节认魔数），
    /// 不是就原样放回去，不会误判。
    static func normalize(_ value: String) -> String {
        let clean = sanitize(value)
        if clean.hasPrefix("data:image/") || clean.hasPrefix("http") { return clean }
        if looksLikeBase64Image(clean) { return "data:image/png;base64," + clean }
        return clean
    }

    // MARK: - 收集候选

    /// 值看起来像「一坨 base64 图片数据」而不是普通文本
    static func looksLikeBase64Image(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        // base64 的图片起码几百字节，太短的多半是 id 或者空字符串
        guard trimmed.count > 512 else { return false }
        guard trimmed.range(of: "^[A-Za-z0-9+/]+={0,2}$", options: .regularExpression) != nil else {
            return false
        }
        // 解码头几个字节认魔数，比看内容可靠
        let head = String(trimmed.prefix(64))
        guard let data = Data(base64Encoded: head + String(repeating: "=", count: (4 - head.count % 4) % 4)),
              data.count >= 4 else { return false }
        return isImageMagic(data)
    }

    /// PNG / JPEG / GIF / WEBP / AVIF 的文件头
    static func isImageMagic(_ data: Data) -> Bool {
        guard data.count >= 4 else { return false }
        let bytes = [UInt8](data.prefix(12))
        if bytes.count >= 4, bytes[0] == 0x89, bytes[1] == 0x50, bytes[2] == 0x4E, bytes[3] == 0x47 { return true }
        if bytes.count >= 3, bytes[0] == 0xFF, bytes[1] == 0xD8, bytes[2] == 0xFF { return true }
        if bytes.count >= 4, bytes[0] == 0x47, bytes[1] == 0x49, bytes[2] == 0x46 { return true }
        if bytes.count >= 12,
           bytes[0] == 0x52, bytes[1] == 0x49, bytes[2] == 0x46, bytes[3] == 0x46,
           bytes[8] == 0x57, bytes[9] == 0x45, bytes[10] == 0x42, bytes[11] == 0x50 { return true }
        if bytes.count >= 12, bytes[4] == 0x66, bytes[5] == 0x74, bytes[6] == 0x79, bytes[7] == 0x70 {
            // ....ftypavif / ....ftypmif1
            if bytes.count >= 12 {
                let brand = String(bytes: bytes[8...11], encoding: .ascii) ?? ""
                if brand.hasPrefix("avif") || brand.hasPrefix("mif1") { return true }
            }
        }
        return false
    }

    private static func collect(_ value: Any, into results: inout [String]) {
        if let text = value as? String {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.range(of: "^(https?://|data:image/)", options: [.regularExpression, .caseInsensitive]) != nil {
                results.append(trimmed)
            } else if looksLikeBase64Image(trimmed) {
                results.append("data:image/png;base64," + trimmed)
            }
            return
        }

        if let array = value as? [Any] {
            for item in array { collect(item, into: &results) }
            return
        }

        guard let object = value as? [String: Any] else { return }

        // 已知字段名优先（顺序有意义：先 url 再 base64）
        let knownKeys = ["url", "image", "image_url", "output", "b64_json", "response_url",
                         "download_url", "uri", "src", "base64", "base64Data", "imageBase64",
                         "image_data", "imageData", "result_image", "original_url", "originalUrl",
                         "file_url", "fileUrl", "result_url", "resultUrl", "thumbnail",
                         "thumbnail_url", "thumbnailUrl", "content"]
        for key in knownKeys {
            guard let fieldValue = object[key] as? String else { continue }
            let lower = key.lowercased()
            if lower.contains("b64") || lower.contains("base64") || lower.contains("image_data") {
                let trimmed = fieldValue.trimmingCharacters(in: .whitespacesAndNewlines)
                if looksLikeBase64Image(trimmed) {
                    results.append("data:image/png;base64," + trimmed)
                } else if trimmed.range(of: "^(https?://|data:image/)", options: [.regularExpression, .caseInsensitive]) != nil {
                    results.append(trimmed)
                }
            } else {
                results.append(fieldValue)
            }
        }

        // 兜底：键名里带 image / img / url / base64 的都试试，并继续下钻
        for (key, fieldValue) in object {
            let lower = key.lowercased()
            let looksRelevant = lower.contains("image") || lower.contains("img")
                || lower.contains("url") || lower.contains("base64") || lower.contains("b64")

            if let text = fieldValue as? String {
                guard looksRelevant else { continue }
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if looksLikeBase64Image(trimmed) {
                    results.append("data:image/png;base64," + trimmed)
                } else if trimmed.range(of: "^(https?://|data:image/)", options: [.regularExpression, .caseInsensitive]) != nil {
                    results.append(trimmed)
                }
            } else if fieldValue is [String: Any] || fieldValue is [Any] {
                // 键名像图片字段、但值是对象时要继续下钻。
                // 覆盖 { outputs: [{ image: { url } }] } 这类结构（Firefly 的官方格式）
                if looksRelevant || lower == "outputs" || lower == "result" || lower == "results" || lower == "data" {
                    collect(fieldValue, into: &results)
                }
            }
        }
    }

    /// 对整段文本做正则扫描，抓 data URL 和被转义的 http 链接
    private static func scanText(_ text: String) -> [String] {
        var found: [String] = []

        if let regex = try? NSRegularExpression(pattern: "data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+") {
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            for match in regex.matches(in: text, range: range) {
                if let r = Range(match.range, in: text) { found.append(String(text[r])) }
            }
        }

        // 调用方已经把 \/ 还原过了，这里按普通 URL 匹配即可
        if let regex = try? NSRegularExpression(pattern: "https?://[^\"'\\s\\\\]+") {
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            for match in regex.matches(in: text, range: range) {
                if let r = Range(match.range, in: text) { found.append(String(text[r])) }
            }
        }
        return found
    }

    // MARK: - 校验与清洗

    /// 尾巴上粘的标点要剥掉。从 markdown 正文里正则扫出来的 URL
    /// 经常带着 `)` `，` `。` 这些 —— 带着它们去下载就是 404。
    /// 注意 `=` 不在剥离集合里：它是 base64 的填充符，也是 query 的一部分。
    static func sanitize(_ value: String) -> String {
        var result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if result.hasPrefix("data:image/") { return result }

        let trailing = CharacterSet(charactersIn: ")]}>\"'`,;:，。；：）】》、»”’")
        while let last = result.unicodeScalars.last, trailing.contains(last) {
            result.removeLast()
        }
        return result
    }

    static func isLikelyImage(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        if value.hasPrefix("data:image/") {
            // 裸 base64 拼出来的 data URL 要确认它真的是图，不是一段长文本
            guard let comma = value.firstIndex(of: ",") else { return false }
            let payload = String(value[value.index(after: comma)...])
            return looksLikeBase64Image(payload)
        }

        guard let url = URL(string: value), let host = url.host?.lowercased() else { return false }

        // 路径里有图片扩展名
        let path = url.path.lowercased()
        for ext in [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"] where path.hasSuffix(ext) {
            return true
        }
        // 域名里带 image / cdn / 各家对象存储的字样。
        // ⚠️ 这是硬编码表，穷举不了；新渠道出现新域名时要在这里补一条，
        //    否则会报「无法从响应中提取图像」。
        let needles = ["oaidalleapiprodscus", "blob", "grs", "claude", "image", "img",
                       "cdn", "adobe", "firefly", "storage", "xai-imgen",
                       "amazonaws", "cloudfront", "aliyuncs", "myqcloud",
                       "googleusercontent", "digitaloceanspaces", "backblazeb2",
                       "b-cdn", "volces", "volccdn", "byteimg", "ibyteimg"]
        let parts = host.split(separator: ".")
        for needle in needles where parts.contains(where: { $0 == Substring(needle) }) {
            return true
        }
        return false
    }

    // MARK: - 取出可用数据

    // MARK: - 自检

    /// `--selftest`：拿各家接口的真实响应形状跑一遍。
    ///
    /// 为什么值得单独做：这段逻辑是「重灾区」—— 它出错时不会崩，
    /// 只会安静地说「无法从响应中提取图像」，然后用户完全不知道是哪儿的问题。
    /// 而且它跨了十几家渠道，光靠肉眼看代码是验不出来的。
    static func runSelfTest() -> Int32 {
        // 造一段够长的 PNG base64：真正的前 8 字节魔数 + 填充。
        // 注意填充必须补在**最后** —— real base64 的 = 只在尾部，
        // 中间出现 = 的字符串根本不是合法 base64，拿它当用例会误判成代码有问题。
        let pngHeader = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        var body = String(pngHeader.drop(while: { _ in false }))
        while body.hasSuffix("=") { body.removeLast() }
        var longBase64 = body + String(repeating: "A", count: 600)
        while longBase64.count % 4 != 0 { longBase64 += "=" }

        let cases: [(name: String, json: String, expect: String?)] = [
            ("GRS 任务中（还没有图）",
             #"{"id":"abc-123","status":"running"}"#, nil),

            ("GRS 结果：results[].url",
             #"{"data":{"status":"succeeded","results":[{"url":"https://grsai.dakka.com.cn/files/a.png"}]}}"#,
             "https://grsai.dakka.com.cn/files/a.png"),

            ("OpenAI 图像接口：b64_json",
             #"{"data":[{"b64_json":"\#(longBase64)"}]}"#,
             "data:image/png;base64," + longBase64),

            ("Firefly：outputs[].image.url（对象下钻）",
             #"{"outputs":[{"image":{"url":"https://pre-signed-firefly-prod.s3-accelerate.amazonaws.com/x?sig=1"}}]}"#,
             "https://pre-signed-firefly-prod.s3-accelerate.amazonaws.com/x?sig=1"),

            ("火山方舟：ark-content.volces.com",
             #"{"data":[{"url":"https://ark-content.volces.com/out/9f2.webp"}]}"#,
             "https://ark-content.volces.com/out/9f2.webp"),

            ("markdown 正文里的图（尾部右括号要剥掉）",
             #"{"choices":[{"message":{"content":"这是结果：![img](https://cdn.example.com/a.webp)"}}]}"#,
             "https://cdn.example.com/a.webp"),

            ("URL 尾部粘了中文句号",
             #"{"url":"https://x.grs.com.cn/b.png。"}"#,
             "https://x.grs.com.cn/b.png"),

            ("裸 base64 放在 content 字段",
             #"{"data":{"content":"\#(longBase64)"}}"#,
             "data:image/png;base64," + longBase64),

            ("转义的斜杠（JSON 里常见）",
             #"{"url":"https:\/\/img.example-cdn.io\/c.jpg"}"#,
             "https://img.example-cdn.io/c.jpg"),

            ("真的没有图：普通网页链接",
             #"{"url":"https://example.com/some/page"}"#, nil),

            ("真的没有图：只有错误信息",
             #"{"error":{"message":"quota exceeded"}}"#, nil),

            ("太短的字符串不能当成 base64 图片",
             #"{"content":"iVBORw0KGgo="}"#, nil),
        ]

        var passed = 0
        print("图像提取自检（\(cases.count) 条）\n")
        for item in cases {
            guard let data = item.json.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) else {
                print("✗ \(item.name)：用例本身不是合法 JSON")
                continue
            }
            let got = find(in: object)
            if got == item.expect {
                passed += 1
            } else {
                print("✗ \(item.name)")
                print("    期望：\(item.expect ?? "nil")")
                print("    实际：\(got ?? "nil")")
            }
        }

        // 这几条是纯函数，单独验一下
        if sanitize("https://a.com/b.png），") == "https://a.com/b.png" {
            passed += 1
        } else {
            print("✗ sanitize 没能把尾部标点剥干净")
        }
        let total = cases.count + 1

        print("\n\(passed)/\(total) 通过")
        return passed == total ? 0 : 1
    }

    /// 把找到的东西变成真正的图片字节。data URL 直接解码，http(s) 去下载。
    static func data(from reference: String, session: URLSession = .shared) async throws -> Data {
        if reference.hasPrefix("data:image/") {
            guard let comma = reference.firstIndex(of: ",") else {
                throw GrsError.noImage("图片数据格式不对（data URL 少了逗号）")
            }
            let payload = String(reference[reference.index(after: comma)...])
            guard let data = Data(base64Encoded: payload, options: .ignoreUnknownCharacters) else {
                throw GrsError.noImage("图片 base64 解不开")
            }
            return data
        }

        guard let url = URL(string: reference) else {
            throw GrsError.noImage("图片地址不合法：\(reference.prefix(80))")
        }
        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            throw GrsError.http(http.statusCode, "下载图片失败")
        }
        return data
    }
}
