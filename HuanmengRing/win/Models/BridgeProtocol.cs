// ============================================================
//  BridgeProtocol.cs — 桥接消息的解析与菜单构建
//
//  消息格式见 SPEC-ring-config.md 第四节。
//
//  容错策略（SPEC 4.2）：
//    params  —— 只在字段非空时覆盖当前值
//    options —— 只在数组非空时覆盖
//    labels  —— 未下发时保留上一次的值（插件可能只在名称变化时才推，
//               每帧清空会导致名称闪回默认值）
//    presets —— 整体替换
// ============================================================

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;

namespace HuanmengRing.Models
{
    public class BridgeOption
    {
        public string Value = "";
        public string Text = "";
    }

    public class BridgePresetItem
    {
        public string Name = "";
        public string Prompt = "";
    }

    public class BridgePresetGroup
    {
        public string Category = "";
        public List<BridgePresetItem> Items = new();
    }

    /// <summary>
    /// 插件下发的槽位定义：这个槽位叫什么、点了干什么。
    /// 槽位 id 是稳定标识，不能改；action 才是「点了干什么」。
    /// </summary>
    public class BridgeSector
    {
        public string Id = "";
        public string Action = "";
        public string Label = "";
    }

    /// <summary>
    /// 插件告知「它能执行哪些动作」，用来填偏好设置里的动作下拉框。
    /// 动作清单的唯一定义在插件侧，圆环不该自己再维护一份 —— 那样迟早对不上。
    /// </summary>
    public class BridgeActionOption
    {
        public string Value = "";
        public string Label = "";
        public string Hint = "";
    }

    /// <summary>一条快捷提问。标题显示在扇区里，Prompt 才是真正发出去的内容。</summary>
    public class BridgeChatQuestion
    {
        public string Label = "";
        public string Prompt = "";
    }

    /// <summary>
    /// 对话状态。圆环上的「对话」子菜单全靠它填：
    /// 模型列表、快捷提问，以及有没有回复可看。
    /// </summary>
    public class BridgeChat
    {
        public string Model = "";
        public List<BridgeOption> Models = new();
        public List<BridgeChatQuestion> Questions = new();
        public bool Busy;
        public bool HasReply;
        public string LastQuestion = "";
        /// <summary>插件只发截断版；完整回复走 type=chat 的推送，助手那边单独留一份</summary>
        public string LastReply = "";
    }

    /// <summary>程序内使用的可变状态快照</summary>
    public class RingState
    {
        public bool DocumentOpen;
        public string DocumentName = "";
        public bool HasSelection;
        public int SelectionWidth, SelectionHeight;

        public string Model = "";
        public string Resolution = "auto";
        public int Count = 1;

        public List<BridgeOption> ModelOptions = new();
        public List<BridgeOption> ResolutionOptions = new();
        public List<int> CountOptions = new() { 1, 2, 3, 4 };
        public List<BridgePresetGroup> Presets = new();

        /// <summary>插件下发的扇区名称。插件不推这个字段时保持为空，不影响现有行为。</summary>
        public Dictionary<string, string> Labels = new();

        /// <summary>插件下发的槽位动作，键是槽位 id</summary>
        public Dictionary<string, string> SectorActions = new();

        /// <summary>插件支持的动作清单（value / label / hint），用来填偏好设置的下拉框</summary>
        public List<BridgeActionOption> PluginActions = new();

        /// <summary>对话子菜单要用的那一块</summary>
        public BridgeChat Chat = new();

        public bool Connected;

