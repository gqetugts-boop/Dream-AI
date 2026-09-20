// ============================================================
//  ChatWindow.xaml.cs — 对话气泡（长对话：整段来回都能看）
//
//  两种形态：
//    · 输入条（矮）：只有一个输入框，问一句就走
//    · 对话窗（高）：上面是聊天记录（可滚动），下面还是那个输入框
//  发过一句之后自动变成对话窗，之后一直能看见上下文。
//
//  和圆环相反，这个窗口是**可激活**的：输入法（TSF）只会挂到前台窗口上，
//  不激活就打不出中文。代价是打字期间 Photoshop 会失去前台焦点 ——
//  这是输入法的硬性要求，不是可以绕过的实现细节。
//  关掉气泡时把焦点还给 Photoshop（见 ForegroundApp.ActivatePhotoshop）。
//
//  聊天记录从哪来：**插件推过来的**（type=chat 的 history 字段），
//  不是这里自己攒的。面板里那份才是唯一事实 ——
//  两边各攒一份迟早会分叉，用户会看到「圆环里问的、面板里没有」。
//
//  键盘归属：气泡开着的时候它是唯一的键盘入口。
//  圆环那边的 KeyboardHook 会吞掉 Esc / 数字键（数字是直选扇区用的），
//  打字期间必须卸掉，否则输入法候选窗的数字选词根本收不到。
// ============================================================

using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;

namespace HuanmengRing.Views
{
    /// <summary>一轮对话</summary>
    public class ChatTurn
    {
        public string Role = "assistant";
        public string Text = "";
        public bool IsError;
        /// <summary>还在等回复的占位（画淡一点）</summary>
        public bool IsPending;

        public bool IsUser => Role == "user";
    }

    public partial class ChatWindow : Window
    {
        private const int MessageLimit = 20000;

        private readonly List<ChatTurn> _transcript = new();
        /// <summary>是否显示聊天记录区。没发过消息时是 false ——
        /// 只问一句就走的话，弹出一个大空窗很碍事。</summary>
        private bool _expanded;

        /// <summary>输入条形态的窗口高度（DIP）。对话窗的高度按屏幕比例算，见 Place。</summary>
        private const double CompactHeight = 66;

        /// <summary>用户按了回车（内容已去掉首尾空白，非空）</summary>
        public event Action<string> Submitted;
        /// <summary>显隐变化。用来让事件钩子把键盘让出来</summary>
        public event Action<bool> VisibilityChanged;

        public bool IsChatVisible => IsVisible;

        /// <summary>上次摆放时用的圆环矩形（物理像素）。
        /// 切形态时要按同一个锚点重新摆 —— 拿窗口自己的位置当参照物会一次比一次往下跑。</summary>
        private int _lastX, _lastY, _lastSize;

        /// <summary>用户手动拖到哪儿了（DIP，左上角）。
        /// 非空时排版一律用它，不再贴回圆环下方 —— 否则「拖开一点看画布」
        /// 会被下一句回复弹回原位。关掉气泡时清空。</summary>
        private Point? _manualTopLeft;

        public ChatWindow()
        {
            InitializeComponent();
        }

        /// <summary>按住气泡拖动窗口。</summary>
        private void OnBubbleMouseDown(object sender, MouseButtonEventArgs e)
        {
            if (e.ButtonState != MouseButtonState.Pressed) return;
            try
            {
                DragMove();   // 阻塞到松手为止；左键没按下时它会抛异常，所以上面先判一次
            }
            catch (InvalidOperationException)
            {
                return;
            }
            // DragMove 返回后 Left/Top 已经是拖完的位置
            _manualTopLeft = new Point(Left, Top);
        }

        // ---------- 对外接口 ----------

        /// <summary>输入条形态：只有一个输入框，不显示聊天记录。</summary>
        public void ShowInput(int ringX, int ringY, int ringSize, string prefill = "")
        {
            _expanded = false;
            Input.Text = prefill ?? "";
            Hint.Text = "回车发送 · Esc 关闭 · 可直接用中文输入法";

            Place(ringX, ringY, ringSize);
            Present();
            Activate();
            Input.Focus();
            Input.CaretIndex = Input.Text.Length;
        }

        /// <summary>打开对话窗看历史（「看对话」菜单项）。</summary>
        public void ShowConversation(int ringX, int ringY, int ringSize, List<ChatTurn> history)
        {
            _transcript.Clear();
            if (history != null) _transcript.AddRange(history);
            _expanded = true;
            Hint.Text = "回车继续提问 · Esc 关闭";

            RenderTranscript();
            Place(ringX, ringY, ringSize);
            Present();
            Activate();
            Input.Focus();
        }

