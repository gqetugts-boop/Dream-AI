// ============================================================
//  RingStyle.cs — 配置的解析结果
//
//  颜色在构造时一次性解析成 WPF 的 Color/Brush，绘制时不再做十六进制解析
//  —— 绘制跑在 60fps 的渲染循环里。
//
//  两条 SPEC 要求在这里落地：
//  1. 超出范围的数值钳制到范围内，而不是报错或忽略
//  2. 配色解析失败时回退到「该字段自己的默认色」，不是统一回退成白色
//     （统一回退成白色的话，一个取色器手滑就会让整块扇区变白，更难排查）
// ============================================================

using System;
using System.Globalization;
using System.Windows.Media;
using HuanmengRing.Models;

namespace HuanmengRing.Models
{
    public class RingStyle
    {
        public Color WedgeFill, WedgeFillAlt, WedgeEdge;
        public Color HoverFill, HoverEdge;
        public Color HubFill, HubEdge;
        public Color Text, TextDim, TextFaint, Accent;

        public double BandRatio, GapRatio, GapMax, PopDistance;
        public double Opacity, DisabledWedgeAlpha, DisabledEdgeAlpha;
        public double AppearScale, AppearStep, HoverSpeed;
        public double LabelFontSize, LabelLineHeight, HubTitleFontSize, HubSubFontSize;

        public bool ShadowEnabled;
        public double ShadowBlur, ShadowOffsetY, ShadowAlpha;

        public bool ShowChildMarker, ShowDirectionLine, PopOnHover;

        /// <summary>关掉之后指针经过不再高亮，只有点击才有效果</summary>
        public bool HoverHighlight;

        public static RingStyle From(RingConfig config)
        {
            var a = config.Appearance;
            var d = new RingPalette();   // 各字段的默认色

            return new RingStyle
            {
                WedgeFill = ParseHex(a.Colors.WedgeFill, d.WedgeFill),
                WedgeFillAlt = ParseHex(a.Colors.WedgeFillAlt, d.WedgeFillAlt),
                WedgeEdge = ParseHex(a.Colors.WedgeEdge, d.WedgeEdge),
                HoverFill = ParseHex(a.Colors.HoverFill, d.HoverFill),
                HoverEdge = ParseHex(a.Colors.HoverEdge, d.HoverEdge),
                HubFill = ParseHex(a.Colors.HubFill, d.HubFill),
                HubEdge = ParseHex(a.Colors.HubEdge, d.HubEdge),
                Text = ParseHex(a.Colors.Text, d.Text),
                TextDim = ParseHex(a.Colors.TextDim, d.TextDim),
                TextFaint = ParseHex(a.Colors.TextFaint, d.TextFaint),
                Accent = ParseHex(a.Colors.Accent, d.Accent),

                BandRatio = Clamp(a.BandRatio, 0.15, 0.85),
                GapRatio = Clamp(a.GapRatio, 0, 0.5),
                GapMax = Math.Max(a.GapMax, 0),
                PopDistance = Clamp(a.PopDistance, 0, 40),
                Opacity = Clamp(a.Opacity, 0.1, 1),
                DisabledWedgeAlpha = Clamp(a.DisabledWedgeAlpha, 0.05, 1),
                DisabledEdgeAlpha = Clamp(a.DisabledEdgeAlpha, 0.05, 1),
                AppearScale = Clamp(a.AppearScale, 0.3, 1),
                AppearStep = Clamp(a.AppearStep, 0.02, 1),
                HoverSpeed = Clamp(a.HoverSpeed, 0.02, 1),
                LabelFontSize = Clamp(a.LabelFontSize, 6, 24),
                LabelLineHeight = Clamp(a.LabelLineHeight, 7, 30),
                HubTitleFontSize = Clamp(a.HubTitleFontSize, 7, 28),
                HubSubFontSize = Clamp(a.HubSubFontSize, 6, 22),

                ShadowEnabled = a.ShadowEnabled,
                ShadowBlur = Clamp(a.ShadowBlur, 0, 40),
                ShadowOffsetY = Clamp(a.ShadowOffsetY, -20, 20),
                ShadowAlpha = Clamp(a.ShadowAlpha, 0, 1),

                ShowChildMarker = config.Interaction.ShowChildMarker,
                ShowDirectionLine = config.Interaction.ShowDirectionLine,
                PopOnHover = config.Interaction.PopOnHover,
                HoverHighlight = config.Interaction.HoverHighlight,
            };
        }

        private static double Clamp(double v, double lo, double hi) =>
            double.IsNaN(v) ? lo : Math.Min(Math.Max(v, lo), hi);

        /// <summary>
        /// 解析 "#RGB" / "#RRGGBB" / "#RRGGBBAA"。失败返回 fallbackHex 解析出的颜色。
        /// 这里按 sRGB 处理（SPEC 第二节所述，与 macOS 版的 calibrated 数值一致）。
        /// </summary>
        public static Color ParseHex(string hex, string fallbackHex)
        {
            if (TryParseHex(hex, out var c)) return c;
            if (TryParseHex(fallbackHex, out var f)) return f;
            return Colors.White;
        }

        public static bool TryParseHex(string hex, out Color color)
        {
            color = Colors.White;
            if (string.IsNullOrWhiteSpace(hex)) return false;

            var t = hex.Trim().TrimStart('#');
            if (t.Length == 3)
            {
                // #RGB → #RRGGBB
                t = string.Concat(t[0], t[0], t[1], t[1], t[2], t[2]);
            }
            if (t.Length != 6 && t.Length != 8) return false;

            if (!uint.TryParse(t, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var v))
                return false;

            byte r, g, b, a;
            if (t.Length == 8)
            {
                r = (byte)((v >> 24) & 0xFF);
                g = (byte)((v >> 16) & 0xFF);
                b = (byte)((v >> 8) & 0xFF);
                a = (byte)(v & 0xFF);
            }
            else
            {
                r = (byte)((v >> 16) & 0xFF);
                g = (byte)((v >> 8) & 0xFF);
                b = (byte)(v & 0xFF);
                a = 255;
            }
            color = Color.FromArgb(a, r, g, b);
            return true;
        }

        /// <summary>转回 "#RRGGBBAA"，供偏好设置的取色器回写。往返恒等。</summary>
        public static string ToHex(Color c) => $"#{c.R:X2}{c.G:X2}{c.B:X2}{c.A:X2}";

        /// <summary>按 alpha 缩放一个颜色（禁用态用）</summary>
        public static Color WithAlphaScale(Color c, double scale)
        {
            var a = (byte)Math.Round(Math.Min(Math.Max(c.A / 255.0 * scale, 0), 1) * 255);
            return Color.FromArgb(a, c.R, c.G, c.B);
        }

        /// <summary>两色线性插值，用于高亮渐变</summary>
        public static Color Blend(Color from, Color to, double amount)
        {
            if (amount <= 0.001) return from;
            if (amount >= 0.999) return to;
            byte L(byte x, byte y) => (byte)Math.Round(x + (y - x) * amount);
            return Color.FromArgb(L(from.A, to.A), L(from.R, to.R), L(from.G, to.G), L(from.B, to.B));
        }

        public static SolidColorBrush Brush(Color c)
        {
            var b = new SolidColorBrush(c);
            b.Freeze();   // 冻结后跨线程安全，且绘制更快
            return b;
        }
    }
}