        public void Apply(JsonObject payload)
        {
            if (payload == null) return;

            if (payload["document"] is JsonObject doc)
            {
                DocumentOpen = GetBool(doc, "open") ?? false;
                DocumentName = GetString(doc, "name") ?? "";
                HasSelection = GetBool(doc, "hasSelection") ?? false;
                SelectionWidth = GetInt(doc, "selectionWidth") ?? 0;
                SelectionHeight = GetInt(doc, "selectionHeight") ?? 0;
            }

            if (payload["params"] is JsonObject p)
            {
                var m = GetString(p, "model"); if (!string.IsNullOrEmpty(m)) Model = m;
                var r = GetString(p, "resolution"); if (!string.IsNullOrEmpty(r)) Resolution = r;
                var c = GetInt(p, "count"); if (c.HasValue && c.Value > 0) Count = c.Value;
            }

            if (payload["options"] is JsonObject o)
            {
                var models = ReadOptions(o["model"]);
                if (models.Count > 0) ModelOptions = models;
                var resolutions = ReadOptions(o["resolution"]);
                if (resolutions.Count > 0) ResolutionOptions = resolutions;
                var counts = ReadInts(o["count"]);
                if (counts.Count > 0) CountOptions = counts;
            }

            if (payload["presets"] is JsonArray groups)
            {
                Presets = groups.OfType<JsonObject>().Select(g => new BridgePresetGroup
                {
                    Category = GetString(g, "category") ?? "",
                    Items = (g["items"] as JsonArray ?? new JsonArray())
                        .OfType<JsonObject>()
                        .Select(it => new BridgePresetItem
                        {
                            Name = GetString(it, "name") ?? "",
                            Prompt = GetString(it, "prompt") ?? "",
                        }).ToList(),
                }).ToList();
            }

            if (payload["chat"] is JsonObject chat)
            {
                var m = GetString(chat, "model"); if (!string.IsNullOrEmpty(m)) Chat.Model = m;
                var models = ReadOptions(chat["models"]);
                if (models.Count > 0) Chat.Models = models;
                if (chat["questions"] is JsonArray questions)
                {
                    Chat.Questions = questions.OfType<JsonObject>().Select(q => new BridgeChatQuestion
                    {
                        Label = GetString(q, "label") ?? "",
                        Prompt = GetString(q, "prompt") ?? GetString(q, "label") ?? "",
                    }).Where(q => q.Label.Length > 0 || q.Prompt.Length > 0).ToList();
                }
                Chat.Busy = GetBool(chat, "busy") ?? false;
                Chat.HasReply = GetBool(chat, "hasReply") ?? false;
                var lq = GetString(chat, "lastQuestion"); if (lq != null) Chat.LastQuestion = lq;
                var lr = GetString(chat, "lastReply"); if (lr != null) Chat.LastReply = lr;
            }

            // labels 未下发时**保留上一次的值**，不清空
            if (payload["labels"] is JsonObject labels)
            {
                var next = new Dictionary<string, string>();
                foreach (var kv in labels)
                {
                    if (kv.Value is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrEmpty(s))
                        next[kv.Key] = s;
                }
                if (next.Count > 0) Labels = next;
            }

            // 槽位表：动作和名称一起下发。同样「没推就保留上一次」——
            // 插件可能只在改动时才推这一项。
            if (payload["sectors"] is JsonArray sectors)
            {
                var actions = new Dictionary<string, string>();
                var names = new Dictionary<string, string>();
                foreach (var item in sectors.OfType<JsonObject>())
                {
                    var id = GetString(item, "id");
                    if (string.IsNullOrEmpty(id)) continue;
                    var act = GetString(item, "action");
                    if (!string.IsNullOrEmpty(act)) actions[id] = act;
                    var name = GetString(item, "label");
                    if (!string.IsNullOrEmpty(name)) names[id] = name;
                }
                if (actions.Count > 0) SectorActions = actions;
                if (names.Count > 0) Labels = names;
            }

            // 动作清单整体替换：它是插件的完整能力列表，不存在「只推一部分」
            if (payload["actions"] is JsonArray options)
            {
                PluginActions = options.OfType<JsonObject>().Select(o => new BridgeActionOption
                {
                    Value = GetString(o, "value") ?? "",
                    Label = GetString(o, "label") ?? "",
                    Hint = GetString(o, "hint") ?? "",
                }).Where(o => o.Value.Length > 0).ToList();
            }
        }

        /// <summary>圆环上显示的一行摘要，放在托盘提示里</summary>
        public string Summary()
        {
            if (!Connected) return "未连接插件";
            var parts = new List<string> { DocumentOpen ? DocumentName : "无文档" };
            if (HasSelection) parts.Add($"选区 {SelectionWidth}×{SelectionHeight}");
            if (!string.IsNullOrEmpty(Model)) parts.Add(Model);
            return string.Join(" · ", parts);
        }

        private static List<BridgeOption> ReadOptions(JsonNode node)
        {
            var result = new List<BridgeOption>();
            if (node is not JsonArray arr) return result;
            foreach (var item in arr)
            {
                if (item is JsonValue v && v.TryGetValue<string>(out var s))
                    result.Add(new BridgeOption { Value = s, Text = s });
                else if (item is JsonObject o)
                {
                    var val = GetString(o, "value") ?? "";
                    if (val.Length == 0) continue;
                    result.Add(new BridgeOption { Value = val, Text = GetString(o, "text") ?? val });
                }
            }
            return result;
        }

