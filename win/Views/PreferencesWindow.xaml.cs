// ============================================================
//  PreferencesWindow.xaml.cs — 偏好设置
//
//  四个标签页：外观 / 交互 / 内容 / 高级。顶部是实时预览，
//  改任何一项立刻反映到预览和真正显示的圆环上，关窗即存盘。
//
//  UI 全部用代码生成而不是写 XAML，是因为我没办法编译验证：
//  代码生成的控件至少能被 C# 编译器检查，XAML 里写错一个属性名
//  只会在运行时抛 XamlParseException，你拿到手才知道。
//
//  取色器用 WinForms 的 ColorDialog —— WPF 自己没有颜色对话框，
//  这也是这个项目 UseWindowsForms=true 的原因（另一个是托盘图标）。
// ============================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using HuanmengRing.Models;
using HuanmengRing.Services;
using WinForms = System.Windows.Forms;

namespace HuanmengRing.Views
{
    public partial class PreferencesWindow : Window
    {
        private static PreferencesWindow _instance;

        private RingConfig _config = new RingConfig();
        private Action<RingConfig> _onChange;
        private readonly List<Action> _refreshers = new List<Action>();
        private DispatcherTimer _saveTimer;

        /// <summary>构建期标志。设控件初值会触发 ValueChanged，不能当成用户改动。</summary>
        private bool _building;

        private RingCanvas _preview;
        private SilhouetteLayer _previewSilhouette;

        /// <summary>高级页显示的热键状态，由 App 提供</summary>
        public Func<string> StatusProvider;

        private const double PreviewSize = 190;

        // ---------- 生命周期 ----------

        public static void ShowFor(Window owner, RingConfig config, Action<RingConfig> onChange,
                                   Func<string> statusProvider)
        {
            if (_instance == null)
            {
                _instance = new PreferencesWindow();
                _instance.Build(config, onChange, statusProvider);
                if (owner != null) _instance.Owner = owner;
                _instance.Closed += (_, __) => _instance = null;
            }
            else
            {
                _instance._onChange = onChange;
                _instance.StatusProvider = statusProvider;
                _instance.RefreshAll();
            }

            _instance.Show();
            // 托盘程序不是前台程序，不激活的话窗口会开在别的窗口后面
            _instance.Activate();
            _instance.Focus();
        }

        private PreferencesWindow()
        {
            InitializeComponent();

            _saveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
            _saveTimer.Tick += (_, __) => Flush();
        }

        private void Build(RingConfig config, Action<RingConfig> onChange, Func<string> statusProvider)
        {
            _config = config ?? new RingConfig();
            _onChange = onChange;
            StatusProvider = statusProvider;

            _building = true;
            BuildPreview();
            BuildPresets();
            BuildActions();
            Tabs.Items.Add(MakeTab("外观", BuildAppearanceTab()));
            Tabs.Items.Add(MakeTab("交互", BuildInteractionTab()));
            Tabs.Items.Add(MakeTab("内容", BuildContentTab()));
            Tabs.Items.Add(MakeTab("高级", BuildAdvancedTab()));
            _building = false;

            RefreshAll();
        }

        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            if (StatusText != null && StatusProvider != null) StatusText.Text = StatusProvider();
        }

        protected override void OnClosed(EventArgs e)
        {
            _saveTimer?.Stop();
            Flush();
            base.OnClosed(e);
        }

        // ---------- 保存与广播 ----------

        /// <summary>用户改了一项：先刷新预览与真圆环，再排队存盘</summary>
        private void Changed()
        {
            if (_building) return;

            UpdatePreview();
            _onChange?.Invoke(_config);

            _saveTimer.Stop();
            _saveTimer.Start();
        }

        private void Flush()
        {
            _saveTimer.Stop();
            _config.Save();
        }

        private void RefreshAll()
        {
            _building = true;
            foreach (var refresher in _refreshers)
            {
                try { refresher(); }
                catch (Exception ex) { Console.Error.WriteLine($"[幻梦圆环] 刷新控件失败：{ex.Message}"); }
            }
            _building = false;

            UpdatePreview();
            if (StatusText != null && StatusProvider != null) StatusText.Text = StatusProvider();
        }

        // ---------- 顶部预览 ----------

