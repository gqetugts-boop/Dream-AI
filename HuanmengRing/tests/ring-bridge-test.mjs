// ============================================================
//  ring-bridge-test.mjs — 验证 Swift 助手的 WebSocket 桥接
//
//  模拟 UXP 插件的行为：连上 ws://127.0.0.1:8799，
//  收 hello，推一条 state，确认服务端正确接收。
//
//  先启动助手：open native/build/HuanmengRing.app
//  用法：node tests/ring-bridge-test.mjs
// ============================================================

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL = process.env.HUANMENG_RING_URL || "ws://127.0.0.1:8799";
const TIMEOUT_MS = 8000;
const STATUS_FILE = join(homedir(), ".huanmeng-ring-status.json");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 报文形状必须和插件 buildState() 现在推的一致。
// 这份样例以前是**卫星插件时代**的老协议：options.resolution 是字符串数组、
// 还有 channel / aspectRatio 这些早就不存在的字段。助手的解码器遇到
// 「resolution 是字符串而不是 {value,text}」会直接抛错、记一次
// stateDecodeFailures —— 自检里就会误报「旧的卫星插件在抢连接」，
// 用户会去 UDT 里翻一个根本不存在的插件。别再改回去了。
const sampleState = {
  type: "state",
  payload: {
    document: { open: true, name: "DSC03809.ARW", hasSelection: true, selectionWidth: 1200, selectionHeight: 1600 },
    params: { model: "nano-banana-pro", resolution: "2K", count: 1 },
    options: {
      model: [
        { value: "nano-banana-fast", text: "nano-banana-fast" },
        { value: "nano-banana-pro", text: "nano-banana-pro" }
      ],
      resolution: [{ value: "1K", text: "1K" }, { value: "2K", text: "2K" }],
      count: [1, 2, 3, 4]
    },
    presets: [
      { category: "人像精修", items: [{ name: "一键修脸", prompt: "保持原构图…" }, { name: "一键场照", prompt: "保持构图…" }] },
      { category: "服装整理", items: [{ name: "丝袜质感提升", prompt: "保持腿部形状…" }] }
    ],
    sectors: [
      { id: "generate", action: "generate", label: "生成" },
      { id: "params", action: "params", label: "参数" },
      { id: "presets", action: "presets", label: "预设" },
      { id: "chat", action: "chatMenu", label: "对话" },
      { id: "readSelection", action: "readSelection", label: "读选区" },
      { id: "close", action: "close", label: "关闭" }
    ],
    actions: [
      { value: "generate", label: "生成", hint: "按当前面板参数出图" },
      { value: "chatMenu", label: "对话菜单", hint: "展开：模型 / 快捷提问 / 打字提问" }
    ],
    chat: {
      model: "grs/gpt-5.4",
      models: [{ value: "grs/gpt-5.4", text: "GPT-5.4" }],
      questions: [{ label: "调色思路", prompt: "给我一个适合这张照片的调色思路。" }],
      busy: false,
      hasReply: false,
      lastQuestion: "",
      lastReply: ""
    }
  }
};

function run() {
  return new Promise((resolve, reject) => {
    const received = [];
    let socket;
    const timer = setTimeout(() => {
      try { socket?.close(); } catch (_) {}
      reject(new Error(`超时 ${TIMEOUT_MS}ms：助手没有响应，确认它已经启动`));
    }, TIMEOUT_MS);

    try {
      socket = new WebSocket(URL);
    } catch (error) {
      clearTimeout(timer);
      reject(new Error("无法构造 WebSocket：" + error.message));
      return;
    }

    socket.addEventListener("open", () => {
      console.log("✓ 已连接", URL);
      socket.send(JSON.stringify(sampleState));
      console.log("→ 已推送 state（文档/参数/选项/预设）");
      // 给服务端一点时间处理，然后主动断开
      setTimeout(() => {
        clearTimeout(timer);
        try { socket.close(); } catch (_) {}
        resolve(received);
      }, 900);
    });

    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      received.push(text);
      console.log("← 收到", text.slice(0, 200));
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("连接失败：助手可能没有启动，或 8799 端口被占用"));
    });
  });
}

/**
 * 助手解析成功后会立刻重写状态文件（bridgeDidReceive → refreshMenu → publishStatus）；
 * 解析失败时它只把计数加一，**不写盘**。所以「文件有没有被重写」就是
 * 「这条 state 到底解没解出来」的实证 —— 光看「发出去了没报错」是不够的，
 * WebSocket 收到一条解不动的报文也不会回任何错误。
 */
function readStatus() {
  try {
    const raw = fs.readFileSync(STATUS_FILE, "utf8");
    return { mtime: fs.statSync(STATUS_FILE).mtimeMs, data: JSON.parse(raw) };
  } catch (_) {
    return null;
  }
}

let exitCode = 0;
try {
  const before = readStatus();

  const received = await run();

  await wait(700);   // 等助手那边把状态文件写完
  const after = readStatus();

  const hello = received.find((text) => text.includes('"hello"'));
  const rewrote = before && after ? after.mtime !== before.mtime : after !== null;
  const failuresBefore = before?.data?.stateDecodeFailures ?? 0;
  const failuresAfter = after?.data?.stateDecodeFailures ?? -1;

  console.log("\n═══ 结论 ═══");
  console.log(`握手 + hello    : ${hello ? "✅ 通过" : "❌ 没收到 hello"}`);
  console.log(`state 解析      : ${rewrote ? "✅ 助手解析成功（状态文件已重写）" : "❌ 助手没能解析这条 state"}`);
  if (failuresAfter > failuresBefore) {
    console.log(`state 解析失败计数：${failuresBefore} → ${failuresAfter}（报文形状和助手的解码器对不上）`);
  }

  if (!hello) exitCode = 1;
  if (!rewrote) exitCode = 1;
  if (failuresAfter > failuresBefore) exitCode = 1;
} catch (error) {
  console.error("✗ " + error.message);
  exitCode = 1;
}

process.exit(exitCode);