        private static List<int> ReadInts(JsonNode node)
        {
            var result = new List<int>();
            if (node is not JsonArray arr) return result;
            foreach (var item in arr)
            {
                if (item is JsonValue v && v.TryGetValue<int>(out var i)) result.Add(i);
            }
            return result;
        }

        private static string GetString(JsonObject o, string key) =>
            o.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

        private static bool? GetBool(JsonObject o, string key) =>
            o.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;

        private static int? GetInt(JsonObject o, string key) =>
            o.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<int>(out var i) ? i : null;
    }

    public static class MenuBuilder
    {
        /// <summary>插件未连接时的占位菜单</summary>
        public static RingLevel PlaceholderLevel() => new()
        {
            Title = "圆环",
            Segments = new List<RingSegment>
            {
                new() { Label = "未连接", Hint = "等待插件", Disabled = true },
                new() { Label = "插件", Hint = "请确认已加载", Disabled = true },
                new() { Label = "关闭", Hint = "或按 Esc", Action = RingAction.CloseRing() },
            }
        };

        /// <summary>
        /// 扇区最终显示的名字。优先级：
        ///   插件下发（需在偏好设置里开启）> 用户自定义 > 内置默认
        /// </summary>
        public static string ResolvedLabel(string id, RingConfig config, RingState state)
        {
            if (config.Content.UsePluginLabels &&
                state.Labels.TryGetValue(id, out var fromPlugin) &&
                !string.IsNullOrEmpty(fromPlugin))
            {
                return fromPlugin;
            }
            var custom = config.Content.Sectors.Get(id).Label;
            return string.IsNullOrEmpty(custom)
                ? (RingSectors.DefaultLabels.TryGetValue(id, out var d) ? d : id)
                : custom;
        }

        /// <summary>
        /// 每个槽位的内置默认动作。没配置过时用它，也就是说
        /// 「不配置时行为和改造前完全一样」。
        /// 值必须和插件侧 ring-bridge.js 的 DEFAULT_ACTIONS 保持一致。
        ///
        /// 注意 chat 槽位对应的是 chatMenu 指令（不是 "chat"）——
        /// 后缀不一致是历史原因，别顺手「统一」掉，那是协议，两边都得改。
        /// 插件侧 DEFAULT_ACTIONS 必须同步改成 chatMenu，否则
        /// 「采用插件下发的扇区动作」一开就会被打回 openChat。
        /// </summary>
        public static readonly Dictionary<string, string> DefaultActions = new()
        {
            ["generate"] = "generate",
            ["params"] = "params",
            ["presets"] = "presets",
            ["chat"] = "chatMenu",
            ["readSelection"] = "readSelection",
            ["close"] = "close",
        };

        /// <summary>
        /// 扇区最终执行的动作。优先级和标签完全一致：
        ///   插件下发（需在偏好设置里开启）> 用户自定义 > 内置默认
        /// </summary>
        public static string ResolvedAction(string id, RingConfig config, RingState state)
        {
            if (config.Content.UsePluginActions &&
                state.SectorActions.TryGetValue(id, out var fromPlugin) &&
                !string.IsNullOrEmpty(fromPlugin))
            {
                return fromPlugin;
            }
            var custom = config.Content.Sectors.Get(id).Action;
            if (!string.IsNullOrEmpty(custom)) return custom;
            return DefaultActions.TryGetValue(id, out var fallback) ? fallback : id;
        }

