// ============================================================
//  RingModel.cs — 圆环数据模型与几何计算
//
//  几何算法与 macOS 版（以及 UXP 版 pie.js）严格一致，见 SPEC 第三节：
//    扇区从正上方（-90°）起算，顺时针排列
//    命中测试靠 atan2 + 半径，不依赖任何命中 API
//  三端必须用同一套算法，否则同一个配置文件在两边显示会不一样。
// ============================================================

using System;
using System.Collections.Generic;

namespace HuanmengRing.Models
{
    /// <summary>扇区触发的动作，由 BridgeServer 编码成 JSON 发给插件</summary>
    public enum RingActionKind { None, Command, CommandWith, SetParam, ApplyPreset, CloseRing, Local }

    /// <summary>圆环本地就能完成、不用发给插件的动作</summary>
    public enum RingLocalKind
    {
        /// <summary>打开输入条。**必须是真的 TextBox**，否则中文输入法挂不上去</summary>
        TextInput,
        /// <summary>把上一条回复重新弹出来</summary>
        ShowReply,
    }

    public class RingAction
    {
        public RingActionKind Kind { get; private set; } = RingActionKind.None;
        public string Command { get; private set; } = "";
        public string Key { get; private set; } = "";
        public string Value { get; private set; } = "";
        /// <summary>CommandWith 的附加参数，原样透传给插件</summary>
        public Dictionary<string, string> Payload { get; private set; } = new();
        public RingLocalKind Local { get; private set; } = RingLocalKind.TextInput;

        public static RingAction Command_(string name) =>
            new RingAction { Kind = RingActionKind.Command, Command = name };

        /// <summary>
        /// 带参数的指令（对话提问、切对话模型…）。
        /// 参数原样交给插件 —— 助手不需要知道里面是什么，
        /// 以后插件加新指令这边一行都不用改。
        /// </summary>
        public static RingAction CommandWith(string name, Dictionary<string, string> payload) =>
            new RingAction { Kind = RingActionKind.CommandWith, Command = name, Payload = payload };

        public static RingAction SetParam(string key, string value) =>
            new RingAction { Kind = RingActionKind.SetParam, Key = key, Value = value };
        public static RingAction ApplyPreset(string name) =>
            new RingAction { Kind = RingActionKind.ApplyPreset, Value = name };
        public static RingAction CloseRing() =>
            new RingAction { Kind = RingActionKind.CloseRing };
        public static RingAction Local_(RingLocalKind kind) =>
            new RingAction { Kind = RingActionKind.Local, Local = kind };
    }

    public class RingSegment
    {
        public string Label = "";
        public string Hint = "";
        /// <summary>非空表示这个扇区还有下一级</summary>
        public List<RingSegment> Children;
        /// <summary>不可用（例如插件未连接），画成半透明且不响应</summary>
        public bool Disabled;
        /// <summary>右上角的小勾，表示当前生效项</summary>
        public bool Checked;
        public RingAction Action;

        public bool HasChildren => Children != null && Children.Count > 0;
    }

    public class RingLevel
    {
        public string Title = "";
        public List<RingSegment> Segments = new();
    }

    /// <summary>圆环几何。半径以视图中心为原点，单位与 ringSize 一致（DIP）。</summary>
    public class RingGeometry
    {
        public double CenterX, CenterY;
        public double OuterRadius, InnerRadius;

        public double RingRadius => (OuterRadius + InnerRadius) / 2;
        public double BandWidth => OuterRadius - InnerRadius;

        public RingGeometry(double width, double height, double bandRatio)
        {
            CenterX = width / 2;
            CenterY = height / 2;

            var maxRadius = Math.Min(width, height) / 2 - 12;
            if (maxRadius < 60) maxRadius = Math.Min(width, height) / 2 - 4;

            OuterRadius = Math.Max(40, maxRadius);
            InnerRadius = OuterRadius * bandRatio;
        }

        /// <summary>第 index 个扇区的中心角（弧度）。-π/2 即正上方，顺时针递增。</summary>
        public static double MidAngle(int index, int count) =>
            -Math.PI / 2 + index * (2 * Math.PI / count);

        /// <summary>扇区中心坐标（y 轴向下，WPF 坐标系亦然）</summary>
        public (double X, double Y) ItemCenter(int index, int count)
        {
            var mid = MidAngle(index, count);
            return (CenterX + RingRadius * Math.Cos(mid),
                    CenterY + RingRadius * Math.Sin(mid));
        }

        /// <summary>
        /// 命中测试。返回 null 表示在环外；返回 -1 表示落在圆心（返回上一级 / 关闭）。
        /// </summary>
        public int? HitTest(double x, double y, int count)
        {
            var dx = x - CenterX;
            var dy = y - CenterY;
            var distance = Math.Sqrt(dx * dx + dy * dy);
            if (distance < InnerRadius) return -1;
            if (distance > OuterRadius + 6) return null;
            if (count <= 0) return null;

            var step = 2 * Math.PI / count;
            var angle = Math.Atan2(dy, dx);
            // 把 -90° 对齐到 0，并挪半个扇区，让扇区中心落在边界内
            angle += Math.PI / 2 + step / 2;
            while (angle < 0) angle += 2 * Math.PI;
            return (int)(angle / step) % count;
        }
    }
}
