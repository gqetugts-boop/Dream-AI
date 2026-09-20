// ============================================================
//  RingWindow.xaml.cs — 无边框透明置顶窗口 + 唤出控制器
//
//  关键点（每一条都是踩过的坑）：
//
//  1. 显示/隐藏一律走 SetWindowPos(SWP_SHOWWINDOW / SWP_HIDEWINDOW)，
//     **不再调用 Window.Show()/Hide()**。因为 WPF 的 ShowActivated 只在
//     第一次 Show() 时生效，之后再 Show() 会抢走 Photoshop 的焦点 ——
//     焦点一丢，PS 当前的工具/选区状态就没了。
//     启动时 Show() 一次把 HWND 和渲染管线建起来，紧接着 HIDEWINDOW 藏掉。
//
//  2. 位置用**物理像素**的 SetWindowPos 设定，不碰 Window.Left/Top。
//     混合 DPI 下 Window.Left 的坐标系是「按主屏缩放的 DIP」，副屏会错位。
//
//  3. 指针位置按帧轮询 GetCursorPos，不依赖 MouseMove。
//     圆环是在光标底下弹出来的，指针没动就不会有 MouseMove 事件，
//     用事件的话第一次唤出永远不高亮。
//
//  4. 键盘走低阶钩子，**只在圆环显示期间安装**。窗口是非激活的，
//     收不到键盘；而常驻键盘钩子一旦有 bug 会影响平时打字。
// ============================================================

using System;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using HuanmengRing.Models;
using HuanmengRing.Services;

namespace HuanmengRing.Views
{
    public partial class RingWindow : Window
    {
        /// <summary>窗口边长的允许范围。太小环带挤成一条，太大在小屏上会跑出可见区。</summary>
        public const double MinSize = 200;
        public const double MaxSize = 900;

        private const int FrameIntervalMs = 16;   // ≈60fps

        private readonly KeyboardHook _keyboard = new KeyboardHook();

        private RingConfig _config = new RingConfig();
        private RingStyle _style = new RingStyle();

        private IntPtr _hwnd = IntPtr.Zero;
        private DispatcherTimer _timer;
        private bool _visible;
        private bool _ready;

        /// <summary>窗口左上角的物理屏幕坐标，以及所在显示器的缩放系数</summary>
        private int _originX;
        private int _originY;
        private double _scale = 1.0;

        /// <summary>上一次唤出时的中心（物理像素）。改配置时按它重新定位，窗口不会跳。</summary>
        private int _centerX;
        private int _centerY;

        private double _dipSize = 340;

        // 轮廓层只在尺寸或扇区数变化时重建，不必每帧
        private double _silWidth = -1;
        private double _silHeight = -1;
        private int _silCount = -1;
        private bool _silShadow;

        /// <summary>扇区被确认（无子菜单）</summary>
        public event Action<RingSegment> SegmentCommitted;

        /// <summary>点了圆心且已在顶层 / 点了环外 / 按了 Esc</summary>
        public event Action Cancelled;

        public event Action<bool> VisibilityChanged;

        public bool IsRingVisible => _visible;

        /// <summary>
        /// 圆环当前的物理屏幕矩形。对话气泡靠它定位。
        /// 圆环收起后这个值仍然有效 —— 气泡正好出现在圆环刚才在的地方。
        /// </summary>
        public (int X, int Y, int Size) PhysicalFrame =>
            (_originX, _originY, (int)Math.Round(_dipSize * _scale));

        /// <summary>
        /// 键盘钩子的开关。
        /// 气泡打字期间必须关掉：钩子会吞掉 Esc 和数字键，
        /// 而这两个正是输入法用来取消组字 / 选候选词的，吞了就打不出中文。
        /// 关掉只是「不再吞」，不影响圆环自己的鼠标操作。
        /// </summary>
        public void SetKeyboardEnabled(bool enabled)
        {
            if (enabled)
            {
                if (_visible) _keyboard.Install();
            }
            else
            {
                _keyboard.Uninstall();
            }
        }

        /// <summary>某个物理屏幕坐标是否落在圆环窗口内。用来判断「点了环外」。</summary>
        public bool ContainsPhysicalPoint(int x, int y)
        {
            if (!_visible) return false;
            var size = (int)Math.Round(_dipSize * _scale);
            return x >= _originX && x < _originX + size && y >= _originY && y < _originY + size;
        }