        /// <summary>
        /// 按动作造一个扇区。
        ///
        /// 这是整个改造的核心：槽位不再写死行为，而是看它被指派了什么动作。
        /// params / presets 要展开子菜单、close 是圆环本地行为，这三个由圆环自己处理；
        /// **其余动作一律当命令转发给插件** —— 圆环不需要知道 "tab:gallery" 是什么意思。
        /// 这样插件以后加新动作，助手一行都不用改。
        /// </summary>
        private static RingSegment SegmentFor(string action, RingState state)
        {
            switch (action)
            {
                case "generate":
                    return new RingSegment
                    {
                        Hint = state.Connected ? "按当前参数出图" : "插件未连接",
                        Disabled = !state.Connected,
                        Action = RingAction.Command_("generate"),
                    };

                case "params":
                    return new RingSegment
                    {
                        Hint = string.IsNullOrEmpty(state.Model) ? "模型/比例/数量" : state.Model,
                        Children = ParameterSegments(state),
                        Disabled = !state.Connected,
                    };

                case "presets":
                    return new RingSegment
                    {
                        Hint = state.Presets.Count == 0 ? "未加载" : $"{state.Presets.Count} 个分类",
                        Children = PresetCategorySegments(state),
                        Disabled = !state.Connected || state.Presets.Count == 0,
                    };

                // 对话子菜单：模型、快捷提问、打字提问全在这儿。
                // 内容由插件下发，主插件的对话流程本来就会把回复记进聊天记录，
                // 这里不另起一套。
                case "chatMenu":
                    return new RingSegment
                    {
                        Hint = state.Chat.Busy
                            ? "正在等回复…"
                            : (string.IsNullOrEmpty(state.Chat.Model) ? "模型 / 提问 / 打字" : state.Chat.Model),
                        Children = ChatSegments(state),
                        Disabled = !state.Connected,
                    };

                case "readSelection":
                    return new RingSegment
                    {
                        Hint = state.HasSelection ? $"{state.SelectionWidth}×{state.SelectionHeight}" : "整图",
                        Disabled = !state.Connected || !state.DocumentOpen,
                        Action = RingAction.Command_("readSelection"),
                    };

                // 圆环本地就把自己关了，不会发到插件
                case "close":
                    return new RingSegment { Hint = "或按 Esc", Action = RingAction.CloseRing() };

                default:
                    return new RingSegment
                    {
                        Hint = ActionHint(action, state),
                        Disabled = !state.Connected,
                        Action = RingAction.Command_(action),
                    };
            }
        }

        /// <summary>动作的说明文字。插件下发过就用它的，没下发就留空 —— 不自己编词。</summary>
        private static string ActionHint(string action, RingState state)
        {
            foreach (var option in state.PluginActions)
            {
                if (option.Value == action) return option.Hint;
            }
            return "";
        }

        public static RingLevel RootLevel(RingState state, RingConfig config)
        {
            // 先按配置的顺序/显隐把槽位拼出来，动作和标签再逐项解析 ——
            // 三个来源（插件下发 / 用户自定义 / 内置默认）各自只有一处判定逻辑。
            var segments = new List<RingSegment>();
            foreach (var (id, _) in config.Content.Sectors.OrderedVisible())
            {
                var action = ResolvedAction(id, config, state);
                var segment = SegmentFor(action, state);
                segment.Label = ResolvedLabel(id, config, state);
                segments.Add(segment);
            }

            // 兜底：用户可能把六个扇区全关了。空菜单会让圆环整个画不出来，
            // 看起来像助手挂了。按内置顺序恢复，不能遍历字典（顺序随机）。
            if (segments.Count == 0)
            {
                foreach (var id in RingSectors.Ids)
                {
                    var action = DefaultActions.TryGetValue(id, out var a) ? a : id;
                    var segment = SegmentFor(action, state);
                    segment.Label = RingSectors.DefaultLabels.TryGetValue(id, out var d) ? d : id;
                    segments.Add(segment);
                }
            }

            return new RingLevel { Title = "圆环", Segments = segments };
        }

        /// <summary>
        /// 参数直接镜像主插件的下拉控件：选项和当前值都是从那边搬过来的，
        /// 所以圆环上看到的永远和面板一致。
        /// </summary>
        private static List<RingSegment> ParameterSegments(RingState state)
        {
            var segments = new List<RingSegment>();

            var modelLabels = ShortLabels(state.ModelOptions.Select(o => o.Value).ToList());
            segments.Add(new RingSegment
            {
                Label = $"模型 {(string.IsNullOrEmpty(state.Model) ? "未选" : state.Model)}",
                Hint = $"{state.ModelOptions.Count} 个可选",
                Children = state.ModelOptions.Zip(modelLabels, (option, label) => new RingSegment
                {
                    Label = label,
                    Hint = string.IsNullOrEmpty(option.Text) ? option.Value : option.Text,
                    Checked = option.Value == state.Model,
                    Action = RingAction.SetParam("model", option.Value),
                }).ToList(),
            });

            segments.Add(new RingSegment
            {
                Label = $"分辨率 {state.Resolution}",
                Hint = "输出尺寸档位",
                Children = state.ResolutionOptions.Select(option => new RingSegment
                {
                    Label = string.IsNullOrEmpty(option.Text) ? option.Value : option.Text,
                    Checked = option.Value == state.Resolution,
                    Action = RingAction.SetParam("resolution", option.Value),
                }).ToList(),
            });

            segments.Add(new RingSegment
            {
                Label = $"数量 {state.Count}",
                Hint = "一次生成几张",
                Children = state.CountOptions.Select(n => new RingSegment
                {
                    Label = $"{n} 张",
                    Checked = n == state.Count,
                    Action = RingAction.SetParam("count", n.ToString()),
                }).ToList(),
            });

            return segments;
        }

