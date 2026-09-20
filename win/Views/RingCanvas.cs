// ============================================================
//  RingCanvas.cs — 圆环绘制与交互（扇形切块版）
//
//  视觉对齐 Blender 的饼菜单，也严格对齐 macOS 版 RingView.swift：
//  每个扇区是一块环形楔形，选中时整块高亮并向外弹出，文字水平居中。
//
//  坐标：WPF 默认 y 轴向下，和 macOS 版的 isFlipped = true 一致，
//  所以角度公式可以直接照搬：-90°（正上方）是 0 号扇区起点，顺时针递增。
//
//  投影拆成两个元素（见 RingWindow.xaml）：
//    SilhouetteLayer 只画合并轮廓，挂 DropShadowEffect
//    RingCanvas 画真正的扇区，盖在阴影之上
//  这样一个 Effect 就够，不用给每个扇区单独加阴影（那会在扇区之间
//  出现内阴影，很难看，而且 60fps 下很贵）。
// ============================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Windows;
using System.Windows.Media;
using HuanmengRing.Models;

namespace HuanmengRing.Views
{
    public class RingCanvas : FrameworkElement
    {
        // ---------- 状态 ----------

        private readonly Stack<RingLevel> _stack = new Stack<RingLevel>();
        private RingLevel _level;
        private int _hoverIndex = -1;
        private RingGeometry _geometry;

        private double _appear;
        private double[] _highlight = Array.Empty<double>();

        /// <summary>
        /// 当前样式。
        /// 必须写 new：FrameworkElement 自己有一个 Style（System.Windows.Style），
        /// 不写就是个 CS0108 警告，而且任何 <c>&lt;views:RingCanvas Style="…"/&gt;</c>
        /// 都会落到那个依赖属性上，行为很怪。
        /// WPF 的样式系统走的是 StyleProperty 依赖属性，遮蔽 CLR 属性不影响它。
        /// </summary>
        public new RingStyle Style { get; private set; } = new RingStyle();

        /// <summary>扇区被确认（没有子菜单时）</summary>
        public event Action<RingSegment> Committed;

        /// <summary>点了圆心且已在顶层 / 点了环外</summary>
        public event Action Cancelled;

        public event Action<RingLevel> LevelChanged;

        public RingCanvas()
        {
            // 让整个方形区域都能命中，透明角也要收到点击（点角落 = 关闭）
            SnapsToDevicePixels = true;
            Focusable = false;
        }

        public RingLevel Level
        {
            get => _level;
            set
            {
                _level = value;
                // 必须一起重置 hoverIndex。层级切换后块数会变少，
                // 旧索引再拿去访问新数组就是越界 —— macOS 版为此崩过一次
                // （Swift runtime failure: Index out of range）。
                _hoverIndex = -1;
                ResetHighlight();
                InvalidateVisual();
            }
        }

        public int HoverIndex => _hoverIndex;

        /// <summary>出现动画进度 0→1，窗口用它驱动整体缩放与淡入</summary>
        public double AppearProgress => _appear;
        public int SegmentCount => _level?.Segments.Count ?? 0;
        public bool CanGoBack => _stack.Count > 0;
        public RingGeometry Geometry => _geometry;

        public void ApplyStyle(RingStyle style)
        {
            Style = style ?? new RingStyle();
            InvalidateVisual();
        }

        /// <summary>唤出时调用：重新播放缩放淡入</summary>
        public void ResetForSummon()
        {
            _stack.Clear();
            _hoverIndex = -1;
            _appear = 0;
            ResetHighlight();
            InvalidateVisual();
        }

        /// <summary>层级切换：只让高亮重新渐入，不重播整个环的淡入</summary>
        public void PulseHighlight()
        {
            ResetHighlight();
            InvalidateVisual();
        }

        public void AdvanceAppear()
        {
            if (_appear < 1) _appear = Math.Min(1, _appear + Style.AppearStep);
        }

        /// <summary>
        /// 偏好设置里的静态预览用：跳过出现动画，直接停在最终状态；
        /// 并把高亮定在指定扇区上，这样配色、弹出距离、描边强度都能看到。
        /// </summary>
        public void ShowPreviewFrame(int hoverIndex)
        {
            _appear = 1;
            _hoverIndex = hoverIndex;
            ResetHighlight();
            if (hoverIndex >= 0 && hoverIndex < _highlight.Length) _highlight[hoverIndex] = 1;
            InvalidateVisual();
        }