        private void BuildPreview()
        {
            _previewSilhouette = new SilhouetteLayer
            {
                Width = PreviewSize,
                Height = PreviewSize,
                IsHitTestVisible = false,
            };
            _preview = new RingCanvas
            {
                Width = PreviewSize,
                Height = PreviewSize,
                IsHitTestVisible = false,
            };

            var host = new Grid { Width = PreviewSize, Height = PreviewSize };
            host.Children.Add(_previewSilhouette);
            host.Children.Add(_preview);
            PreviewHost.Content = host;
        }

        private void UpdatePreview()
        {
            if (_preview == null) return;
            try
            {
                var style = RingStyle.From(_config);
                _preview.ApplyStyle(style);
                _preview.Level = MenuBuilder.RootLevel(SampleState(), _config);
                // 固定高亮第 0 块，这样配色、弹出距离、描边强度都能看到
                _preview.ShowPreviewFrame(0);

                var shadow = style.ShadowEnabled;
                _previewSilhouette.Update(PreviewSize, PreviewSize, style.BandRatio, style.GapRatio,
                                          style.GapMax, _preview.SegmentCount, shadow);
                _previewSilhouette.Effect = shadow
                    ? new System.Windows.Media.Effects.DropShadowEffect
                    {
                        Color = Colors.Black,
                        BlurRadius = Math.Max(0, style.ShadowBlur),
                        ShadowDepth = Math.Abs(style.ShadowOffsetY),
                        Direction = style.ShadowOffsetY >= 0 ? 270 : 90,
                        Opacity = style.ShadowAlpha,
                        RenderingBias = System.Windows.Media.Effects.RenderingBias.Performance,
                    }
                    : null;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[幻梦圆环] 预览刷新失败：{ex.Message}");
            }
        }

        /// <summary>预览用的假状态，让预览里的扇区名称和真圆环一致</summary>
        private static RingState SampleState() => new RingState
        {
            Connected = true,
            DocumentOpen = true,
            DocumentName = "预览.psd",
            HasSelection = true,
            SelectionWidth = 1024,
            SelectionHeight = 1024,
            Model = "nano-banana-fast",
            Resolution = "1K",
            Count = 2,
            ModelOptions = new List<BridgeOption>
            {
                new BridgeOption { Value = "nano-banana-fast", Text = "Nano Banana 快" },
                new BridgeOption { Value = "nano-banana-2", Text = "Nano Banana 2" },
            },
            ResolutionOptions = new List<BridgeOption>
            {
                new BridgeOption { Value = "1K", Text = "1K" },
                new BridgeOption { Value = "2K", Text = "2K" },
            },
        };

        // ---------- 控件工厂 ----------

        private static TabItem MakeTab(string title, UIElement content)
        {
            return new TabItem
            {
                Header = title,
                Content = new ScrollViewer
                {
                    Content = content,
                    VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                    HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                    Padding = new Thickness(14),
                },
            };
        }

        private static StackPanel MakePanel() => new StackPanel { Orientation = Orientation.Vertical };

        private static void AddSection(StackPanel panel, string title)
        {
            panel.Children.Add(new TextBlock
            {
                Text = title,
                FontWeight = FontWeights.SemiBold,
                Margin = new Thickness(0, 14, 0, 6),
                Foreground = new SolidColorBrush(Color.FromRgb(0x33, 0x41, 0x55)),
            });
        }

