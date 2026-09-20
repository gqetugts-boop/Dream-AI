// ============================================================
//  App.xaml.cs — 装配与总控（对应 macOS 版的 AppDelegate.swift）
//
//  这个程序没有主窗口：托盘图标 + 一个随时会被唤出的透明圆环窗口。
//  所有部件在这里接线：
//     RingConfig  →  RingWindow / HotkeyManager / BridgeServer 端口
//     MouseHook   →  唤出圆环
//     RingWindow  →  RingAction  →  BridgeServer  →  Photoshop 插件
//     BridgeServer  →  RingState  →  下一帧的圆环菜单
// ============================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Windows;
using System.Windows.Threading;
using HuanmengRing.Models;
using HuanmengRing.Services;
using HuanmengRing.Views;
using WinForms = System.Windows.Forms;

namespace HuanmengRing
{
    public partial class App : Application
    {
        private RingConfig _config = new RingConfig();
        private RingState _state = new RingState();

        private RingWindow _ring;
        /// <summary>圆环下方的对话气泡。中文输入法要求真 TextBox，所以它是独立窗口</summary>
        private ChatWindow _chat;
        /// <summary>助手自己留一份完整回复。state 里那份是截断过的</summary>
        private string _lastChatQuestion = "";
        private string _lastChatReply = "";
        /// <summary>完整聊天记录（插件推一份、这里留一份）。用来支持「看对话」</summary>
        private List<ChatTurn> _lastChatHistory = new();
        /// <summary>正在等插件回 history（助手刚重启过时本地是空的）</summary>
        private bool _chatWantsHistory;
        private BridgeServer _bridge;
        private HotkeyManager _hotkey;
        private MouseHook _mouseHook;
        private WinForms.NotifyIcon _tray;
        private WinForms.ToolStripMenuItem _statusItem;
        private WinForms.ToolStripMenuItem _hotkeyItem;
        private DispatcherTimer _saveTimer;

        private IntPtr _trayIconHandle = IntPtr.Zero;
        private bool _announcedConnection;

        // ---------- 启动 ----------

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            _config = RingConfig.Load();

            _saveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(600) };
            _saveTimer.Tick += (_, __) => FlushConfig();

            BuildTray();
            BuildRing();
            BuildChat();
            BuildBridge();
            BuildHotkey();
            BuildMouseHook();