        public RingWindow()
        {
            InitializeComponent();

            _keyboard.OnKeyDown = HandleKey;
            Ring.Committed += OnSegmentCommitted;
            Ring.Cancelled += OnCancelled;
            Ring.LevelChanged += _ => RefreshSilhouette(force: true);

            _timer = new DispatcherTimer(DispatcherPriority.Render)
            {
                Interval = TimeSpan.FromMilliseconds(FrameIntervalMs),
            };
            _timer.Tick += (_, __) => OnFrame();
        }

        // ---------- 初始化与配置 ----------

        /// <summary>启动时调一次：建 HWND、应用配置、然后藏起来。</summary>
        public void Initialize(RingConfig config)
        {
            ApplyConfig(config);

            // 只 Show 这一次。此刻 Root.Opacity 是 0（XAML 里写死），
            // 所以不会闪一下；紧接着 HIDEWINDOW 藏掉，之后全靠 SetWindowPos。
            Show();
            _hwnd = new WindowInteropHelper(this).Handle;
            NativeMethods.SetWindowPos(_hwnd, IntPtr.Zero, 0, 0, 0, 0, NativeMethods.ConcealFlags);
            _ready = true;
        }

        /// <summary>
        /// 应用新配置。偏好设置里每次改动都会调到这里，所以必须便宜、可重入。
        /// 尺寸变化时保持窗口中心不动 —— 否则正在显示时改大小，圆环会在屏幕上跳一下。
        /// </summary>
        public void ApplyConfig(RingConfig config)
        {
            _config = config ?? new RingConfig();
            _style = RingStyle.From(_config);

            _dipSize = Math.Min(Math.Max(_config.Appearance.RingSize, MinSize), MaxSize);
            Width = _dipSize;
            Height = _dipSize;

            Ring.ApplyStyle(_style);
            RefreshSilhouette(force: true);

            if (_visible && _ready && _centerX != 0 && _centerY != 0)
                Reposition(_centerX, _centerY);
        }

        /// <summary>
        /// 重建投影轮廓层。尺寸取自 RingCanvas 的实际渲染尺寸 ——
        /// 只有两边用同一个尺寸，投影才会和扇区严丝合缝地对上。
        /// </summary>
        private void RefreshSilhouette(bool force = false)
        {
            var size = Ring.RenderSize;
            var width = size.Width > 1 ? size.Width : _dipSize;
            var height = size.Height > 1 ? size.Height : _dipSize;
            var count = Ring.SegmentCount;
            var shadow = _style.ShadowEnabled;

            if (!force &&
                Math.Abs(width - _silWidth) < 0.5 &&
                Math.Abs(height - _silHeight) < 0.5 &&
                count == _silCount &&
                shadow == _silShadow)
            {
                return;
            }

            _silWidth = width;
            _silHeight = height;
            _silCount = count;
            _silShadow = shadow;

            Silhouette.Update(width, height, _style.BandRatio, _style.GapRatio, _style.GapMax,
                              count, shadow);
            Silhouette.Effect = shadow ? BuildShadow() : null;
        }

        private DropShadowEffect BuildShadow()
        {
            var offset = _style.ShadowOffsetY;
            return new DropShadowEffect
            {
                Color = Colors.Black,
                BlurRadius = Math.Max(0, _style.ShadowBlur),
                ShadowDepth = Math.Abs(offset),
                // WPF 的角度：0=向右，90=向上，180=向左，270=向下
                Direction = offset >= 0 ? 270 : 90,
                Opacity = _style.ShadowAlpha,
                RenderingBias = RenderingBias.Performance,
            };
        }

        // ---------- 唤出与关闭 ----------

        /// <summary>在物理屏幕坐标处唤出圆环。</summary>
        public void Summon(RingLevel level, int physicalX, int physicalY)
        {
            if (!_ready) return;

            Ring.ResetForSummon();
            Ring.Level = level;
            RefreshSilhouette(force: true);

            Reposition(physicalX, physicalY);

            NativeMethods.SetWindowPos(_hwnd, NativeMethods.HWND_TOPMOST, _originX, _originY, 0, 0,
                                       NativeMethods.SummonFlags);

            _timer.Start();
            _keyboard.Install();

            if (!_visible)
            {
                _visible = true;
                VisibilityChanged?.Invoke(true);
            }

            // 立刻高亮到指针当前方向，打开即有反馈
            UpdatePointerFromCursor();
        }

