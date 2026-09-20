const serviceUrl = process.env.HUANMENG_UXP_SERVICE || "ws://127.0.0.1:14001/socket/cli";
const pluginPath = process.cwd();
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
      reject(new Error(`无法连接：${url}`));
    }, { once: true });
  });
}

async function connectService() {
  const socket = await createSocket(serviceUrl);
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
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ command: "proxy", clientId, requestId: id, message }));
    });
  }

  const client = await ready;
  return { socket, client, request };
}

async function evaluateCdt(url, expression, timeoutMs = 30000) {
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
          const preferred = contexts.find((context) => /com\.huanmeng\.ai\.retouch|huanmeng-ai|index\.html/i.test(`${context.origin || ''} ${context.name || ''}`));
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
          return reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
        }
        resolve(message.result && message.result.result && message.result.result.value);
      }
    });
    const enableRuntime = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    setTimeout(enableRuntime, 300);
    enableTimer = setInterval(enableRuntime, 750);
  });
}

const service = await connectService();
let loadedSessionId = null;
try {
  const load = await service.request(service.client.id, {
    command: "Plugin",
    action: "load",
    params: { provider: { type: "disk", path: pluginPath } },
    breakOnStart: false,
  });
  if (!load.pluginSessionId) throw new Error("插件已加载，但未返回 pluginSessionId");
  loadedSessionId = load.pluginSessionId;
  // 磁盘插件首次加载时，面板 DOM 会先出现，feature 脚本随后完成注册。
  await wait(750);

  let runtime = null;
  let lastRuntimeError = null;
  for (let attempt = 0; attempt < 3 && !runtime; attempt += 1) {
    const debug = await service.request(service.client.id, {
      command: "Plugin",
      action: "debug",
      pluginSessionId: load.pluginSessionId,
    });
    if (!debug.wsdebugUrl) throw new Error("UXP 未返回调试地址");
    try {
      const runtimeValue = await evaluateCdt(debug.wsdebugUrl, `(() => {
        const ps = require('photoshop');
        const health = {
          title: document.title,
          photoshopVersion: ps.app.version,
          documentCount: ps.app.documents.length,
          modules: {
            colorMatch: !!window.HuanmengColorMatch,
            glow: !!window.GlowEngine,
            spaceFx: !!window.HuanmengSpaceFx
          },
          toolCount: document.querySelectorAll('#toolbox .tt-toolb-tool, #toolbox .tt-toolbox-item').length,
          activeView: document.querySelector('.tab-content.active')?.id || ''
        };
        return JSON.stringify({ health });
      })()`, 7000);
      runtime = typeof runtimeValue === 'string' ? JSON.parse(runtimeValue) : runtimeValue;
    } catch (error) {
      lastRuntimeError = error;
      if (!/Runtime\.evaluate 超时/.test(error.message)) throw error;
    }
  }

  let hostSmoke = null;
  let glowPreviewSmoke = null;
  let glowPlacementSmoke = null;
  let spaceFxSmoke = null;
  let blendMatchSmoke = null;
  let uiAuditSmoke = null;
  if (runtime && runtime.health && runtime.health.documentCount > 0) {
    const startDebug = await service.request(service.client.id, {
      command: "Plugin",
      action: "debug",
      pluginSessionId: load.pluginSessionId,
    });
    await evaluateCdt(startDebug.wsdebugUrl, `(() => {
      const ps = require('photoshop');
      globalThis.__huanmengHostSmoke = {
        state: 'running',
        pixelsRead: false,
        pixelBufferLength: 0,
        pixelsWritten: false,
        cleanupComplete: false
      };
      (async () => {
        const bytes = new Uint8Array(8 * 8 * 4);
        for (let offset = 0; offset < bytes.length; offset += 4) {
          bytes[offset] = 45;
          bytes[offset + 1] = 190;
          bytes[offset + 2] = 255;
          bytes[offset + 3] = 255;
        }
        const imageData = await ps.imaging.createImageDataFromBuffer(bytes, {
          width: 8,
          height: 8,
          components: 4,
          chunky: true,
          colorSpace: 'RGB',
          colorProfile: 'sRGB IEC61966-2.1'
        });
        globalThis.__huanmengHostSmoke.imageDataCreated = !!imageData;
        await ps.core.executeAsModal(async () => {
          let layer = null;
          let capturedImageData = null;
          try {
            const doc = ps.app.activeDocument;
            const capture = await ps.imaging.getPixels({
              documentID: doc.id,
              sourceBounds: { left: 0, top: 0, right: Math.min(64, doc.width), bottom: Math.min(64, doc.height) },
              targetSize: { width: 32, height: 32 },
              colorSpace: 'RGB',
              colorProfile: 'sRGB IEC61966-2.1',
              componentSize: 8,
              applyAlpha: true
            });
            capturedImageData = capture.imageData;
            const capturedBytes = await capturedImageData.getData({ chunky: true });
            globalThis.__huanmengHostSmoke.pixelsRead = !!capturedBytes;
            globalThis.__huanmengHostSmoke.pixelBufferLength = Number(capturedBytes && capturedBytes.length) || 0;
            layer = await doc.createPixelLayer({ name: '幻梦 UXP 回写自检（临时）' });
            await ps.imaging.putPixels({
              documentID: doc.id,
              layerID: layer.id,
              imageData,
              replace: true,
              targetBounds: { left: 0, top: 0 }
            });
            globalThis.__huanmengHostSmoke.pixelsWritten = true;
          } finally {
            if (capturedImageData) capturedImageData.dispose();
            imageData.dispose();
            if (layer) {
              await layer.delete();
              globalThis.__huanmengHostSmoke.cleanupComplete = true;
            }
          }
        }, { commandName: '幻梦 AI UXP 回写自检' });
        globalThis.__huanmengHostSmoke.state = 'completed';
      })().catch((error) => {
        globalThis.__huanmengHostSmoke.state = 'failed';
        globalThis.__huanmengHostSmoke.error = error && error.message ? error.message : String(error);
      });
      return 'started';
    })()`);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await wait(300);
      const pollDebug = await service.request(service.client.id, {
        command: "Plugin",
        action: "debug",
        pluginSessionId: load.pluginSessionId,
      });
      const value = await evaluateCdt(pollDebug.wsdebugUrl, `JSON.stringify(globalThis.__huanmengHostSmoke || null)`);
      hostSmoke = value ? JSON.parse(value) : null;
      if (hostSmoke && hostSmoke.state !== 'running') break;
    }

    if (hostSmoke && hostSmoke.state === 'completed') {
      const previewDebug = await service.request(service.client.id, {
        command: "Plugin",
        action: "debug",
        pluginSessionId: load.pluginSessionId,
      });
      await evaluateCdt(previewDebug.wsdebugUrl, `(() => {
        globalThis.__huanmengGlowPreviewSmoke = { state: 'running' };
        (async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const toolboxTab = document.querySelector('.tab[data-tab="toolbox"]');
          if (toolboxTab) toolboxTab.click();
          await wait(150);
          const openButton = document.getElementById('btnToolGlowEditor');
          if (openButton) openButton.click();
          await wait(150);
          const readButton = document.getElementById('btnToolReadImage');
          if (readButton) readButton.click();
          let canvas = null;
          let empty = null;
          for (let attempt = 0; attempt < 30; attempt += 1) {
            await wait(300);
            canvas = document.getElementById('glowPreviewImage');
            empty = document.querySelector('#toolEditorContent .tt-live-preview-empty');
            if (canvas && canvas.style.display === 'block' && canvas.src) break;
            if (empty && /失败|未加载|无法/.test(String(empty.textContent || ''))) break;
          }
          await wait(200);
          const allSingleSelects = Array.from(document.querySelectorAll('select')).filter((select) => !select.multiple);
          const unwrappedSelects = allSingleSelects.filter((select) => !select.closest('.custom-select'));
          const glowStyleSelect = document.getElementById('glowStyleSel');
          const glowStyleWrapper = glowStyleSelect && glowStyleSelect.closest('.custom-select');
          const glowStyleRow = glowStyleSelect && glowStyleSelect.closest('.tt-control-row');
          const glowStyleWrapperRect = glowStyleWrapper && glowStyleWrapper.getBoundingClientRect ? glowStyleWrapper.getBoundingClientRect() : null;
          const glowStyleRowRect = glowStyleRow && glowStyleRow.getBoundingClientRect ? glowStyleRow.getBoundingClientRect() : null;
          const zoomOut = document.getElementById('btnGlowZoomOut');
          const zoomReset = document.getElementById('btnGlowZoomReset');
          const zoomIn = document.getElementById('btnGlowZoomIn');
          const zoomToolbar = document.querySelector('.tt-preview-zoom-controls');
          const defaultViewport = document.getElementById('glowPreviewViewport');
          const defaultImageRect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
          const defaultViewportRect = defaultViewport && defaultViewport.getBoundingClientRect ? defaultViewport.getBoundingClientRect() : null;
          const defaultPreviewSideGap = defaultImageRect && defaultViewportRect
            ? Math.round((defaultViewportRect.width - defaultImageRect.width) * 100) / 100
            : null;
          const glowSliders = Array.from(document.querySelectorAll('#glowControls [data-glow-slider-for]'));
          const glowRangeInputs = Array.from(document.querySelectorAll('#glowControls input[type="range"]'));
          const glowNumberInputs = Array.from(document.querySelectorAll('#glowControls input[type="number"]'));
          const strengthInput = document.getElementById('toolGlowStrength');
          const strengthFill = document.querySelector('[data-glow-slider-for="toolGlowStrength"] .tt-glow-slider-fill');
          if (strengthInput) {
            strengthInput.value = '60';
            strengthInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const strengthOutputAfterChange = String((document.getElementById('toolGlowStrengthOut') || {}).textContent || '');
          const strengthFillAfterChange = strengthFill ? String(strengthFill.style.width || '') : '';
          const colorSwatches = Array.from(document.querySelectorAll('#toolGlowColorPresets .tt-glow-color-swatch'));
          const colorSwatchHandlerReady = !!colorSwatches[2] && typeof colorSwatches[2].onclick === 'function';
          const colorSwatchThirdValue = colorSwatches[2] ? String(colorSwatches[2].getAttribute('data-glow-color') || '') : '';
          if (colorSwatches[2]) colorSwatches[2].click();
          let colorValueAfterClick = String((document.getElementById('toolGlowColor') || {}).value || '');
          let colorNameAfterClick = String((document.getElementById('toolGlowColorOut') || {}).textContent || '');
          if (colorValueAfterClick !== '#8ad8ff' && colorSwatchHandlerReady) {
            colorSwatches[2].onclick();
            colorValueAfterClick = String((document.getElementById('toolGlowColor') || {}).value || '');
            colorNameAfterClick = String((document.getElementById('toolGlowColorOut') || {}).textContent || '');
          }
          if (colorSwatches[0]) colorSwatches[0].click();
          if (strengthInput) {
            strengthInput.value = '40';
            strengthInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const widthBeforeZoom = canvas ? parseFloat(canvas.style.width || '0') : 0;
          if (zoomIn) zoomIn.click();
          await wait(80);
          const widthAfterZoom = canvas ? parseFloat(canvas.style.width || '0') : 0;
          const zoomLabelAfterIn = zoomReset ? String(zoomReset.textContent || '') : '';
          if (zoomReset) zoomReset.click();
          const viewport = document.getElementById('glowPreviewViewport');
          const glowControls = document.getElementById('glowControls');
          const imageRect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
          const viewportRect = viewport && viewport.getBoundingClientRect ? viewport.getBoundingClientRect() : null;
          const controlsRect = glowControls && glowControls.getBoundingClientRect ? glowControls.getBoundingClientRect() : null;
          const centered = !!imageRect && !!viewportRect &&
            Math.abs((imageRect.left + imageRect.right) / 2 - (viewportRect.left + viewportRect.right) / 2) <= 3 &&
            Math.abs((imageRect.top + imageRect.bottom) / 2 - (viewportRect.top + viewportRect.bottom) / 2) <= 3;
          globalThis.__huanmengGlowPreviewSmoke = {
            state: 'completed',
            editorOpened: !!document.getElementById('glowControls'),
            readButtonReady: !!readButton && readButton.disabled === false,
            canvasVisible: !!canvas && canvas.style.display === 'block',
            width: canvas ? (canvas.clientWidth || parseFloat(canvas.style.width || '0') || 0) : 0,
            height: canvas ? (canvas.clientHeight || parseFloat(canvas.style.height || '0') || 0) : 0,
            zoomControlsReady: !!zoomOut && !!zoomReset && !!zoomIn,
            zoomInHandlerReady: !!zoomIn && typeof zoomIn.onclick === 'function',
            glowSliderCount: glowSliders.length,
            selectCount: allSingleSelects.length,
            unwrappedSelectCount: unwrappedSelects.length,
            glowStylePreRendered: !!glowStyleWrapper,
            glowStyleRightGap: glowStyleWrapperRect && glowStyleRowRect ? Math.round((glowStyleRowRect.right - glowStyleWrapperRect.right) * 100) / 100 : null,
            glowRangeInputCount: glowRangeInputs.length,
            glowNumberInputCount: glowNumberInputs.length,
            strengthOutputAfterChange,
            strengthFillAfterChange,
            colorSwatchCount: colorSwatches.length,
            colorSwatchHandlerReady,
            colorSwatchThirdValue,
            colorValueAfterClick,
            colorNameAfterClick,
            zoomToolbarHeight: zoomToolbar ? zoomToolbar.getBoundingClientRect().height : 0,
            zoomToolbarRadius: zoomToolbar && typeof getComputedStyle === 'function' ? getComputedStyle(zoomToolbar).borderRadius : '',
            zoomInEnlarged: widthAfterZoom > widthBeforeZoom,
            zoomLabelAfterIn,
            centered,
            defaultPreviewSideGap,
            previewSideGap: imageRect && viewportRect ? Math.round((viewportRect.width - imageRect.width) * 100) / 100 : null,
            controlsWidthRatio: controlsRect && viewportRect && viewportRect.width ? Math.round(controlsRect.width / viewportRect.width * 100) / 100 : null,
            message: empty ? String(empty.textContent || '') : ''
          };
        })().catch((error) => {
          globalThis.__huanmengGlowPreviewSmoke = {
            state: 'failed',
            error: error && error.message ? error.message : String(error)
          };
        });
        return 'started';
      })()`);
      for (let attempt = 0; attempt < 35; attempt += 1) {
        await wait(300);
        const pollDebug = await service.request(service.client.id, {
          command: "Plugin",
          action: "debug",
          pluginSessionId: load.pluginSessionId,
        });
        const value = await evaluateCdt(pollDebug.wsdebugUrl, `JSON.stringify(globalThis.__huanmengGlowPreviewSmoke || null)`);
        glowPreviewSmoke = value ? JSON.parse(value) : null;
        if (glowPreviewSmoke && glowPreviewSmoke.state !== 'running') break;
      }

      if (glowPreviewSmoke && glowPreviewSmoke.canvasVisible) {
        const placementDebug = await service.request(service.client.id, {
          command: "Plugin",
          action: "debug",
          pluginSessionId: load.pluginSessionId,
        });
        await evaluateCdt(placementDebug.wsdebugUrl, `(() => {
          const ps = require('photoshop');
          const numberOf = (value) => Number(value && typeof value === 'object' ? (value._value ?? value.value) : value);
          globalThis.__huanmengGlowPlacementSmoke = { state: 'running' };
          (async () => {
            const doc = ps.app.activeDocument;
            const beforeIds = new Set(Array.from(doc.layers || []).map((layer) => Number(layer.id)));
            const selection = doc.selection && doc.selection.bounds;
            const expected = selection ? {
              left: numberOf(selection.left),
              top: numberOf(selection.top),
              right: numberOf(selection.right),
              bottom: numberOf(selection.bottom)
            } : { left: 0, top: 0, right: numberOf(doc.width), bottom: numberOf(doc.height) };
            let created = null;
            try {
              const applyButton = document.getElementById('btnToolGlow');
              if (!applyButton || typeof applyButton.onclick !== 'function') throw new Error('辉光应用按钮未绑定');
              await applyButton.onclick();
              created = Array.from(doc.layers || []).find((layer) => !beforeIds.has(Number(layer.id))) || null;
              if (!created) throw new Error('没有创建辉光图层');
              const descriptors = await ps.action.batchPlay([{
                _obj: 'get',
                _target: [{ _property: 'bounds' }, { _ref: 'layer', _id: Number(created.id) }]
              }, {
                _obj: 'get',
                _target: [{ _property: 'mode' }, { _ref: 'layer', _id: Number(created.id) }]
              }], { synchronousExecution: true });
              const rawBounds = descriptors && descriptors[0] && descriptors[0].bounds;
              const rawMode = descriptors && descriptors[1] && descriptors[1].mode;
              const actual = rawBounds ? {
                left: numberOf(rawBounds.left),
                top: numberOf(rawBounds.top),
                right: numberOf(rawBounds.right),
                bottom: numberOf(rawBounds.bottom)
              } : null;
              const aligned = !!actual && ['left', 'top', 'right', 'bottom'].every((key) => Math.abs(actual[key] - expected[key]) <= 1);
              globalThis.__huanmengGlowPlacementSmoke = {
                state: 'completed',
                layerCreated: true,
                aligned,
                expected,
                actual,
                blendMode: String(rawMode && typeof rawMode === 'object' ? (rawMode._value || rawMode.value || '') : (rawMode || created.blendMode || ''))
              };
            } catch (error) {
              globalThis.__huanmengGlowPlacementSmoke = {
                state: 'failed',
                error: error && error.message ? error.message : String(error)
              };
            } finally {
              if (created) {
                try {
                  await ps.core.executeAsModal(async () => { await created.delete(); }, { commandName: '清理辉光定位测试图层' });
                  globalThis.__huanmengGlowPlacementSmoke.cleanupComplete = true;
                } catch (cleanupError) {
                  globalThis.__huanmengGlowPlacementSmoke.cleanupError = cleanupError && cleanupError.message ? cleanupError.message : String(cleanupError);
                }
              }
            }
          })();
          return 'started';
        })()`);
        await wait(1000);
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const pollDebug = await service.request(service.client.id, {
            command: "Plugin",
            action: "debug",
            pluginSessionId: load.pluginSessionId,
          });
          const value = await evaluateCdt(pollDebug.wsdebugUrl, `JSON.stringify(globalThis.__huanmengGlowPlacementSmoke || null)`, 60000);
          glowPlacementSmoke = value ? JSON.parse(value) : null;
          if (glowPlacementSmoke && glowPlacementSmoke.state !== 'running') break;
          await wait(500);
        }
      }
    }

    const spaceDebug = await service.request(service.client.id, {
      command: "Plugin",
      action: "debug",
      pluginSessionId: load.pluginSessionId,
    });
    await evaluateCdt(spaceDebug.wsdebugUrl, `(() => {
      const ps = require('photoshop');
      const numberOf = (value) => Number(value && typeof value === 'object' ? (value._value ?? value.value) : value);
      globalThis.__huanmengSpaceFxSmoke = { state: 'running' };
      (async () => {
        const doc = ps.app.activeDocument;
        const expected = { left: 37, top: 53, right: 133, bottom: 181 };
        let created = null;
        try {
          await ps.core.executeAsModal(async () => {
            await ps.action.batchPlay([{
              _obj: 'set',
              _target: [{ _property: 'selection', _ref: 'channel' }],
              to: {
                _obj: 'rectangle',
                left: { _unit: 'pixelsUnit', _value: expected.left },
                top: { _unit: 'pixelsUnit', _value: expected.top },
                right: { _unit: 'pixelsUnit', _value: expected.right },
                bottom: { _unit: 'pixelsUnit', _value: expected.bottom }
              }
            }], { synchronousExecution: true });
          }, { commandName: '空间特效非零选区测试' });
          document.querySelector('.tab[data-tab="toolbox"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 120));
          document.getElementById('btnToolSpaceFx')?.click();
          await new Promise((resolve) => setTimeout(resolve, 150));
          const readButton = document.getElementById('btnToolReadImage');
          if (!readButton || typeof readButton.onclick !== 'function') throw new Error('空间特效读取按钮未绑定');
          await readButton.onclick();
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const canvas = document.getElementById('spaceFxPreviewImage');
            if (canvas && canvas.style.display === 'block' && canvas.src) break;
            await new Promise((resolve) => setTimeout(resolve, 180));
          }
          const canvas = document.getElementById('spaceFxPreviewImage');
          if (!canvas || canvas.style.display !== 'block') throw new Error('空间特效实时预览未显示：' + String(document.querySelector('#toolEditorContent .tt-live-preview-empty')?.textContent || '') + ' / ' + String(document.getElementById('status')?.textContent || '无状态'));
          const rangeControls = document.querySelectorAll('#toolEditorContent [data-tool-range-for]').length;
          const presetWrapped = !!document.getElementById('spaceFxPreset')?.closest('.custom-select');
          const beforeIds = new Set(Array.from(doc.layers || []).map((layer) => Number(layer.id)));
          const applyButton = document.getElementById('btnSpaceFxApply');
          if (!applyButton || typeof applyButton.onclick !== 'function') throw new Error('空间特效应用按钮未绑定');
          await applyButton.onclick();
          created = Array.from(doc.layers || []).find((layer) => !beforeIds.has(Number(layer.id))) || null;
          if (!created) throw new Error('空间特效未创建新图层');
          const result = await ps.action.batchPlay([{
            _obj: 'get',
            _target: [{ _property: 'bounds' }, { _ref: 'layer', _id: Number(created.id) }]
          }], { synchronousExecution: true });
          const raw = result && result[0] && result[0].bounds;
          const actual = raw ? {
            left: numberOf(raw.left), top: numberOf(raw.top), right: numberOf(raw.right), bottom: numberOf(raw.bottom)
          } : null;
          const aligned = !!actual && ['left','top','right','bottom'].every((key) => Math.abs(actual[key] - expected[key]) <= 1);
          globalThis.__huanmengSpaceFxSmoke = {
            state: 'completed', previewVisible: true, presetWrapped, rangeControls,
            layerCreated: true, aligned, expected, actual
          };
        } catch (error) {
          globalThis.__huanmengSpaceFxSmoke = { state: 'failed', error: error && error.message ? error.message : String(error) };
        } finally {
          try {
            await ps.core.executeAsModal(async () => {
              if (created) await created.delete();
              await ps.action.batchPlay([{
                _obj: 'set', _target: [{ _property: 'selection', _ref: 'channel' }],
                to: { _enum: 'ordinal', _value: 'none' }
              }], { synchronousExecution: true });
            }, { commandName: '清理空间特效测试' });
            globalThis.__huanmengSpaceFxSmoke.cleanupComplete = true;
          } catch (cleanupError) {
            globalThis.__huanmengSpaceFxSmoke.cleanupError = cleanupError && cleanupError.message ? cleanupError.message : String(cleanupError);
          }
        }
      })();
      return 'started';
    })()`, 60000);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(500);
      const pollDebug = await service.request(service.client.id, {
        command: "Plugin", action: "debug", pluginSessionId: load.pluginSessionId,
      });
      const value = await evaluateCdt(pollDebug.wsdebugUrl, `JSON.stringify(globalThis.__huanmengSpaceFxSmoke || null)`, 60000);
      spaceFxSmoke = value ? JSON.parse(value) : null;
      if (spaceFxSmoke && spaceFxSmoke.state !== 'running') break;
    }

    const blendDebug = await service.request(service.client.id, {
      command: "Plugin", action: "debug", pluginSessionId: load.pluginSessionId,
    });
    await evaluateCdt(blendDebug.wsdebugUrl, `(() => {
      const ps = require('photoshop');
      const numberOf = (value) => Number(value && typeof value === 'object' ? (value._value ?? value.value) : value);
      globalThis.__huanmengBlendMatchSmoke = { state: 'running' };
      (async () => {
        const doc = ps.app.activeDocument;
        const expected = { left: 61, top: 79, right: 141, bottom: 175 };
        let sourceLayer = null;
        let resultLayer = null;
        let sourceImageData = null;
        try {
          const width = expected.right - expected.left;
          const height = expected.bottom - expected.top;
          const bytes = new Uint8Array(width * height * 4);
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            bytes[offset] = 175 + (x % 50);
            bytes[offset + 1] = 45 + (y % 70);
            bytes[offset + 2] = 70 + ((x + y) % 60);
            bytes[offset + 3] = 255;
          }
          sourceImageData = await ps.imaging.createImageDataFromBuffer(bytes, {
            width, height, components: 4, chunky: true, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1'
          });
          await ps.core.executeAsModal(async () => {
            sourceLayer = await doc.createPixelLayer({ name: '融合校色测试源（临时）' });
            await ps.imaging.putPixels({
              documentID: doc.id, layerID: sourceLayer.id, imageData: sourceImageData, replace: true,
              targetBounds: { left: expected.left, top: expected.top }
            });
          }, { commandName: '创建融合校色测试源' });
          sourceImageData.dispose();
          sourceImageData = null;
          document.querySelector('.tab[data-tab="toolbox"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 120));
          document.getElementById('btnToolColorMatch')?.click();
          for (let attempt = 0; attempt < 45; attempt += 1) {
            const canvas = document.getElementById('blendMatchPreviewImage');
            if (canvas && canvas.style.display === 'block' && canvas.src) break;
            await new Promise((resolve) => setTimeout(resolve, 180));
          }
          const canvas = document.getElementById('blendMatchPreviewImage');
          if (!canvas || canvas.style.display !== 'block') throw new Error('融合校色实时预览未显示：' + String(document.querySelector('#toolEditorContent .tt-live-preview-empty')?.textContent || '') + ' / ' + String(document.getElementById('status')?.textContent || '无状态'));
          const beforeIds = new Set(Array.from(doc.layers || []).map((layer) => Number(layer.id)));
          const applyButton = document.getElementById('btnBlendMatchApply');
          if (!applyButton || typeof applyButton.onclick !== 'function') throw new Error('融合校色应用按钮未绑定');
          await applyButton.onclick();
          resultLayer = Array.from(doc.layers || []).find((layer) => !beforeIds.has(Number(layer.id))) || null;
          if (!resultLayer) throw new Error('融合校色未创建结果图层');
          const descriptor = await ps.action.batchPlay([{
            _obj: 'get', _target: [{ _property: 'bounds' }, { _ref: 'layer', _id: Number(resultLayer.id) }]
          }], { synchronousExecution: true });
          const raw = descriptor && descriptor[0] && descriptor[0].bounds;
          const actual = raw ? {
            left: numberOf(raw.left), top: numberOf(raw.top), right: numberOf(raw.right), bottom: numberOf(raw.bottom)
          } : null;
          const aligned = !!actual && ['left','top','right','bottom'].every((key) => Math.abs(actual[key] - expected[key]) <= 1);
          globalThis.__huanmengBlendMatchSmoke = {
            state: 'completed', previewVisible: true,
            modeWrapped: !!document.getElementById('blendMatchMode')?.closest('.custom-select'),
            methodWrapped: !!document.getElementById('blendMatchMethod')?.closest('.custom-select'),
            rangeControls: document.querySelectorAll('#toolEditorContent [data-tool-range-for]').length,
            meta: String(document.getElementById('blendMatchMeta')?.textContent || ''),
            layerCreated: true, aligned, expected, actual
          };
        } catch (error) {
          globalThis.__huanmengBlendMatchSmoke = { state: 'failed', error: error && error.message ? error.message : String(error) };
        } finally {
          if (sourceImageData) sourceImageData.dispose();
          try {
            await ps.core.executeAsModal(async () => {
              if (resultLayer) await resultLayer.delete();
              if (sourceLayer) await sourceLayer.delete();
            }, { commandName: '清理融合校色测试图层' });
            globalThis.__huanmengBlendMatchSmoke.cleanupComplete = true;
          } catch (cleanupError) {
            globalThis.__huanmengBlendMatchSmoke.cleanupError = cleanupError && cleanupError.message ? cleanupError.message : String(cleanupError);
          }
        }
      })();
      return 'started';
    })()`, 60000);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await wait(500);
      const pollDebug = await service.request(service.client.id, {
        command: "Plugin", action: "debug", pluginSessionId: load.pluginSessionId,
      });
      const value = await evaluateCdt(pollDebug.wsdebugUrl, `JSON.stringify(globalThis.__huanmengBlendMatchSmoke || null)`, 60000);
      blendMatchSmoke = value ? JSON.parse(value) : null;
      if (blendMatchSmoke && blendMatchSmoke.state !== 'running') break;
    }

    const uiDebug = await service.request(service.client.id, {
      command: "Plugin", action: "debug", pluginSessionId: load.pluginSessionId,
    });
    await evaluateCdt(uiDebug.wsdebugUrl, `(() => {
      globalThis.__huanmengUiAuditSmoke = { state: 'running' };
      (async () => {
      const workspace = document.querySelector('.workspace');
      const results = [];
      const tabIds = Array.from(new Set(Array.from(document.querySelectorAll('.tab[data-tab]')).map((tab) => tab.getAttribute('data-tab'))));
      for (const tabId of tabIds) {
        const tab = document.querySelector('.tab[data-tab="' + tabId + '"]');
        if (!tab || tab.style.display === 'none') continue;
        if (typeof window.switchTab === 'function') window.switchTab(tabId);
        else tab.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        const content = document.getElementById(tabId);
        if (!content || !content.classList.contains('active')) continue;
        const workspaceRect = workspace.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const directChildren = Array.from(content.children).filter((child) => getComputedStyle(child).display !== 'none');
        const narrowChildren = directChildren.filter((child) => {
          const rect = child.getBoundingClientRect();
          return rect.width > 1 && rect.width < contentRect.width * 0.94;
        }).map((child) => ({ tag: child.tagName, id: child.id || '', className: child.className || '', width: child.getBoundingClientRect().width }));
        results.push({
          tabId,
          className: content.className,
          display: getComputedStyle(content).display,
          connected: content.isConnected,
          parentClass: content.parentElement?.className || '',
          childCount: directChildren.length,
          computedWidth: getComputedStyle(content).width,
          flexBasis: getComputedStyle(content).flexBasis,
          inlineWidth: content.style.width || '',
          contentWidth: Math.round(contentRect.width),
          workspaceWidth: Math.round(workspace.clientWidth),
          rightGap: Math.round((workspace.clientWidth - contentRect.width) * 100) / 100,
          overflowX: Math.max(0, content.scrollWidth - content.clientWidth),
          narrowChildren
        });
      }
      if (typeof window.switchTab === 'function') window.switchTab('img2img');
      else document.querySelector('.tab[data-tab="img2img"]')?.click();
      const category = document.getElementById('presetCategory');
      const wrapper = category?.closest('.custom-select');
      const trigger = wrapper?.querySelector('.custom-select-trigger');
      const panel = document.querySelector('.custom-select-panel[data-select-for="presetCategory"]');
      const card = wrapper?.closest('.module-card');
      const heightBefore = card?.getBoundingClientRect().height || 0;
      trigger?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const heightAfter = card?.getBoundingClientRect().height || 0;
      const panelStyle = panel ? getComputedStyle(panel) : null;
      const categoryOption = Array.from(panel?.querySelectorAll('.custom-select-option') || []).find((item) => {
        const index = Number(item.dataset.index);
        const option = category?.options[index];
        return option && !option.disabled && option.value;
      });
      categoryOption?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const preset = document.getElementById('promptPreset');
      const presetWrapper = preset?.closest('.custom-select');
      const presetTrigger = presetWrapper?.querySelector('.custom-select-trigger');
      const presetPanel = document.querySelector('.custom-select-panel[data-select-for="promptPreset"]');
      presetTrigger?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const presetOption = Array.from(presetPanel?.querySelectorAll('.custom-select-option') || []).find((item) => {
        const index = Number(item.dataset.index);
        const option = preset?.options[index];
        return option && !option.disabled && option.value;
      });
      const presetOptionIndex = Number(presetOption?.dataset.index || -1);
      const presetOptionValue = presetOptionIndex >= 0 ? (preset?.options[presetOptionIndex]?.value || '') : '';
      const promptBeforePreset = document.getElementById('imgPrompt')?.value || '';
      presetOption?.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const presetSelectionAudit = {
        portal: panel?.parentElement?.id === 'customSelectPortal' && presetPanel?.parentElement?.id === 'customSelectPortal',
        categoryOptions: panel?.querySelectorAll('.custom-select-option').length || 0,
        presetOptions: presetPanel?.querySelectorAll('.custom-select-option').length || 0,
        presetOptionIndex,
        presetOptionValue,
        presetPanelConnected: !!presetPanel?.isConnected,
        categoryValue: category?.value || '',
        presetValue: preset?.value || '',
        promptChanged: (document.getElementById('imgPrompt')?.value || '') !== promptBeforePreset,
        panelPosition: panelStyle?.position || '',
        panelZ: panelStyle?.zIndex || ''
      };
      trigger?.click();
      const unwrapped = Array.from(document.querySelectorAll('select')).filter((select) => !select.multiple && !select.closest('.custom-select') && !select.classList.contains('reference-native-state-select')).map((select) => select.id);

      const renderButton = document.getElementById('btnImg2Img');
      const countSelect = document.getElementById('imageCount');
      const countWrapper = countSelect?.closest('.custom-select');
      const countPanel = document.querySelector('.custom-select-panel[data-select-for="imageCount"]');
      const countTrigger = countWrapper?.querySelector('.custom-select-trigger');
      const countDispatchResult = countTrigger ? countTrigger.dispatchEvent(new Event('click', { bubbles: true })) : false;
      await new Promise((resolve) => setTimeout(resolve, 60));
      const renderRowAudit = {
        renderWidth: Math.round(renderButton?.getBoundingClientRect().width || 0),
        countWidth: Math.round(countWrapper?.getBoundingClientRect().width || 0),
        countPanelPosition: countPanel ? getComputedStyle(countPanel).position : '',
        countPanelWidth: Math.round(countPanel?.getBoundingClientRect().width || 0),
        countPanelOpen: !!countPanel?.classList.contains('open'),
        countDispatchResult,
        countSelectDisabled: !!countSelect?.disabled,
        countTriggerDisabled: !!countTrigger?.disabled,
        countOptions: countPanel?.querySelectorAll('.custom-select-option').length || 0,
        countWrapperConnected: !!countWrapper?.isConnected,
        countPanelConnected: !!countPanel?.isConnected,
        liveWrapperSame: countSelect?.closest('.custom-select') === countWrapper
      };
      if (countTrigger && countPanel?.classList.contains('open')) countTrigger.dispatchEvent(new Event('click', { bubbles: true }));

      if (typeof window.switchTab === 'function') window.switchTab('apps');
      await new Promise((resolve) => setTimeout(resolve, 120));
      const quickCards = Array.from(document.querySelectorAll('#appsHome .app-launch-card')).map((item) => String(item.textContent || '').trim());
      const kaoCard = document.querySelector('#appsHome .app-launch-card[data-app-category="kao-vfx"]');
      let kaoClickError = '';
      try {
        if (kaoCard && typeof kaoCard.onclick === 'function') kaoCard.onclick({ preventDefault() {}, stopPropagation() {} });
        else kaoCard?.click();
      } catch (error) { kaoClickError = error && error.message ? error.message : String(error); }
      await new Promise((resolve) => setTimeout(resolve, 180));
      const kaoAudit = {
        card: !!kaoCard,
        bound: typeof kaoCard?.onclick === 'function',
        clickError: kaoClickError,
        editorDisplay: document.getElementById('appEditor') ? getComputedStyle(document.getElementById('appEditor')).display : '',
        bodyText: String(document.getElementById('appEditorBody')?.textContent || '').slice(0, 120),
        panel: !!document.querySelector('#appEditorBody .kao-panel'),
        effects: document.querySelectorAll('#appEditorBody input[id^="kaoFx_"]').length,
        toggles: document.querySelectorAll('#appEditorBody [data-kao-toggle]').length,
        renderedRanges: document.querySelectorAll('#appEditorBody [data-rendered-range-for]').length,
        selects: document.querySelectorAll('#appEditorBody .custom-select').length,
        generate: typeof document.getElementById('kaoStartBtn')?.onclick === 'function'
      };
      const backAfterKao = document.getElementById('btnBackToGenericAppHome');
      if (backAfterKao && typeof backAfterKao.onclick === 'function') backAfterKao.onclick(); else backAfterKao?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (typeof window.switchTab === 'function') window.switchTab('runninghub');
      await new Promise((resolve) => setTimeout(resolve, 120));
      const referenceCards = Array.from(document.querySelectorAll('#runninghubHome .app-launch-card')).map((item) => item.getAttribute('data-app-category'));
      const cameraCard = document.querySelector('#runninghubHome .app-launch-card[data-app-category="camera-ui"]');
      if (cameraCard && typeof cameraCard.onclick === 'function') cameraCard.onclick({ preventDefault() {}, stopPropagation() {} }); else cameraCard?.click();
      await new Promise((resolve) => setTimeout(resolve, 160));
      const cameraAudit = {
        panel: !!document.querySelector('#appEditorBody .cam3d-panel'),
        canvas: !!document.getElementById('camCanvas'),
        canvasHeight: Math.round(document.getElementById('camCanvas')?.getBoundingClientRect().height || 0),
        sliders: document.querySelectorAll('#appEditorBody .cam3d-slider').length,
        renderedRanges: document.querySelectorAll('#appEditorBody [data-rendered-range-for]').length,
        zoom: !!document.getElementById('camZoomSlider'),
        generate: typeof document.getElementById('btnCamGenerate')?.onclick === 'function'
      };
      const backAfterCamera = document.getElementById('btnBackToGenericAppHome');
      if (backAfterCamera && typeof backAfterCamera.onclick === 'function') backAfterCamera.onclick(); else backAfterCamera?.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const hemiCard = document.querySelector('#runninghubHome .app-launch-card[data-app-category="hemisynth-ui"]');
      if (hemiCard && typeof hemiCard.onclick === 'function') hemiCard.onclick({ preventDefault() {}, stopPropagation() {} }); else hemiCard?.click();
      await new Promise((resolve) => setTimeout(resolve, 160));
      const hemiAudit = {
        panel: !!document.querySelector('#appEditorBody .hemisynth-panel'),
        tabs: document.querySelectorAll('#hsTabs [data-tab]').length,
        fields: document.querySelectorAll('#appEditorBody .hs-field').length,
        renderedRanges: document.querySelectorAll('#appEditorBody [data-rendered-range-for]').length,
        promptTemplates: Object.keys(window._hemisynthPrompts || {}).sort(),
        generate: typeof document.getElementById('hsStartBtn')?.onclick === 'function'
      };
      const backAfterHemi = document.getElementById('btnBackToGenericAppHome');
      if (backAfterHemi && typeof backAfterHemi.onclick === 'function') backAfterHemi.onclick(); else backAfterHemi?.click();

      if (typeof window.switchTab === 'function') window.switchTab('generationCenter');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const generationCenterAudit = {
        active: document.getElementById('generationCenter')?.classList.contains('active'),
        chat: !!document.getElementById('chatHistory') && !!document.getElementById('chatPrompt'),
        tasks: !!document.getElementById('taskCenterList') && !!document.getElementById('taskRunningBadge')
      };

      if (typeof window.switchTab === 'function') window.switchTab('toolbox');
      await new Promise((resolve) => setTimeout(resolve, 100));
      document.getElementById('btnToolScope')?.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      const scopeAudit = {
        canvases: document.querySelectorAll('#toolEditorContent [data-scope]').length,
        controls: document.querySelectorAll('#toolEditorContent .scope-btng-btn, #toolEditorContent .scope-tbtn').length,
        refreshBound: typeof document.getElementById('btnScopeRefresh')?.onclick === 'function',
        info: String(document.getElementById('scopeInfo')?.textContent || '')
      };
      if (typeof window.switchTab === 'function') window.switchTab('img2img');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const promptForPreset = document.getElementById('imgPrompt');
      if (promptForPreset) promptForPreset.value = 'UXP preset dialog smoke';
      document.getElementById('btnSavePreset')?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const presetDialogAudit = {
        overlay: !!document.querySelector('.preset-save-overlay'),
        name: !!document.getElementById('presetSaveName'),
        category: !!document.getElementById('presetSaveCat'),
        subCategory: !!document.getElementById('presetSaveSubCat'),
        promptSummary: String(document.querySelector('.preset-save-summary')?.textContent || '')
      };
      document.getElementById('presetSaveCancel')?.click();
      if (typeof window.switchTab === 'function') window.switchTab('settings');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const cloudAudit = {
        syncCard: !!document.getElementById('promptSyncServerCard'),
        syncButtonBound: typeof document.getElementById('btnSyncServerPresets')?.onclick === 'function',
        syncStatus: String(document.getElementById('promptSyncStatus')?.textContent || ''),
        presetBase: document.getElementById('promptSyncBaseUrl')?.value || '',
        sub2apiTitle: String(document.querySelector('#settings [data-group="sub2api"] .settings-group-toggle')?.textContent || '')
      };
      const syncInputStyle = document.getElementById('promptSyncBaseUrl') ? getComputedStyle(document.getElementById('promptSyncBaseUrl')) : null;
      cloudAudit.syncInput = syncInputStyle ? {
        background: syncInputStyle.backgroundColor,
        border: syncInputStyle.borderColor,
        color: syncInputStyle.color,
        height: syncInputStyle.height
      } : null;
      globalThis.__huanmengUiAuditSmoke = {
        state: 'completed',
        tabResults: results,
        // 18px 为 Photoshop UXP 固定滚动槽；只把额外空白和真实横向溢出判为失败。
        tabsWithGap: results.filter((item) => item.rightGap > 20 || item.rightGap < 0 || item.overflowX > 8 || item.narrowChildren.length > 0),
        unwrapped,
        renderedRangeCount: document.querySelectorAll('[data-rendered-range-for], [data-glow-slider-for], [data-tool-range-for], [data-slider-for]').length,
        visibleNativeRanges: Array.from(document.querySelectorAll('input[type="range"]')).filter((input) => getComputedStyle(input).display !== 'none').map((input) => input.id),
        dropdownAbsolute: panelStyle?.position === 'absolute',
        dropdownOpaque: !!panelStyle && !/rgba\\([^)]*,\\s*0(?:\\.0+)?\\)/.test(panelStyle.backgroundColor),
        dropdownZ: panelStyle?.zIndex || '',
        dropdownDoesNotReflow: Math.abs(heightAfter - heightBefore) <= 1,
        presetSelectionAudit,
        triggerBackground: trigger ? getComputedStyle(trigger).backgroundImage : '',
        triggerBackgroundColor: trigger ? getComputedStyle(trigger).backgroundColor : '',
        renderRowAudit,
        quickCards,
        kaoAudit,
        referenceCards,
        cameraAudit,
        hemiAudit,
        generationCenterAudit,
        scopeAudit,
        presetDialogAudit,
        cloudAudit
      };
      })().catch((error) => {
        globalThis.__huanmengUiAuditSmoke = { state: 'failed', error: error && error.message ? error.message : String(error) };
      });
      return 'started';
    })()`, 60000);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(200);
      const uiPollDebug = await service.request(service.client.id, {
        command: "Plugin", action: "debug", pluginSessionId: load.pluginSessionId,
      });
      const uiValue = await evaluateCdt(uiPollDebug.wsdebugUrl, `JSON.stringify(globalThis.__huanmengUiAuditSmoke || null)`, 30000);
      uiAuditSmoke = uiValue ? JSON.parse(uiValue) : null;
      if (uiAuditSmoke && uiAuditSmoke.state !== 'running') break;
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    pluginLoaded: true,
    panelContext: !!runtime,
    runtime,
    hostSmoke,
    glowPreviewSmoke,
    glowPlacementSmoke,
    spaceFxSmoke,
    blendMatchSmoke,
    uiAuditSmoke,
    note: runtime ? undefined : `面板未展开，跳过像素写入：${lastRuntimeError?.message || '无运行上下文'}`
  })}\n`);
} finally {
  if (loadedSessionId) {
    try {
      await service.request(service.client.id, {
        command: "Plugin", action: "unload", pluginSessionId: loadedSessionId,
      }, 10000);
    } catch (_) {
      // 调试宿主退出或主动关闭面板时无需让清理错误覆盖真实测试结果。
    }
  }
  service.socket.close();
}
