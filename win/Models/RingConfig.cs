// ============================================================
//  RingConfig.cs — 配置模型与持久化
//
//  字段、默认值、取值范围全部对齐 SPEC-ring-config.md，
//  与 macOS 版共用同一份 ~/.huanmeng-ring.json 格式。
//
//  容错要求（SPEC 第六节）：
//    文件不存在 / JSON 语法错误 / 类型不对 / 只写一半
//    —— 四种情况都必须回退到默认值继续运行，不能启动失败。
//  所以这里不用 JsonSerializer 直接反序列化整个对象，而是先读成
//  JsonNode 再逐字段取值，任何一层取不到就用默认值。
// ============================================================

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace HuanmengRing.Models
{
    /// <summary>配色。全部是 "#RRGGBB" / "#RRGGBBAA" 字符串，跨平台中立。</summary>
    public class RingPalette
    {
        public string WedgeFill { get; set; } = "#33333BF5";
        public string WedgeFillAlt { get; set; } = "#2B2B33F5";
        public string WedgeEdge { get; set; } = "#5C5C5CD9";
        public string HoverFill { get; set; } = "#4278C2FF";
        public string HoverEdge { get; set; } = "#85BDFFFF";
        public string HubFill { get; set; } = "#1F1F24FA";
        public string HubEdge { get; set; } = "#4770A8FF";
        public string Text { get; set; } = "#F0F0F0FF";
        public string TextDim { get; set; } = "#999999FF";
        public string TextFaint { get; set; } = "#6B6B6BFF";
        public string Accent { get; set; } = "#61E094FF";

        public RingPalette Clone() => (RingPalette)MemberwiseClone();
    }

    public class RingAppearance
    {
        public double RingSize { get; set; } = 340;
        public double BandRatio { get; set; } = 0.44;
        public double GapRatio { get; set; } = 0.06;
        public double GapMax { get; set; } = 0.014;
        public double PopDistance { get; set; } = 7;
        public double Opacity { get; set; } = 1.0;
        public double DisabledWedgeAlpha { get; set; } = 0.4;
        public double DisabledEdgeAlpha { get; set; } = 0.35;
        public double AppearScale { get; set; } = 0.86;
        public double AppearStep { get; set; } = 0.18;
        public double HoverSpeed { get; set; } = 0.28;
        public double LabelFontSize { get; set; } = 9.5;
        public double LabelLineHeight { get; set; } = 11;
        public double HubTitleFontSize { get; set; } = 12;
        public double HubSubFontSize { get; set; } = 9;
        public bool ShadowEnabled { get; set; } = true;
        public double ShadowBlur { get; set; } = 10;
        public double ShadowOffsetY { get; set; } = 3;
        public double ShadowAlpha { get; set; } = 0.55;
        public RingPalette Colors { get; set; } = new RingPalette();
    }

    public class RingInteraction
    {
        public string Hotkey { get; set; } = "";
        public bool AltRightClick { get; set; } = true;
        public bool HoverHighlight { get; set; } = true;
        public bool KeyboardSelect { get; set; } = true;
        public bool EscapeToClose { get; set; } = true;
        public bool SummonAtCursor { get; set; } = true;
        public bool ShowChildMarker { get; set; } = true;
        public bool ShowDirectionLine { get; set; } = true;
        public bool PopOnHover { get; set; } = true;
    }

    public class RingSectorConfig
    {
        public string Label { get; set; } = "";
        public bool Visible { get; set; } = true;
        public int Order { get; set; } = 99;

        /// <summary>
        /// 这个扇区被点了以后干什么。
        /// 空 = 用该槽位的内置默认动作（见 MenuBuilder.DefaultActions），
        /// 也就是「没配置过时行为和改造前完全一样」。
        /// 插件下发同名动作时会覆盖这里 —— 优先级和标签一致。
        /// </summary>
        public string Action { get; set; } = "";

        public RingSectorConfig() { }
        public RingSectorConfig(string label, int order) { Label = label; Order = order; }
    }

    public class RingSectors
    {
        public RingSectorConfig Generate { get; set; } = new RingSectorConfig("生成", 0);
        public RingSectorConfig Params { get; set; } = new RingSectorConfig("参数", 1);
        public RingSectorConfig Presets { get; set; } = new RingSectorConfig("预设", 2);
        public RingSectorConfig Chat { get; set; } = new RingSectorConfig("对话", 3);
        public RingSectorConfig ReadSelection { get; set; } = new RingSectorConfig("读选区", 4);
        public RingSectorConfig Close { get; set; } = new RingSectorConfig("关闭", 5);

        /// <summary>六个扇区的稳定 id，顺序即内置默认顺序。改 id 会让已存配置失效。</summary>
        public static readonly string[] Ids =
            { "generate", "params", "presets", "chat", "readSelection", "close" };

        public static readonly Dictionary<string, string> DefaultLabels = new()
        {
            ["generate"] = "生成", ["params"] = "参数", ["presets"] = "预设",
            ["chat"] = "对话", ["readSelection"] = "读选区", ["close"] = "关闭",
        };

        public RingSectorConfig Get(string id) => id switch
        {
            "generate" => Generate,
            "params" => Params,
            "presets" => Presets,
            "chat" => Chat,
            "readSelection" => ReadSelection,
            "close" => Close,
            _ => new RingSectorConfig("", 99) { Visible = false },
        };

        /// <summary>按 order 升序排出可见扇区。顺序由配置决定，不依赖字典顺序。</summary>
        public List<(string Id, RingSectorConfig Config)> OrderedVisible() =>
            Ids.Select(id => (Id: id, Config: Get(id)))
               .Where(x => x.Config.Visible)
               .OrderBy(x => x.Config.Order)
               .ToList();
    }

    public class RingContent
    {
        public bool UsePluginLabels { get; set; } = true;

        /// <summary>
        /// 采用插件下发的扇区动作。关掉则永远用自定义动作 / 内置默认。
        /// 和 UsePluginLabels 是两个独立开关 —— 你可以想用插件的名字
        /// 但自己决定点了干什么，反之亦然。
        /// </summary>
        public bool UsePluginActions { get; set; } = true;

        public RingSectors Sectors { get; set; } = new RingSectors();
    }

    public class RingBridge
    {
        public int Port { get; set; } = 8799;
    }

    public class RingConfig
    {
        public int Version { get; set; } = 1;
        public RingAppearance Appearance { get; set; } = new RingAppearance();
        public RingInteraction Interaction { get; set; } = new RingInteraction();
        public RingContent Content { get; set; } = new RingContent();
        public RingBridge Bridge { get; set; } = new RingBridge();

        /// <summary>顶层 hotkey（旧格式）。interaction.hotkey 为空时生效。</summary>
        public string LegacyHotkey { get; set; } = "";

        public string EffectiveHotkey =>
            string.IsNullOrWhiteSpace(Interaction.Hotkey) ? LegacyHotkey : Interaction.Hotkey;

        public static string ConfigPath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".huanmeng-ring.json");

        // ---------- 读取 ----------

        public static RingConfig Load()
        {
            var config = new RingConfig();
            JsonObject root;
            try
            {
                if (!File.Exists(ConfigPath)) return config;
                var text = File.ReadAllText(ConfigPath);
                root = JsonNode.Parse(text) as JsonObject;
                if (root == null) return config;   // 顶层不是对象，整份忽略
            }
            catch (Exception ex)
            {
                // JSON 坏了不该让助手起不来
                Console.Error.WriteLine($"[幻梦圆环] 配置文件解析失败，使用默认配置：{ex.Message}");
                return config;
            }

            config.LegacyHotkey = Str(root, "hotkey") ?? "";

            if (root["config"] is JsonObject c)
            {
                config.Version = Int(c, "version") ?? config.Version;
                ReadAppearance(c["appearance"] as JsonObject, config.Appearance);
                ReadInteraction(c["interaction"] as JsonObject, config.Interaction);
                ReadContent(c["content"] as JsonObject, config.Content);
                if (c["bridge"] is JsonObject b)
                    config.Bridge.Port = Int(b, "port") ?? config.Bridge.Port;
            }
            return config;
        }

        private static void ReadAppearance(JsonObject o, RingAppearance a)
        {
            if (o == null) return;
            a.RingSize = Dbl(o, "ringSize") ?? a.RingSize;
            a.BandRatio = Dbl(o, "bandRatio") ?? a.BandRatio;
            a.GapRatio = Dbl(o, "gapRatio") ?? a.GapRatio;
            a.GapMax = Dbl(o, "gapMax") ?? a.GapMax;
            a.PopDistance = Dbl(o, "popDistance") ?? a.PopDistance;
            a.Opacity = Dbl(o, "opacity") ?? a.Opacity;
            a.DisabledWedgeAlpha = Dbl(o, "disabledWedgeAlpha") ?? a.DisabledWedgeAlpha;
            a.DisabledEdgeAlpha = Dbl(o, "disabledEdgeAlpha") ?? a.DisabledEdgeAlpha;
            a.AppearScale = Dbl(o, "appearScale") ?? a.AppearScale;
            a.AppearStep = Dbl(o, "appearStep") ?? a.AppearStep;
            a.HoverSpeed = Dbl(o, "hoverSpeed") ?? a.HoverSpeed;
            a.LabelFontSize = Dbl(o, "labelFontSize") ?? a.LabelFontSize;
            a.LabelLineHeight = Dbl(o, "labelLineHeight") ?? a.LabelLineHeight;
            a.HubTitleFontSize = Dbl(o, "hubTitleFontSize") ?? a.HubTitleFontSize;
            a.HubSubFontSize = Dbl(o, "hubSubFontSize") ?? a.HubSubFontSize;
            a.ShadowEnabled = Bool(o, "shadowEnabled") ?? a.ShadowEnabled;
            a.ShadowBlur = Dbl(o, "shadowBlur") ?? a.ShadowBlur;
            a.ShadowOffsetY = Dbl(o, "shadowOffsetY") ?? a.ShadowOffsetY;
            a.ShadowAlpha = Dbl(o, "shadowAlpha") ?? a.ShadowAlpha;

            if (o["colors"] is JsonObject col)
            {
                var d = new RingPalette();
                a.Colors = new RingPalette
                {
                    WedgeFill = Str(col, "wedgeFill") ?? d.WedgeFill,
                    WedgeFillAlt = Str(col, "wedgeFillAlt") ?? d.WedgeFillAlt,
                    WedgeEdge = Str(col, "wedgeEdge") ?? d.WedgeEdge,
                    HoverFill = Str(col, "hoverFill") ?? d.HoverFill,
                    HoverEdge = Str(col, "hoverEdge") ?? d.HoverEdge,
                    HubFill = Str(col, "hubFill") ?? d.HubFill,
                    HubEdge = Str(col, "hubEdge") ?? d.HubEdge,
                    Text = Str(col, "text") ?? d.Text,
                    TextDim = Str(col, "textDim") ?? d.TextDim,
                    TextFaint = Str(col, "textFaint") ?? d.TextFaint,
                    Accent = Str(col, "accent") ?? d.Accent,
                };
            }
        }

        private static void ReadInteraction(JsonObject o, RingInteraction i)
        {
            if (o == null) return;
            i.Hotkey = Str(o, "hotkey") ?? i.Hotkey;
            i.AltRightClick = Bool(o, "altRightClick") ?? i.AltRightClick;
            i.HoverHighlight = Bool(o, "hoverHighlight") ?? i.HoverHighlight;
            i.KeyboardSelect = Bool(o, "keyboardSelect") ?? i.KeyboardSelect;
            i.EscapeToClose = Bool(o, "escapeToClose") ?? i.EscapeToClose;
            i.SummonAtCursor = Bool(o, "summonAtCursor") ?? i.SummonAtCursor;
            i.ShowChildMarker = Bool(o, "showChildMarker") ?? i.ShowChildMarker;
            i.ShowDirectionLine = Bool(o, "showDirectionLine") ?? i.ShowDirectionLine;
            i.PopOnHover = Bool(o, "popOnHover") ?? i.PopOnHover;
        }

        private static void ReadContent(JsonObject o, RingContent ct)
        {
            if (o == null) return;
            ct.UsePluginLabels = Bool(o, "usePluginLabels") ?? ct.UsePluginLabels;
            // 老配置文件没有这个键，缺了要按默认（开）走
            ct.UsePluginActions = Bool(o, "usePluginActions") ?? ct.UsePluginActions;
            if (o["sectors"] is JsonObject s)
            {
                foreach (var id in RingSectors.Ids)
                {
                    if (s[id] is not JsonObject one) continue;
                    var target = ct.Sectors.Get(id);
                    target.Label = Str(one, "label") ?? target.Label;
                    target.Visible = Bool(one, "visible") ?? target.Visible;
                    target.Order = Int(one, "order") ?? target.Order;
                    target.Action = Str(one, "action") ?? target.Action;
                }
            }
        }

        // JsonNode 的取值助手。类型不对时返回 null，由调用方回落到默认值。
        private static string Str(JsonObject o, string key) =>
            o.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

        private static double? Dbl(JsonObject o, string key) =>
            o.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<double>(out var d) ? d : null;

        private static int? Int(JsonObject o, string key) =>
            o.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<int>(out var i) ? i : null;

        private static bool? Bool(JsonObject o, string key) =>
            o.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;

        // ---------- 写入 ----------

        /// <summary>
        /// 写盘。必须保留文件里不认识的顶层键 —— 用户可能在里面放了自己的东西，
        /// 也可能有更新版本写入的字段，整份覆盖会丢。
        /// </summary>
        public void Save()
        {
            JsonObject root;
            try
            {
                root = File.Exists(ConfigPath)
                    ? JsonNode.Parse(File.ReadAllText(ConfigPath)) as JsonObject ?? new JsonObject()
                    : new JsonObject();
            }
            catch
            {
                root = new JsonObject();   // 原文件坏了，重写成一份干净的
            }

            var hotkey = EffectiveHotkey;
            if (!string.IsNullOrWhiteSpace(hotkey)) root["hotkey"] = hotkey;

            root["config"] = new JsonObject
            {
                ["version"] = Version,
                ["appearance"] = new JsonObject
                {
                    ["ringSize"] = Appearance.RingSize,
                    ["bandRatio"] = Appearance.BandRatio,
                    ["gapRatio"] = Appearance.GapRatio,
                    ["gapMax"] = Appearance.GapMax,
                    ["popDistance"] = Appearance.PopDistance,
                    ["opacity"] = Appearance.Opacity,
                    ["disabledWedgeAlpha"] = Appearance.DisabledWedgeAlpha,
                    ["disabledEdgeAlpha"] = Appearance.DisabledEdgeAlpha,
                    ["appearScale"] = Appearance.AppearScale,
                    ["appearStep"] = Appearance.AppearStep,
                    ["hoverSpeed"] = Appearance.HoverSpeed,
                    ["labelFontSize"] = Appearance.LabelFontSize,
                    ["labelLineHeight"] = Appearance.LabelLineHeight,
                    ["hubTitleFontSize"] = Appearance.HubTitleFontSize,
                    ["hubSubFontSize"] = Appearance.HubSubFontSize,
                    ["shadowEnabled"] = Appearance.ShadowEnabled,
                    ["shadowBlur"] = Appearance.ShadowBlur,
                    ["shadowOffsetY"] = Appearance.ShadowOffsetY,
                    ["shadowAlpha"] = Appearance.ShadowAlpha,
                    ["colors"] = new JsonObject
                    {
                        ["wedgeFill"] = Appearance.Colors.WedgeFill,
                        ["wedgeFillAlt"] = Appearance.Colors.WedgeFillAlt,
                        ["wedgeEdge"] = Appearance.Colors.WedgeEdge,
                        ["hoverFill"] = Appearance.Colors.HoverFill,
                        ["hoverEdge"] = Appearance.Colors.HoverEdge,
                        ["hubFill"] = Appearance.Colors.HubFill,
                        ["hubEdge"] = Appearance.Colors.HubEdge,
                        ["text"] = Appearance.Colors.Text,
                        ["textDim"] = Appearance.Colors.TextDim,
                        ["textFaint"] = Appearance.Colors.TextFaint,
                        ["accent"] = Appearance.Colors.Accent,
                    },
                },
                ["interaction"] = new JsonObject
                {
                    ["hotkey"] = Interaction.Hotkey,
                    ["altRightClick"] = Interaction.AltRightClick,
                    ["hoverHighlight"] = Interaction.HoverHighlight,
                    ["keyboardSelect"] = Interaction.KeyboardSelect,
                    ["escapeToClose"] = Interaction.EscapeToClose,
                    ["summonAtCursor"] = Interaction.SummonAtCursor,
                    ["showChildMarker"] = Interaction.ShowChildMarker,
                    ["showDirectionLine"] = Interaction.ShowDirectionLine,
                    ["popOnHover"] = Interaction.PopOnHover,
                },
                ["content"] = new JsonObject
                {
                    ["usePluginLabels"] = Content.UsePluginLabels,
                    ["usePluginActions"] = Content.UsePluginActions,
                    ["sectors"] = new JsonObject(
                        RingSectors.Ids.Select(id =>
                        {
                            var s = Content.Sectors.Get(id);
                            return new KeyValuePair<string, JsonNode>(id, new JsonObject
                            {
                                ["label"] = s.Label,
                                ["visible"] = s.Visible,
                                ["order"] = s.Order,
                                ["action"] = s.Action,
                            });
                        })),
                },
                ["bridge"] = new JsonObject { ["port"] = Bridge.Port },
            };

            try
            {
                var options = new JsonSerializerOptions { WriteIndented = true };
                File.WriteAllText(ConfigPath, root.ToJsonString(options));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[幻梦圆环] 配置写入失败：{ex.Message}");
            }
        }

        /// <summary>恢复默认。整份重写，但保留顶层 hotkey。</summary>
        public static RingConfig ResetToDefaults()
        {
            var config = new RingConfig
            {
                LegacyHotkey = Load().LegacyHotkey
            };
            config.Save();
            return config;
        }
    }
}
