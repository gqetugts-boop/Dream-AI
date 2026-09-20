const MAIN_PLUGIN = '/Users/zero/Documents/Dream AI/Dream-ps-ai';
import { connectService, loadPlugin, wait, pollFlag } from "./lib/uxp-driver.mjs";
const service = await connectService();
let main = null;
try {
  main = await loadPlugin(service, MAIN_PLUGIN);
  await wait(5000);
  const raw = await main.evaluate(`JSON.stringify({
    moduleLoaded: !!window.HuanmengRingBridge,
    connected: window.HuanmengRingBridge ? HuanmengRingBridge.isConnected() : null
  })`);
  console.log("桥接模块:", raw);
  await wait(3000);
  const state = await main.evaluate(`JSON.stringify((() => {
    if (!window.HuanmengRingBridge) return { error: 'no module' };
    const s = HuanmengRingBridge.buildState();
    return {
      document: s.document,
      params: s.params,
      modelOptionCount: (s.options.model || []).length,
      resolutionOptions: (s.options.resolution || []).map(o => o.text),
      presetCategories: (s.presets || []).length,
      presetTotal: (s.presets || []).reduce((n, g) => n + g.items.length, 0)
    };
  })())`);
  console.log("状态快照:", JSON.stringify(JSON.parse(state), null, 2));
} catch (e) { console.error("失败:", e.message); }
finally { if (main) await main.close(); service.socket.close(); }
process.exit(0);