        private void ResetHighlight() =>
            _highlight = new double[_level?.Segments.Count ?? 0];

        /// <summary>每帧推进高亮插值。返回 true 表示还有动画没结束。</summary>
        public bool Tick()
        {
            var settled = _appear >= 1;
            var current = _level;
            if (current == null) return settled;

            for (var i = 0; i < _highlight.Length && i < current.Segments.Count; i++)
            {
                var target = (i == _hoverIndex && !current.Segments[i].Disabled) ? 1.0 : 0.0;
                var delta = target - _highlight[i];
                if (Math.Abs(delta) > 0.01)
                {
                    _highlight[i] += delta * Style.HoverSpeed;
                    settled = false;
                }
                else
                {
                    _highlight[i] = target;
                }
            }
            InvalidateVisual();
            return settled;
        }

        // ---------- 命中 ----------

        public int? HitTestRing(Point point)
        {
            if (_geometry == null || _level == null) return null;
            return _geometry.HitTest(point.X, point.Y, _level.Segments.Count);
        }

        public void UpdatePointer(Point point) => SetHover(HitTestRing(point) ?? -1);

        private void SetHover(int index)
        {
            var normalized = index >= 0 ? index : -1;
            if (normalized == _hoverIndex) return;
            _hoverIndex = normalized;
        }

        /// <summary>确认当前高亮项</summary>
        public bool CommitHover() => CommitIndex(_hoverIndex);

        /// <summary>
        /// 确认指定扇区。index &lt; 0 表示圆心（返回上一级 / 关闭）。
        /// 进入下一级只在这里发生 —— 悬停只负责高亮，不展开子菜单，
        /// 否则鼠标路过带子项的扇区时会误触发。
        /// </summary>
        public bool CommitIndex(int index)
        {
            var current = _level;
            if (current == null) return false;

            if (index < 0)
            {
                if (_stack.Count > 0) { PopLevel(); return true; }
                Cancelled?.Invoke();
                return true;
            }

            if (index >= current.Segments.Count) return false;
            var segment = current.Segments[index];
            if (segment.Disabled) return false;

            if (segment.HasChildren)
            {
                _stack.Push(current);
                var next = new RingLevel { Title = segment.Label, Segments = segment.Children };
                PulseHighlight();
                Level = next;
                LevelChanged?.Invoke(next);
                return true;
            }

            Committed?.Invoke(segment);
            return true;
        }

        public void PopLevel()
        {
            if (_stack.Count == 0) return;
            var previous = _stack.Pop();
            PulseHighlight();
            Level = previous;
            LevelChanged?.Invoke(previous);
        }

        // ---------- 鼠标 ----------

        protected override void OnMouseMove(System.Windows.Input.MouseEventArgs e)
        {
            base.OnMouseMove(e);
            UpdatePointer(e.GetPosition(this));
        }

        protected override void OnMouseLeftButtonDown(System.Windows.Input.MouseButtonEventArgs e)
        {
            base.OnMouseLeftButtonDown(e);
            UpdatePointer(e.GetPosition(this));
            CommitHover();
            e.Handled = true;
        }

        // ---------- 绘制 ----------

