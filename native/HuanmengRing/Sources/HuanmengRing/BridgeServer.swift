// ============================================================
//  BridgeServer.swift — 零依赖 WebSocket 服务端
//
//  UXP 插件只有 WebSocket 客户端、没有服务端 API（真机实测确认），
//  所以服务端必须由本程序来当，插件反向连过来。
//
//  只实现协议里够用的部分：RFC6455 握手 + 单帧文本消息 + ping/pong + close。
//  消息都是小 JSON，不需要分片和扩展协商。
// ============================================================

import Foundation
import Network
import CryptoKit

protocol BridgeServerDelegate: AnyObject {
    func bridgeDidChangeConnection(connected: Bool)
    func bridgeDidReceive(_ message: [String: Any])
}

final class BridgeServer {

    private let port: UInt16
    private var listener: NWListener?
    private var connection: NWConnection?
    private var buffer = Data()

    weak var delegate: BridgeServerDelegate?

    private static let webSocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    init(port: UInt16 = 8799) {
        self.port = port
    }

    var isConnected: Bool { connection != nil }

    func start() {
        guard listener == nil else { return }
        do {
            let parameters = NWParameters.tcp
            // 只监听回环地址，不暴露到局域网
            parameters.requiredLocalEndpoint = NWEndpoint.hostPort(
                host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
            let created = try NWListener(using: parameters)
            created.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            created.stateUpdateHandler = { state in
                switch state {
                case .ready: NSLog("[幻梦圆环] 桥接服务已监听 127.0.0.1:\(self.port)")
                case .failed(let error): NSLog("[幻梦圆环] 桥接服务失败：\(error)")
                default: break
                }
            }
            created.start(queue: .main)
            listener = created
        } catch {
            NSLog("[幻梦圆环] 无法监听端口 \(port)：\(error.localizedDescription)")
        }
    }

    func stop() {
        connection?.cancel()
        connection = nil
        listener?.cancel()
        listener = nil
    }

    // MARK: - 连接

    private func accept(_ newConnection: NWConnection) {
        // 旧连接可能还在关闭过程中。必须先把 connection 指向新连接，
        // 并且让旧连接的回调认不出自己 —— 否则旧连接稍后触发的
        // cancelled 回调会把刚建立的新连接抹掉，表现为插件每次重连都被踢。
        let previous = connection
        connection = newConnection
        buffer.removeAll()
        handshakeDone = false
        previous?.cancel()

        newConnection.stateUpdateHandler = { [weak self] state in
            guard let self, self.connection === newConnection else { return }
            switch state {
            case .ready:
                self.receive(newConnection)
            case .failed, .cancelled:
                self.handleDisconnect(newConnection)
            default:
                break
            }
        }
        newConnection.start(queue: .main)
    }

    /// 只有当前连接自己的失败才算断线，避免被旧连接的回调误触发
    private func handleDisconnect(_ target: NWConnection) {
        guard connection === target else { return }
        connection = nil
        buffer.removeAll()
        handshakeDone = false
        delegate?.bridgeDidChangeConnection(connected: false)
    }

    private func receive(_ source: NWConnection) {
        source.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
            [weak self] data, _, isComplete, error in
            guard let self, self.connection === source else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                self.processBuffer()
            }
            if let error {
                NSLog("[幻梦圆环] 连接错误：\(error.localizedDescription)")
                self.handleDisconnect(source)
                return
            }
            if isComplete {
                self.handleDisconnect(source)
                return
            }
            self.receive(source)
        }
    }

    // MARK: - 握手与帧解析

    private func processBuffer() {
        // 还没握手：先等完整的 HTTP 请求头
        if !handshakeDone {
            guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return }
            let headerData = buffer.subdata(in: 0..<headerEnd.lowerBound)
            buffer.removeSubrange(0..<headerEnd.upperBound)
            guard let headerText = String(data: headerData, encoding: .utf8) else {
                connection?.cancel(); return
            }
            performHandshake(headerText)
            return
        }

        // 已握手：按帧解析
        while let frame = decodeFrame() {
            switch frame.opcode {
            case 0x1:
                if let text = String(data: frame.payload, encoding: .utf8),
                   let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
                    delegate?.bridgeDidReceive(json)
                }
            case 0x8:
                // 收到 close 帧：先取消再按连接身份清理，
                // 顺序反了会让 cancelled 回调找不到目标而漏掉状态通知
                if let current = connection {
                    current.cancel()
                    handleDisconnect(current)
                }
                return
            case 0x9:
                sendFrame(opcode: 0xA, payload: frame.payload) // pong
            default:
                break
            }
        }
    }

    private var handshakeDone = false

    private func performHandshake(_ headerText: String) {
        var key = ""
        for line in headerText.split(separator: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            if parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "sec-websocket-key" {
                key = parts[1].trimmingCharacters(in: .whitespaces)
            }
        }
        guard !key.isEmpty else {
            NSLog("[幻梦圆环] 握手失败：缺少 Sec-WebSocket-Key")
            connection?.cancel()
            return
        }

        let digest = Insecure.SHA1.hash(data: Data((key + Self.webSocketGUID).utf8))
        let accept = Data(digest).base64EncodedString()
        let response = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Accept: \(accept)",
            "", ""
        ].joined(separator: "\r\n")

        connection?.send(content: Data(response.utf8), completion: .contentProcessed { _ in })
        handshakeDone = true
        // 连接日志统一由 AppDelegate 的 bridgeDidChangeConnection 打，
        // 这里再打一条会让同一次连接在日志里出现两遍
        // 主动报个到，插件据此确认链路通了，不必靠超时猜
        send(["type": "hello", "server": "huanmeng-ring", "version": "0.1.0"])
        delegate?.bridgeDidChangeConnection(connected: true)
    }

    private struct Frame {
        let opcode: UInt8
        let payload: Data
    }

    /// 返回 nil 表示缓冲区里还没有完整的一帧。客户端发来的帧一定带掩码。
    private func decodeFrame() -> Frame? {
        guard buffer.count >= 2 else { return nil }
        let bytes = [UInt8](buffer)
        let opcode = bytes[0] & 0x0F
        let masked = (bytes[1] & 0x80) != 0
        var length = Int(bytes[1] & 0x7F)
        var offset = 2

        if length == 126 {
            guard bytes.count >= 4 else { return nil }
            length = Int(bytes[2]) << 8 | Int(bytes[3])
            offset = 4
        } else if length == 127 {
            guard bytes.count >= 10 else { return nil }
            var value = 0
            for index in 2..<10 { value = value << 8 | Int(bytes[index]) }
            length = value
            offset = 10
        }

        let maskLength = masked ? 4 : 0
        guard bytes.count >= offset + maskLength + length else { return nil }

        var payload = Data(bytes[(offset + maskLength)..<(offset + maskLength + length)])
        if masked {
            let mask = Array(bytes[offset..<(offset + 4)])
            for index in 0..<payload.count {
                payload[index] ^= mask[index % 4]
            }
        }
        buffer.removeSubrange(0..<(offset + maskLength + length))
        return Frame(opcode: opcode, payload: payload)
    }

    private func sendFrame(opcode: UInt8, payload: Data) {
        // 首字节必须是 FIN(0x80) | opcode。只写 opcode 会发出非终止帧，
        // 客户端会一直等后续分片，message 事件永远不触发。
        var frame = Data([0x80 | opcode])
        let length = payload.count
        // 服务端发出的帧不加掩码
        if length < 126 {
            frame.append(UInt8(length))
        } else if length < 65536 {
            frame.append(126)
            frame.append(UInt8((length >> 8) & 0xFF))
            frame.append(UInt8(length & 0xFF))
        } else {
            frame.append(127)
            for shift in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((length >> shift) & 0xFF))
            }
        }
        frame.append(payload)
        connection?.send(content: frame, completion: .contentProcessed { _ in })
    }

    /// 给插件下发指令
    func send(_ message: [String: Any]) {
        guard let connection, let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        sendFrame(opcode: 0x1, payload: data)
    }
}