        public void Dismiss()
        {
            if (!_visible) return;

            _timer.Stop();
            _keyboard.Uninstall();
            NativeMethods.SetWindowPos(_hwnd, IntPtr.Zero, 0, 0, 0, 0, NativeMethods.ConcealFlags);

            _visible = false;
            VisibilityChanged?.Invoke(false);
        }

        /// <summary>圆环贴着屏幕边缘时往回挪，别让窗口跑出可见区域</summary>
        private void Reposition(int physicalX, int physicalY)
        {
            var point = new NativeMethods.POINT { X = physicalX, Y = physicalY };
            var scale = NativeMethods.ScaleAt(point);
            if (scale <= 0) scale = 1.0;

            var size = (int)Math.Round(_dipSize * scale);
            var x = physicalX - size / 2;
            var y = physicalY - size / 2;

            if (NativeMethods.TryGetWorkArea(point, out var work))
            {
                x = Math.Min(Math.Max(x, work.Left), Math.Max(work.Left, work.Right - size));
                y = Math.Min(Math.Max(y, work.Top), Math.Max(work.Top, work.Bottom - size));
            }

            _originX = x;
            _originY = y;
            _scale = scale;
            _centerX = x + size / 2;
            _centerY = y + size / 2;

            // 只挪位置，尺寸交给 WPF 按 DIP 自己算 —— 两边都设会互相打架
            NativeMethods.SetWindowPos(_hwnd, IntPtr.Zero, x, y, 0, 0,
                                       NativeMethods.SWP_NOSIZE | NativeMethods.SWP_NOZORDER |
                                       NativeMethods.SWP_NOACTIVATE);
        }

        // ---------- 每帧 ----------

        private void OnFrame()
        {
            if (!_visible) return;

            var before = Ring.HoverIndex;
            UpdatePointerFromCursor();
            if (Ring.HoverIndex != before) Ring.InvalidateVisual();

            Ring.Tick();
            // 布局要一帧才生效，所以尺寸同步也放在这里做（内部有变化检测）
            RefreshSilhouette();

            // 出现动画：整体缩放 + 淡入。缩放放在容器上，
            // 这样文字和投影会一起缩，和 macOS 版逐扇区缩放视觉上一致。
            var progress = EaseOut(Ring.AppearProgress);
            var scale = _style.AppearScale + (1 - _style.AppearScale) * progress;
            AppearTransform.ScaleX = scale;
            AppearTransform.ScaleY = scale;
            Root.Opacity = Math.Min(Math.Max(progress * _style.Opacity, 0), 1);
        }

        private static double EaseOut(double value) => 1 - Math.Pow(1 - value, 3);

        private void UpdatePointerFromCursor()
        {
            if (!NativeMethods.GetCursorPos(out var point)) return;

            // 物理像素 → 本窗口的 DIP 坐标
            var dipX = (point.X - _originX) / _scale;
            var dipY = (point.Y - _originY) / _scale;
            Ring.UpdatePointer(new Point(dipX, dipY));
        }

        // ---------- 键盘 ----------

        private bool HandleKey(int virtualKey)
        {
            if (!_visible) return false;

            const int VK_ESCAPE = 0x1B;
            const int VK_BACK = 0x08;
            const int VK_LEFT = 0x25;
            const int VK_DELETE = 0x2E;

            if (virtualKey == VK_ESCAPE && _config.Interaction.EscapeToClose)
            {
                Dismiss();
                return true;
            }

            if (!_config.Interaction.KeyboardSelect) return false;

            // 主键盘 1-9：直选第 n 个扇区
            if (virtualKey >= 0x31 && virtualKey <= 0x39) { Ring.CommitIndex(virtualKey - 0x31); return true; }
            // 小键盘 1-9
            if (virtualKey >= 0x61 && virtualKey <= 0x69) { Ring.CommitIndex(virtualKey - 0x61); return true; }

            // 返回上一级。已经在顶层就直接关掉，不然按了没反应会以为卡死
            if (virtualKey == VK_LEFT || virtualKey == VK_BACK || virtualKey == VK_DELETE)
            {
                if (Ring.CanGoBack) Ring.PopLevel();
                else Dismiss();
                return true;
            }

            return false;
        }

        // ---------- 确认 ----------

        private void OnSegmentCommitted(RingSegment segment)
        {
            Dismiss();
            SegmentCommitted?.Invoke(segment);
        }

        private void OnCancelled()
        {
            Dismiss();
            Cancelled?.Invoke();
        }

        protected override void OnClosed(EventArgs e)
        {
            _timer?.Stop();
            _keyboard.Dispose();
            base.OnClosed(e);
        }
    }
}