        protected override void OnRender(DrawingContext dc)
        {
            var size = RenderSize;
            if (size.Width <= 1 || size.Height <= 1) return;

            // 先铺一层全透明矩形：不画的话方形的四角收不到鼠标事件，
            // WPF 的命中测试只认画过的内容
            dc.DrawRectangle(Brushes.Transparent, null, new Rect(size));

            var current = _level;
            if (current == null || current.Segments.Count == 0) return;

            var base_ = new RingGeometry(size.Width, size.Height, Style.BandRatio);
            _geometry = base_;

            var count = current.Segments.Count;
            var step = 2 * Math.PI / count;
            var gap = Math.Min(Style.GapMax, step * Style.GapRatio);
            var scale = Style.AppearScale + (1 - Style.AppearScale) * EaseOut(_appear);
            var outer = base_.OuterRadius * scale;
            var inner = base_.InnerRadius * scale;

            // ---- 扇区 ----
            for (var index = 0; index < count; index++)
            {
                var segment = current.Segments[index];
                var mid = -Math.PI / 2 + index * step;
                var intensity = EffectiveHighlight(segment, index);
                // 选中时向外弹出，形成「被拎出来」的手感
                var pop = Style.PopOnHover ? intensity * Style.PopDistance : 0;

                var geometry = BuildWedge(base_.CenterX, base_.CenterY, inner, outer + pop,
                                          mid - step / 2 + gap, mid + step / 2 - gap);

                var fill = index % 2 == 0 ? Style.WedgeFill : Style.WedgeFillAlt;
                if (segment.Disabled) fill = RingStyle.WithAlphaScale(fill, Style.DisabledWedgeAlpha);
                fill = RingStyle.Blend(fill, Style.HoverFill, intensity);

                var edge = segment.Disabled
                    ? RingStyle.WithAlphaScale(Style.WedgeEdge, Style.DisabledEdgeAlpha)
                    : Style.WedgeEdge;
                edge = RingStyle.Blend(edge, Style.HoverEdge, intensity);

                dc.DrawGeometry(RingStyle.Brush(fill), new Pen(RingStyle.Brush(edge), 1 + intensity), geometry);
            }

            // ---- 文字与标记（画在扇区之上，避免被后画的扇区压住）----
            for (var index = 0; index < count; index++)
            {
                var segment = current.Segments[index];
                var mid = -Math.PI / 2 + index * step;
                var intensity = EffectiveHighlight(segment, index);
                var radius = (inner + outer) / 2 + (Style.PopOnHover ? intensity * Style.PopDistance : 0);
                var anchor = new Point(base_.CenterX + radius * Math.Cos(mid),
                                       base_.CenterY + radius * Math.Sin(mid));
                var color = segment.Disabled
                    ? Style.TextFaint
                    : RingStyle.Blend(Style.Text, Colors.White, intensity);

                DrawLabel(dc, segment.Label, anchor, Math.Max(48, step * radius * 0.9), color);

                if (segment.Checked) DrawCheck(dc, new Point(anchor.X, anchor.Y + 13));

                // 子菜单只能靠点击进入，必须标出来哪些扇区带下一级，
                // 否则用户根本不知道能点进去
                if (segment.HasChildren && Style.ShowChildMarker)
                {
                    DrawChildMarker(dc,
                        new Point(base_.CenterX + (outer - 9) * Math.Cos(mid),
                                  base_.CenterY + (outer - 9) * Math.Sin(mid)),
                        mid, intensity);
                }
            }

            // ---- 圆心 ----
            var hubRadius = inner - 2;
            if (hubRadius > 0)
            {
                var hubEdge = RingStyle.Blend(Style.HubEdge, Style.HoverEdge, _hoverIndex < 0 ? 0.55 : 0);
                dc.DrawEllipse(RingStyle.Brush(Style.HubFill),
                               new Pen(RingStyle.Brush(hubEdge), 1),
                               new Point(base_.CenterX, base_.CenterY), hubRadius, hubRadius);
            }
            DrawHub(dc, base_, hubRadius);

            // ---- 方向指示线 ----
            if (_hoverIndex >= 0 && Style.ShowDirectionLine)
            {
                var mid = -Math.PI / 2 + _hoverIndex * step;
                var target = new Point(base_.CenterX + (outer + 7) * Math.Cos(mid),
                                       base_.CenterY + (outer + 7) * Math.Sin(mid));
                var brush = RingStyle.Brush(RingStyle.WithAlphaScale(Style.HoverEdge, 0.45));
                dc.DrawLine(new Pen(brush, 2), new Point(base_.CenterX, base_.CenterY), target);
            }
        }

        /// <summary>合并轮廓。只给 SilhouetteLayer 用 —— 它独自承担整个环的投影。</summary>
        public static Geometry BuildSilhouette(double width, double height, double bandRatio,
                                               double gapRatio, double gapMax, int count)
        {
            var geo = new RingGeometry(width, height, bandRatio);
            var group = new GeometryGroup { FillRule = FillRule.Nonzero };
            if (count <= 0) return group;

            var step = 2 * Math.PI / count;
            var gap = Math.Min(gapMax, step * gapRatio);

            for (var index = 0; index < count; index++)
            {
                var mid = -Math.PI / 2 + index * step;
                group.Children.Add(BuildWedge(geo.CenterX, geo.CenterY, geo.InnerRadius, geo.OuterRadius,
                                              mid - step / 2 + gap, mid + step / 2 - gap));
            }
            group.Children.Add(new EllipseGeometry(new Point(geo.CenterX, geo.CenterY),
                                                   geo.InnerRadius, geo.InnerRadius));
            group.Freeze();
            return group;
        }