        /// <summary>等回复。问题立刻进记录，回复位置先占一行「正在回复…」，
        /// 用户才知道真的发出去了（接口可能要十几秒）。</summary>
        public void ShowThinking(int ringX, int ringY, int ringSize, string question, List<ChatTurn> history)
        {
            if (history != null && history.Count > 0)
            {
                _transcript.Clear();
                _transcript.AddRange(history);
            }
            else if (!string.IsNullOrEmpty(question))
            {
                // 老版本插件不推 history，本地补一条，免得看不到自己刚问的
                _transcript.Add(new ChatTurn { Role = "user", Text = question });
            }
            _transcript.Add(new ChatTurn { Role = "assistant", Text = "正在回复…", IsPending = true });

            _expanded = true;
            Hint.Text = "正在等回复 · Esc 关闭";

            RenderTranscript();
            Place(ringX, ringY, ringSize);
            Present();
            Activate();
            Input.Focus();
        }

        /// <summary>回复到了。history 非空就整份替换（以插件那份为准），
        /// 否则把本地那条「正在回复…」换成正文。</summary>
        public void ShowReply(int ringX, int ringY, int ringSize, List<ChatTurn> history,
                              string question, string text, bool isError)
        {
            if (history != null && history.Count > 0)
            {
                _transcript.Clear();
                _transcript.AddRange(history);
            }
            else
            {
                var body = Clamp(text);
                var last = _transcript.Count > 0 ? _transcript[_transcript.Count - 1] : null;
                if (last != null && last.IsPending)
                {
                    last.Text = body;
                    last.IsError = isError;
                    last.IsPending = false;
                }
                else
                {
                    _transcript.Add(new ChatTurn { Role = "assistant", Text = body, IsError = isError });
                }
            }

            _expanded = true;
            Hint.Text = "回车继续提问 · Esc 关闭";

            RenderTranscript();
            Place(ringX, ringY, ringSize);
            Present();
        }

        /// <summary>回复到了，而气泡还开着 —— 原地更新。
        /// 气泡已经被 Esc 关掉时不动它：用户主动关了，不该被一个窗口突然弹回来。</summary>
        public void UpdatePendingReply(int ringX, int ringY, int ringSize, List<ChatTurn> history,
                                       string question, string text, bool isError)
        {
            if (!IsVisible) return;
            ShowReply(ringX, ringY, ringSize, history, question, text, isError);
        }

        public void Dismiss()
        {
            if (!IsVisible) return;
            // 手动拖的位置只在这一轮对话里有效：下次打开重新回到圆环下方，
            // 免得几天后再用发现气泡出现在上次随手拖到的角落
            _manualTopLeft = null;
            Hide();
            VisibilityChanged?.Invoke(false);
            // 打完字把前台还给 Photoshop：输入法逼着我们抢了一次焦点，
            // 不还的话用户会发现 PS 标题栏变灰、快捷键不响应
            Services.ForegroundApp.ActivatePhotoshop();
        }

        // ---------- 内容 ----------

        private static string Clamp(string text)
        {
            var value = text ?? "";
            return value.Length > MessageLimit
                ? value.Substring(0, MessageLimit) + "\n…（已截断，完整内容看面板）"
                : value;
        }

        private static readonly SolidColorBrush UserBrush =
            new(Color.FromRgb(0x8C, 0xC7, 0xFF));
        private static readonly SolidColorBrush AssistantBrush =
            new(Color.FromArgb(0x80, 0xFF, 0xFF, 0xFF));
        private static readonly SolidColorBrush BodyBrush = new(Colors.White);
        private static readonly SolidColorBrush ErrorBrush =
            new(Color.FromRgb(0xFF, 0x7B, 0x72));
        private static readonly SolidColorBrush PendingBrush =
            new(Color.FromArgb(0x73, 0xFF, 0xFF, 0xFF));

