// ============================================================
//  NativeMethods.cs — Win32 P/Invoke 集中定义
//
//  集中放一处，方便核对签名。这里每一个 DllImport 都是没验证过的，
//  如果你编译报 "无法封送" / "找不到入口点"，先看这个文件。
//
//  坐标约定（重要）：
//    · 鼠标钩子给的 pt、GetCursorPos、SetWindowPos 用的都是**物理像素**
//    · WPF 的布局、Window.Left/Top、Canvas 坐标都是 **DIP**
//    · 本程序声明为 PerMonitorV2，两者在 150% 缩放下差 1.5 倍
//    所以圆环窗口的位置和大小一律走 SetWindowPos（物理像素），
//    不碰 Window.Left/Top —— 那条路在混合 DPI 下会错位。
// ============================================================

using System;
using System.Runtime.InteropServices;
using System.Text;

namespace HuanmengRing.Services
{
    internal static class NativeMethods
    {
        // ---------- 窗口定位 ----------

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
                                               int X, int Y, int cx, int cy, uint uFlags);

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;
        public const uint SWP_HIDEWINDOW = 0x0080;
        public const uint SWP_NOOWNERZORDER = 0x0200;

        /// <summary>藏起来，不移动、不改大小、不改 Z 序、不抢焦点</summary>
        public const uint ConcealFlags =
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW;

        /// <summary>
        /// 置顶 + 显示，但不抢焦点（抢了 Photoshop 就丢了当前工具）。
        ///
        /// SWP_NOSIZE 不能少：唤出时调用方传的 cx/cy 是 0，
        /// 少了这个标志 Win32 会把 0 当真，把窗口 resize 成 0×0 ——
        /// 圆环完全看不见，而且鼠标点击永远落不到窗口上。
        /// 窗口尺寸由 WPF 按 DIP 自己算，这里只管位置。
        /// 注意不要顺手加 SWP_NOMOVE，调用方要靠它挪到 _originX/_originY。
        /// </summary>
        public const uint SummonFlags =
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER;

        // ---------- 鼠标位置（轮询用，不依赖窗口是否 key）----------

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetCursorPos(out POINT point);

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        public const int VK_LBUTTON = 0x01;
        public const int VK_RBUTTON = 0x02;
        public const int VK_SHIFT = 0x10;
        public const int VK_CONTROL = 0x11;
        public const int VK_MENU = 0x12;      // Alt
        public const int VK_ESCAPE = 0x1B;
        public const int VK_LWIN = 0x5B;
        public const int VK_RWIN = 0x5C;

        /// <summary>某键当前是否按下。高位为 1 表示按下。</summary>
        public static bool IsKeyDown(int vKey) => (GetAsyncKeyState(vKey) & 0x8000) != 0;

        // ---------- 低阶鼠标钩子 ----------

        public delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn,
                                                     IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        /// <summary>释放 Bitmap.GetHicon() 拿到的图标句柄。Icon.FromHandle 不接管所有权。</summary>
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool DestroyIcon(IntPtr hIcon);

        public const int WH_MOUSE_LL = 14;
        public const int WH_KEYBOARD_LL = 13;

        public const int WM_MOUSEMOVE = 0x0200;
        public const int WM_LBUTTONDOWN = 0x0201;
        public const int WM_LBUTTONUP = 0x0202;
        public const int WM_RBUTTONDOWN = 0x0204;
        public const int WM_RBUTTONUP = 0x0205;
        public const int WM_MBUTTONDOWN = 0x0207;
        public const int WM_MBUTTONUP = 0x0208;
        public const int WM_MOUSEWHEEL = 0x020A;
        public const int WM_MOUSEHWHEEL = 0x020E;

        public const int WM_KEYDOWN = 0x0100;
        public const int WM_KEYUP = 0x0101;
        public const int WM_SYSKEYDOWN = 0x0104;
        public const int WM_SYSKEYUP = 0x0105;

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public POINT pt;              // 物理屏幕像素
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        // ---------- 前台窗口判定 ----------

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

        public static string WindowTitle(IntPtr hwnd)
        {
            var length = GetWindowTextLength(hwnd);
            if (length <= 0) return "";
            var buffer = new StringBuilder(length + 2);
            GetWindowText(hwnd, buffer, buffer.Capacity);
            return buffer.ToString();
        }

        // ---------- 显示器与 DPI ----------

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

        public const uint MONITOR_DEFAULTTONEAREST = 2;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        public const uint MONITORINFOF_PRIMARY = 1;

        /// <summary>shcore.dll，Win8.1+。取显示器的有效 DPI。</summary>
        [DllImport("shcore.dll")]
        public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

        public const int MDT_EFFECTIVE_DPI = 0;

        /// <summary>
        /// 取某个物理点所在显示器的缩放系数（1.0 = 96 DPI）。
        /// 任何一步失败都退回 1.0 —— 宁可环大小不准，也不能崩。
        /// </summary>
        public static double ScaleAt(POINT physicalPoint)
        {
            try
            {
                var monitor = MonitorFromPoint(physicalPoint, MONITOR_DEFAULTTONEAREST);
                if (monitor == IntPtr.Zero) return 1.0;
                if (GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, out var dpiX, out _) != 0) return 1.0;
                if (dpiX == 0) return 1.0;
                return dpiX / 96.0;
            }
            catch (DllNotFoundException) { return 1.0; }
            catch (EntryPointNotFoundException) { return 1.0; }
        }

        /// <summary>可见工作区（不含任务栏），物理像素。给圆环贴边回挪用。</summary>
        public static bool TryGetWorkArea(POINT physicalPoint, out RECT work)
        {
            work = default;
            var monitor = MonitorFromPoint(physicalPoint, MONITOR_DEFAULTTONEAREST);
            if (monitor == IntPtr.Zero) return false;
            var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (!GetMonitorInfo(monitor, ref info)) return false;
            work = info.rcWork;
            return true;
        }

        // ---------- 前台窗口 ----------

        /// <summary>把焦点还给 Photoshop 用（打完字关掉气泡时）</summary>
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        // ---------- 热键 ----------

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        public const uint MOD_ALT = 0x0001;
        public const uint MOD_CONTROL = 0x0002;
        public const uint MOD_SHIFT = 0x0004;
        public const uint MOD_WIN = 0x0008;
        public const uint MOD_NOREPEAT = 0x4000;
        public const int WM_HOTKEY = 0x0312;
    }
}