        /// <summary>环形楔形：外弧正向扫，内弧反向扫回来，闭合。</summary>
        private static Geometry BuildWedge(double cx, double cy, double inner, double outer,
                                           double start, double end)
        {
            var geometry = new StreamGeometry();
            using (var ctx = geometry.Open())
            {
                var sweep = end - start;
                var outerStart = OnCircle(cx, cy, outer, start);

                ctx.BeginFigure(outerStart, true, true);

                if (sweep >= 2 * Math.PI - 0.001)
                {
                    // 只有一块扇区时起止点重合，ArcTo 画不出东西（WPF 会直接跳过），
                    // 拆成两个半圆
                    var half = start + Math.PI;
                    ctx.ArcTo(OnCircle(cx, cy, outer, half), new Size(outer, outer), 0,
                              false, SweepDirection.Clockwise, true, false);
                    ctx.ArcTo(outerStart, new Size(outer, outer), 0,
                              false, SweepDirection.Clockwise, true, false);
                }
                else
                {
                    ctx.ArcTo(OnCircle(cx, cy, outer, end), new Size(outer, outer), 0,
                              sweep > Math.PI, SweepDirection.Clockwise, true, false);
                }

                ctx.LineTo(OnCircle(cx, cy, inner, end), true, false);

                if (sweep >= 2 * Math.PI - 0.001)
                {
                    var half = end - Math.PI;
                    ctx.ArcTo(OnCircle(cx, cy, inner, half), new Size(inner, inner), 0,
                              false, SweepDirection.Counterclockwise, true, false);
                    ctx.ArcTo(OnCircle(cx, cy, inner, start), new Size(inner, inner), 0,
                              false, SweepDirection.Counterclockwise, true, false);
                }
                else
                {
                    ctx.ArcTo(OnCircle(cx, cy, inner, start), new Size(inner, inner), 0,
                              sweep > Math.PI, SweepDirection.Counterclockwise, true, false);
                }
            }
            geometry.Freeze();
            return geometry;
        }

        private static Point OnCircle(double cx, double cy, double radius, double angle) =>
            new Point(cx + radius * Math.Cos(angle), cy + radius * Math.Sin(angle));

        private double EffectiveHighlight(RingSegment segment, int index)
        {
            if (segment.Disabled) return 0;
            if (!Style.HoverHighlight) return 0;
            return index < _highlight.Length ? _highlight[index] : 0;
        }

        private static double EaseOut(double value) => 1 - Math.Pow(1 - value, 3);

        private void DrawLabel(DrawingContext dc, string text, Point center, double maxWidth, Color color)
        {
            if (string.IsNullOrEmpty(text)) return;

            var width = Math.Max(48, maxWidth);
            var perLine = Math.Max(3, (int)(width / 6.2));
            List<string> lines;
            if (text.Length <= perLine)
            {
                lines = new List<string> { text };
            }
            else
            {
                var first = text.Substring(0, perLine);
                var rest = text.Substring(perLine);
                if (rest.Length > perLine) rest = rest.Substring(0, perLine - 1) + "…";
                lines = new List<string> { first, rest };
            }

            var lineHeight = Style.LabelLineHeight;
            var y = center.Y - lineHeight * lines.Count / 2;
            foreach (var line in lines)
            {
                DrawCentered(dc, line, new Rect(center.X - width / 2, y, width, lineHeight),
                             Style.LabelFontSize, FontWeights.Medium, color);
                y += lineHeight;
            }
        }

