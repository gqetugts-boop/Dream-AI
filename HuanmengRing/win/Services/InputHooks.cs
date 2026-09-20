// ============================================================
//  InputHooks.cs — 低阶鼠标钩子 + 低阶键盘钩子
//
//  为什么必须用钩子而不是窗口消息：
//    圆环窗口是**非激活**的（不能抢走 Photoshop 的焦点，抢了当前工具就没了），
//    所以它收不到键盘。macOS 版同样的问题，解法是 CGEventTap。
//
//  安全边界（重要）：
//    · 鼠标钩子常驻，但只在「Alt 按下 + 右键按下 + Photoshop 在前台」时才动作
//    · **键盘钩子只在圆环显示期间安装**，圆环一关立刻摘掉。
//      这样即使钩子里有 bug，最坏情况也只是圆环开着的时候吃几个按键，
//      不会影响平时打字。
//
//  两个 delegate 都必须存成字段：只传给 SetWindowsHookEx 的话，
//  GC 一回收就是访问已释放内存的崩溃，而且是随机复现。
// ============================================================

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace HuanmengRing.Services
{
    /// <summary>低阶鼠标钩子。常驻，用来捕获 Alt+右键唤出、以及环外点击关闭。</summary>
    public sealed class MouseHook : IDisposable
    {
        private IntPtr _hook = IntPtr.Zero;
        // 不能让 GC 回收掉
        private NativeMethods.LowLevelProc _proc;

        /// <summary>返回 true 表示这一下要吞掉，不让 Photoshop 收到（避免弹出右键菜单）</summary>
        public Func<int, int, bool> OnRightButtonDown;

        /// <summary>左键按下。参数是物理屏幕坐标。返回 true 表示吞掉。</summary>
        public Func<int, int, bool> OnLeftButtonDown;

        /// <summary>鼠标移动。用来在没有窗口焦点时也能更新圆环高亮。</summary>
        public Action<int, int> OnMouseMove;

        public bool IsInstalled => _hook != IntPtr.Zero;

        public bool Install()
        {
            if (_hook != IntPtr.Zero) return true;
            try
            {
                _proc = HookProc;
                _hook = NativeMethods.SetWindowsHookEx(
                    NativeMethods.WH_MOUSE_LL, _proc, ModuleHandle(), 0);
                if (_hook == IntPtr.Zero)
                {
                    Console.Error.WriteLine($"[幻梦圆环] 安装鼠标钩子失败：错误码 {Marshal.GetLastWin32Error()}");
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[幻梦圆环] 安装鼠标钩子异常：{ex.Message}");
                return false;
            }
        }

        public void Uninstall()
        {
            if (_hook == IntPtr.Zero) return;
            NativeMethods.UnhookWindowsHookEx(_hook);
            _hook = IntPtr.Zero;
            _proc = null;
        }

        public void Dispose() => Uninstall();

        private IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode < 0) return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);

            try
            {
                var message = wParam.ToInt32();
                if (message == NativeMethods.WM_MOUSEMOVE)
                {
                    if (OnMouseMove != null)
                    {
                        var move = Marshal.PtrToStructure<NativeMethods.MSLLHOOKSTRUCT>(lParam);
                        OnMouseMove(move.pt.X, move.pt.Y);
                    }
                    return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
                }

                if (message == NativeMethods.WM_RBUTTONDOWN && OnRightButtonDown != null)
                {
                    var data = Marshal.PtrToStructure<NativeMethods.MSLLHOOKSTRUCT>(lParam);
                    if (OnRightButtonDown(data.pt.X, data.pt.Y)) return 1;
                }
                else if (message == NativeMethods.WM_LBUTTONDOWN && OnLeftButtonDown != null)
                {
                    var data = Marshal.PtrToStructure<NativeMethods.MSLLHOOKSTRUCT>(lParam);
                    if (OnLeftButtonDown(data.pt.X, data.pt.Y)) return 1;
                }
            }
            catch (Exception ex)
            {
                // 钩子回调里抛异常会直接把整个进程带走，必须全吃掉
                Console.Error.WriteLine($"[幻梦圆环] 鼠标钩子异常：{ex.Message}");
            }

            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        internal static IntPtr ModuleHandle()
        {
            try
            {
                using var process = Process.GetCurrentProcess();
                var name = process.MainModule?.ModuleName;
                return string.IsNullOrEmpty(name)
                    ? NativeMethods.GetModuleHandle(null)
                    : NativeMethods.GetModuleHandle(name);
            }
            catch
            {
                return NativeMethods.GetModuleHandle(null);
            }
        }
    }

    /// <summary>低阶键盘钩子。只在圆环显示期间安装。</summary>
    public sealed class KeyboardHook : IDisposable
    {
        private IntPtr _hook = IntPtr.Zero;
        private NativeMethods.LowLevelProc _proc;

        /// <summary>返回 true 表示吞掉这个按键。参数是虚拟键码。</summary>
        public Func<int, bool> OnKeyDown;

        public bool IsInstalled => _hook != IntPtr.Zero;

        public bool Install()
        {
            if (_hook != IntPtr.Zero) return true;
            try
            {
                _proc = HookProc;
                _hook = NativeMethods.SetWindowsHookEx(
                    NativeMethods.WH_KEYBOARD_LL, _proc, MouseHook.ModuleHandle(), 0);
                if (_hook == IntPtr.Zero)
                {
                    Console.Error.WriteLine($"[幻梦圆环] 安装键盘钩子失败：错误码 {Marshal.GetLastWin32Error()}");
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[幻梦圆环] 安装键盘钩子异常：{ex.Message}");
                return false;
            }
        }

        public void Uninstall()
        {
            if (_hook == IntPtr.Zero) return;
            NativeMethods.UnhookWindowsHookEx(_hook);
            _hook = IntPtr.Zero;
            _proc = null;
        }

        public void Dispose() => Uninstall();

        private IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode < 0) return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);

            try
            {
                var message = wParam.ToInt32();
                // 只处理按下，不处理抬起。处理抬起会吞掉按键释放，
                // 有些程序会因此认为按键一直按着。
                if (message == NativeMethods.WM_KEYDOWN || message == NativeMethods.WM_SYSKEYDOWN)
                {
                    var data = Marshal.PtrToStructure<NativeMethods.KBDLLHOOKSTRUCT>(lParam);
                    if (OnKeyDown != null && OnKeyDown((int)data.vkCode)) return 1;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[幻梦圆环] 键盘钩子异常：{ex.Message}");
            }

            return NativeMethods.CallNextHookEx(_hook, nCode, wParam, lParam);
        }
    }

    /// <summary>判断前台窗口是不是 Photoshop。</summary>
    internal static class ForegroundApp
    {
        private static string _cachedName = "";
        private static bool _photoshopRunning;
        private static DateTime _checkedAt = DateTime.MinValue;

        /// <summary>
        /// 系统里根本没跑 Photoshop 时一律放行 —— 否则你没开 PS 的时候
        /// 想单独试试圆环都试不了，还会以为是程序坏了。
        /// </summary>
        public static bool IsPhotoshopForeground()
        {
            try
            {
                if ((DateTime.UtcNow - _checkedAt).TotalSeconds > 5)
                {
                    _checkedAt = DateTime.UtcNow;
                    // 拿到的 Process 要显式释放：每 5 秒一批，不释放就是稳定的句柄泄漏
                    var found = Process.GetProcessesByName("Photoshop");
                    _photoshopRunning = found.Length > 0;
                    foreach (var process in found) process.Dispose();
                }
                if (!_photoshopRunning) return true;

                var hwnd = NativeMethods.GetForegroundWindow();
                if (hwnd == IntPtr.Zero) return false;
                NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
                if (pid == 0) return false;

                using var process = Process.GetProcessById((int)pid);
                _cachedName = process.ProcessName;
                return string.Equals(_cachedName, "Photoshop", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                // 查不到就放行：宁可多唤出一次，也不要按了没反应
                return true;
            }
        }

        /// <summary>
        /// 把前台还给 Photoshop。
        ///
        /// 为什么需要：中文输入法要求气泡窗口是前台窗口（TSF 只往前台挂），
        /// 打完字关掉气泡，前台就留在了助手这边 —— 用户会发现
        /// Photoshop 的标题栏变灰、快捷键不响应，得自己点一下才回来。
        ///
        /// 此刻助手正是前台进程，所以 SetForegroundWindow 不会被
        /// 系统的「防抢焦点」规则挡掉。失败也不抛，最多是用户手动点一下。
        /// </summary>
        public static void ActivatePhotoshop()
        {
            try
            {
                var found = Process.GetProcessesByName("Photoshop");
                foreach (var process in found)
                {
                    try
                    {
                        if (process.MainWindowHandle != IntPtr.Zero)
                        {
                            NativeMethods.SetForegroundWindow(process.MainWindowHandle);
                            return;
                        }
                    }
                    finally
                    {
                        process.Dispose();
                    }
                }
            }
            catch
            {
                // 拿不到就算了，不该因为「还焦点」失败而崩
            }
        }
    }
}
