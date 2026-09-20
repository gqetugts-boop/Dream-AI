// ============================================================
//  BridgeServer.cs — 零依赖 WebSocket 服务端
//
//  UXP 插件只有 WebSocket 客户端、没有服务端 API（真机实测确认），
//  所以服务端必须由本程序来当，插件反向连过来。
//
//  **刻意不用 HttpListener + AcceptWebSocketAsync**：
//  HttpListener 的 URL 前缀要在 HTTP.SYS 里注册（netsh http add urlacl），
//  非管理员账号直接抛 "拒绝访问"，而且报错信息很难懂。
//  自己写握手 + 帧解析用不到 200 行，没有任何系统前置条件。
//
//  与 macOS 版 BridgeServer.swift 行为一致：
//  同一时刻只留一个连接，新连接进来就把旧的踢掉。
//  这里把「缓冲区 + 握手状态」放进 Connection 对象里，
//  而不是像 Swift 版那样放在 server 字段上，从根上避免了
//  旧连接的回调把新连接状态抹掉的问题。
// ============================================================

using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace HuanmengRing.Services
{
    public sealed class BridgeServer
    {
        private const string WebSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        private const string ServerVersion = "1.0.0";

        private readonly int _port;
        private TcpListener _listener;
        private CancellationTokenSource _cts;
        private Connection _current;
        private readonly object _gate = new object();

        /// <summary>连接状态变化（true=插件已连上）</summary>
        public event Action<bool> ConnectionChanged;

        /// <summary>收到插件的 JSON 消息</summary>
        public event Action<JsonObject> MessageReceived;

        public BridgeServer(int port) => _port = port;

        public bool IsConnected
        {
            get { lock (_gate) return _current != null; }
        }

        public void Start()
        {
            if (_listener != null) return;
            try
            {
                _cts = new CancellationTokenSource();
                // 只监听回环地址，不暴露到局域网
                _listener = new TcpListener(IPAddress.Loopback, _port);
                _listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                _listener.Start();
                _ = AcceptLoopAsync(_cts.Token);
                Log($"桥接服务已监听 127.0.0.1:{_port}");
            }
            catch (Exception ex)
            {
                // 端口被占用是最常见的原因：多半是另一个圆环实例还在跑，
                // 或者是之前崩掉的进程没退干净
                Log($"无法监听端口 {_port}：{ex.Message}");
                _listener = null;
            }
        }

        public void Stop()
        {
            try { _cts?.Cancel(); } catch { }
            try { _listener?.Stop(); } catch { }
            _listener = null;
            lock (_gate)
            {
                _current?.Close();
                _current = null;
            }
            _cts?.Dispose();
            _cts = null;
        }

        // ---------- 接受连接 ----------

        private async Task AcceptLoopAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync(token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { return; }
                catch (ObjectDisposedException) { return; }
                catch (SocketException) { continue; }

                var connection = new Connection(client, this);
                Connection previous;
                lock (_gate)
                {
                    previous = _current;
                    _current = connection;
                }
                // 旧连接可能还在关闭过程中。先让 _current 指向新连接，
                // 再踢掉旧的 —— 顺序反了会让旧连接的断开事件把新连接抹掉，
                // 表现为插件每次重连都被踢。
                previous?.Close();
                _ = connection.RunAsync(token);
            }
        }

        internal void OnConnected(Connection connection)
        {
            lock (_gate)
            {
                if (!ReferenceEquals(_current, connection)) return;
            }
            ConnectionChanged?.Invoke(true);
        }

        internal void OnDisconnected(Connection connection)
        {
            lock (_gate)
            {
                // 只有当前连接自己的断开才算数
                if (!ReferenceEquals(_current, connection)) return;
                _current = null;
            }
            ConnectionChanged?.Invoke(false);
        }

        internal void OnMessage(JsonObject message) => MessageReceived?.Invoke(message);

        // ---------- 发送 ----------

        /// <summary>给插件下发指令。未连接时静默丢弃 —— 圆环照常能开，只是点了没反应。</summary>
        public void Send(JsonObject message)
        {
            Connection connection;
            lock (_gate) connection = _current;
            connection?.SendText(message.ToJsonString());
        }

        private static void Log(string message) =>
            Console.Error.WriteLine($"[幻梦圆环] {message}");

        // ============================================================
        //  单个连接：握手 + 帧解析 + 发送
        // ============================================================

        internal sealed class Connection
        {
            private readonly TcpClient _client;
            private readonly BridgeServer _server;
            private readonly NetworkStream _stream;
            private readonly SemaphoreSlim _writeLock = new SemaphoreSlim(1, 1);
            private readonly MemoryStream _buffer = new MemoryStream();
            /// <summary>分片消息的累积缓冲。WebSocket 允许把一条消息拆成多帧发。</summary>
            private readonly MemoryStream _fragment = new MemoryStream();
            private int _fragmentOpcode = -1;
            /// <summary>收到长度字段离谱的帧。缓冲区已经不可能恢复，只能断开。</summary>
            private bool _fatal;
            private bool _handshakeDone;
            private int _closed;

            /// <summary>单条消息上限。插件推的是状态 JSON，正常不超过几十 KB。</summary>
            private const int MaxMessageBytes = 8 * 1024 * 1024;

            public Connection(TcpClient client, BridgeServer server)
            {
                _client = client;
                _server = server;
                _client.NoDelay = true;
                _stream = client.GetStream();
            }

            public async Task RunAsync(CancellationToken token)
            {
                var chunk = new byte[16384];
                try
                {
                    while (!token.IsCancellationRequested)
                    {
                        var read = await _stream.ReadAsync(chunk.AsMemory(0, chunk.Length), token)
                                                .ConfigureAwait(false);
                        if (read <= 0) break;
                        _buffer.Write(chunk, 0, read);
                        if (!ProcessBuffer()) break;
                    }
                }
                catch (OperationCanceledException) { }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                catch (SocketException) { }
                catch (Exception ex) { Log($"连接异常：{ex.Message}"); }
                finally { Close(); }
            }

            /// <summary>返回 false 表示这条连接该结束了</summary>
            private bool ProcessBuffer()
            {
                if (!_handshakeDone)
                {
                    return TryHandshake();
                }

                while (true)
                {
                    var frame = DecodeFrame();
                    if (frame == null)
                    {
                        // 返回 null 的正常含义是「缓冲区里还没有完整的一帧」，
                        // 但 _fatal 例外 —— 那种情况再等下去只会把内存吃光。
                        return !_fatal;
                    }
                    var (fin, opcode, payload) = frame.Value;

                    // 控制帧可以插在分片消息中间，而且自己永远不分片
                    if (opcode == 0x8) return false;                                    // close
                    if (opcode == 0x9) { _ = SendFrameAsync(0xA, payload); continue; }  // ping → pong
                    if (opcode == 0xA) continue;                                        // pong，忽略

                    if (opcode == 0x0)   // continuation：分片消息的后续帧
                    {
                        if (_fragmentOpcode < 0) continue;      // 没有起始帧的孤儿续帧，丢弃
                        if (!AppendFragment(payload)) return false;
                        if (!fin) continue;
                        Deliver(_fragmentOpcode, _fragment.ToArray());
                        _fragment.SetLength(0);
                        _fragmentOpcode = -1;
                        continue;
                    }

                    if (fin)
                    {
                        Deliver(opcode, payload);
                    }
                    else
                    {
                        // 起始帧但没结束 —— 后面的续帧会陆续到来。
                        // 插件的 "读选区" 会推大 payload，Chromium 的 WebSocket
                        // 到达一定长度就会分片，不分片处理的话这些消息全部丢失。
                        _fragmentOpcode = opcode;
                        _fragment.SetLength(0);
                        if (!AppendFragment(payload)) return false;
                    }
                }
            }

            private bool AppendFragment(byte[] payload)
            {
                if (_fragment.Length + payload.Length > MaxMessageBytes)
                {
                    Log("分片消息超过上限，断开这条连接");
                    _fatal = true;
                    return false;
                }
                _fragment.Write(payload, 0, payload.Length);
                return true;
            }

            private void Deliver(int opcode, byte[] payload)
            {
                if (opcode != 0x1) return;   // 只处理文本消息，二进制直接丢
                var text = Encoding.UTF8.GetString(payload);
                try
                {
                    var parsed = JsonNode.Parse(text) as JsonObject;
                    if (parsed != null) _server.OnMessage(parsed);
                }
                catch (JsonException ex)
                {
                    Log($"消息不是合法 JSON，已忽略：{ex.Message}");
                }
            }

            private bool TryHandshake()
            {
                var data = _buffer.ToArray();
                var headerEnd = IndexOf(data, "\r\n\r\n");
                if (headerEnd < 0) return true;   // 还没收全

                var headerText = Encoding.UTF8.GetString(data, 0, headerEnd);
                var restStart = headerEnd + 4;

                // 请求头之后可能已经跟着帧数据了，别丢
                var rest = new byte[data.Length - restStart];
                Array.Copy(data, restStart, rest, 0, rest.Length);
                _buffer.SetLength(0);
                _buffer.Write(rest, 0, rest.Length);

                var key = "";
                foreach (var line in headerText.Split('\n'))
                {
                    var trimmed = line.Trim();
                    var colon = trimmed.IndexOf(':');
                    if (colon <= 0) continue;
                    if (trimmed.Substring(0, colon).Trim().ToLowerInvariant() == "sec-websocket-key")
                        key = trimmed.Substring(colon + 1).Trim();
                }

                if (string.IsNullOrEmpty(key))
                {
                    Log("握手失败：缺少 Sec-WebSocket-Key");
                    return false;
                }

                string accept;
                using (var sha1 = SHA1.Create())
                {
                    accept = Convert.ToBase64String(sha1.ComputeHash(Encoding.UTF8.GetBytes(key + WebSocketGuid)));
                }

                var response = "HTTP/1.1 101 Switching Protocols\r\n" +
                               "Upgrade: websocket\r\n" +
                               "Connection: Upgrade\r\n" +
                               $"Sec-WebSocket-Accept: {accept}\r\n\r\n";

                _ = SendRawAsync(Encoding.UTF8.GetBytes(response));
                _handshakeDone = true;

                // 主动报个到，插件据此确认链路通了，不必靠超时猜
                SendText(new JsonObject
                {
                    ["type"] = "hello",
                    ["server"] = "huanmeng-ring",
                    ["version"] = ServerVersion,
                }.ToJsonString());

                _server.OnConnected(this);
                return true;
            }

            private static int IndexOf(byte[] haystack, string needle)
            {
                var pattern = Encoding.ASCII.GetBytes(needle);
                for (var i = 0; i + pattern.Length <= haystack.Length; i++)
                {
                    var match = true;
                    for (var j = 0; j < pattern.Length; j++)
                    {
                        if (haystack[i + j] != pattern[j]) { match = false; break; }
                    }
                    if (match) return i;
                }
                return -1;
            }

            /// <summary>
            /// 返回 null 表示缓冲区里还没有完整的一帧（或已标记 _fatal）。
            /// 客户端发来的帧一定带掩码。
            /// </summary>
            private (bool Fin, int Opcode, byte[] Payload)? DecodeFrame()
            {
                var bytes = _buffer.ToArray();
                if (bytes.Length < 2) return null;

                var fin = (bytes[0] & 0x80) != 0;
                var opcode = bytes[0] & 0x0F;
                var masked = (bytes[1] & 0x80) != 0;
                long length = bytes[1] & 0x7F;
                var offset = 2;

                if (length == 126)
                {
                    if (bytes.Length < 4) return null;
                    length = (bytes[2] << 8) | bytes[3];
                    offset = 4;
                }
                else if (length == 127)
                {
                    if (bytes.Length < 10) return null;
                    length = 0;
                    for (var i = 2; i < 10; i++) length = (length << 8) | bytes[i];
                    offset = 10;
                }

                // 长度字段离谱 —— 协议已经错位了，再往缓冲区里堆数据也只是白吃内存。
                // 这里必须标记成致命并断开，不能返回 null 假装「还没收全」。
                if (length < 0 || length > MaxMessageBytes)
                {
                    Log($"帧长度超出范围（{length}），断开这条连接");
                    _fatal = true;
                    return null;
                }

                var maskLength = masked ? 4 : 0;
                var total = offset + maskLength + (int)length;
                if (bytes.Length < total) return null;

                var payload = new byte[length];
                Array.Copy(bytes, offset + maskLength, payload, 0, (int)length);
                if (masked)
                {
                    var mask = new byte[4];
                    Array.Copy(bytes, offset, mask, 0, 4);
                    for (var i = 0; i < payload.Length; i++) payload[i] ^= mask[i % 4];
                }

                var remaining = new byte[bytes.Length - total];
                Array.Copy(bytes, total, remaining, 0, remaining.Length);
                _buffer.SetLength(0);
                _buffer.Write(remaining, 0, remaining.Length);

                return (fin, opcode, payload);
            }

            public void SendText(string text) => _ = SendFrameAsync(0x1, Encoding.UTF8.GetBytes(text));

            private async Task SendFrameAsync(int opcode, byte[] payload)
            {
                // 首字节必须是 FIN(0x80) | opcode。只写 opcode 会发出非终止帧，
                // 客户端会一直等后续分片，message 事件永远不触发。
                var header = new List<byte> { (byte)(0x80 | opcode) };
                var length = payload.Length;
                // 服务端发出的帧不加掩码
                if (length < 126)
                {
                    header.Add((byte)length);
                }
                else if (length < 65536)
                {
                    header.Add(126);
                    header.Add((byte)((length >> 8) & 0xFF));
                    header.Add((byte)(length & 0xFF));
                }
                else
                {
                    header.Add(127);
                    for (var shift = 56; shift >= 0; shift -= 8)
                        header.Add((byte)(((long)length >> shift) & 0xFF));
                }

                var frame = new byte[header.Count + length];
                header.CopyTo(frame, 0);
                Array.Copy(payload, 0, frame, header.Count, length);

                await SendRawAsync(frame).ConfigureAwait(false);
            }

            private async Task SendRawAsync(byte[] frame)
            {
                await _writeLock.WaitAsync().ConfigureAwait(false);
                try
                {
                    await _stream.WriteAsync(frame).ConfigureAwait(false);
                    await _stream.FlushAsync().ConfigureAwait(false);
                }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                catch (SocketException) { }
                finally
                {
                    try { _writeLock.Release(); } catch (ObjectDisposedException) { }
                }
            }

            public void Close()
            {
                if (Interlocked.Exchange(ref _closed, 1) != 0) return;
                try { _client.Close(); } catch { }
                _server.OnDisconnected(this);
            }
        }
    }
}