        private void DrawHub(DrawingContext dc, RingGeometry geo, double radius)
        {
            // 越界防护：绘制每帧都在跑，不能指望调用方永远把 hoverIndex 维护正确
            RingSegment hovered = null;
            var segments = _level?.Segments;
            if (_hoverIndex >= 0 && segments != null && _hoverIndex < segments.Count)
                hovered = segments[_hoverIndex];

            var title = hovered?.Label ?? (_stack.Count == 0 ? "圆环" : "返回");
            var sub = hovered?.Hint ?? (_stack.Count == 0 ? "Esc 取消" : "点圆心返回");
            if (hovered != null && hovered.HasChildren && string.IsNullOrEmpty(sub)) sub = "子菜单";
            if (sub.Length > 22) sub = sub.Substring(0, 21) + "…";

            if (radius <= 6) return;

            DrawCentered(dc, title, new Rect(geo.CenterX - radius, geo.CenterY - 16, radius * 2, 16),
                         Style.HubTitleFontSize, FontWeights.SemiBold, Style.Text);
            DrawCentered(dc, sub, new Rect(geo.CenterX - radius, geo.CenterY + 1, radius * 2, 13),
                         Style.HubSubFontSize, FontWeights.Normal, Style.TextFaint);
        }

        private void DrawCentered(DrawingContext dc, string text, Rect rect, double fontSize,
                                  FontWeight weight, Color color)
        {
            if (string.IsNullOrEmpty(text) || rect.Width <= 1) return;
            var formatted = MakeText(text, fontSize, weight, color, rect.Width);
            dc.DrawText(formatted, rect.TopLeft);
        }

        private FormattedText MakeText(string text, double fontSize, FontWeight weight,
                                       Color color, double maxWidth)
        {
            return new FormattedText(
                text,
                CultureInfo.CurrentUICulture,
                FlowDirection.LeftToRight,
                new Typeface(new FontFamily("Microsoft YaHei UI, Segoe UI"),
                             FontStyles.Normal, weight, FontStretches.Normal),
                fontSize,
                RingStyle.Brush(color),
                // 少了这个参数在 .NET Core 上编译不过，而且高 DPI 下文字会糊
                VisualTreeHelper.GetDpi(this).PixelsPerDip)
            {
                MaxTextWidth = maxWidth,
                TextAlignment = TextAlignment.Center,
                Trimming = TextTrimming.CharacterEllipsis,
                MaxLineCount = 1,
            };
        }

        /// <summary>指向圆心外侧的小三角，表示这个扇区还有下一级</summary>
        private void DrawChildMarker(DrawingContext dc, Point point, double angle, double intensity)
        {
            const double size = 4;
            var geometry = new StreamGeometry();
            using (var ctx = geometry.Open())
            {
                ctx.BeginFigure(OnCircle(point.X, point.Y, size, angle), true, true);
                ctx.LineTo(OnCircle(point.X, point.Y, size, angle + 2.2), true, false);
                ctx.LineTo(OnCircle(point.X, point.Y, size, angle - 2.2), true, false);
            }
            geometry.Freeze();
            dc.DrawGeometry(RingStyle.Brush(RingStyle.Blend(Style.TextDim, Colors.White, intensity)),
                            null, geometry);
        }

        private void DrawCheck(DrawingContext dc, Point point)
        {
            var geometry = new StreamGeometry();
            using (var ctx = geometry.Open())
            {
                ctx.BeginFigure(new Point(point.X - 4, point.Y), false, false);
                ctx.LineTo(new Point(point.X - 1, point.Y + 3), true, false);
                ctx.LineTo(new Point(point.X + 4, point.Y - 3), true, false);
            }
            geometry.Freeze();
            dc.DrawGeometry(null, new Pen(RingStyle.Brush(Style.Accent), 1.8) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round }, geometry);
        }
    }

    /// <summary>
    /// 只画合并轮廓的一层，挂在 RingWindow 的投影 Effect 上。
    /// 单独一层是为了让投影只作用于轮廓 —— 直接给整个 RingCanvas 加 Effect
    /// 会把文字也糊掉，而且扇区之间会出现内阴影。
    /// </summary>
    public class SilhouetteLayer : FrameworkElement
    {
        private Geometry _geometry;

        public void Update(double width, double height, double bandRatio,
                           double gapRatio, double gapMax, int count, bool enabled)
        {
            _geometry = enabled && count > 0
                ? RingCanvas.BuildSilhouette(width, height, bandRatio, gapRatio, gapMax, count)
                : null;
            InvalidateVisual();
        }

        protected override void OnRender(DrawingContext dc)
        {
            if (_geometry == null) return;
            dc.DrawGeometry(Brushes.Black, null, _geometry);
        }
    }
}