            UpdateTrayStatus();
            Console.Error.WriteLine($"[幻梦圆环] 已启动。配置文件：{RingConfig.ConfigPath}");
        }

        private void BuildTray()
        {
            _tray = new WinForms.NotifyIcon
            {
                Icon = CreateTrayIcon(),
                Visible = true,
                Text = "幻梦圆环",
            };

            var menu = new WinForms.ContextMenuStrip();

            var summon = new WinForms.ToolStripMenuItem("唤出圆环");
            summon.Click += (_, __) => SummonRing();
            menu.Items.Add(summon);

            _hotkeyItem = new WinForms.ToolStripMenuItem("热键：—") { Enabled = false };
            menu.Items.Add(_hotkeyItem);

            menu.Items.Add(new WinForms.ToolStripSeparator());

            _statusItem = new WinForms.ToolStripMenuItem("未连接插件") { Enabled = false };
            menu.Items.Add(_statusItem);

            var prefs = new WinForms.ToolStripMenuItem("偏好设置…");
            prefs.Click += (_, __) => OpenPreferences();
            menu.Items.Add(prefs);

            var reveal = new WinForms.ToolStripMenuItem("打开配置文件");
            reveal.Click += (_, __) => RevealConfig();
            menu.Items.Add(reveal);

            menu.Items.Add(new WinForms.ToolStripSeparator());

            var quit = new WinForms.ToolStripMenuItem("退出幻梦圆环");
            quit.Click += (_, __) => Shutdown();
            menu.Items.Add(quit);

            _tray.ContextMenuStrip = menu;
            _tray.DoubleClick += (_, __) => SummonRing();
        }

        private void BuildRing()
        {
            _ring = new RingWindow();
            _ring.SegmentCommitted += OnSegmentCommitted;
            _ring.Cancelled += () => Console.Error.WriteLine("[幻梦圆环] 已取消");
            _ring.VisibilityChanged += _ => RefreshInputOwnership();
            _ring.Initialize(_config);
        }

        private void BuildChat()
        {
            _chat = new ChatWindow();
            _chat.Submitted += OnChatSubmitted;
            _chat.VisibilityChanged += _ => RefreshInputOwnership();
        }

        /// <summary>
        /// 键盘归属。
        ///
        /// 平时归圆环：它的 KeyboardHook 要吞掉 Esc / 数字键（数字是直选扇区）。
        /// **气泡一开就全归气泡** —— 输入法要用数字键选候选词、用 Esc 取消组字，
        /// 被钩子吞掉就打不出中文了。这不是理论风险，是实测会让中文输入直接不可用。
        /// </summary>
        private void RefreshInputOwnership()
        {
            if (_ring == null) return;
            var chatOpen = _chat != null && _chat.IsChatVisible;

            // 圆环收了，气泡也不该孤零零留在屏幕上
            if (!_ring.IsRingVisible && chatOpen)
            {
                _chat.Dismiss();
                chatOpen = false;
            }

            _ring.SetKeyboardEnabled(_ring.IsRingVisible && !chatOpen);
        }

        private void BuildBridge()
        {
            _bridge = new BridgeServer(_config.Bridge.Port);
            _bridge.ConnectionChanged += OnConnectionChanged;
            _bridge.MessageReceived += OnBridgeMessage;
            _bridge.Start();
        }

        private void BuildHotkey()
        {
            _hotkey = new HotkeyManager();
            var ok = _hotkey.Register(_config.EffectiveHotkey, SummonRing);

            var display = _hotkey.Current?.Display ?? "—";
            _hotkeyItem.Text = ok ? $"热键：{display}" : $"热键：{display}（{_hotkey.LastError}）";
            if (!string.IsNullOrEmpty(_hotkey.LastError))
                Console.Error.WriteLine($"[幻梦圆环] {_hotkey.LastError}");
        }

        private void BuildMouseHook()
        {
            _mouseHook = new MouseHook();
            _mouseHook.OnRightButtonDown = OnGlobalRightDown;
            _mouseHook.OnLeftButtonDown = OnGlobalLeftDown;
            if (!_mouseHook.Install())
            {
                Console.Error.WriteLine("[幻梦圆环] 鼠标钩子未装上，Alt+右键唤出不可用；热键仍然可用");
            }
        }

        // ---------- 唤出 ----------

        private void SummonRing()
        {
            if (_ring == null) return;

            if (_ring.IsRingVisible)
            {
                _ring.Dismiss();
                return;
            }

            // 每次唤出都现取菜单，这样插件推来的选项永远是最新的
            var level = _state.Connected
                ? MenuBuilder.RootLevel(_state, _config)
                : MenuBuilder.PlaceholderLevel();

            NativeMethods.POINT point;
            if (_config.Interaction.SummonAtCursor && NativeMethods.GetCursorPos(out point))
            {
                _ring.Summon(level, point.X, point.Y);
                return;
            }

            // 不跟随鼠标时弹在主屏工作区中央
            if (NativeMethods.TryGetWorkArea(new NativeMethods.POINT { X = 0, Y = 0 }, out var work))
                _ring.Summon(level, (work.Left + work.Right) / 2, (work.Top + work.Bottom) / 2);
            else
                _ring.Summon(level, 600, 400);
        }

        private bool OnGlobalRightDown(int x, int y)
        {
            if (!_config.Interaction.AltRightClick) return false;
            if (!NativeMethods.IsKeyDown(NativeMethods.VK_MENU)) return false;
            if (!ForegroundApp.IsPhotoshopForeground()) return false;

            // 吞掉这一下，否则 Photoshop 会弹出它自己的右键菜单
            SummonRing();
            return true;
        }

        private bool OnGlobalLeftDown(int x, int y)
        {
            // 气泡开着的时候不关圆环：输入法的候选窗属于别的进程，
            // 用鼠标点候选词会被当成「点了 Photoshop」，一打字就把圆环收掉了。
            // （macOS 版在同样阶段摘掉全局点击监听，是同一件事。）
            if (_chat != null && _chat.IsChatVisible) return false;

            // 圆环开着的时候点环外 = 关掉它。不吞事件，Photoshop 该收到还得收到。
            if (_ring != null && _ring.IsRingVisible && !_ring.ContainsPhysicalPoint(x, y))
                _ring.Dismiss();
            return false;
        }

        // ---------- 圆环 → 插件 ----------

        private void OnSegmentCommitted(RingSegment segment)
        {
            if (segment?.Action == null) return;

            switch (segment.Action.Kind)
            {
                case RingActionKind.Command:
                    // resolved: true 告诉插件「这个动作助手已经解析过了，别再解析一次」。
                    // 插件侧有一层兼容旧版助手的翻译（老助手只发槽位 id）；
                    // 新助手发的是解析好的动作，不加这个标记会被插件二次解析，
                    // 把用户在助手偏好设置里关掉「采用插件下发的扇区动作」后做的改动覆盖掉。
                    _bridge?.Send(new System.Text.Json.Nodes.JsonObject
                    {
                        ["type"] = "command",
                        ["action"] = segment.Action.Command,
                        ["resolved"] = true,
                    });
                    break;

                case RingActionKind.SetParam:
                    // payload 这一层不能省：插件侧读的是 message.payload.key，
                    // 发扁平的 key/value 会静默失效（圆环里选模型没反应就是这个原因）
                    _bridge?.Send(new System.Text.Json.Nodes.JsonObject
                    {
                        ["type"] = "command",
                        ["action"] = "setParam",
                        ["payload"] = new System.Text.Json.Nodes.JsonObject
                        {
                            ["key"] = segment.Action.Key,
                            ["value"] = segment.Action.Value,
                        },
                    });
                    break;

                case RingActionKind.ApplyPreset:
                    _bridge?.Send(new System.Text.Json.Nodes.JsonObject
                    {
                        ["type"] = "command",
                        ["action"] = "applyPreset",
                        ["payload"] = new System.Text.Json.Nodes.JsonObject
                        {
                            ["name"] = segment.Action.Value,
                        },
                    });
                    break;

                // 带参数的指令：对话提问、切对话模型。
                // payload 原样交给插件，助手不需要知道里面是什么。
                case RingActionKind.CommandWith:
                    var payload = new System.Text.Json.Nodes.JsonObject();
                    foreach (var kv in segment.Action.Payload) payload[kv.Key] = kv.Value;
                    _bridge?.Send(new System.Text.Json.Nodes.JsonObject
                    {
                        ["type"] = "command",
                        ["action"] = segment.Action.Command,
                        ["resolved"] = true,
                        ["payload"] = payload,
                    });
                    break;

                case RingActionKind.Local:
                    OnLocalAction(segment.Action.Local);
                    break;

                case RingActionKind.CloseRing:
                    // 圆环在这之前已经关掉了，这里什么都不用做
                    break;
            }
        }

        // ---------- 圆环本地动作 ----------

        /// <summary>
        /// 提交动作时圆环已经收起来了，但窗口还停在刚才的位置 ——
        /// 气泡出现在圆环刚才在的地方才符合直觉。
        /// </summary>
        private void OnLocalAction(RingLocalKind kind)
        {
            if (_chat == null) return;
            var frame = _ring != null ? _ring.PhysicalFrame : (X: 0, Y: 0, Size: 0);
            if (frame.Size <= 0) return;

            switch (kind)
            {
                case RingLocalKind.TextInput:
                    _chat.ShowInput(frame.X, frame.Y, frame.Size);
                    break;

                case RingLocalKind.ShowReply:
                    // 优先用助手手里那份完整记录；没有（助手刚重启过）就找插件要 ——
                    // 插件那边才是唯一事实，它答完就把整份 history 推回来
                    if (_lastChatHistory.Count > 0)
                    {
                        _chat.ShowConversation(frame.X, frame.Y, frame.Size, _lastChatHistory);
                        break;
                    }
                    if (!_state.Chat.HasReply && string.IsNullOrEmpty(_lastChatReply)) break;
                    _chatWantsHistory = true;
                    _bridge?.Send(new System.Text.Json.Nodes.JsonObject
                    {
                        ["type"] = "command",
                        ["action"] = "chatHistory",
                        ["resolved"] = true,
                    });
                    break;
            }
        }

        private void OnChatSubmitted(string text)
        {
            if (_chat == null) return;
            _lastChatQuestion = text;
            var frame = _ring != null ? _ring.PhysicalFrame : (X: 0, Y: 0, Size: 0);
            // 先用本地那份记录把气泡撑起来（立刻有反馈），
            // 插件随后推的 thinking 会带上权威的一份并覆盖它
            _chat.ShowThinking(frame.X, frame.Y, frame.Size, text, _lastChatHistory);
            _bridge?.Send(new System.Text.Json.Nodes.JsonObject
            {
                ["type"] = "command",
                ["action"] = "chatAsk",
                ["resolved"] = true,
                ["payload"] = new System.Text.Json.Nodes.JsonObject { ["prompt"] = text },
            });
        }

        // ---------- 插件 → 圆环 ----------

        private void OnBridgeMessage(System.Text.Json.Nodes.JsonObject message)
        {
            var type = message["type"]?.GetValue<string>() ?? "";
            if (type == "hello") return;

            if (message["payload"] is not System.Text.Json.Nodes.JsonObject payload) return;

            switch (type)
            {
                case "state":
                    _state.Apply(payload);
                    UpdateTrayStatus();
                    break;

                // 对话推送：正文要显示在气泡里，塞进托盘提示根本看不完。
                // 以前这里不区分 type，任何 payload 都往 _state 上 Apply ——
                // 对话消息会污染状态，而且没人处理正文。
                case "chat":
                    OnChatPush(message);
                    break;

                default:
                    break;
            }
        }

        private void OnChatPush(System.Text.Json.Nodes.JsonObject message)
        {
            var action = message["action"]?.GetValue<string>() ?? "";
            var payload = message["payload"] as System.Text.Json.Nodes.JsonObject;
            var question = payload?["question"]?.GetValue<string>() ?? "";
            var history = ParseHistory(payload?["history"]);

            var frame = _ring != null ? _ring.PhysicalFrame : (X: 0, Y: 0, Size: 0);

            switch (action)
            {
                case "thinking":
                    _lastChatQuestion = question;
                    // 打字提问时气泡已经开着，不会重复弹；
                    // 快捷提问时气泡还没开，这才是它出现的地方
                    if (_chat != null && _chat.IsChatVisible)
                        _chat.UpdatePendingReply(frame.X, frame.Y, frame.Size, history, question, "正在回复…", false);
                    else if (_chat != null && frame.Size > 0)
                        _chat.ShowThinking(frame.X, frame.Y, frame.Size, question, history);
                    break;

                case "reply":
                    var text = payload?["text"]?.GetValue<string>() ?? "";
                    _lastChatQuestion = question;
                    _lastChatReply = text;
                    if (history.Count > 0) _lastChatHistory = history;
                    _chat?.UpdatePendingReply(frame.X, frame.Y, frame.Size, history, question, text, false);
                    break;

                case "error":
                    var reason = payload?["message"]?.GetValue<string>() ?? "提问失败";
                    _lastChatQuestion = question;
                    _lastChatReply = "";
                    if (history.Count > 0) _lastChatHistory = history;
                    _chat?.UpdatePendingReply(frame.X, frame.Y, frame.Size, history, question, reason, true);
                    break;

                // 「看对话」时找插件要的那一份
                case "history":
                    if (!_chatWantsHistory) break;
                    _chatWantsHistory = false;
                    _lastChatHistory = history;
                    if (frame.Size > 0)
                        _chat?.ShowConversation(frame.X, frame.Y, frame.Size, history);
                    break;
            }
        }

        /// <summary>把插件推的 history 数组转成聊天记录。
        /// 格式：<c>[{"role": "user"|"assistant", "text": "..."}]</c></summary>
        private static List<ChatTurn> ParseHistory(System.Text.Json.Nodes.JsonNode node)
        {
            var result = new List<ChatTurn>();
            if (node is not System.Text.Json.Nodes.JsonArray array) return result;
            foreach (var item in array)
            {
                if (item is not System.Text.Json.Nodes.JsonObject turn) continue;
                var text = turn["text"]?.GetValue<string>() ?? "";
                if (text.Length == 0) continue;
                var role = turn["role"]?.GetValue<string>() ?? "assistant";
                result.Add(new ChatTurn
                {
                    Role = role,
                    Text = text,
                    // 面板把失败也写成一条 assistant 消息，前缀是固定的
                    IsError = role != "user" && text.StartsWith("发送失败"),
                });
            }
            return result;
        }

        private void OnConnectionChanged(bool connected)
        {
            _state.Connected = connected;
            UpdateTrayStatus();

            if (connected && !_announcedConnection)
            {
                _announcedConnection = true;
                ShowBalloon("已连接 Photoshop 插件", "Alt+右键 或热键唤出圆环");
            }
            else if (!connected)
            {
                _announcedConnection = false;
            }
        }

        // ---------- 托盘状态 ----------

        private void UpdateTrayStatus()
        {
            if (_statusItem == null || _tray == null) return;

            var text = _state.Connected ? "已连接插件" : "未连接插件";
            _statusItem.Text = text;
            _tray.Text = Truncate($"幻梦圆环 · {text}", 62);
        }

        private void ShowBalloon(string title, string body)
        {
            try
            {
                _tray?.ShowBalloonTip(3000, title, body, WinForms.ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[幻梦圆环] 气泡提示失败：{ex.Message}");
            }
        }

        private static string Truncate(string text, int max) =>
            string.IsNullOrEmpty(text) || text.Length <= max ? text : text.Substring(0, max);

        // ---------- 配置 ----------

        private void OpenPreferences()
        {
            PreferencesWindow.ShowFor(_ring, _config, OnConfigChanged, HotkeyStatus);
        }

        private string HotkeyStatus()
        {
            if (_hotkey?.Current == null) return "热键：未注册";
            return string.IsNullOrEmpty(_hotkey.LastError)
                ? $"热键 {_hotkey.Current.Display} 已注册，鼠标钩子{(_mouseHook != null && _mouseHook.IsInstalled ? "正常" : "未装上")}"
                : _hotkey.LastError;
        }

        /// <summary>偏好设置里改一项就调一次。要便宜，所以存盘走防抖。</summary>
        private void OnConfigChanged(RingConfig config)
        {
            _config = config;

            _ring?.ApplyConfig(_config);

            // 热键重新注册：改了才重来，没改就是一次空转
            var desired = _config.EffectiveHotkey;
            if (_hotkey == null || _hotkey.Current == null ||
                !string.Equals(_hotkey.Current.Source, string.IsNullOrWhiteSpace(desired)
                    ? HotkeyManager.DefaultText : desired, StringComparison.OrdinalIgnoreCase))
            {
                BuildHotkey();
            }

            _saveTimer.Stop();
            _saveTimer.Start();
        }

        private void FlushConfig()
        {
            _saveTimer?.Stop();
            try { _config.Save(); }
            catch (Exception ex) { Console.Error.WriteLine($"[幻梦圆环] 配置保存失败：{ex.Message}"); }
        }

        private void RevealConfig()
        {
            FlushConfig();
            var path = RingConfig.ConfigPath;
            try
            {
                if (System.IO.File.Exists(path))
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
                }
                else
                {
                    Process.Start(new ProcessStartInfo("explorer.exe",
                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)) { UseShellExecute = true });
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[幻梦圆环] 打开配置文件失败：{ex.Message}");
            }
        }

        // ---------- 退出 ----------

        protected override void OnExit(ExitEventArgs e)
        {
            FlushConfig();

            try { _mouseHook?.Dispose(); } catch { }
            try { _hotkey?.Dispose(); } catch { }
            try { _bridge?.Stop(); } catch { }

            if (_tray != null)
            {
                _tray.Visible = false;
                _tray.Dispose();
                _tray = null;
            }

            // Icon.FromHandle 不接管句柄的所有权，得自己释放
            if (_trayIconHandle != IntPtr.Zero)
            {
                try { NativeMethods.DestroyIcon(_trayIconHandle); } catch { }
                _trayIconHandle = IntPtr.Zero;
            }

            base.OnExit(e);
        }

        // ---------- 托盘图标 ----------

        /// <summary>
        /// 运行时画一个圆环图标，不依赖 .ico 资源文件 ——
        /// 二进制资源没法用文本工具生成，写死了反而会编译不过。
        /// </summary>
        private System.Drawing.Icon CreateTrayIcon()
        {
            const int size = 32;
            using var bitmap = new System.Drawing.Bitmap(size, size);
            using (var g = System.Drawing.Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(System.Drawing.Color.Transparent);

                var rect = new System.Drawing.Rectangle(4, 4, size - 8, size - 8);
                using var basePen = new System.Drawing.Pen(
                    System.Drawing.Color.FromArgb(230, 225, 235, 245), 4f);
                g.DrawArc(basePen, rect, -90, 300);

                using var accentPen = new System.Drawing.Pen(
                    System.Drawing.Color.FromArgb(240, 90, 150, 230), 4f);
                g.DrawArc(accentPen, rect, 210, 60);
            }

            _trayIconHandle = bitmap.GetHicon();
            return System.Drawing.Icon.FromHandle(_trayIconHandle);
        }
    }
}
