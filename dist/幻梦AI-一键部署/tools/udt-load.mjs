// ============================================================
//  udt-load.mjs — 通过 UDT 的 CLI 通道把插件加载进 Photoshop
//
//  协议来源：UDT 的服务端跑在 ws://127.0.0.1:14001/socket/cli，
//  发 {command:"proxy", clientId, requestId, message:{command:"Plugin", action:"load", ...}}
//  就能让 Photoshop 加载磁盘上的插件。这套用法项目里的
//  tests/lib/uxp-driver.mjs 已经在用，这里把它抽成独立脚本。
//
//  **为什么要常驻而不是跑完就退**：
//  项目经验（tests/lib/uxp-driver.mjs 的注释）记着「UDT 的 CLI 会话绑定在
//  WebSocket 连接上，连接一断会话就没了」。如果这个判断成立，
//  跑完就退等于白加载；如果不成立，常驻也完全无害。
//  所以这里选择**保持连接 + 定期心跳**，两种情况都能工作。
//  用 SIGTERM/SIGINT 退出时会主动 unload，不留垃圾会话。
//
//  用法：
//    node udt-load.mjs <插件目录> [--pid-file <路径>] [--once]
//      --once  加载成功后立刻退出（用于测试，插件可能随之卸载）
// ============================================================

// WebSocket 用 Node 内置的全局实现（Node 22+ 稳定）。不引第三方包 ——
// 部署包里不该再带一份 node_modules。
import { writeFileSync, unlinkSync } from "node:fs";

const SERVICE_URL = process.env.HUANMENG_UXP_SERVICE || "ws://127.0.0.1:14001/socket/cli";
const HEARTBEAT_MS = 20000;

const args = process.argv.slice(2);
const pluginPath = args.find((a) => !a.startsWith("--"));
const pidFileIndex = args.indexOf("--pid-file");
const pidFile = pidFileIndex >= 0 ? args[pidFileIndex + 1] : null;
const once = args.includes("--once");
/// 只连一下、报个到就退，不碰插件。用来确认 UDT 通道是通的。
const probe = args.includes("--probe");

function log(message) {
    process.stdout.write(`${message}\n`);
}

function fail(message, code = 1) {
    process.stderr.write(`✗ ${message}\n`);
    process.exit(code);
}

if (!pluginPath && !probe) fail("用法：node udt-load.mjs <插件目录> [--pid-file <路径>] [--once]");

/** 连上 UDT 服务，等 Photoshop 的运行时客户端就位。 */
function connect(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        let socket;
        try {
            socket = new WebSocket(SERVICE_URL);
        } catch (error) {
            reject(new Error(`无法创建连接：${error.message}`));
            return;
        }

        const timer = setTimeout(() => {
            try { socket.close(); } catch {}
            reject(new Error(
                `连接 UDT 超时：${SERVICE_URL}\n` +
                `  请确认 Photoshop 和「Adobe UXP Developer Tools」都已启动。`
            ));
        }, timeoutMs);

        let requestId = 0;
        let photoshopClient = null;
        const replies = new Map();

        const request = (message, timeout = 20000) =>
            new Promise((res, rej) => {
                const id = ++requestId;
                const t = setTimeout(() => {
                    replies.delete(id);
                    rej(new Error(`UDT 请求超时：${message.action || message.command}`));
                }, timeout);
                replies.set(id, {
                    resolve(value) { clearTimeout(t); res(value); },
                    reject(error) { clearTimeout(t); rej(error); },
                });
                socket.send(JSON.stringify({
                    command: "proxy",
                    clientId: photoshopClient.id,
                    requestId: id,
                    message,
                }));
            });

        socket.addEventListener("open", () => {
            log(`· 已连接 UDT：${SERVICE_URL}`);
        });

        socket.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error(
                `连不上 UDT：${SERVICE_URL}\n` +
                `  请确认「Adobe UXP Developer Tools」正在运行。`
            ));
        });

        socket.addEventListener("message", (event) => {
            let message;
            try { message = JSON.parse(String(event.data)); } catch { return; }

            if (message.command === "didAddRuntimeClient" && message.app?.appId === "PS") {
                photoshopClient = message;
                log("· Photoshop 运行时已就位");
            }
            if (message.command === "didCompleteConnection") {
                if (!photoshopClient) {
                    clearTimeout(timer);
                    reject(new Error("UDT 里没有 Photoshop 客户端 —— 请先在 UDT 里连接到 Photoshop"));
                    return;
                }
                clearTimeout(timer);
                resolve({ socket, client: photoshopClient, request });
            }
            if (message.command === "reply" && replies.has(message.requestId)) {
                const callback = replies.get(message.requestId);
                replies.delete(message.requestId);
                if (message.error) callback.reject(new Error(message.error));
                else callback.resolve(message);
            }
        });
    });
}

async function main() {
    log(`▶ 把插件加载进 Photoshop`);
    log(`  插件：${pluginPath}`);

    const service = await connect();

    if (probe) {
        log("✓ UDT 通道正常，Photoshop 客户端在");
        try { service.socket.close(); } catch {}
        process.exit(0);
    }

    const load = await service.request({
        command: "Plugin",
        action: "load",
        params: { provider: { type: "disk", path: pluginPath } },
        breakOnStart: false,
    });

    const sessionId = load.pluginSessionId;
    if (!sessionId) fail("UDT 没有返回 pluginSessionId，加载可能失败了");

    log("✓ 插件已加载");
    if (pidFile) {
        try { writeFileSync(pidFile, String(process.pid)); } catch {}
    }

    if (once) {
        log("（--once：立刻退出。如果 UDT 的会话确实绑在连接上，插件会随之卸载）");
        try { service.socket.close(); } catch {}
        process.exit(0);
    }

    log("· 保持连接以维持会话（Ctrl-C 退出并卸载）");

    // 心跳：不一定要发什么，但保持这条 WebSocket 活着
    const heartbeat = setInterval(() => {
        if (service.socket.readyState === 1) {
            try { service.socket.send(JSON.stringify({ command: "ping" })); } catch {}
        }
    }, HEARTBEAT_MS);

    service.socket.addEventListener("close", () => {
        log("! 与 UDT 的连接断开了，插件会话可能已失效");
        process.exit(0);
    });

    const shutdown = async () => {
        clearInterval(heartbeat);
        log("\n· 正在卸载插件…");
        try {
            await service.request({ command: "Plugin", action: "unload", pluginSessionId: sessionId }, 8000);
            log("✓ 已卸载");
        } catch {
            // 宿主已退出或面板已关时卸载会失败，这不该影响退出
        }
        if (pidFile) { try { unlinkSync(pidFile); } catch {} }
        process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

main().catch((error) => fail(error.message));