        /// <summary>
        /// 对话子菜单的内容。
        ///
        /// 「打字提问」和「看回复」是圆环本地动作（不发给插件）：
        /// 前者要开一个真正的 TextBox 才能挂上中文输入法，
        /// 后者是把助手手里那份回复原样再显示一遍。
        /// </summary>
        public static List<RingSegment> ChatSegments(RingState state)
        {
            var segments = new List<RingSegment>();
            var chat = state.Chat;

            var modelLabels = ShortLabels(chat.Models.Select(o => o.Value).ToList());
            segments.Add(new RingSegment
            {
                Label = $"模型 {(string.IsNullOrEmpty(chat.Model) ? "未选" : chat.Model)}",
                Hint = $"{chat.Models.Count} 个可选",
                Disabled = chat.Models.Count == 0,
                Children = chat.Models.Zip(modelLabels, (option, label) => new RingSegment
                {
                    Label = label,
                    Hint = string.IsNullOrEmpty(option.Text) ? option.Value : option.Text,
                    Checked = option.Value == chat.Model,
                    Action = RingAction.CommandWith("chatModel",
                        new Dictionary<string, string> { ["value"] = option.Value }),
                }).ToList(),
            });

            segments.Add(new RingSegment
            {
                Label = "快捷提问",
                Hint = chat.Questions.Count == 0 ? "未设置" : $"{chat.Questions.Count} 条",
                Disabled = chat.Questions.Count == 0,
                Children = chat.Questions.Select(q => new RingSegment
                {
                    Label = q.Label,
                    Hint = Truncate(q.Prompt, 28),
                    Action = RingAction.CommandWith("chatAsk",
                        new Dictionary<string, string> { ["prompt"] = q.Prompt }),
                }).ToList(),
            });

            segments.Add(new RingSegment
            {
                Label = "打字提问",
                Hint = "支持中文输入法",
                Action = RingAction.Local_(RingLocalKind.TextInput),
            });

            if (chat.HasReply)
            {
                segments.Add(new RingSegment
                {
                    Label = "看回复",
                    Hint = Truncate(chat.LastReply, 20),
                    Action = RingAction.Local_(RingLocalKind.ShowReply),
                });
            }

            segments.Add(new RingSegment
            {
                Label = "新对话",
                Hint = "清空聊天记录",
                Action = RingAction.Command_("chatNew"),
            });

            segments.Add(new RingSegment
            {
                Label = "打开面板",
                Hint = "切到对话页",
                Action = RingAction.Command_("openChat"),
            });

            return segments;
        }

        private static List<RingSegment> PresetCategorySegments(RingState state) =>
            state.Presets.Select(group => new RingSegment
            {
                Label = group.Category,
                Hint = $"{group.Items.Count} 条",
                Children = group.Items.Select(item => new RingSegment
                {
                    Label = item.Name,
                    Hint = Truncate(item.Prompt, 28),
                    Action = RingAction.ApplyPreset(item.Name),
                }).ToList(),
            }).ToList();

        /// <summary>
        /// 模型名按兄弟项的公共前缀缩写，和 macOS / UXP 版一致：
        /// nano-banana-fast / -2 / -pro 全写出来扇区里根本分不清。
        /// </summary>
        public static List<string> ShortLabels(List<string> values)
        {
            if (values.Count == 0) return new List<string>();
            var prefix = values[0];
            foreach (var v in values)
            {
                var i = 0;
                while (i < prefix.Length && i < v.Length && prefix[i] == v[i]) i++;
                prefix = prefix.Substring(0, i);
                if (prefix.Length == 0) break;
            }
            // 缩到最后一个分隔符为止，避免把 "nano-banana-f" 这种半截词当公共前缀
            var cut = prefix.LastIndexOfAny(new[] { '-', '_', '/', '.' });
            if (cut > 0) prefix = prefix.Substring(0, cut + 1);

            return values.Select(v =>
            {
                var short_ = prefix.Length > 0 && v.StartsWith(prefix) ? v.Substring(prefix.Length) : v;
                return string.IsNullOrEmpty(short_) ? v : short_;
            }).ToList();
        }

        private static string Truncate(string text, int max)
        {
            if (string.IsNullOrEmpty(text)) return "";
            return text.Length <= max ? text : text.Substring(0, max - 1) + "…";
        }
    }
}