        private static Grid MakeRowGrid()
        {
            var grid = new Grid { Margin = new Thickness(0, 3, 0, 3) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(158) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(64) });
            return grid;
        }

        private static TextBlock RowLabel(string text)
        {
            return new TextBlock
            {
                Text = text,
                VerticalAlignment = VerticalAlignment.Center,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 8, 0),
            };
        }

        private static double ClampToRange(double value, double min, double max) =>
            double.IsNaN(value) ? min : Math.Min(Math.Max(value, min), max);

        private FrameworkElement SliderRow(string label, double min, double max,
                                           Func<double> get, Action<double> set, string format = "0.###")
        {
            var grid = MakeRowGrid();
            grid.Children.Add(RowLabel(label));

            var slider = new Slider
            {
                Minimum = min,
                Maximum = max,
                Value = ClampToRange(get(), min, max),
                VerticalAlignment = VerticalAlignment.Center,
                SmallChange = (max - min) / 200.0,
                LargeChange = (max - min) / 20.0,
            };
            Grid.SetColumn(slider, 1);
            grid.Children.Add(slider);

            var readout = new TextBlock
            {
                Text = get().ToString(format, CultureInfo.InvariantCulture),
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = HorizontalAlignment.Right,
                Foreground = Brushes.Gray,
            };
            Grid.SetColumn(readout, 2);
            grid.Children.Add(readout);

            slider.ValueChanged += (_, e) =>
            {
                if (_building) return;
                set(e.NewValue);
                readout.Text = e.NewValue.ToString(format, CultureInfo.InvariantCulture);
                Changed();
            };

            _refreshers.Add(() =>
            {
                var value = ClampToRange(get(), min, max);
                slider.Value = value;
                readout.Text = value.ToString(format, CultureInfo.InvariantCulture);
            });
            return grid;
        }

        private FrameworkElement CheckRow(string label, Func<bool> get, Action<bool> set)
        {
            var box = new CheckBox
            {
                Content = label,
                IsChecked = get(),
                Margin = new Thickness(0, 4, 0, 4),
            };
            box.Checked += (_, __) => { if (!_building) { set(true); Changed(); } };
            box.Unchecked += (_, __) => { if (!_building) { set(false); Changed(); } };

            _refreshers.Add(() => box.IsChecked = get());
            return box;
        }

        private FrameworkElement TextRow(string label, Func<string> get, Action<string> set)
        {
            var grid = MakeRowGrid();
            grid.Children.Add(RowLabel(label));

            var box = new TextBox { Text = get() ?? "", VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(box, 1);
            grid.Children.Add(box);

            box.TextChanged += (_, __) => { if (!_building) { set(box.Text); Changed(); } };
            _refreshers.Add(() => box.Text = get() ?? "");
            return grid;
        }

        private FrameworkElement IntRow(string label, Func<int> get, Action<int> set, int min, int max)
        {
            var grid = MakeRowGrid();
            grid.Children.Add(RowLabel(label));

            var box = new TextBox
            {
                Text = get().ToString(CultureInfo.InvariantCulture),
                Width = 90,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center,
            };
            Grid.SetColumn(box, 1);
            grid.Children.Add(box);

            Action commit = () =>
            {
                if (_building) return;
                if (!int.TryParse(box.Text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value))
                    return;
                set(Math.Min(Math.Max(value, min), max));
                Changed();
            };
            box.LostFocus += (_, __) => commit();
            box.KeyDown += (_, e) =>
            {
                if (e.Key == System.Windows.Input.Key.Enter) commit();
            };

            _refreshers.Add(() => box.Text = get().ToString(CultureInfo.InvariantCulture));
            return grid;
        }

        private FrameworkElement ColorRow(string label, Func<string> get, Action<string> set)
        {
            var grid = MakeRowGrid();
            grid.Children.Add(RowLabel(label));

            var panel = new StackPanel { Orientation = Orientation.Horizontal };
            var swatch = new Button { Width = 44, Height = 22, Margin = new Thickness(0, 0, 6, 0) };
            var hexBox = new TextBox { Width = 110, VerticalAlignment = VerticalAlignment.Center };
            panel.Children.Add(swatch);
            panel.Children.Add(hexBox);
            Grid.SetColumn(panel, 1);
            grid.Children.Add(panel);

            void Paint()
            {
                swatch.Background = new SolidColorBrush(RingStyle.ParseHex(get(), "#00000000"));
                swatch.ToolTip = get();
            }

            swatch.Click += (_, __) =>
            {
                try
                {
                    var current = RingStyle.ParseHex(get(), "#00000000");
                    using var dialog = new WinForms.ColorDialog
                    {
                        FullOpen = true,
                        AnyColor = true,
                        Color = System.Drawing.Color.FromArgb(current.A, current.R, current.G, current.B),
                    };
                    if (dialog.ShowDialog() != WinForms.DialogResult.OK) return;

                    var picked = dialog.Color;
                    var hex = RingStyle.ToHex(System.Windows.Media.Color.FromArgb(
                        picked.A, picked.R, picked.G, picked.B));
                    set(hex);
                    hexBox.Text = hex;
                    Paint();
                    Changed();
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[幻梦圆环] 取色失败：{ex.Message}");
                }
            };

            Action commitHex = () =>
            {
                if (_building) return;
                if (!RingStyle.TryParseHex(hexBox.Text, out _)) return;   // 没写对就不改
                set(hexBox.Text.Trim());
                Paint();
                Changed();
            };
            hexBox.LostFocus += (_, __) => commitHex();
            hexBox.KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Enter) commitHex(); };

            _refreshers.Add(() =>
            {
                hexBox.Text = get() ?? "";
                Paint();
            });
            return grid;
        }

        private static Button MakeButton(string text, Action onClick, double width = 0)
        {
            var button = new Button
            {
                Content = text,
                Padding = new Thickness(12, 5, 12, 5),
                Margin = new Thickness(6, 0, 0, 0),
                MinWidth = 76,
            };
            if (width > 0) button.Width = width;
            button.Click += (_, __) =>
            {
                try { onClick(); }
                catch (Exception ex)
                {
                    MessageBox.Show(ex.Message, "幻梦圆环", MessageBoxButton.OK, MessageBoxImage.Warning);
                }
            };
            return button;
        }

        // ---------- 外观 ----------

        /// <summary>
        /// 注意所有取值/赋值都必须**每次从 _config 现取**，不能提前存成局部变量。
        /// 「恢复默认」会整份换掉 _config，提前捕获的引用会指向旧对象，
        /// 表现为改设置没反应、或者改完又弹回旧值 —— 很难查。
        /// </summary>
        private UIElement BuildAppearanceTab()
        {
            var panel = MakePanel();
            var a = new Func<RingAppearance>(() => _config.Appearance);

            AddSection(panel, "尺寸与形状");
            panel.Children.Add(SliderRow("环大小", 200, 900, () => a().RingSize, v => a().RingSize = v, "0"));
            panel.Children.Add(SliderRow("环带厚度比", 0.15, 0.85, () => a().BandRatio, v => a().BandRatio = v));
            panel.Children.Add(SliderRow("扇区间隙比例", 0, 0.5, () => a().GapRatio, v => a().GapRatio = v));
            panel.Children.Add(SliderRow("扇区间隙上限(弧度)", 0, 0.12, () => a().GapMax, v => a().GapMax = v));
            panel.Children.Add(SliderRow("悬停弹出距离", 0, 40, () => a().PopDistance, v => a().PopDistance = v));
            panel.Children.Add(SliderRow("整体不透明度", 0.1, 1, () => a().Opacity, v => a().Opacity = v));

            AddSection(panel, "动画");
            panel.Children.Add(SliderRow("出现起始缩放", 0.3, 1, () => a().AppearScale, v => a().AppearScale = v));
            panel.Children.Add(SliderRow("出现速度", 0.02, 1, () => a().AppearStep, v => a().AppearStep = v));
            panel.Children.Add(SliderRow("高亮渐变速度", 0.02, 1, () => a().HoverSpeed, v => a().HoverSpeed = v));

            AddSection(panel, "投影");
            panel.Children.Add(CheckRow("启用合并轮廓投影", () => a().ShadowEnabled, v => a().ShadowEnabled = v));
            panel.Children.Add(SliderRow("模糊半径", 0, 40, () => a().ShadowBlur, v => a().ShadowBlur = v));
            panel.Children.Add(SliderRow("垂直偏移", -20, 20, () => a().ShadowOffsetY, v => a().ShadowOffsetY = v));
            panel.Children.Add(SliderRow("浓度", 0, 1, () => a().ShadowAlpha, v => a().ShadowAlpha = v));

            AddSection(panel, "字号");
            panel.Children.Add(SliderRow("扇区文字", 6, 24, () => a().LabelFontSize, v => a().LabelFontSize = v, "0.#"));
            panel.Children.Add(SliderRow("扇区行高", 7, 30, () => a().LabelLineHeight, v => a().LabelLineHeight = v, "0.#"));
            panel.Children.Add(SliderRow("圆心主标题", 7, 28, () => a().HubTitleFontSize, v => a().HubTitleFontSize = v, "0.#"));
            panel.Children.Add(SliderRow("圆心副标题", 6, 22, () => a().HubSubFontSize, v => a().HubSubFontSize = v, "0.#"));

            AddSection(panel, "禁用态");
            panel.Children.Add(SliderRow("填充透明度", 0.05, 1, () => a().DisabledWedgeAlpha, v => a().DisabledWedgeAlpha = v));
            panel.Children.Add(SliderRow("描边透明度", 0.05, 1, () => a().DisabledEdgeAlpha, v => a().DisabledEdgeAlpha = v));

            AddSection(panel, "配色");
            var c = new Func<RingPalette>(() => _config.Appearance.Colors);
            panel.Children.Add(ColorRow("扇区填充（偶数）", () => c().WedgeFill, v => c().WedgeFill = v));
            panel.Children.Add(ColorRow("扇区填充（奇数）", () => c().WedgeFillAlt, v => c().WedgeFillAlt = v));
            panel.Children.Add(ColorRow("扇区描边", () => c().WedgeEdge, v => c().WedgeEdge = v));
            panel.Children.Add(ColorRow("高亮填充", () => c().HoverFill, v => c().HoverFill = v));
            panel.Children.Add(ColorRow("高亮描边", () => c().HoverEdge, v => c().HoverEdge = v));
            panel.Children.Add(ColorRow("圆心填充", () => c().HubFill, v => c().HubFill = v));
            panel.Children.Add(ColorRow("圆心描边", () => c().HubEdge, v => c().HubEdge = v));
            panel.Children.Add(ColorRow("正文", () => c().Text, v => c().Text = v));
            panel.Children.Add(ColorRow("次要文字", () => c().TextDim, v => c().TextDim = v));
            panel.Children.Add(ColorRow("弱化文字", () => c().TextFaint, v => c().TextFaint = v));
            panel.Children.Add(ColorRow("强调色（勾）", () => c().Accent, v => c().Accent = v));
            panel.Children.Add(new TextBlock
            {
                Text = "颜色写 #RRGGBB 或 #RRGGBBAA。写错的那一项会退回它自己的默认色，不会整块变白。",
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brushes.Gray,
                Margin = new Thickness(0, 6, 0, 0),
            });

            return panel;
        }

        // ---------- 交互 ----------

        private UIElement BuildInteractionTab()
        {
            var panel = MakePanel();
            var i = new Func<RingInteraction>(() => _config.Interaction);

            AddSection(panel, "快捷键");
            panel.Children.Add(TextRow("全局热键", () => i().Hotkey, v => i().Hotkey = v));
            panel.Children.Add(new TextBlock
            {
                Text = "写法：ctrl+alt+r。修饰键可用 ctrl / alt / shift / cmd（Windows 上 cmd 即 Win 键，"
                     + "但 Win+字母基本都被系统占了，不建议用）。留空则用默认值。\n"
                     + "改完按回车或点别处生效。",
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brushes.Gray,
                Margin = new Thickness(158, 0, 0, 6),
            });

            AddSection(panel, "唤出");
            panel.Children.Add(CheckRow("Alt + 右键唤出圆环", () => i().AltRightClick, v => i().AltRightClick = v));
            panel.Children.Add(CheckRow("在鼠标位置弹出（关掉则弹在屏幕中央）", () => i().SummonAtCursor, v => i().SummonAtCursor = v));
            panel.Children.Add(new TextBlock
            {
                Text = "鼠标和键盘钩子都只在 Photoshop 前台时生效。如果系统里根本没开 Photoshop，"
                     + "则一律放行 —— 方便你单独试圆环。",
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brushes.Gray,
                Margin = new Thickness(158, 0, 0, 6),
            });

            AddSection(panel, "操作");
            panel.Children.Add(CheckRow("悬停即高亮（关掉则只有点击才有效果）", () => i().HoverHighlight, v => i().HoverHighlight = v));
            panel.Children.Add(CheckRow("数字键 1-9 直选扇区", () => i().KeyboardSelect, v => i().KeyboardSelect = v));
            panel.Children.Add(CheckRow("Esc 关闭圆环", () => i().EscapeToClose, v => i().EscapeToClose = v));
            panel.Children.Add(CheckRow("悬停时扇区向外弹出", () => i().PopOnHover, v => i().PopOnHover = v));

            AddSection(panel, "视觉提示");
            panel.Children.Add(CheckRow("带子菜单的扇区显示外缘三角标", () => i().ShowChildMarker, v => i().ShowChildMarker = v));
            panel.Children.Add(CheckRow("显示指向扇区的方向线", () => i().ShowDirectionLine, v => i().ShowDirectionLine = v));

            return panel;
        }

        // ---------- 内容 ----------

        private UIElement BuildContentTab()
        {
            var panel = MakePanel();

            AddSection(panel, "扇区");
            panel.Children.Add(CheckRow("采用插件下发的扇区名称", () => _config.Content.UsePluginLabels,
                                        v => _config.Content.UsePluginLabels = v));
            panel.Children.Add(new TextBlock
            {
                Text = "开着的时候，Photoshop 插件推过来什么名字就显示什么；插件没推的扇区用下面的自定义名。"
                     + "关掉则永远用自定义名 / 内置默认名。",
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brushes.Gray,
                Margin = new Thickness(0, 0, 0, 10),
            });

            foreach (var sectorId in RingSectors.Ids)
            {
                var id = sectorId;                                  // 闭包捕获的是字符串，不是对象
                var sector = new Func<RingSectorConfig>(() => _config.Content.Sectors.Get(id));
                var defaultLabel = RingSectors.DefaultLabels.TryGetValue(id, out var d) ? d : id;

                var grid = new Grid { Margin = new Thickness(0, 4, 0, 4) };
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(88) });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(90) });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

                var box = new CheckBox
                {
                    Content = "显示",
                    IsChecked = sector().Visible,
                    VerticalAlignment = VerticalAlignment.Center,
                };
                box.Checked += (_, __) => { if (!_building) { sector().Visible = true; Changed(); } };
                box.Unchecked += (_, __) => { if (!_building) { sector().Visible = false; Changed(); } };
                Grid.SetColumn(box, 0);
                grid.Children.Add(box);

                var labelBox = new TextBox
                {
                    Text = sector().Label,
                    VerticalAlignment = VerticalAlignment.Center,
                };
                labelBox.TextChanged += (_, __) =>
                {
                    if (_building) return;
                    sector().Label = labelBox.Text;
                    Changed();
                };
                Grid.SetColumn(labelBox, 1);
                grid.Children.Add(labelBox);

                var orderBox = new TextBox
                {
                    Text = sector().Order.ToString(CultureInfo.InvariantCulture),
                    Width = 54,
                    HorizontalAlignment = HorizontalAlignment.Left,
                    VerticalAlignment = VerticalAlignment.Center,
                };
                Action commitOrder = () =>
                {
                    if (_building) return;
                    if (!int.TryParse(orderBox.Text.Trim(), out var order)) return;
                    sector().Order = Math.Min(Math.Max(order, 0), 99);
                    Changed();
                };
                orderBox.LostFocus += (_, __) => commitOrder();
                orderBox.KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Enter) commitOrder(); };
                Grid.SetColumn(orderBox, 2);
                grid.Children.Add(orderBox);

                // 动作下拉。选项表见 ActionChoices —— 那是插件侧 ACTIONS 的副本，
                // 只在「助手没连上插件」时兜底用；连上后以插件下发的为准。
                var actionBox = new ComboBox
                {
                    Width = 168,
                    VerticalAlignment = VerticalAlignment.Center,
                    ToolTip = $"id={id}　默认「{defaultLabel}」",
                };
                actionBox.Items.Add(new ComboBoxItem { Content = "默认", Tag = "" });
                foreach (var choice in ActionChoices)
                {
                    actionBox.Items.Add(new ComboBoxItem { Content = choice.Label, Tag = choice.Value });
                }

                Action commitAction = () =>
                {
                    if (_building) return;
                    var picked = actionBox.SelectedItem as ComboBoxItem;
                    if (picked == null) return;
                    sector().Action = (string)picked.Tag ?? "";
                    Changed();
                };
                actionBox.SelectionChanged += (_, __) => commitAction();
                Grid.SetColumn(actionBox, 3);
                grid.Children.Add(actionBox);

                _refreshers.Add(() =>
                {
                    box.IsChecked = sector().Visible;
                    labelBox.Text = sector().Label;
                    orderBox.Text = sector().Order.ToString(CultureInfo.InvariantCulture);
                    var want = sector().Action ?? "";
                    foreach (var entry in actionBox.Items)
                    {
                        var item = entry as ComboBoxItem;
                        if (item != null && (string)item.Tag == want) { actionBox.SelectedItem = item; return; }
                    }
                    actionBox.SelectedIndex = 0;   // 没配过 → 「默认」
                });

                panel.Children.Add(grid);
            }

            panel.Children.Add(new TextBlock
            {
                Text = "顺序数字越小越靠前，从正上方顺时针排。名称留空则用插件的默认名。\n"
                     + "六个全部取消勾选时会自动回退到内置的六个扇区 —— 空菜单会让圆环整个画不出来，"
                     + "看起来像程序挂了。",
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brushes.Gray,
                Margin = new Thickness(0, 10, 0, 0),
            });

            return panel;
        }

        // ---------- 高级 ----------

        private UIElement BuildAdvancedTab()
        {
            var panel = MakePanel();

            AddSection(panel, "桥接");
            panel.Children.Add(IntRow("端口", () => _config.Bridge.Port, v => _config.Bridge.Port = v, 1024, 65535));
            panel.Children.Add(new TextBlock
            {
                Text = "改端口后要重启本程序才生效。Photoshop 插件那边的地址也要跟着改。",
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brushes.Gray,
                Margin = new Thickness(0, 0, 0, 6),
            });

            AddSection(panel, "配置文件");
            panel.Children.Add(new TextBlock
            {
                Text = RingConfig.ConfigPath,
                TextWrapping = TextWrapping.Wrap,
                FontFamily = new FontFamily("Consolas, Microsoft YaHei UI"),
                Margin = new Thickness(0, 0, 0, 6),
            });
            panel.Children.Add(new TextBlock
            {
                Text = "macOS 版和 Windows 版各自读写本机的这一份文件，互不干扰。"
                     + "想两边一致就用「导出配置」，把文件拷到另一台机器再「导入配置」。",
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brushes.Gray,
            });

            return panel;
        }

        // ---------- 顶部预设与底部按钮 ----------

        /// <summary>
        /// 动作下拉的兜底选项。
        ///
        /// 动作的唯一定义在插件侧（ring-bridge.js 的 ACTIONS）；这份**只在
        /// 「助手没连上插件」时**用来保证断线也能改设置。
        /// value 必须和插件那边逐字对应 —— 漏了哪项，断线时那一项就会从下拉里消失。
        /// </summary>
        private static readonly (string Value, string Label)[] ActionChoices =
        {
            ("generate", "生成"),
            ("params", "参数菜单"),
            ("presets", "预设菜单"),
            ("readSelection", "读取选区"),
            ("openChat", "对话"),
            ("tab:img2img", "切到「生成」"),
            ("tab:apps", "切到「快速」"),
            ("tab:toolbox", "切到「工具箱」"),
            ("tab:runninghub", "切到「应用」"),
            ("tab:gallery", "切到「画廊」"),
            ("tab:generationCenter", "切到「生成中心」"),
            ("tab:logs", "切到「记录」"),
            ("tab:settings", "切到「设置」"),
            ("clearPrompt", "清空提示词"),
            ("close", "关闭圆环"),
        };

        private static readonly (string Name, RingPalette Palette)[] Presets =
        {
            ("默认深灰", new RingPalette()),
            ("高对比", new RingPalette
            {
                WedgeFill = "#000000F2", WedgeFillAlt = "#141414F2", WedgeEdge = "#FFFFFFE6",
                HoverFill = "#FFD400FF", HoverEdge = "#FFFFFFFF", HubFill = "#000000FA",
                HubEdge = "#FFFFFFFF", Text = "#FFFFFFFF", TextDim = "#D0D0D0FF",
                TextFaint = "#9A9A9AFF", Accent = "#5CFF9DFF",
            }),
            ("暖色", new RingPalette
            {
                WedgeFill = "#3A2A20F5", WedgeFillAlt = "#2E211AF5", WedgeEdge = "#8A6A4FD9",
                HoverFill = "#D9762EFF", HoverEdge = "#FFC489FF", HubFill = "#241A14FA",
                HubEdge = "#C08A5AFF", Text = "#FFF3E6FF", TextDim = "#C4AA92FF",
                TextFaint = "#8A7460FF", Accent = "#FFC24DFF",
            }),
            ("冷色", new RingPalette
            {
                WedgeFill = "#1E2A38F5", WedgeFillAlt = "#18222DF5", WedgeEdge = "#4C6B8AD9",
                HoverFill = "#2E86C1FF", HoverEdge = "#8FD0FFFF", HubFill = "#141C26FA",
                HubEdge = "#4C7FA8FF", Text = "#E8F2FBFF", TextDim = "#96AEC4FF",
                TextFaint = "#69808FFF", Accent = "#4DE0C0FF",
            }),
            ("半透明", new RingPalette
            {
                WedgeFill = "#33333BB0", WedgeFillAlt = "#2B2B33B0", WedgeEdge = "#5C5C5C99",
                HoverFill = "#4278C2CC", HoverEdge = "#85BDFFDD", HubFill = "#1F1F24C0",
                HubEdge = "#4770A8CC", Text = "#F0F0F0FF", TextDim = "#999999FF",
                TextFaint = "#6B6B6BFF", Accent = "#61E094FF",
            }),
        };

        private void BuildPresets()
        {
            PresetPanel.Children.Add(new TextBlock
            {
                Text = "配色预设",
                FontWeight = FontWeights.SemiBold,
                Margin = new Thickness(0, 0, 0, 6),
            });

            var wrap = new WrapPanel { MaxWidth = 460 };
            foreach (var (name, palette) in Presets)
            {
                var captured = palette;
                var button = MakeButton(name, () =>
                {
                    _config.Appearance.Colors = captured.Clone();
                    RefreshAll();
                    Changed();
                });
                button.Margin = new Thickness(0, 0, 6, 6);
                button.MinWidth = 96;
                wrap.Children.Add(button);
            }
            PresetPanel.Children.Add(wrap);

            PresetPanel.Children.Add(new TextBlock
            {
                Text = "套用后再逐项微调即可。改完立刻生效，关窗自动保存。",
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brushes.Gray,
                MaxWidth = 460,
            });
        }

        private void BuildActions()
        {
            ActionPanel.Children.Add(MakeButton("恢复默认", ResetToDefaults));
            ActionPanel.Children.Add(MakeButton("导入配置…", ImportConfig));
            ActionPanel.Children.Add(MakeButton("导出配置…", ExportConfig));
            ActionPanel.Children.Add(MakeButton("打开配置文件", RevealConfig));
            ActionPanel.Children.Add(MakeButton("关闭", Close));
        }

        private void ResetToDefaults()
        {
            var answer = MessageBox.Show(
                "把外观、交互、内容全部恢复成默认值？\n配置文件里你自己加的其它键会保留。",
                "幻梦圆环", MessageBoxButton.OKCancel, MessageBoxImage.Question);
            if (answer != MessageBoxResult.OK) return;

            _config = RingConfig.ResetToDefaults();
            RefreshAll();
            _onChange?.Invoke(_config);
        }

        private void ImportConfig()
        {
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Title = "导入圆环配置",
                Filter = "JSON 配置 (*.json)|*.json|所有文件 (*.*)|*.*",
                CheckFileExists = true,
            };
            if (dialog.ShowDialog(this) != true) return;

            try
            {
                // 先按目标路径做一次容错校验：坏文件不该把现有配置冲掉
                var incoming = File.ReadAllText(dialog.FileName);
                JsonParseCheck(incoming);

                File.Copy(dialog.FileName, RingConfig.ConfigPath, true);
                _config = RingConfig.Load();
                RefreshAll();
                _onChange?.Invoke(_config);
                MessageBox.Show("导入完成。", "幻梦圆环", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show($"导入失败：{ex.Message}", "幻梦圆环", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        /// <summary>导入前确认它是合法 JSON —— 否则写进去下次启动就得吃容错回退</summary>
        private static void JsonParseCheck(string text) =>
            System.Text.Json.Nodes.JsonNode.Parse(text);

        private void ExportConfig()
        {
            Flush();   // 先把内存里的改动落盘，不然导出的是旧内容

            var dialog = new Microsoft.Win32.SaveFileDialog
            {
                Title = "导出圆环配置",
                FileName = "huanmeng-ring.json",
                Filter = "JSON 配置 (*.json)|*.json|所有文件 (*.*)|*.*",
                OverwritePrompt = true,
            };
            if (dialog.ShowDialog(this) != true) return;

            try
            {
                File.Copy(RingConfig.ConfigPath, dialog.FileName, true);
                MessageBox.Show("导出完成。", "幻梦圆环", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show($"导出失败：{ex.Message}", "幻梦圆环", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        private void RevealConfig()
        {
            Flush();
            var path = RingConfig.ConfigPath;
            try
            {
                if (File.Exists(path))
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"")
                    {
                        UseShellExecute = true,
                    });
                }
                else
                {
                    Process.Start(new ProcessStartInfo("explorer.exe",
                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile))
                    {
                        UseShellExecute = true,
                    });
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show($"打不开：{ex.Message}", "幻梦圆环", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
    }
}
