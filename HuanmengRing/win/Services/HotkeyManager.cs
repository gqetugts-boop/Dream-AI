// ============================================================
//  HotkeyManager.cs — 全局快捷键（RegisterHotKey）
//
//  为什么用 RegisterHotKey 而不是再挂一个键盘钩子：
//    1. 它由系统匹配，不碰用户输入 —— 即使写错了也不会影响打字
//    2. 注册失败会返回 false，可以如实告诉用户「被别的程序占了」
//  代价：组合会被本进程独占，和 Photoshop 撞车的话 PS 就收不到了。
//        所以默认值选了一个 Windows 上几乎不可能冲突的组合。
//
//  需要一个窗口句柄来收 WM_HOTKEY。这里建一个 message-only 窗口，
//  它不出现在任务栏、不在 Alt+Tab 里、不可见。
//
//  跨平台差异（SPEC 没规定默认值，两边各自定）：
//    配置文件里的 "cmd" 在 Windows 上映射成 Win 键。但 Win+字母 基本都被
//    系统占了（Win+R 是运行），所以 Windows 默认用 ctrl+alt+r。
//    从 macOS 导入的配置如果写着 cmd 组合，会注册失败并在菜单里提示。
// ============================================================

using System;
using System.Collections.Generic;
using System.Windows.Interop;

namespace HuanmengRing.Services
{
    public sealed class HotkeyBinding
    {
        public uint Modifiers;
        public uint VirtualKey;
        public string Display = "";
        public string Source = "";

        /// <summary>至少要有 ctrl / alt / shift 之一：不带的单键注册了会全局吃掉这个键</summary>
        public bool HasSafeModifier =>
            (Modifiers & (NativeMethods.MOD_CONTROL | NativeMethods.MOD_ALT | NativeMethods.MOD_SHIFT)) != 0;
    }

    public sealed class HotkeyManager : IDisposable
    {
        /// <summary>Windows 上的默认热键。Photoshop 没占用 Ctrl+Alt+R。</summary>
        public const string DefaultText = "ctrl+alt+r";

        private const int HotkeyId = 0x4852;   // 'HR'

        private HwndSource _source;
        private bool _registered;
        private Action _handler;

        public HotkeyBinding Current { get; private set; }

        /// <summary>注册失败的原因，给菜单栏提示用。空字符串表示没出错。</summary>
        public string LastError { get; private set; } = "";

        /// <summary>
        /// 解析 "ctrl+alt+cmd+r" 这类字符串。
        /// 修饰键别名：cmd/command→Win、alt/option/opt、ctrl/control、shift。
        /// 解析失败返回 null，由调用方决定回退策略。
        /// </summary>
        public static HotkeyBinding Parse(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;

            uint modifiers = 0;
            var display = new List<string>();
            string key = null;

            foreach (var raw in text.ToLowerInvariant().Split('+'))
            {
                var part = raw.Trim();
                if (part.Length == 0) continue;
                switch (part)
                {
                    case "cmd": case "command": case "win": case "super":
                        modifiers |= NativeMethods.MOD_WIN; display.Add("Win"); break;
                    case "alt": case "option": case "opt":
                        modifiers |= NativeMethods.MOD_ALT; display.Add("Alt"); break;
                    case "ctrl": case "control":
                        modifiers |= NativeMethods.MOD_CONTROL; display.Add("Ctrl"); break;
                    case "shift":
                        modifiers |= NativeMethods.MOD_SHIFT; display.Add("Shift"); break;
                    default:
                        key = part; break;
                }
            }

            if (string.IsNullOrEmpty(key) || key.Length != 1)
            {
                Console.Error.WriteLine($"[幻梦圆环] 无法解析 hotkey：{text}");
                return null;
            }

            var upper = char.ToUpperInvariant(key[0]);
            uint vk;
            if (upper >= 'A' && upper <= 'Z') vk = upper;               // VK_A..VK_Z == 'A'..'Z'
            else if (upper >= '0' && upper <= '9') vk = upper;          // VK_0..VK_9 == '0'..'9'
            else
            {
                Console.Error.WriteLine($"[幻梦圆环] 暂不支持这个按键：{key}");
                return null;
            }

            display.Add(upper.ToString());
            return new HotkeyBinding
            {
                Modifiers = modifiers,
                VirtualKey = vk,
                Display = string.Join("+", display),
                Source = text,
            };
        }

        /// <summary>注册热键。text 为空则用平台默认值。返回是否成功。</summary>
        public bool Register(string text, Action handler)
        {
            Unregister();
            _handler = handler;
            LastError = "";

            var binding = Parse(text);
            if (binding == null)
            {
                if (!string.IsNullOrWhiteSpace(text))
                    LastError = $"热键格式无法识别：{text}";
                binding = Parse(DefaultText);
                binding.Source = DefaultText;
            }

            if (!binding.HasSafeModifier)
            {
                LastError = "热键必须带 Ctrl / Alt / Shift 之一";
                binding = Parse(DefaultText);
                binding.Source = DefaultText;
            }

            if (!EnsureWindow())
            {
                LastError = "无法创建热键消息窗口";
                return false;
            }

            // MOD_NOREPEAT：按住不放不要连续触发
            _registered = NativeMethods.RegisterHotKey(
                _source.Handle, HotkeyId, binding.Modifiers | NativeMethods.MOD_NOREPEAT, binding.VirtualKey);

            if (!_registered)
            {
                var code = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                // 1409 = ERROR_HOTKEY_ALREADY_REGISTERED
                LastError = code == 1409
                    ? $"{binding.Display} 已被其它程序占用"
                    : $"注册 {binding.Display} 失败（错误码 {code}）";
                Console.Error.WriteLine($"[幻梦圆环] {LastError}");
            }

            Current = binding;
            return _registered;
        }

        public void Unregister()
        {
            if (_registered && _source != null)
            {
                NativeMethods.UnregisterHotKey(_source.Handle, HotkeyId);
                _registered = false;
            }
            Current = null;
        }

        private bool EnsureWindow()
        {
            if (_source != null) return true;
            try
            {
                var parameters = new HwndSourceParameters("HuanmengRingHotkeySink")
                {
                    // 用 1 而不是 0：WPF 的窗口管理器对 0 像素的窗口处理得很吃力，
                    // 而 message-only 窗口反正不显示，1×1 和 0×0 没有区别
                    Width = 1,
                    Height = 1,
                    PositionX = 0,
                    PositionY = 0,
                    WindowStyle = 0,                        // 不显示
                    ExtendedWindowStyle = 0,
                    ParentWindow = new IntPtr(-3),          // HWND_MESSAGE：消息专用窗口
                };
                _source = new HwndSource(parameters);
                _source.AddHook(WndProc);
                return true;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[幻梦圆环] 创建消息窗口失败：{ex.Message}");
                _source = null;
                return false;
            }
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == NativeMethods.WM_HOTKEY && wParam.ToInt32() == HotkeyId)
            {
                handled = true;
                try { _handler?.Invoke(); }
                catch (Exception ex) { Console.Error.WriteLine($"[幻梦圆环] 热键回调异常：{ex.Message}"); }
            }
            return IntPtr.Zero;
        }

        public void Dispose()
        {
            Unregister();
            if (_source != null)
            {
                _source.RemoveHook(WndProc);
                _source.Dispose();
                _source = null;
            }
        }
    }
}
