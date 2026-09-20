// ============================================================
//  uxp-driver.mjs — 通过 UXP Developer Tools 调试通道驱动真机
//
//  依赖：Photoshop 正在运行，且 UXP Developer Tools 已启动
//        （默认服务 ws://127.0.0.1:14001/socket/cli）。
//
//  注意：UDT 的 CLI 会话绑定在 WebSocket 连接上，连接一断会话就没了，
//  但 UDT 列表里的 Loaded 是残留显示，此时点 Reload 会报
//  "Reload Request Failed. Unknown Error."。
//  恢复办法：UDT 里 Unload 再 Add Plugin。
// ============================================================

export const SERVICE_URL = process.env.HUANMENG_UXP_SERVICE || "ws://127.0.0.1:14001/socket/cli";

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createSocket(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`连接超时：${url}`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`无法连接：${url}（请确认 Photoshop 与 UXP Developer Tools 已启动）`));
    }, { once: true });
  });
}

/** 连接 UDT 服务并等待 Photoshop 运行时客户端出现。 */
export async function connectService() {
  const socket = await createSocket(SERVICE_URL);
  let requestId = 0;
  let photoshopClient = null;
  const replies = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(() => readyReject(new Error("未发现 Photoshop UXP 运行时")), 10000);

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.command === "didAddRuntimeClient" && message.app && message.app.appId === "PS") {
      photoshopClient = message;
    }
    if (message.command === "didCompleteConnection") {
      clearTimeout(readyTimer);
      if (photoshopClient) readyResolve(photoshopClient);
      else readyReject(new Error("Photoshop 未连接到 UXP Developer Tools"));
    }
    if (message.command === "reply" && replies.has(message.requestId)) {
      const callback = replies.get(message.requestId);
      replies.delete(message.requestId);
      if (message.error) callback.reject(new Error(message.error));
      else callback.resolve(message);
    }
  });

  function request(clientId, message, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => {
        replies.delete(id);
        reject(new Error(`UXP 请求超时：${message.action || message.command}`));
      }, timeoutMs);
      replies.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      socket.send(JSON.stringify({ command: "proxy", clientId, requestId: id, message }));
    });
  }

  const client = await ready;
  return { socket, client, request };
}

/** 在插件的调试上下文里求值一个表达式，返回其值。 */
export async function evaluateCdt(url, expression, timeoutMs = 30000) {
  const normalizedUrl = url.startsWith("ws=") ? `ws://${url.slice(3)}` : url;
  const socket = await createSocket(normalizedUrl);
  let contextId = null;
  const contexts = [];
  let enabled = false;
  let sent = false;

  return new Promise((resolve, reject) => {
    let enableTimer = null;
    const timer = setTimeout(() => {
      if (enableTimer) clearInterval(enableTimer);
      socket.close();
      reject(new Error("UXP Runtime.evaluate 超时"));
    }, timeoutMs);

    function maybeEvaluate() {
      if (!enabled || contextId == null || sent) return;
      sent = true;
      socket.send(JSON.stringify({
        id: 2,
        method: "Runtime.evaluate",
        params: { expression, contextId, awaitPromise: true, returnByValue: true },
      }));
    }

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.error && message.id == null) {
        clearTimeout(timer);
        if (enableTimer) clearInterval(enableTimer);
        socket.close();
        reject(new Error(message.error));
        return;
      }
      if (message.method === "Runtime.executionContextCreated") {
        const context = message.params && message.params.context;
        if (context) contexts.push(context);
      } else if (message.id === 1) {
        if (message.error) return reject(new Error(JSON.stringify(message.error)));
        if (enableTimer) clearInterval(enableTimer);
        enabled = true;
        socket.send(JSON.stringify({ id: 3, method: "Debugger.enable" }));
        socket.send(JSON.stringify({ id: 4, method: "Runtime.runIfWaitingForDebugger" }));
        setTimeout(() => {
          const preferred = contexts.find((context) =>
            /huanmeng|retouch|index\.html/i.test(context.origin + " " + context.name));
          const fallback = contexts.find((context) => context.auxData && context.auxData.isDefault) || contexts[0];
          contextId = (preferred || fallback || {}).id ?? null;
          maybeEvaluate();
        }, 250);
      } else if (message.id === 2) {
        clearTimeout(timer);
        if (enableTimer) clearInterval(enableTimer);
        socket.close();
        if (message.error) return reject(new Error(JSON.stringify(message.error)));
        if (message.result && message.result.exceptionDetails) {
          return reject(new Error(message.result.exceptionDetails.text));
        }
        resolve(message.result && message.result.result && message.result.result.value);
      }
    });

    const enableRuntime = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    setTimeout(enableRuntime, 300);
    enableTimer = setInterval(enableRuntime, 750);
  });
}

/** 加载磁盘插件，返回 { pluginSessionId, evaluate, close }。 */
export async function loadPlugin(service, pluginPath) {
  const load = await service.request(service.client.id, {
    command: "Plugin",
    action: "load",
    params: { provider: { type: "disk", path: pluginPath } },
    breakOnStart: false,
  });
  if (!load.pluginSessionId) throw new Error("插件已加载，但未返回 pluginSessionId");

  const pluginSessionId = load.pluginSessionId;
  await wait(750);

  async function evaluate(expression, timeoutMs = 30000) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const debug = await service.request(service.client.id, {
        command: "Plugin", action: "debug", pluginSessionId,
      });
      if (!debug.wsdebugUrl) throw new Error("UXP 未返回调试地址");
      try {
        return await evaluateCdt(debug.wsdebugUrl, expression, timeoutMs);
      } catch (error) {
        lastError = error;
        if (!/Runtime\.evaluate 超时/.test(error.message)) throw error;
        await wait(400);
      }
    }
    throw lastError;
  }

  async function close() {
    try {
      await service.request(service.client.id, {
        command: "Plugin", action: "unload", pluginSessionId,
      }, 10000);
    } catch (_) {
      // 宿主已退出或面板已关闭时，清理失败不应覆盖真实结果
    }
  }

  return { pluginSessionId, evaluate, close };
}

/** 轮询等待 globalThis 上的旗标对象完成（state !== 'running'）。 */
export async function pollFlag(plugin, flagName, { attempts = 40, intervalMs = 300 } = {}) {
  let value = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(intervalMs);
    const raw = await plugin.evaluate(`JSON.stringify(globalThis.${flagName} || null)`);
    value = raw ? JSON.parse(raw) : null;
    if (value && value.state !== "running") break;
  }
  return value;
}