        private void RenderTranscript()
        {
            Transcript.Inlines.Clear();
            for (var i = 0; i < _transcript.Count; i++)
            {
                var turn = _transcript[i];
                if (i > 0) Transcript.Inlines.Add(new Run("\n"));

                // 说话人前缀：短、有色、一眼能分出谁说的
                Transcript.Inlines.Add(new Run(turn.IsUser ? "我  " : "助手  ")
                {
                    FontSize = 11,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = turn.IsUser ? UserBrush : AssistantBrush,
                });

                var brush = turn.IsError ? ErrorBrush : (turn.IsPending ? PendingBrush : BodyBrush);
                Transcript.Inlines.Add(new Run(Clamp(turn.Text)) { Foreground = brush });
                Transcript.Inlines.Add(new Run("\n"));
            }

            TranscriptScroll.Visibility = _expanded ? Visibility.Visible : Visibility.Collapsed;
            TranscriptRow.Height = _expanded ? new GridLength(1, GridUnitType.Star) : new GridLength(0);

            // 滚到底。必须等一次布局 —— 刚设完 Inlines 时排版还没算出来，
            // 立刻 ScrollToEnd 会停在错误的位置。
            Dispatcher.BeginInvoke(new Action(() => TranscriptScroll.ScrollToEnd()),
                                   System.Windows.Threading.DispatcherPriority.Loaded);
        }

        // ---------- 布局 ----------

        /// <summary>
        /// 贴着圆环下方摆。坐标是物理像素，WPF 用的是 DIP，
        /// 所以先按所在显示器的缩放系数换算，否则高 DPI 下位置会偏一半。
        /// </summary>
        private void Place(int ringX, int ringY, int ringSize)
        {
            _lastX = ringX;
            _lastY = ringY;
            _lastSize = ringSize;

            var point = new Services.NativeMethods.POINT
            {
                X = ringX + ringSize / 2,
                Y = ringY + ringSize / 2,
            };
            var scale = Services.NativeMethods.ScaleAt(point);
            if (scale <= 0) scale = 1.0;

            var width = Math.Min(Math.Max(ringSize / scale * 1.9, 420), 720);

            var workTopDip = 0.0;
            var workBottomDip = 0.0;
            var workLeftDip = 0.0;
            var workRightDip = 0.0;
            var hasWork = Services.NativeMethods.TryGetWorkArea(point, out var work);
            if (hasWork)
            {
                workLeftDip = work.Left / scale;
                workRightDip = work.Right / scale;
                workTopDip = work.Top / scale;
                workBottomDip = work.Bottom / scale;
            }

            // 对话窗高度：屏幕可见高度的 45%，夹在 150–460 之间
            // （和 macOS 版同一套算法，两边看起来才一致）
            var height = CompactHeight;
            if (_expanded)
            {
                var available = hasWork ? (workBottomDip - workTopDip) * 0.45 : 420;
                height = height + 8 + Math.Min(Math.Max(available, 150), 460);
            }

            var left = (ringX + ringSize / 2.0) / scale - width / 2;
            var top = (ringY + ringSize + 12) / scale;

            if (hasWork)
            {
                if (_manualTopLeft.HasValue)
                {
                    // 拖过就听用户的。左上角保持不动、往下长 ——
                    // 输入条和对话窗高度差很多，锚左上角才不会把窗口顶出屏幕。
                    left = _manualTopLeft.Value.X;
                    top = _manualTopLeft.Value.Y;
                }
                else if (top + height > workBottomDip)
                {
                    // 圆环贴着屏幕下沿时翻到上面去，上下都放不下就贴边
                    var above = ringY / scale - 12 - height;
                    top = above >= workTopDip ? above : Math.Max(workTopDip, workBottomDip - height);
                }

                // 别让它跑到工作区外面
                left = Math.Min(Math.Max(left, workLeftDip), Math.Max(workLeftDip, workRightDip - width));
                top = Math.Min(Math.Max(top, workTopDip), Math.Max(workTopDip, workBottomDip - height));
            }

            Width = width;
            Height = height;
            Left = left;
            Top = top;
        }

        private void Present()
        {
            if (!IsVisible)
            {
                Show();
                VisibilityChanged?.Invoke(true);
            }
            Topmost = true;
        }

        // ---------- 键盘 ----------

        protected override void OnPreviewKeyDown(KeyEventArgs e)
        {
            // 输入法正在组字（拼音还没上屏）时，回车是「选词」、Esc 是「取消组字」，
            // 这两个键这时候归输入法，不能拿来发送 / 关窗。
            // WPF 的 TextBox 在组字期间会把这两个键交给 IME，
            // 事件里能看到的 ImeProcessed 就说明这一次不该我们管。
            if (e.Key == Key.ImeProcessed) return;

            if (e.Key == Key.Enter)
            {
                Submit();
                e.Handled = true;
                return;
            }

            if (e.Key == Key.Escape)
            {
                Dismiss();
                e.Handled = true;
                return;
            }

            base.OnPreviewKeyDown(e);
        }

        private void Submit()
        {
            var text = (Input.Text ?? "").Trim();
            if (text.Length == 0) return;
            Submitted?.Invoke(text);
        }
    }
}
