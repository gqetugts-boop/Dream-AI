# Dream AI

幻梦AI 系列产品的开发目录。**这是一个 git 仓库**（根目录在 `.git`）。

---

## 目录导航

| 目录 | 是什么 | 状态 |
|---|---|---|
| **`Dream-ps-ai/`** | **幻梦AI 修图插件** —— Photoshop UXP 面板，主力产品（`com.huanmeng.ai.retouch`） | 🟢 活跃 |
| **`HuanmengRing/`** | **幻梦圆环** —— macOS 菜单栏助手（Swift），含 Windows 版（C#/WPF） | 🟢 活跃（Windows 版未编译验证） |
| `_archive/dream-ai-plugin/` | Dream AI 创意助手 —— 早期独立插件（`com.dream.ai.studio`），与主插件无引用关系 | 🔴 已归档 |
| `_archive/satellite-plugin/` | 已废弃的 UXP「卫星插件」，功能已合并进主插件 | 🔴 归档，别 Load |

> 本地可能还有一个 `参考/` 目录（第三方插件，作对照用）。
> **它不在版本库里** —— 那是别人的作品且没有许可证，
> 一起发布等于未授权分发，也无权为它授予本仓库的 GPL。已在 `.gitignore` 里排除。

---

## 两个活跃产品的关系

```
Dream-ps-ai（PS 插件）  ←── WebSocket 127.0.0.1:8799 ──→  HuanmengRing（圆环助手）
     实际干活的地方                                        只是个遥控器
```

**两个都要装**才能用圆环。只装插件也能正常用面板，只是没有圆环。

安装和排障看 **`HuanmengRing/使用说明.md`** —— 里面有从零到能用的完整流程，
以及一个内置自检（菜单栏 ◎ →「自检…」），出问题它会直接告诉你哪儿不对。

---

## 版本控制

```bash
cd "/Users/zero/Documents/Dream AI"

git status                              # 看改了什么
git diff                                # 看具体改动
git add -A && git commit -m "说明"       # 提交
git log --oneline -10                   # 最近 10 次
git checkout -- <文件>                   # 丢弃某个文件的改动
```

### 不纳入版本控制的东西

构建产物和缓存（能从源码重新生成，进去只会让 diff 变脏）：

- `HuanmengRing/native/HuanmengRing/.build/` —— Swift 构建缓存（76M）
- `HuanmengRing/native/build/` —— 组装出的 `.app`
- `HuanmengRing/dist/` —— `.dmg` / `.zip` 分发件
- `HuanmengRing/win/{bin,obj,publish}/` —— WPF 构建产物
- 各种 `_backup/`、`.DS_Store`

### ⚠️ 绝不提交凭据

**2026-09 的初始提交里，曾经误提交过两把明文 API 密钥**（`huanmeng-shared.json`
里的 GRS key、`_archive/dream-ai-plugin/.vscode/settings.json` 里的 DeepSeek key
——后者现在随项目一起归档了，项目不再维护的话建议直接删掉那个文件）。
当时仓库只有一次提交、没有远程，已用 `commit --amend` + `gc` 彻底清除。

`.gitignore` 里已经把它们挡在外面。**新增配置时不要往被跟踪的文件里写密钥** ——
用环境变量，或者写进已被忽略的 `settings.local.json`。

已经泄漏过的那两把密钥应当作废重发：进过 git 又清掉，并不能让它们重新变安全。

---

## 注意事项

**移动项目目录会打断这些绝对路径依赖**：

| 移动谁 | 会断什么 | 怎么修 |
|---|---|---|
| `HuanmengRing/` | `~/Library/LaunchAgents/com.huanmeng.ring.plist` 里的绝对路径；Swift 模块缓存 | `bash native/autostart.sh install` 重装；删掉 `native/HuanmengRing/.build` |
| `Dream-ps-ai/` | UXP Developer Tool 的工作区记录 | UDT 里重新 Add Plugin |

另外 `HuanmengRing` 的辅助功能授权**绑定在二进制的 cdhash 上** ——
移动目录不影响，但**每次重新 `build.sh` 都要重新授权一次**。

---

## 快速开始

**macOS 从源码安装**：双击根目录的 **`一键安装.command`**。
它会编译助手 → 安装 → 设置自启 → 引导授权 → 把插件加载进 Photoshop → 自检。

需要 Xcode Command Line Tools（`xcode-select --install`）。

**只想用插件**（不需要圆环）：把 `Dream-ps-ai/` 拖进 UXP Developer Tool 加载即可，
Windows 上也一样。插件本身是跨平台的。

---

## 许可证

**GPL-3.0**，全文见 [`LICENSE`](LICENSE)。

简单说：你可以自由使用、修改、分发，**但分发修改版时必须同样开源**，
并且保留版权声明。

`参考/` 目录（如果本地有）**不在授权范围内** —— 那是第三方作品，
不属于本仓库，也没有被纳入版本控制。

---

## 各项目的详细文档

- 插件：`Dream-ps-ai/README.md`
- 圆环（含安装、使用、排障）：`HuanmengRing/使用说明.md`
- 圆环配置与桥接协议规格：`HuanmengRing/SPEC-ring-config.md`
- Windows 版构建说明：`HuanmengRing/win/README-win.md`
