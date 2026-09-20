// ============================================================
//  ring-reconnect-test.mjs — 桥接自动重连真机验证
//
//  做五件事：
//    1. 加载插件，等它连上助手
//    2. 杀掉助手，确认插件识别到断线
//    3. 重启助手，确认插件自己接回去（不需要人工干预）
//    4. 确认重连后还能构造出完整状态
//    5. 确认对话子菜单要用的那块状态（chat）也在
//
//  前置：Photoshop + UXP Developer Tools 运行中
//  用法：node tests/ring-reconnect-test.mjs
//
//  历史：这个文件以前查的是 window.SatBridge —— 卫星插件的东西，
//  那个插件早就并进主插件删掉了，加上里面引用了不存在的变量 root，
//  整个文件从来没能跑起来。现在按合并后的架构（HuanmengRingBridge）重写。
// ============================================================

import { connectService, loadPlugin, wait } from "./lib/uxp-driver.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn, execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..");
const MAIN_PLUGIN = resolve(REPO, "..", "Dream-ps-ai");
const APP_BINARY = resolve(REPO, "native/build/HuanmengRing.app/Contents/MacOS/HuanmengRing");

function killHelper() {
  try { execSync("pkill -f HuanmengRing", { stdio: "ignore" }); } catch (_) {}
}

function startHelper() {
  const child = spawn(APP_BINARY, [], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

/** 轮询桥接模块的连接状态，直到达到期望值或超时 */
async function waitForConnection(plugin, expected, timeoutMs, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const raw = await plugin.evaluate(
      `JSON.stringify({ connected: window.HuanmengRingBridge
                          ? window.HuanmengRingBridge.isConnected() : null })`);
    last = raw ? JSON.parse(raw) : null;
    if (last && last.connected === expected) {
      console.log(`  ✓ ${label}（${Math.round((Date.now() - start) / 100) / 10}s）`);
      return last;
    }
    await wait(400);
  }
  console.log(`  ✗ ${label} —— 超时，最后状态：${JSON.stringify(last)}`);
  return last;
}

const service = await connectService();
let plugin = null;
let exitCode = 0;
const problems = [];

try {
  killHelper();
  await wait(800);
  startHelper();
  await wait(1500);

  console.log("▶ 加载主插件");
  plugin = await loadPlugin(service, MAIN_PLUGIN);
  await wait(2500);

  const hasModule = await plugin.evaluate(`typeof window.HuanmengRingBridge`);
  console.log(`  HuanmengRingBridge 模块：${hasModule}`);
  if (hasModule !== "object") problems.push("HuanmengRingBridge 未注册");

  console.log("\n▶ 步骤 1：初始连接");
  await waitForConnection(plugin, true, 12000, "插件连上助手");

  console.log("\n▶ 步骤 2：杀掉助手，插件应识别到断线");
  killHelper();
  const afterKill = await waitForConnection(plugin, false, 15000, "插件识别到断线");
  if (!afterKill || afterKill.connected !== false) problems.push("助手被杀后插件没有识别到断线");

  console.log("\n▶ 步骤 3：重启助手，插件应自行接回");
  await wait(1000);
  startHelper();
  const afterRestart = await waitForConnection(plugin, true, 25000, "插件自动重连成功");
  if (!afterRestart || afterRestart.connected !== true) {
    problems.push("助手重启后插件没有自动重连");
  }

  console.log("\n▶ 步骤 4：重连后状态仍能完整构造");
  const stateSent = await plugin.evaluate(`JSON.stringify((() => {
    try {
      const snapshot = window.HuanmengRingBridge.buildState();
      return {
        ok: true,
        models: (snapshot.options.model || []).length,
        presets: (snapshot.presets || []).length,
        sectors: (snapshot.sectors || []).length,
        actions: (snapshot.actions || []).length,
        hasDocument: !!(snapshot.document && snapshot.document.open),
        model: snapshot.params.model
      };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  })())`);
  const snapshot = JSON.parse(stateSent);
  console.log("  状态快照:", JSON.stringify(snapshot));
  if (!snapshot.ok) problems.push("重连后无法构造状态：" + snapshot.error);
  if (snapshot.models === 0) problems.push("状态里没有图像模型选项");
  if (snapshot.presets === 0) problems.push("状态里没有预设");
  if (snapshot.sectors !== 6) problems.push("槽位不是 6 个，实际 " + snapshot.sectors);

  console.log("\n▶ 步骤 5：对话子菜单的状态");
  const chatSent = await plugin.evaluate(`JSON.stringify((() => {
    try {
      const snapshot = window.HuanmengRingBridge.buildState();
      const chat = snapshot.chat || null;
      const api = window.HuanmengChat || null;
      return {
        ok: !!chat,
        questions: chat ? (chat.questions || []).length : 0,
        firstLabel: chat && chat.questions && chat.questions[0] ? chat.questions[0].label : '',
        models: chat ? (chat.models || []).length : 0,
        api: !!api,
        apiAsk: !!(api && typeof api.ask === 'function'),
        // 默认动作必须是展开子菜单，而不是老的「切到对话页」
        chatAction: (snapshot.sectors || [])
          .filter(function (s) { return s.id === 'chat'; })
          .map(function (s) { return s.action; })[0] || ''
      };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  })())`);
  const chat = JSON.parse(chatSent);
  console.log("  对话状态:", JSON.stringify(chat));
  if (!chat.ok) problems.push("state 里没有 chat 块，圆环的对话菜单会是空的：" + chat.error);
  if (chat.questions < 1) problems.push("没有快捷提问，圆环上的「快捷提问」会是空的");
  if (!chat.api) problems.push("window.HuanmengChat 没注册，圆环问出去没人接");
  if (!chat.apiAsk) problems.push("HuanmengChat.ask 不是函数");
  if (chat.chatAction !== "chatMenu") {
    problems.push("对话槽位的动作是 " + chat.chatAction + "，应当是 chatMenu（画成子菜单）");
  }

  console.log("\n═══ 结论 ═══");
  if (problems.length) {
    console.log("❌ 有问题：");
    problems.forEach((item) => console.log("   · " + item));
    exitCode = 1;
  } else {
    console.log("✅ 自动重连 + 对话状态全链路通过");
  }
} catch (error) {
  console.error("✗ 测试异常：" + error.message);
  exitCode = 1;
} finally {
  if (plugin) await plugin.close();
  service.socket.close();
}

process.exit(exitCode);
