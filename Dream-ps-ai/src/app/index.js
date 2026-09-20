// ============================================================
// index.js — 幻梦AI UXP 面板应用入口
//
// 职责：启动界面、编排生成任务、连接 Provider，并调度 Photoshop 回填能力。
// 输入：用户界面事件、插件设置、选区图像与供应商响应。
// 输出：界面状态、任务/记录持久化，以及 Photoshop 文档修改。
// 边界：复杂颜色算法放在 feature 模块；版本化提示词放在 assets，不在此文件内维护。
// ============================================================

(function() {
    const DEBUG_STORAGE_KEY = 'huanmeng_debug';
    let debugEnabled = false;

    try {
        debugEnabled = localStorage.getItem(DEBUG_STORAGE_KEY) === '1';
    } catch (e) {
        debugEnabled = false;
    }

    window.setGeminiAiDebug = function(enabled) {
        debugEnabled = !!enabled;
        try {
            localStorage.setItem(DEBUG_STORAGE_KEY, debugEnabled ? '1' : '0');
        } catch (e) {
            // ignore storage errors
        }
    };

    function isDebugEnabled() {
        return debugEnabled;
    }

    function debugLog() {
        if (!isDebugEnabled()) return;
        console.info.apply(console, arguments);
    }

    // UXP 会把未处理的 Promise 拒绝升级为 “Error while executing Task Queue Item”
    // 系统弹窗。统一接住事件并显示在插件状态栏，避免一次接口/界面错误反复弹窗。
    window.addEventListener('unhandledrejection', function(event) {
        const reason = event && event.reason;
        const message = reason && reason.message ? reason.message : String(reason || '未知异步错误');
        console.error('未处理的异步错误:', reason || message);
        window.__huanmengLastError = message;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        try { showStatus('操作失败：' + message, 'error'); } catch (ignore) {}
    });
    window.addEventListener('error', function(event) {
        const message = event && event.message ? event.message : '界面脚本错误';
        window.__huanmengLastError = message;
        console.error('界面脚本错误:', event && event.error || message);
    });

    function runGuardedUiAction(action, label) {
        try {
            return Promise.resolve(typeof action === 'function' ? action() : action).catch(function(error) {
                const message = error && error.message ? error.message : String(error || '未知错误');
                console.error((label || '界面操作') + '失败:', error);
                window.__huanmengLastError = message;
                try { showStatus((label || '操作') + '失败：' + message, 'error'); } catch (ignore) {}
                return null;
            });
        } catch (error) {
            const message = error && error.message ? error.message : String(error || '未知错误');
            console.error((label || '界面操作') + '失败:', error);
            window.__huanmengLastError = message;
            try { showStatus((label || '操作') + '失败：' + message, 'error'); } catch (ignore) {}
            return Promise.resolve(null);
        }
    }

    const DEFAULT_SERVER_API_URL = "https://www.syyyy.online";
    const SERVER_API_URL = DEFAULT_SERVER_API_URL;
    const PLUGIN_VERSION = "3.1.1";
    const DEFAULT_RUNNINGHUB_POLL_INTERVAL = 3000;
    const DEFAULT_RUNNINGHUB_TIMEOUT = 30000;
    const DEFAULT_RUNNINGHUB_MAX_CONCURRENT = 1;
    const DEFAULT_AI_OPTIMIZE_APP_ID = '2012102815430221826';
    const TEXT_INPUT_SELECTOR = [
        'textarea',
        'sp-textarea',
        'input:not([type])',
        'input[type="text"]',
        'input[type="search"]',
        'input[type="url"]',
        'input[type="email"]',
        'input[type="tel"]',
        'input[type="password"]'
    ].join(',');

    function removeTextInputLengthLimit(control) {
        if (!control || typeof control.removeAttribute !== 'function') return;

        control.removeAttribute('maxlength');
        control.removeAttribute('maxLength');

        if ('maxLength' in control) {
            try {
                control.maxLength = -1;
            } catch (e) {
                control.removeAttribute('maxlength');
            }
        }
    }

    function removeAllTextInputLengthLimits(root) {
        const scope = root && root.querySelectorAll ? root : document;

        if (scope.matches && (scope.matches(TEXT_INPUT_SELECTOR) || scope.hasAttribute('maxlength'))) {
            removeTextInputLengthLimit(scope);
        }

        scope.querySelectorAll(TEXT_INPUT_SELECTOR + ', [maxlength]').forEach(removeTextInputLengthLimit);
    }

    function initTextInputLengthLimitRemoval() {
        removeAllTextInputLengthLimits(document);
        if (!document.documentElement.dataset.textInputLimitBound) {
            document.addEventListener('focusin', function(event) {
                removeAllTextInputLengthLimits(event.target);
            }, true);

            document.documentElement.dataset.textInputLimitBound = '1';
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTextInputLengthLimitRemoval, { once: true });
    }

    const DEFAULT_IMAGE_MODELS = [];

    const DEFAULT_GRS_CHAT_MODEL = "grs/gemini-3.1-pro";
    const GRS_CHAT_MODEL_DEFAULT_OPTIONS = [
        { value: "gpt-5.4", text: "gpt-5.4 (GRS)" },
        { value: "gpt-5.5", text: "gpt-5.5 (GRS)" },
        { value: "gemini-3-pro", text: "gemini-3-pro (GRS)" },
        { value: "gemini-3.1-pro", text: "gemini-3.1-pro (GRS)" },
        { value: "gemini-2.5-pro", text: "gemini-2.5-pro (GRS)" }
    ];
    const FAKE_SELECT_IDS = [
        'imgModel',
        'imgProvider',
        'imgResolution',
        'chatModel',
        'presetCategory',
        'promptPreset',
        'imageCount',
        'alignmentMode',
        'newApiImageMode',
        'vfxEffectPreset',
        'vfxMaterialPreset',
        'vfxPresetCategory',
        'vfxPromptPreset',
        'compositeImageSource',
        'compositeChatModel',
        'compositeImageModel',
        'compositeOutputSize',
        'compositeQuality',
        'compositeImageResolution',
        'compositeOutputTarget',
        'effectTransferChatModel',
        'effectTransferImageModel',
        'effectTransferResolution',
        'effectTransferStrength',
        'aiSuperresFactor',
        'toolColorMatchMethod',
        'autoColorMatchMethod'
    ];

    function shouldUseInlineFakeSelect(selectId) {
        // 全部下拉一律就地内联展开，不再使用浮层面板。
        //
        // 背景：浮层方案在这个 UXP 环境里反复失败。实测（getComputedStyle）确认
        // 面板的 position/z-index/背景/坐标全部正确——无论是挂在 body 级 portal、
        // 还是留在 .custom-select 内；无论是 position:fixed 还是 absolute；
        // 无论 z-index 是 2147482000 还是 5001；无论祖先有没有 isolation / z-index。
        // 面板仍然会被同页其它卡片盖住。UXP 的合成器在这个布局下不按全局
        // z-index 排序，浮层这条路走不通。
        //
        // 内联展开是本插件自己验证过的做法：presetCategory、promptPreset 等预设
        // 下拉一直这么实现，教程里也把「改为内联伪下拉框，展开时占用布局空间，
        // 不再盖住下面的提示词输入框」记为 2.1.1 修遮挡问题的正式方案。
        // 面板在文档流内把下方内容推开，结构上不可能被遮挡。
        return true;
    }

    const GRS_DEFAULT_BASE_URL = "https://grsaiapi.com";
    const GRS_CHINA_BASE_URL = "https://grsai.dakka.com.cn";
    const OPENAI_OFFICIAL_BASE_URL = "https://api.openai.com";
    const XAI_DEFAULT_BASE_URL = "https://api.x.ai";
    const GROK2API_DEFAULT_BASE_URL = "http://127.0.0.1:8000";
    const SUB2API_DEFAULT_BASE_URL = "http://127.0.0.1:8080";
    const NEWAPI_DEFAULT_BASE_URL = "http://127.0.0.1:3000";
    const FIREFLY_DEFAULT_BASE_URL = "http://127.0.0.1:8787";
    const VOLCENGINE_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
    const VOLCENGINE_DEFAULT_IMAGE_MODEL = "doubao-seedream-4-0-250828";
    const VOLCENGINE_DEFAULT_CHAT_MODEL = "doubao-seed-1-6-250615";
    const DEFAULT_IMAGE_MODEL = "PS_NATIVE_NANO_BANANA";
    const DEFAULT_IMAGE_RESOLUTION = "auto";
    const DEFAULT_TEXT_SYSTEM_PROMPT_POSITIVE = '准确理解用户目标，优先给出可直接执行、结构清晰且与当前图像工作流相关的回答。';
    const DEFAULT_TEXT_SYSTEM_PROMPT_NEGATIVE = '不要编造不存在的接口结果、文件状态或执行结果；不要忽略用户明确的格式、范围和安全约束。';
    const DEFAULT_IMAGE_SYSTEM_PROMPT_POSITIVE = '严格遵循用户的编辑目标；存在输入图时优先保持主体身份、姿势、构图、透视与未指定区域不变，输出单张完整成图。';
    const DEFAULT_IMAGE_SYSTEM_PROMPT_NEGATIVE = '避免身份漂移、五官和肢体畸形、无关物体、错误文字、水印、边框、拼图、构图漂移、过曝、脏污和低清晰度。';
    const LEGACY_IMAGE_DEFAULT_MODEL = "nano-banana-pro";
    const GRS_NANO_BANANA_MODELS = [
        "nano-banana-2",
        "nano-banana-2-cl",
        "nano-banana-2-4k-cl",
        "nano-banana-fast",
        "nano-banana",
        "nano-banana-pro",
        "nano-banana-pro-vt",
        "nano-banana-pro-cl",
        "nano-banana-pro-vip",
        "nano-banana-pro-4k-vip"
    ];
    const GRS_GPT_IMAGE_MODEL_ALIASES = {
        "gpt-imagine-2": "gpt-image-2"
    };
    // GRS /v1/api/generate 接口支持的 gpt-image 系列全部型号（见官方 OpenAPI）。
    const GRS_GPT_IMAGE_MODELS = [
        "gpt-image-2",
        "gpt-imagine-2",
        "gpt-image-2-vip",
        "gpt-image-2.5",
        "gpt-image-2.5-flare",
        "gpt-image-2.5-sunburst"
    ];
    // GRS 官方模型名与单次参考价。
    // 来源：https://grsai.com/zh/dashboard/models （页面自述汇率 ¥1 = 20,000 积分，
    // CNY 参考价 = 积分 / 20,000，"失败返还 / 违规返还"）。
    // 这里只是【显示文字】的映射表，键名是插件实际发给 GRS 的模型 ID，
    // 改这张表不会影响生成，改错了也只是下拉框显示不对。
    //
    // 可靠性分级：
    //   gpt-image 系列 —— 官网逐字对应，可信
    //   nano-banana    —— 官网原文明写「nano-banana 是由 gemini-3.1-flash-lite-image 封装而来」
    //   其余 nano-banana-* —— 官网只给出 gemini-3.x-image-preview 的若干价位，
    //                          没有列出可调用的模型 ID，这里按价位档位推断对应关系，
    //                          如与实际不符请直接改表。
    // nano-banana-fast / nano-banana-pro-vt 在官网找不到可对应的条目，
    // 保留原显示名、不标价格，避免给出编造的价格。
    const GRS_MODEL_DISPLAY = {
        'gpt-image-2':            { name: 'gpt-image-2',                          price: '¥0.03/次' },
        'gpt-image-2.5':          { name: 'gpt-image-2.5',                        price: '¥0.03/次' },
        'gpt-image-2.5-flare':    { name: 'gpt-image-2.5-flare',                  price: '¥0.10/次' },
        'gpt-image-2.5-sunburst': { name: 'gpt-image-2.5-sunburst',               price: '¥0.12/次' },
        'gpt-image-2-vip':        { name: 'GPT Image 2 (1K/2K/4K)',               price: '¥0.10/次' },
        'nano-banana':            { name: 'gemini-3.1-flash-lite-image',          price: '¥0.022/次' },
        'nano-banana-2':          { name: 'gemini-3.1-flash-image-preview',       price: '¥0.06/次' },
        'nano-banana-2-cl':       { name: 'gemini-3.1-flash-image-preview (1K)',  price: '¥0.30/次' },
        'nano-banana-2-4k-cl':    { name: 'gemini-3.1-flash-image-preview (4K)',  price: '¥0.65/次' },
        'nano-banana-pro':        { name: 'gemini-3-pro-image-preview',           price: '¥0.09/次' },
        'nano-banana-pro-cl':     { name: 'gemini-3-pro-image-preview (1K)',      price: '¥0.50/次' },
        'nano-banana-pro-vip':    { name: 'gemini-3-pro-image-preview (1K/2K)',   price: '¥0.50/次' },
        'nano-banana-pro-4k-vip': { name: 'gemini-3-pro-image-preview (4K)',      price: '¥0.90/次' }
    };
    const GRS_IMAGE_MODEL_DEFAULT_OPTIONS = [
        { value: "nano-banana-fast", text: "nano-banana-fast (GRS Nano Banana)" },
        { value: "nano-banana", text: "nano-banana (GRS Nano Banana)" },
        { value: "nano-banana-2", text: "nano-banana-2 (GRS Nano Banana)" },
        { value: "nano-banana-2-cl", text: "nano-banana-2-cl (GRS Nano Banana)" },
        { value: "nano-banana-2-4k-cl", text: "nano-banana-2-4k-cl (GRS Nano Banana 4K)" },
        { value: "nano-banana-pro", text: "nano-banana-pro (GRS Nano Banana Pro)" },
        { value: "nano-banana-pro-vt", text: "nano-banana-pro-vt (GRS Nano Banana Pro)" },
        { value: "nano-banana-pro-cl", text: "nano-banana-pro-cl (GRS Nano Banana Pro)" },
        { value: "nano-banana-pro-vip", text: "nano-banana-pro-vip (GRS Nano Banana VIP)" },
        { value: "nano-banana-pro-4k-vip", text: "nano-banana-pro-4k-vip (GRS Nano Banana 4K VIP)" },
        { value: "gpt-image-2", text: "gpt-image-2 / GPT-imagine-2 (GRS 图生图优化)" },
        { value: "gpt-image-2-vip", text: "gpt-image-2-vip (GRS 图生图优化 VIP)" },
        { value: "gpt-image-2.5", text: "gpt-image-2.5 (GRS 图生图优化)" },
        { value: "gpt-image-2.5-flare", text: "gpt-image-2.5-flare (GRS VIP 像素级)" },
        { value: "gpt-image-2.5-sunburst", text: "gpt-image-2.5-sunburst (GRS VIP 像素级)" }
    ];
    const XAI_IMAGE_MODEL_DEFAULT_OPTIONS = [
        { value: "xai/grok-imagine-image-quality", text: "Grok Imagine Quality (xAI 高质量)" },
        { value: "xai/grok-imagine-image", text: "Grok Imagine (xAI 快速)" }
    ];
    // 注意：这里只能列 grok2api 内置目录里真实存在的模型名。
    // 曾经有个 "grok-imagine-image-quality-lite"，是 "-quality" 和 "-lite" 拼出来的
    // 名字，Console 和 Web 两个目录里都没有，选中即请求失败。
    // grok-imagine-image-2.0 在 Console 与 Web 目录中都存在，xAI 官方也有对应模型页。
    const GROK2API_IMAGE_MODEL_DEFAULT_OPTIONS = [
        { value: "grok2api/grok-imagine-image-2.0", text: "Grok Imagine 2.0 (grok2api)" },
        { value: "grok2api/grok-imagine-image-quality", text: "Grok Imagine Quality (grok2api · Console)" },
        { value: "grok2api/grok-imagine-image", text: "Grok Imagine (grok2api · Console)" },
        { value: "grok2api/grok-imagine-image-lite", text: "Grok Imagine Lite (grok2api · Web)" }
    ];
    const SUB2API_IMAGE_MODEL_DEFAULT_OPTIONS = [
        { value: "sub2api/grok-imagine-image-quality", text: "Grok Imagine Quality (Sub2API)" },
        { value: "sub2api/grok-imagine-image", text: "Grok Imagine Image (Sub2API)" },
        { value: "sub2api/grok-imagine", text: "Grok Imagine (Sub2API)" }
    ];
    const FIREFLY_IMAGE_MODEL_DEFAULT_OPTIONS = [
        { value: "firefly/google:firefly:colligo:gemini-flash", text: "Gemini 3 Nano Banana Pro (Firefly)" },
        { value: "firefly/gemini-3-nano-banana-pro", text: "Gemini 3 Nano Banana Pro 别名 (Firefly)" },
        { value: "firefly/gpt-image-2", text: "GPT Image 2 (Firefly)" },
        { value: "firefly/gpt-image-1.5", text: "GPT Image 1.5 (Firefly)" },
        { value: "firefly/flux-2-pro", text: "FLUX 2 Pro (Firefly)" }
    ];

    // 全局变量
    let selectedImageBase64 = null;
    let referenceImages = [];
    const MAX_REFERENCE_IMAGES = 4;
    let referenceInputMode = 'single';
    let currentSettings = null;
    let chatHistory = [];
    let savedSelectionBounds = null;
    let savedDocumentId = null;
    let skipAutoColorMatchOnce = false;
    // 正在进行中的生成任务：taskId → { taskId, abortController, placement }
    //
    // 这三个值以前是下面的样子，是**模块级单例**：
    //     let currentGenerationTask / currentGenerationAbortController / activeGenerationTaskId
    // 于是天然只能跑一个任务（再点渲染就取消上一个）。改成并发之后
    // 必须一个任务一份，否则第二个任务会覆盖第一个的：
    //   · placement（选区快照）→ 结果贴到错误的位置
    //   · abortController     → 第一个任务中途被报「已取消」
    // 用 Map 按 taskId 索引，任务中心的取消按钮才找得到该取消哪一个。
    const generationContexts = new Map();

    function createGenerationContext(taskId) {
        const ctx = {
            taskId: taskId,
            abortController: new AbortController(),
        };
        generationContexts.set(taskId, ctx);
        return ctx;
    }

    function releaseGenerationContext(ctx) {
        if (ctx && ctx.taskId) generationContexts.delete(ctx.taskId);
    }

    function abortGenerationTask(taskId) {
        const ctx = generationContexts.get(taskId);
        if (ctx) ctx.abortController.abort();
    }
    let taskEntries = [];
    let pendingReturnCache = Object.create(null);
    let scopeRefreshTimer = null;
    let scopeLastDataUrl = '';
    const scopeOptions = { quality: 360, range: 'full', vecGain: 1, histScale: 'log', showR: true, showG: true, showB: true, skin: true, targets: true };
    let activeToolEditor = '';
    let toolEditorReturnTab = 'toolbox';
    let toolPreviewRenderVersion = 0;
    let glowPreviewRenderVersion = 0;
    let glowPreviewDrawVersion = 0;
    let glowPreviewSourceImageData = null;
    let glowPreviewZoom = 1;
    let blendMatchPreviewSources = null;
    let batchTasks = [];
    let currentRefreshAbortController = null;
    let lastChatInput = '';
    let currentAllPresets = [];
    let currentNewApiChatModels = [];
    let currentVfxConfig = null;
    let currentAppCategory = '';
    let appsViewMode = 'home';
    let appsReturnTab = 'apps';
    let appEditorMeta = null;
    let runninghubApps = [];
    let currentRunninghubFieldValues = {};
    let runninghubAppSearchQuery = '';
    let pendingRunninghubParsedApp = null;
    let imageModelOptionCatalog = [];
    const BLANK_RUNNINGHUB_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2fJ0QAAAAASUVORK5CYII=';
    const COMPOSITE_ASSISTANT_PASS_TYPES = [
        { id: 'depth', title: '深度图', desc: '黑白距离关系，用于景深、雾效和空间遮罩。' },
        { id: 'normal', title: '法线图', desc: 'RGB 表面朝向，用于重新打光和材质合成。' },
        { id: 'segmentation', title: '分割图', desc: '按主体、背景、材质区域生成彩色分区。' },
        { id: 'fogMask', title: '雾效遮罩', desc: '空气透视和远近雾化控制图。' },
        { id: 'reflection', title: '高光/反射辅助图', desc: '提取可用于镜面、金属和反光增强的区域。' },
        { id: 'edge', title: '边缘线稿', desc: '干净轮廓线与结构边缘，用于特效贴合。' }
    ];
    const COMPOSITE_ASSISTANT_PASS_PROMPTS = {
        depth: 'Generate a clean grayscale depth map from the input image. Near objects are bright, far objects are dark, with smooth spatial gradients and crisp silhouettes. Preserve the exact composition, subject structure, pose, camera, crop, and object layout. No text, no labels, no new objects.',
        normal: 'Generate a clean RGB normal map from the input image. Encode surface direction with stable red, green, and blue gradients. Preserve the exact composition, subject structure, pose, camera, crop, and object layout. No texture noise, no labels, no text, no new objects.',
        segmentation: 'Generate a flat-color semantic segmentation map from the input image. Separate subject, hair, skin, clothing, props, foreground, background, sky, ground, and major materials with distinct clean colors. Preserve the exact composition and all object boundaries. No shading, no gradients, no labels, no text.',
        fogMask: 'Generate a grayscale atmospheric fog mask from the input image. White means stronger fog or distant atmospheric haze, black means clear foreground. Preserve the exact composition, silhouettes, subject structure, and scene layout. No text, no labels, no added objects.',
        reflection: 'Generate a grayscale highlight and reflection helper map from the input image. White marks glossy, metallic, wet, glass, mirror, and specular highlight regions; black marks matte areas. Preserve the exact composition, subject structure, and object layout. No text, no labels, no new objects.',
        edge: 'Generate a clean black-and-white edge line-art map from the input image. Keep important contours, hard edges, facial and subject outlines, clothing borders, props, and object separation lines. Preserve the exact composition and structure. White background, black lines, no shading, no text.',
        luminance: 'Generate a clean grayscale luminance map from the input image based on perceived brightness. Preserve the exact composition, subject structure, and tonal hierarchy. No stylization, no text, no labels, no new objects.',
        negative: 'Do not change composition, camera, crop, identity, pose, anatomy, clothing, object layout, or subject structure. Do not add text, labels, logos, watermarks, new objects, new people, random symbols, painterly style, blur, noise, or distorted anatomy.'
    };
    const EFFECT_TRANSFER_ANALYZE_PROMPT = [
        'Analyze only the effect-source image for transferable visual effects.',
        'Describe its color palette, material quality, edge behavior, glow, light direction, particles, smoke, distortion, lens language, depth layering, and compositing rules.',
        'Write a concise image-generation prompt for transferring only the effect, material, lighting, and atmosphere onto a separate original image.',
        'The original image must keep its subject, identity, composition, pose, camera angle, and object layout unchanged.',
        'Do not transfer faces, characters, objects, text, logos, watermarks, or composition from the effect-source image.'
    ].join('\n');
    const EFFECT_TRANSFER_DIRECT_PROMPT = [
        'Use the first/original image as the only source for subject, identity, pose, camera, composition, crop, object layout, and structure.',
        'Use the second/effect reference image only for visual effect style: color, material, glow, particles, smoke, light behavior, edge treatment, atmosphere, and cinematic lens feel.',
        'Transfer the effect naturally onto the original image with realistic occlusion, reflections, shadows, and light interaction.',
        'Do not replace the subject, do not change the face, do not change clothing or body shape, do not add text, logo, watermark, or unrelated objects.'
    ].join('\n');
    const AI_SUPER_RES_TILE_PROMPT = [
        'Perform high-quality super-resolution and detail enhancement on this tile.',
        'Increase clarity, edge quality, micro-detail stability, texture definition, and clean high-frequency detail while preserving the exact content.',
        'Do not redraw the composition, do not change identity, face, pose, clothing, object count, layout, camera, lighting direction, or crop.',
        'Do not add or remove objects. Do not invent text, logos, watermarks, or decorative symbols.',
        'Keep border details continuous and neutral so adjacent tiles can be stitched seamlessly without visible seams.'
    ].join('\n');
    const DEFAULT_COMPOSITE_ASSISTANT_STATE = {
        image: null,
        imageSource: 'canvas',
        imageUrl: '',
        selectedPasses: ['depth', 'normal', 'segmentation'],
        outputSize: 'source',
        quality: 'standard',
        preserveEdges: true,
        outputTarget: 'photoshop',
        chatModel: '',
        imageModel: '',
        imageResolution: '1K',
        imageCount: 1,
        promptStrength: 0.75,
        analysisEnabled: false,
        temperature: 0.4,
        customPromptPrefix: '',
        negativePrompt: COMPOSITE_ASSISTANT_PASS_PROMPTS.negative
    };
    let compositeAssistantState = Object.assign({}, DEFAULT_COMPOSITE_ASSISTANT_STATE, {
        selectedPasses: DEFAULT_COMPOSITE_ASSISTANT_STATE.selectedPasses.slice()
    });
    const DEFAULT_EFFECT_TRANSFER_STATE = {
        mode: 'analyze-then-generate',
        sourceImage: null,
        effectImage: null,
        chatModel: '',
        imageModel: '',
        imageResolution: '1K',
        strength: 'balanced',
        generatedPrompt: ''
    };
    let effectTransferState = Object.assign({}, DEFAULT_EFFECT_TRANSFER_STATE);
    const DEFAULT_AI_SUPER_RESOLUTION_STATE = {
        sourceImage: null,
        upscaleFactor: 2,
        tileOverlap: 128,
        tilePlan: null,
        model: 'nano-banana-2-4k-cl',
        outputGroupName: ''
    };
    let aiSuperResolutionState = Object.assign({}, DEFAULT_AI_SUPER_RESOLUTION_STATE);
    const RUNNINGHUB_IMAGE_VALUE_SOURCE_LABEL = '当前 Photoshop 选区';
    const DEFAULT_VFX_CONFIG = {
        enabled: false,
        color: '#00f0ff',
        saturation: 82,
        brightness: 100,
        effectPreset: 'energy-trail',
        effectCustomName: '',
        motionPathText: '',
        trajectoryReferenceImage: null,
        materialPreset: 'plasma',
        materialCustomName: '',
        particleText: '',
        smokeEnabled: false,
        smokeText: ''
    };
    const VFX_EFFECT_PRESETS = [
        { value: 'energy-trail', label: 'Energy Trail', uiLabel: '能量拖尾' },
        { value: 'neon-outline', label: 'Neon Outline', uiLabel: '霓虹描边' },
        { value: 'glitch-shards', label: 'Glitch Shards', uiLabel: '故障碎片' },
        { value: 'magic-circle', label: 'Magic Circle', uiLabel: '魔法阵' },
        { value: 'light-ribbon', label: 'Light Ribbon', uiLabel: '光带丝带' },
        { value: 'custom', label: 'Custom', uiLabel: '自定义' }
    ];
    const VFX_MATERIAL_PRESETS = [
        { value: 'plasma', label: 'plasma light', uiLabel: '等离子光感' },
        { value: 'glassy', label: 'glassy light', uiLabel: '玻璃质光感' },
        { value: 'electric-particles', label: 'electric particles', uiLabel: '电流粒子' },
        { value: 'liquid-fire', label: 'liquid fire', uiLabel: '液态火焰' },
        { value: 'dusty-aura', label: 'dusty aura', uiLabel: '尘雾光环' },
        { value: 'custom', label: 'Custom', uiLabel: '自定义' }
    ];
    const VFX_PROMPT_BASE_TEMPLATE = [
        'Preserve the original subject exactly.',
        'Do not change the face, identity, pose, clothing, body proportions, camera framing, or main composition.',
        '',
        'This is a cinematic VFX augmentation task applied on top of the original image,',
        'not a character redraw, not a costume redesign, and not a scene replacement.',
        '',
        'Generate visual effects around the subject with realistic spatial interaction:',
        'the effect must wrap in front of and behind the subject,',
        'create natural occlusion, lighting interaction, grounded reflection, procedural fluid turbulence, and dense volumetric depth,',
        'keep the face unobstructed and readable,',
        'avoid fully covering the subject,',
        'add strong cinematic rim light from the effect onto the character,',
        'and create natural contact haze, environment light bounce, and floor reflection where appropriate.',
        '',
        'The overall result should feel premium, cinematic, layered, intense, realistically composited, and physically grounded,',
        'like a high-end VFX poster, Unreal Engine 5 / Houdini / EmberGen / Niagara hero frame, or commercial key visual,',
        'not a cheap game effect or flat neon overlay.',
        '',
        'Avoid:',
        'face changes, extra fingers, extra limbs, extra characters, perfect circular halos, random symbols, text, logo, watermark, overexposure, muddy glow.'
    ].join('\n');
    const VFX_BUILTIN_PRESETS = [];
    let logSearchTimer = null;
    let uxpFs = null;
    let photoshopCoreModules = null;
    const CHAT_MEMORY_ROUNDS = 8;
    const customSelectRegistry = new Map();
    
    // Photoshop API对象
    let psAPI = {
        uxp: null,
        app: null,
        core: null,
        action: null,
        imaging: null,
        constants: null,
        isAvailable: false
    };
    
    // 核心：调用 PS 原生底层 AI 引擎 (Nano Banana)
    async function executeNativeAIPreset(promptText) {
        initCompatibility();
        const timestamp = new Date().toLocaleString('zh-CN');
        const model = 'PS 原生 Nano Banana Pro';
        
        // 1. 检查 PS 原生 API 是否可用
        if (!psAPI.isAvailable || !psAPI.core || !psAPI.action) {
            showStatus('Photoshop API 不可用，请检查环境！', 'error');
            Config.addLog({
                timestamp: timestamp,
                model: model,
                prompt: promptText,
                type: 'native',
                status: '失败',
                error: 'Photoshop API 不可用，请检查环境！'
            });
            return;
        }
        
        try {
            // 2. 检查用户有没有选区
            const doc = psAPI.app.activeDocument;
            if (!doc) {
                showStatus('请先打开一张图片！', 'error');
                Config.addLog({
                    timestamp: timestamp,
                    model: model,
                    prompt: promptText,
                    type: 'native',
                    status: '失败',
                    error: '请先打开一张图片！'
                });
                return;
            }
            try {
                const bounds = doc.selection.bounds;
            } catch(e) {
                showStatus('请先在画布上用选框工具画一个区域！', 'error');
                Config.addLog({
                    timestamp: timestamp,
                    model: model,
                    prompt: promptText,
                    type: 'native',
                    status: '失败',
                    error: '请先在画布上用选框工具画一个区域！'
                });
                return;
            }

            showStatus('正在调用 PS 原生 Nano Banana 引擎生成...', 'success');
            
            // 3. 执行刚才抓到的底层 batchPlay 代码
            await psAPI.core.executeAsModal(async () => {
                await psAPI.action.batchPlay(
                    [
                        {
                            _obj: "syntheticFill",
                            _target: [
                                {
                                    _ref: "document",
                                    _enum: "ordinal",
                                    _value: "targetEnum"
                                }
                            ],
                            // 替换为咱们自己的提示词变量
                            prompt: promptText,
                            serviceID: "clio",
                            workflowType: {
                                _enum: "genWorkflow",
                                _value: "in_painting"
                            },
                            serviceOptionsList: {
                                clio: {
                                    _obj: "clio",
                                    gi_PROMPT: promptText, // 这里也必须替换
                                    gi_MODE: "tinp",
                                    gi_SEED: -1,
                                    gi_NUM_STEPS: -1,
                                    gi_GUIDANCE: 6,
                                    gi_SIMILARITY: 0,
                                    gi_CROP: false,
                                    gi_DILATE: false,
                                    gi_CONTENT_PRESERVE: 0,
                                    gi_ENABLE_PROMPT_FILTER: true,
                                    dualCrop: true
                                }
                            },
                            serviceVersion: "nano_banana_2", // 我们抓到的顶配模型
                            workflow_to_active_service_identifier_map: {
                                gen_harmonize: "gen_harmonize",
                                generativeUpscale: "clio_f16_async",
                                instruct_edit: "null",
                                text_to_image: "clio3",
                                generate_similar: "clio3",
                                out_painting: "me_md",
                                generate_background: "clio3",
                                in_painting: "nano_banana_2"
                            },
                            _options: {
                                dialogOptions: "dontDisplay"
                            }
                        }
                    ],
                    {
                        synchronousExecution: false,
                        modalBehavior: "execute"
                    }
                );
            }, { commandName: "执行一键AI预设" }); // 进度条上的文案
            
            showStatus('渲染指令已发送，请等待 PS 原生进度条完成！', 'success');
            
            Config.addLog({
                timestamp: timestamp,
                model: model,
                prompt: promptText,
                type: 'native',
                status: '成功',
                message: '渲染指令已发送，请等待 PS 原生进度条完成！'
            });
            
        } catch (error) {
            console.error("执行原生生成失败:", error);
            const errorMessage = formatImageGenerationError(error && error.message, '生成出错了: ');
            showStatus(errorMessage, 'error');
            Config.addLog({
                timestamp: timestamp,
                model: model,
                prompt: promptText,
                type: 'native',
                status: '失败',
                error: errorMessage
            });
        }
    }
    
    // 兼容性状态
    let compatibility = {
        photoshopVersion: "unknown",
        isUXPAvailable: false,
        isImagingAvailable: false,
        features: {
            selection: false,
            imageProcessing: false,
            fileSystem: false
        }
    };

    // 先定义UI函数，避免在catch块中调用时未定义
    function showStatus(message, type) {
        const status = document.getElementById('status');
        if (status) {
            status.textContent = message;
            status.className = 'status show ' + type;

            setTimeout(function() {
                if (status) {
                    status.classList.remove('show');
                }
            }, 5000);
        }
    }

    function normalizeImagePolicyErrorMessage(message) {
        const raw = message == null ? '' : String(message).trim();
        if (!raw) return '';
        const lower = raw.toLowerCase();
        const matched = (
            lower.includes('violated our relevant policies') ||
            lower.includes('may have violated') ||
            lower.includes('content policy') ||
            lower.includes('policy violation') ||
            lower.includes('safety policy') ||
            lower.includes('moderation') ||
            lower.includes('prompt filter') ||
            lower.includes('prompt_filter') ||
            lower.includes('content_filter') ||
            lower.includes('content blocked') ||
            lower.includes('safety system')
        );
        if (!matched) return raw;
        return '生成内容被安全策略拦截，请弱化提示词、避开敏感描述，或更换参考图后重试。';
    }

    function formatImageGenerationError(message, prefix) {
        const normalized = normalizeImagePolicyErrorMessage(message) || '未知错误';
        return prefix ? (prefix + normalized) : normalized;
    }

    function showToast(message) {
        const toast = document.getElementById('toast');
        if (toast) {
            toast.textContent = message || '';
            if (!message) {
                toast.classList.remove('show');
                return;
            }
            toast.classList.add('show');

            setTimeout(function() {
                if (toast) {
                    toast.classList.remove('show');
                    toast.textContent = '';
                }
            }, 3000);
        }
    }

    // 初始化兼容性检查
    function initCompatibility() {
        if (compatibility.isUXPAvailable || psAPI.isAvailable) {
            return true;
        }
        try {
            // 尝试加载UXP模块
            psAPI.uxp = require("uxp");
            psAPI.app = require("photoshop").app;
            psAPI.core = require("photoshop").core;
            psAPI.action = require("photoshop").action;
            psAPI.imaging = require("photoshop").imaging;
            psAPI.constants = require("photoshop").constants;
            
            // 初始化 uxpFs
            uxpFs = psAPI.uxp?.storage?.localFileSystem || null;

            if (!photoshopCoreModules) {
                photoshopCoreModules = {
                    lock: require('./src/features/photoshop-core/ps-lock.js')
                };
                photoshopCoreModules.operationLock = photoshopCoreModules.lock.createPSLock({
                    sleep: function(milliseconds) { return new Promise(function(resolve) { setTimeout(resolve, milliseconds); }); }
                });
            }
            
            psAPI.isAvailable = true;
            compatibility.isUXPAvailable = true;
            
            // 检测Photoshop版本
            try {
                if (psAPI.app && psAPI.app.version) {
                    compatibility.photoshopVersion = psAPI.app.version;
                }
            } catch (e) {
                debugLog("无法检测Photoshop版本:", e);
            }
            
            // 检测功能可用性
            compatibility.features.selection = true;
            compatibility.features.imageProcessing = true;
            compatibility.features.fileSystem = true;
            return true;

        } catch (e) {
            debugLog("UXP模块加载失败，Photoshop功能将不可用:", e);
            psAPI.isAvailable = false;
            compatibility.isUXPAvailable = false;
            return false;
        }
    }

    function clearPrimaryImagePreview(message) {
        const stage = document.querySelector('.tt-stage-card');
        const previewImage = document.getElementById('previewImage');
        const previewPlaceholder = document.getElementById('previewPlaceholder');
        const selectionInfo = document.getElementById('selectionInfo');
        if (stage) stage.classList.remove('has-selection');
        if (previewImage) {
            previewImage.removeAttribute('src');
            previewImage.style.display = 'none';
        }
        if (previewPlaceholder) previewPlaceholder.style.display = 'block';
        if (selectionInfo) selectionInfo.textContent = message || '尚未读取选区';
    }

    function updatePrimaryImagePreview(dataUrl, bounds, label) {
        if (!dataUrl) {
            clearPrimaryImagePreview(label);
            return;
        }
        const stage = document.querySelector('.tt-stage-card');
        const previewImage = document.getElementById('previewImage');
        const previewPlaceholder = document.getElementById('previewPlaceholder');
        const selectionInfo = document.getElementById('selectionInfo');
        selectedImageBase64 = dataUrl;
        if (stage) stage.classList.add('has-selection');
        if (previewImage) {
            previewImage.src = dataUrl;
            previewImage.style.display = 'block';
        }
        if (previewPlaceholder) previewPlaceholder.style.display = 'none';
        if (selectionInfo) {
            const width = bounds && Math.max(1, Math.round(Number(bounds.width) || 0));
            const height = bounds && Math.max(1, Math.round(Number(bounds.height) || 0));
            selectionInfo.textContent = width && height
                ? '选区尺寸: ' + width + ' x ' + height + ' 像素'
                : (label || '已载入图片');
        }
    }

    function readBrowserFileAsDataUrl(file) {
        return new Promise(function(resolve, reject) {
            if (!file || !/^image\//i.test(file.type || '')) {
                reject(new Error('请选择图片文件'));
                return;
            }
            const reader = new FileReader();
            reader.onload = function() { resolve(String(reader.result || '')); };
            reader.onerror = function() { reject(new Error('读取图片文件失败')); };
            reader.readAsDataURL(file);
        });
    }

    function getBrowserImageSize(dataUrl) {
        return new Promise(function(resolve) {
            const image = new Image();
            const timer = setTimeout(function() { resolve({ width: 0, height: 0 }); }, 10000);
            image.onload = function() {
                clearTimeout(timer);
                resolve({ width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0 });
            };
            image.onerror = function() {
                clearTimeout(timer);
                resolve({ width: 0, height: 0 });
            };
            image.src = dataUrl;
        });
    }

    function pickBrowserImage(label) {
        return new Promise(function(resolve, reject) {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.className = 'browser-file-input';
            input.setAttribute('aria-label', label || '上传图片');
            document.body.appendChild(input);
            const cleanup = function() {
                if (input.parentNode) input.parentNode.removeChild(input);
            };
            input.onchange = async function() {
                const file = input.files && input.files[0];
                if (!file) {
                    cleanup();
                    reject(new Error('未选择图片'));
                    return;
                }
                try {
                    const dataUrl = await readBrowserFileAsDataUrl(file);
                    const size = await getBrowserImageSize(dataUrl);
                    const bounds = size.width && size.height
                        ? { left: 0, top: 0, right: size.width, bottom: size.height, width: size.width, height: size.height }
                        : null;
                    resolve({ base64: dataUrl, bounds: bounds, documentId: null, label: file.name || label || '上传图片' });
                } catch (error) {
                    reject(error);
                } finally {
                    cleanup();
                }
            };
            input.click();
        });
    }

    function applyBrowserCaptureLabels() {
        if (initCompatibility()) return;
        const labels = {
            btnImg2ImgReadSelection: '上传主图',
            btnChatReadSelection: '上传图片',
            btnAddReferenceImage: '+ 上传参考图'
        };
        Object.keys(labels).forEach(function(id) {
            const button = document.getElementById(id);
            if (!button) return;
            button.textContent = labels[id];
            button.title = labels[id];
        });
        document.querySelectorAll('button').forEach(function(button) {
            const text = String(button.textContent || '').trim();
            if (!/(读取|捕获|抓取|重新读取).*(选区|画布|图片|原图|轨迹|文档)/.test(text)) return;
            if (!button.getAttribute('data-browser-original-label')) button.setAttribute('data-browser-original-label', text);
            button.textContent = /参考|轨迹|特效源|原图/.test(text) ? '上传参考图片' : '上传图片';
            button.title = button.textContent;
        });
        [
            ['chatSelectionPreview', 'btnChatReadSelection']
        ].forEach(function(pair) {
            const preview = document.getElementById(pair[0]);
            const button = document.getElementById(pair[1]);
            if (!preview || !button || preview.getAttribute('data-browser-upload-bound') === '1') return;
            preview.setAttribute('data-browser-upload-bound', '1');
            preview.setAttribute('role', 'button');
            preview.setAttribute('tabindex', '0');
            preview.title = '单击上传图片';
            preview.onclick = function() { button.click(); };
            preview.onkeydown = function(event) {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); }
            };
        });
        const autoReturn = document.getElementById('taskAutoReturn');
        if (autoReturn) {
            // 保持生成后的统一输出流程开启；浏览器分支会把它解释为“进入画廊”，
            // 而不是 Photoshop 回传。
            autoReturn.checked = true;
            autoReturn.disabled = true;
            const label = autoReturn.closest && autoReturn.closest('label');
            if (label) label.lastChild.textContent = ' 生成结果统一保存到画廊';
        }
    }

    function setupGenerationImageInputs() {
        const isUxp = initCompatibility();
        document.documentElement.classList.toggle('runtime-browser', !isUxp);
        if (document.body) document.body.classList.toggle('runtime-browser', !isUxp);

        const card = document.querySelector('.tt-image-input-card');
        const toggle = document.getElementById('btnToggleImageInput');
        if (card && toggle && toggle.dataset.bound !== '1') {
            toggle.onclick = function() {
                card.classList.toggle('is-collapsed');
                const collapsed = card.classList.contains('is-collapsed');
                toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                toggle.textContent = collapsed ? '参考图 · 已收起' : '参考图 · 已展开';
            };
            toggle.dataset.bound = '1';
            toggle.textContent = card.classList.contains('is-collapsed') ? '参考图 · 已收起' : '参考图 · 已展开';
        }

        if (isUxp) return;
        applyBrowserCaptureLabels();
        if (!window.__huanmengBrowserCaptureObserver && typeof MutationObserver !== 'undefined') {
            const workspace = document.querySelector('.workspace') || document.body;
            window.__huanmengBrowserCaptureObserver = new MutationObserver(function() {
                applyBrowserCaptureLabels();
            });
            window.__huanmengBrowserCaptureObserver.observe(workspace, { childList: true, subtree: true });
        }
        const selectionPreview = document.getElementById('selectionPreview');
        const primaryButton = document.getElementById('btnUploadPrimaryImage');
        const primaryInput = document.getElementById('browserPrimaryImageInput');
        if (primaryButton && primaryInput) {
            primaryButton.onclick = function() { primaryInput.click(); };
            if (selectionPreview) {
                selectionPreview.setAttribute('role', 'button');
                selectionPreview.setAttribute('tabindex', '0');
                selectionPreview.setAttribute('aria-label', '点击上传主图');
                selectionPreview.onclick = function() { primaryInput.click(); };
                selectionPreview.onkeydown = function(event) {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        primaryInput.click();
                    }
                };
                const placeholder = document.getElementById('previewPlaceholder');
                if (placeholder && !selectedImageBase64) placeholder.textContent = '点击此处从手机 / 电脑上传主图';
            }
            primaryInput.onchange = async function() {
                const file = primaryInput.files && primaryInput.files[0];
                if (!file) return;
                try {
                    const dataUrl = await readBrowserFileAsDataUrl(file);
                    const size = await getBrowserImageSize(dataUrl);
                    savedSelectionBounds = size.width && size.height
                        ? { left: 0, top: 0, right: size.width, bottom: size.height, width: size.width, height: size.height }
                        : null;
                    savedDocumentId = null;
                    updatePrimaryImagePreview(dataUrl, savedSelectionBounds, '已从设备上传主图');
                    showStatus('图片已载入，可以开始生成', 'success');
                } catch (error) {
                    showStatus('上传图片失败：' + error.message, 'error');
                } finally {
                    primaryInput.value = '';
                }
            };
        }

        const referenceButton = document.getElementById('btnUploadReferenceImage');
        const referenceInput = document.getElementById('browserReferenceImageInput');
        if (referenceButton && referenceInput) {
            referenceButton.onclick = function() { referenceInput.click(); };
            referenceInput.onchange = async function() {
                const files = Array.prototype.slice.call(referenceInput.files || [], 0, MAX_REFERENCE_IMAGES);
                try {
                    for (let i = 0; i < files.length && referenceImages.length < MAX_REFERENCE_IMAGES; i++) {
                        const dataUrl = await readBrowserFileAsDataUrl(files[i]);
                        const size = await getBrowserImageSize(dataUrl);
                        referenceImages.push({
                            base64: dataUrl,
                            label: files[i].name || ('参考图' + (referenceImages.length + 1)),
                            bounds: size.width && size.height ? { width: size.width, height: size.height } : null
                        });
                    }
                    referenceImages = normalizeReferenceImageList(referenceImages);
                    renderReferenceImages();
                    showStatus('参考图已载入', 'success');
                } catch (error) {
                    showStatus('上传参考图失败：' + error.message, 'error');
                } finally {
                    referenceInput.value = '';
                }
            };
        }
    }

    // Photoshop API 在真正调用 PS 功能时再初始化，避免 UXP 加载阶段超时

    function getModelName(modelValue) {
        if (!modelValue) return 'gemini-2.0-flash-exp';
        const text = String(modelValue);
        if (text.indexOf('/') > -1) {
            return text.split('/').pop();
        }
        return text;
    }

    function getModelKey(modelValue) {
        return String(getModelName(modelValue) || '').trim().toLowerCase();
    }

    function parseModelSelection(modelValue) {
        const raw = String(modelValue || '').trim();
        if (!raw) {
            return { raw: '', provider: '', model: '' };
        }

        const lower = raw.toLowerCase();
        if (lower.startsWith('grs/')) {
            return { raw: raw, provider: 'grs', model: getModelName(raw.slice(4)) };
        }
        if (lower.startsWith('openai/')) {
            return { raw: raw, provider: 'openai', model: getModelName(raw.slice(7)) };
        }
        if (lower.startsWith('google/')) {
            return { raw: raw, provider: 'google', model: getModelName(raw.slice(7)) };
        }
        if (lower.startsWith('xai/')) {
            return { raw: raw, provider: 'xai', model: getModelName(raw.slice(4)) };
        }
        if (lower.startsWith('grok2api/')) {
            return { raw: raw, provider: 'grok2api', model: getModelName(raw.slice(9)) };
        }
        if (lower.startsWith('sub2api/')) {
            return { raw: raw, provider: 'sub2api', model: getModelName(raw.slice(8)) };
        }
        if (lower.startsWith('firefly/')) {
            return { raw: raw, provider: 'firefly', model: getModelName(raw.slice(8)) };
        }
        if (lower.startsWith('volcengine/')) {
            return { raw: raw, provider: 'volcengine', model: getModelName(raw.slice(11)) };
        }
        if (lower.startsWith('newapi-openai/')) {
            return { raw: raw, provider: 'newapi-openai', model: getModelName(raw.slice(14)) };
        }
        if (lower.startsWith('newapi-gemini/')) {
            return { raw: raw, provider: 'newapi-gemini', model: getModelName(raw.slice(14)) };
        }
        if (lower.startsWith('newapi/')) {
            const parsedModel = getModelName(raw.slice(7));
            const parsedModelKey = String(parsedModel || '').toLowerCase();
            return {
                raw: raw,
                provider: parsedModelKey.includes('gemini') ? 'newapi-gemini' : 'newapi-openai',
                model: parsedModel
            };
        }

        const model = getModelName(raw);
        const modelKey = String(model || '').toLowerCase();
        if (modelKey.includes('gemini')) {
            return { raw: raw, provider: 'google', model: model };
        }
        // 这里必须用 isGrsGptImageModel 而不是硬编码的 gpt-image-2 / gpt-imagine-2：
        // 后者漏掉了 gpt-image-2-vip 和 gpt-image-2.5 系列，它们会掉到下面的
        // startsWith('gpt') 分支被误判成 openai。
        if (isGrsNanoBananaModel(modelKey) || isGrsGptImageModel(modelKey)) {
            return { raw: raw, provider: 'grs', model: model };
        }
        if (modelKey.startsWith('gpt')) {
            return { raw: raw, provider: 'openai', model: model };
        }

        return { raw: raw, provider: '', model: model };
    }

    function buildModelValue(provider, modelName) {
        const cleanModel = String(getModelName(modelName) || '').trim();
        if (!cleanModel) return '';
        if (!provider) return cleanModel;
        return String(provider).toLowerCase() + '/' + cleanModel;
    }

    function getImageModelSelectionKey(modelValue) {
        const parsed = parseModelSelection(modelValue);
        const provider = parsed.provider || (getModelKey(modelValue) === 'ps_native_nano_banana' ? 'photoshop' : 'local');
        return String(provider).toLowerCase() + '::' + String(parsed.model || getModelName(modelValue) || '').toLowerCase();
    }

    function normalizeChatModelValue(modelValue) {
        const parsed = parseModelSelection(modelValue || DEFAULT_GRS_CHAT_MODEL);
        const modelName = parsed.model || getModelName(DEFAULT_GRS_CHAT_MODEL);
        const provider = parsed.provider || 'grs';
        if (isNewApiProvider(provider) || provider === 'newapi' || provider === 'volcengine') {
            return buildModelValue(provider, modelName);
        }
        return buildModelValue('grs', modelName);
    }

    function getChatOptionKey(provider, modelName) {
        return String(provider || '').toLowerCase() + '::' + String(modelName || '').toLowerCase();
    }

    function isGrsNanoBananaModel(modelValue) {
        return GRS_NANO_BANANA_MODELS.indexOf(getModelKey(modelValue)) > -1;
    }

    function isGrsGptImageModel(modelValue) {
        return GRS_GPT_IMAGE_MODELS.indexOf(getModelKey(modelValue)) > -1;
    }

    function shouldOptimizePromptForImagine2(modelValue) {
        return isGrsGptImageModel(modelValue);
    }

    function buildImagine2ImageEditPrompt(promptText) {
        const prompt = normalizePresetPromptText(promptText);
        if (!prompt) return '';

        if (prompt.indexOf('图生图编辑任务：') > -1 && prompt.indexOf('Imagine-2执行规则：') > -1) {
            return prompt;
        }

        return [
            '图生图编辑任务：请以输入图片作为唯一视觉参考进行编辑，不要从零重画。',
            '编辑目标：',
            prompt,
            'Imagine-2执行规则：',
            '1. 只修改“编辑目标”明确要求修改的区域；未提到的区域保持原图。',
            '2. 保持人物身份、五官比例、表情、姿势、构图、透视、服装设计、道具位置、背景结构、光源方向、色温、景深、清晰度和噪点一致；只有编辑目标明确要求时才允许改变。',
            '3. 编辑目标中以“改变、过度、出现、导致、误删、遮挡、不自然、比例失调、背景变形、禁止、严禁、避免、不要”等描述的失败情况，全部理解为反向约束，不要生成这些结果。',
            '4. 修改区域需要无缝融合，边缘、遮挡、投影、反射、纹理密度、透视缩放和颗粒感与原图一致。',
            '5. 输出单张干净成图，不添加解释文字、水印、logo、边框、拼图或额外画面，除非编辑目标明确要求。'
        ].join('\n\n');
    }

    function getConfiguredSystemPrompts(kind) {
        const settings = currentSettings || {};
        if (kind === 'text') {
            return {
                positive: String(settings.textSystemPromptPositive == null ? DEFAULT_TEXT_SYSTEM_PROMPT_POSITIVE : settings.textSystemPromptPositive).trim(),
                negative: String(settings.textSystemPromptNegative == null ? DEFAULT_TEXT_SYSTEM_PROMPT_NEGATIVE : settings.textSystemPromptNegative).trim()
            };
        }
        return {
            positive: String(settings.imageSystemPromptPositive == null ? DEFAULT_IMAGE_SYSTEM_PROMPT_POSITIVE : settings.imageSystemPromptPositive).trim(),
            negative: String(settings.imageSystemPromptNegative == null ? DEFAULT_IMAGE_SYSTEM_PROMPT_NEGATIVE : settings.imageSystemPromptNegative).trim()
        };
    }

    function composeConfiguredSystemPrompt(kind, promptText) {
        const prompt = normalizePresetPromptText(promptText);
        const configured = getConfiguredSystemPrompts(kind === 'text' ? 'text' : 'image');
        const parts = [];
        if (configured.positive) parts.push('系统正向要求：\n' + configured.positive);
        if (prompt) parts.push('当前任务：\n' + prompt);
        if (configured.negative) parts.push('系统逆向约束（必须避免）：\n' + configured.negative);
        return parts.join('\n\n');
    }

    function prependTextSystemMessage(messages) {
        const list = Array.isArray(messages) ? messages.slice() : [];
        const configured = getConfiguredSystemPrompts('text');
        const content = [
            configured.positive ? '正向要求：\n' + configured.positive : '',
            configured.negative ? '逆向约束（必须避免）：\n' + configured.negative : ''
        ].filter(Boolean).join('\n\n');
        if (!content) return list;
        if (list[0] && list[0].role === 'system') {
            return list;
        } else {
            list.unshift({ role: 'system', content: content });
        }
        return list;
    }

    function applySystemPromptToApiOptions(options) {
        const next = Object.assign({}, options || {});
        if (next.__huanmengSystemPromptApplied) return next;
        const parsed = parseModelSelection(next.model);
        const modelKey = getModelKey(next.model);
        const looksLikeTextTask = next.systemPromptKind === 'text'
            || (Array.isArray(next.messages) && next.messages.length > 0)
            || (isGrsChatModel(modelKey) && !next.imageBase64 && !(next.referenceImages && next.referenceImages.length))
            || (parsed.provider === 'volcengine' && modelKey.indexOf('seedream') < 0 && !next.imageBase64);
        if (looksLikeTextTask) {
            next.prompt = composeConfiguredSystemPrompt('text', next.prompt || '');
            if (Array.isArray(next.messages)) next.messages = prependTextSystemMessage(next.messages);
        } else {
            next.prompt = composeConfiguredSystemPrompt('image', next.prompt || '');
        }
        next.__huanmengSystemPromptApplied = true;
        return next;
    }

    function getImageRequestPrompt(modelValue, promptText, hasInputImage) {
        const prompt = normalizePresetPromptText(promptText);
        if (!shouldOptimizePromptForImagine2(modelValue) || hasInputImage === false) {
            return prompt;
        }
        return buildImagine2ImageEditPrompt(prompt);
    }

    function normalizeGrsModelName(modelValue) {
        const modelName = String(getModelName(modelValue) || '').trim();
        const modelKey = modelName.toLowerCase();
        return GRS_GPT_IMAGE_MODEL_ALIASES[modelKey] || modelName;
    }

    function normalizeBaseUrl(baseUrl, fallbackBaseUrl) {
        const raw = String(baseUrl || fallbackBaseUrl || '').trim();
        return raw.replace(/\/+$/, '');
    }

    function normalizeGrsBaseUrlStrict(baseUrl) {
        const normalized = normalizeBaseUrl(baseUrl, GRS_DEFAULT_BASE_URL).toLowerCase();
        if (normalized === GRS_DEFAULT_BASE_URL || normalized === GRS_CHINA_BASE_URL) {
            return normalized;
        }
        return GRS_DEFAULT_BASE_URL;
    }

    function joinApiUrl(baseUrl, path) {
        const normalizedBaseUrl = normalizeBaseUrl(baseUrl, '');
        const normalizedPath = String(path || '');
        if (!normalizedPath) return normalizedBaseUrl;
        return normalizedBaseUrl + (normalizedPath.startsWith('/') ? normalizedPath : '/' + normalizedPath);
    }

    function getGrsDrawBaseUrlFromSettings(settings) {
        const selectedRegion = settings && settings.grsRegion ? settings.grsRegion : (currentSettings && currentSettings.grsRegion);
        if (selectedRegion === 'domestic') return GRS_CHINA_BASE_URL;
        if (selectedRegion === 'overseas') return GRS_DEFAULT_BASE_URL;
        const urlFromSettings = settings && settings.imgApiUrl ? settings.imgApiUrl : '';
        return normalizeGrsBaseUrlStrict(urlFromSettings || (currentSettings && currentSettings.imgApiUrl));
    }

    function getVolcengineBaseUrlFromSettings(settings) {
        const value = settings && settings.volcengineApiUrl ? settings.volcengineApiUrl : (currentSettings && currentSettings.volcengineApiUrl);
        return normalizeBaseUrl(value, VOLCENGINE_DEFAULT_BASE_URL);
    }

    function getGrsDrawBaseUrl() {
        return getGrsDrawBaseUrlFromSettings(currentSettings);
    }

    function getNewApiBaseUrlFromSettings(settings) {
        const urlFromSettings = settings && settings.newApiUrl ? settings.newApiUrl : '';
        // 各调用点自己拼 '/v1/...'，所以这里要剥掉用户可能填进地址里的尾部 /v1，
        // 否则 https://host/v1 会拼成 https://host/v1/v1/images/generations。
        // 与 xai / grok2api / sub2api 的处理保持一致。
        return normalizeBaseUrl(urlFromSettings || (currentSettings && currentSettings.newApiUrl), NEWAPI_DEFAULT_BASE_URL).replace(/\/v1$/i, '');
    }

    function getXaiBaseUrlFromSettings(settings) {
        const urlFromSettings = settings && settings.xaiApiUrl ? settings.xaiApiUrl : '';
        return normalizeBaseUrl(urlFromSettings || (currentSettings && currentSettings.xaiApiUrl), XAI_DEFAULT_BASE_URL).replace(/\/v1$/i, '');
    }

    function getGrok2ApiBaseUrlFromSettings(settings) {
        const urlFromSettings = settings && settings.grok2apiApiUrl ? settings.grok2apiApiUrl : '';
        return normalizeBaseUrl(urlFromSettings || (currentSettings && currentSettings.grok2apiApiUrl), GROK2API_DEFAULT_BASE_URL).replace(/\/v1$/i, '');
    }

    function getSub2ApiBaseUrlFromSettings(settings) {
        const urlFromSettings = settings && settings.sub2apiApiUrl ? settings.sub2apiApiUrl : '';
        return normalizeBaseUrl(urlFromSettings || (currentSettings && currentSettings.sub2apiApiUrl), SUB2API_DEFAULT_BASE_URL).replace(/\/v1$/i, '');
    }

    function getFireflyBaseUrlFromSettings(settings) {
        const urlFromSettings = settings && settings.fireflyApiUrl ? settings.fireflyApiUrl : '';
        return normalizeBaseUrl(urlFromSettings || (currentSettings && currentSettings.fireflyApiUrl), FIREFLY_DEFAULT_BASE_URL);
    }

    function isNewApiProvider(provider) {
        const providerKey = String(provider || '').toLowerCase();
        return providerKey === 'newapi' || providerKey === 'newapi-openai' || providerKey === 'newapi-gemini';
    }



    function isGrsChatModel(modelValue) {
        const modelKey = getModelKey(modelValue);
        return !!modelKey && !isGrsNanoBananaModel(modelKey) && !isGrsGptImageModel(modelKey);
    }

    function isOpenAIChatModel(modelValue) {
        const modelKey = getModelKey(modelValue);
        return modelKey.startsWith('gpt') && !isGrsGptImageModel(modelKey);
    }

    function normalizeSupportedAspectRatio(aspectRatio) {
        const requested = getAspectRatioValue(aspectRatio);
        let closest = AUTO_ASPECT_RATIO_PRESETS[0];
        AUTO_ASPECT_RATIO_PRESETS.forEach(function(preset) {
            if (Math.abs(preset.value - requested) < Math.abs(closest.value - requested)) {
                closest = preset;
            }
        });
        return closest.label;
    }

    function normalizeXaiResolution(imageResolution, sizeHint) {
        const selected = normalizeImageResolution(imageResolution);
        if (selected === '2K' || selected === '4K') return '2k';
        if (selected === '1K') return '1k';
        return getPreferredImageSizeByHint(sizeHint) === '1K' ? '1k' : '2k';
    }

    function getReferenceImageMediaType(image) {
        const match = String(image || '').match(/^data:(image\/(?:png|jpeg));base64,/i);
        return match ? match[1].toLowerCase() : 'image/png';
    }

    function getNanoBananaImageSize(modelValue) {
        const modelKey = getModelKey(modelValue);
        if (modelKey.includes('4k') || modelKey === 'nano-banana-2-4k-cl' || modelKey === 'nano-banana-pro-4k-vip') {
            return '4K';
        }
        if (modelKey.includes('2k')) {
            return '2K';
        }
        return '1K';
    }

    const AUTO_ASPECT_RATIO_PRESETS = [
        { label: '1:1', value: 1 },
        { label: '4:3', value: 4 / 3 },
        { label: '3:4', value: 3 / 4 },
        { label: '3:2', value: 3 / 2 },
        { label: '2:3', value: 2 / 3 },
        { label: '16:9', value: 16 / 9 },
        { label: '9:16', value: 9 / 16 }
    ];

    function normalizeSizeHint(sizeHint) {
        if (!sizeHint || typeof sizeHint !== 'object') return null;
        const width = Number(sizeHint.width);
        const height = Number(sizeHint.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return null;
        }
        return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    }

    function getSelectionAspectRatioLabel(sizeHint) {
        const hint = normalizeSizeHint(sizeHint);
        if (!hint) {
            debugLog("getSelectionAspectRatioLabel: 无效的尺寸数据，返回默认1:1");
            return '1:1';
        }

        const width = hint.width;
        const height = hint.height;
        const gcd = function(a, b) {
            let x = Math.abs(Math.round(a));
            let y = Math.abs(Math.round(b));
            while (y) {
                const temp = x % y;
                x = y;
                y = temp;
            }
            return x || 1;
        };
        const divisor = gcd(width, height);
        const left = Math.max(1, Math.round(width / divisor));
        const right = Math.max(1, Math.round(height / divisor));
        return left + ':' + right;
    }



    function getAspectRatioLabelByHint(sizeHint) {
        const hint = normalizeSizeHint(sizeHint);
        if (!hint) {
            debugLog("getAspectRatioLabelByHint: 无效的尺寸数据，返回默认1:1");
            return '1:1';
        }

        return getSelectionAspectRatioLabel(hint);
    }

    function getAspectRatioValue(aspectRatio) {
        const text = String(aspectRatio || '1:1').trim();
        const parts = text.split(':');
        if (parts.length !== 2) return 1;
        const left = Number(parts[0]);
        const right = Number(parts[1]);
        if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return 1;
        return left / right;
    }

    function getBaseResolutionByImageSize(imageSize) {
        if (imageSize === '4K') return 4096;
        if (imageSize === '2K') return 2048;
        return 1024;
    }

    function clampNanoImageSizeByCapability(preferredSize, capabilitySize) {
        const level = { '1K': 1, '2K': 2, '4K': 4 };
        const preferred = level[preferredSize] || 1;
        const capability = level[capabilitySize] || 1;

        if (preferred >= 4 && capability >= 4) return '4K';
        if (preferred >= 2 && capability >= 2) return '2K';
        return '1K';
    }

    function getPreferredImageSizeByHint(sizeHint) {
        const hint = normalizeSizeHint(sizeHint);
        if (!hint) return '1K';
        const longSide = Math.max(hint.width, hint.height);
        if (longSide >= 3000) return '4K';
        if (longSide >= 1500) return '2K';
        return '1K';
    }

    function normalizeImageResolution(value) {
        const normalized = String(value || DEFAULT_IMAGE_RESOLUTION).trim().toUpperCase();
        if (normalized === '1K' || normalized === '2K' || normalized === '4K') {
            return normalized;
        }
        return DEFAULT_IMAGE_RESOLUTION;
    }

    function getSelectedImageResolution() {
        const resolutionSelect = document.getElementById('imgResolution');
        if (resolutionSelect) {
            return normalizeImageResolution(resolutionSelect.value);
        }
        return normalizeImageResolution(currentSettings && currentSettings.imgResolution);
    }

    function buildDimensionsFromAspect(baseResolution, aspectRatio) {
        const safeBase = Math.max(256, Number(baseResolution) || 1024);
        const ratio = Math.max(0.2, Math.min(5, getAspectRatioValue(aspectRatio)));

        let width = safeBase;
        let height = safeBase;

        if (ratio >= 1) {
            width = safeBase;
            height = Math.round((safeBase / ratio) / 8) * 8;
        } else {
            height = safeBase;
            width = Math.round((safeBase * ratio) / 8) * 8;
        }

        width = Math.max(256, width);
        height = Math.max(256, height);

        return { width: width, height: height };
    }

    function getGptImageSizeByAspect(aspectRatio) {
        const ratio = getAspectRatioValue(aspectRatio);
        if (ratio >= 1.2) return '1536x1024';
        if (ratio <= 0.83) return '1024x1536';
        return '1024x1024';
    }

    function parseSizeToDimensions(sizeText) {
        const match = String(sizeText || '').match(/^(\d+)\s*x\s*(\d+)$/i);
        if (!match) {
            return { width: 1024, height: 1024 };
        }
        return {
            width: Math.max(256, Number(match[1]) || 1024),
            height: Math.max(256, Number(match[2]) || 1024)
        };
    }

    function getModelImageConfig(modelValue, sizeHint, imageResolution) {
        const modelKey = getModelKey(modelValue);
        const aspectRatio = getAspectRatioLabelByHint(sizeHint);
        const selectedResolution = normalizeImageResolution(imageResolution);
        const explicitImageSize = selectedResolution === DEFAULT_IMAGE_RESOLUTION ? '' : selectedResolution;

        if (isGrsNanoBananaModel(modelKey)) {
            const maxCapability = getNanoBananaImageSize(modelKey);
            const preferredImageSize = explicitImageSize || getPreferredImageSizeByHint(sizeHint);
            const imageSize = explicitImageSize || clampNanoImageSizeByCapability(preferredImageSize, maxCapability);
            const dimensions = buildDimensionsFromAspect(getBaseResolutionByImageSize(imageSize), aspectRatio);
            return {
                width: dimensions.width,
                height: dimensions.height,
                aspectRatio: aspectRatio,
                size: 'auto',
                imageSize: imageSize
            };
        }
        if (isGrsGptImageModel(modelKey)) {
            const explicitDimensions = explicitImageSize
                ? buildDimensionsFromAspect(getBaseResolutionByImageSize(explicitImageSize), aspectRatio)
                : null;
            const size = explicitDimensions
                ? explicitDimensions.width + 'x' + explicitDimensions.height
                : getGptImageSizeByAspect(aspectRatio);
            const dimensions = parseSizeToDimensions(size);
            return {
                width: dimensions.width,
                height: dimensions.height,
                aspectRatio: aspectRatio,
                size: size,
                imageSize: explicitImageSize || '1K'
            };
        }

        const explicitFallbackDimensions = explicitImageSize
            ? buildDimensionsFromAspect(getBaseResolutionByImageSize(explicitImageSize), aspectRatio)
            : null;
        const fallbackSize = explicitFallbackDimensions
            ? explicitFallbackDimensions.width + 'x' + explicitFallbackDimensions.height
            : getGptImageSizeByAspect(aspectRatio);
        const fallbackDimensions = parseSizeToDimensions(fallbackSize);
        return {
            width: fallbackDimensions.width,
            height: fallbackDimensions.height,
            aspectRatio: aspectRatio,
            size: 'auto',
            imageSize: explicitImageSize || '1K'
        };
    }

    function getImageModelDisplayName(modelValue, fallbackText) {
        const modelName = String(getModelName(modelValue) || '').trim();
        const modelKey = modelName.toLowerCase();

        if (modelKey === 'ps_native_nano_banana') {
            return 'PS 原生 Banana Pro (Photoshop 官方)';
        }
        // GRS 模型一律显示官网写法 + 单次参考价。
        // 键是真实调用 ID（不变），只换显示文字，见 GRS_MODEL_DISPLAY。
        const grsInfo = GRS_MODEL_DISPLAY[modelKey];
        if (grsInfo) {
            return grsInfo.name + ' · ' + grsInfo.price;
        }
        if (isGrsGptImageModel(modelKey)) {
            if (modelKey === 'gpt-imagine-2') {
                return 'gpt-imagine-2 (兼容别名 → gpt-image-2)';
            }
            return modelName + ' (GRS 图生图优化)';
        }
        if (isGrsNanoBananaModel(modelKey)) {
            if (modelKey.includes('4k')) {
                return modelName + ' (GRS Nano Banana 4K)';
            }
            return modelName + ' (GRS Nano Banana)';
        }

        return fallbackText || modelName;
    }

    function resolveImageApiRouting(modelValue, settings) {
        const parsed = parseModelSelection(modelValue);
        const requestedProvider = String(parsed.provider || '').toLowerCase();
        const modelKey = getModelKey(parsed.model || modelValue);
        const safeSettings = settings || {};

        if (isNewApiProvider(requestedProvider)) {
            return {
                provider: requestedProvider,
                model: parsed.model || getModelName(modelValue),
                apiKey: safeSettings.newApiKey || '',
                baseUrl: getNewApiBaseUrlFromSettings(safeSettings),
                apiType: 'newapi',
                missingKeyMessage: '请先在设置中配置 NewAPI 地址和密钥'
            };
        }

        if (requestedProvider === 'xai') {
            return {
                provider: 'xai',
                model: parsed.model || getModelName(modelValue),
                apiKey: safeSettings.xaiApiKey || '',
                baseUrl: getXaiBaseUrlFromSettings(safeSettings),
                apiType: 'xai-images',
                missingKeyMessage: '请先在设置中配置 xAI API Key'
            };
        }

        if (requestedProvider === 'grok2api') {
            return {
                provider: 'grok2api',
                model: parsed.model || getModelName(modelValue),
                apiKey: safeSettings.grok2apiApiKey || '',
                baseUrl: getGrok2ApiBaseUrlFromSettings(safeSettings),
                apiType: 'grok2api-images',
                missingKeyMessage: '请在 grok2api 后台的 Client Keys 中创建并填写 g2a_... 密钥（不是管理员密码，也不是 xAI 官方 Key）'
            };
        }

        if (requestedProvider === 'sub2api') {
            return {
                provider: 'sub2api',
                model: parsed.model || getModelName(modelValue),
                apiKey: safeSettings.sub2apiApiKey || '',
                baseUrl: getSub2ApiBaseUrlFromSettings(safeSettings),
                apiType: 'sub2api-images',
                missingKeyMessage: '请在 Sub2API 用户后台创建并填写 sk-... API Key'
            };
        }

        if (requestedProvider === 'firefly') {
            return {
                provider: 'firefly',
                model: parsed.model || getModelName(modelValue),
                apiKey: safeSettings.fireflyApiKey || '',
                baseUrl: getFireflyBaseUrlFromSettings(safeSettings),
                apiType: 'firefly-images',
                apiKeyOptional: true,
                missingKeyMessage: '请先在设置中配置 Firefly 服务地址'
            };
        }

        if (requestedProvider === 'volcengine') {
            return {
                provider: 'volcengine',
                model: parsed.model || safeSettings.volcengineImageModel || VOLCENGINE_DEFAULT_IMAGE_MODEL,
                apiKey: safeSettings.volcengineApiKey || '',
                baseUrl: getVolcengineBaseUrlFromSettings(safeSettings),
                apiType: 'volcengine-images',
                missingKeyMessage: '请先在设置中配置火山方舟 API Key'
            };
        }

        if (modelKey.includes('gemini')) {
            return {
                provider: 'google',
                model: parsed.model || getModelName(modelValue),
                apiKey: safeSettings.googleApiKey || '',
                googleAiEnabled: !!safeSettings.googleAiEnabled,
                missingKeyMessage: '请先在设置中配置Google AI Studio API密钥'
            };
        }

        if (isGrsNanoBananaModel(modelKey) || isGrsGptImageModel(modelKey)) {
            return {
                provider: 'grs',
                model: parsed.model || getModelName(modelValue),
                apiKey: safeSettings.imgApiKey || '',
                apiType: 'nano',
                missingKeyMessage: '请先在设置中配置GRS生图API密钥'
            };
        }

        if (isOpenAIChatModel(modelKey)) {
            return {
                provider: 'openai',
                model: parsed.model || getModelName(modelValue),
                apiKey: safeSettings.chatApiKey || '',
                apiType: 'openai',
                missingKeyMessage: '请先在设置中配置OpenAI官方API密钥'
            };
        }

        return {
            provider: 'unsupported',
            apiKey: '',
            apiType: 'unsupported',
            missingKeyMessage: '当前模型不受支持。仅支持 GRS / Grok Imagine / Firefly / Google AI Studio / NewAPI'
        };
    }

    function validateImageApiRouting(modelValue, settings) {
        const route = resolveImageApiRouting(modelValue, settings);

        if (route.provider === 'unsupported') {
            return { valid: false, message: route.missingKeyMessage };
        }

        if (route.provider === 'google' && !route.googleAiEnabled) {
            return { valid: false, message: '请先在设置中启用Google AI Studio' };
        }

        if (!route.apiKey && !route.apiKeyOptional) {
            return { valid: false, message: route.missingKeyMessage || '缺少API密钥' };
        }
        if ((isNewApiProvider(route.provider) || route.provider === 'xai' || route.provider === 'grok2api' || route.provider === 'sub2api' || route.provider === 'firefly' || route.provider === 'volcengine') && !route.baseUrl) {
            return { valid: false, message: '请先在设置中配置当前提供商地址' };
        }

        return { valid: true, route: route };
    }

    function resolveChatApiRouting(modelValue, settings) {
        const safeSettings = settings || {};
        const parsed = parseModelSelection(modelValue || DEFAULT_GRS_CHAT_MODEL);
        const modelName = parsed.model || getModelName(DEFAULT_GRS_CHAT_MODEL);
        const provider = parsed.provider || 'grs';

        if (isNewApiProvider(provider)) {
            return {
                provider: provider,
                model: modelName,
                apiKey: safeSettings.newApiKey || '',
                baseUrl: getNewApiBaseUrlFromSettings(safeSettings),
                missingKeyMessage: '请先在设置中配置 NewAPI 地址和密钥'
            };
        }

        if (provider === 'volcengine') {
            return {
                provider: 'volcengine',
                model: modelName || safeSettings.volcengineChatModel || VOLCENGINE_DEFAULT_CHAT_MODEL,
                apiKey: safeSettings.volcengineApiKey || '',
                baseUrl: getVolcengineBaseUrlFromSettings(safeSettings),
                missingKeyMessage: '请先在设置中配置火山方舟 API Key'
            };
        }

        return {
            provider: 'grs',
            model: modelName,
            apiKey: safeSettings.imgApiKey || safeSettings.chatApiKey || '',
            baseUrl: getGrsDrawBaseUrlFromSettings(safeSettings),
            missingKeyMessage: '请先在设置中配置 GRS API 密钥'
        };
    }

    function validateChatApiRouting(modelValue, settings) {
        const route = resolveChatApiRouting(modelValue, settings);
        if (!route.apiKey) {
            return { valid: false, message: route.missingKeyMessage || '缺少API密钥' };
        }
        if (isNewApiProvider(route.provider) && !route.baseUrl) {
            return { valid: false, message: '请先在设置中配置 NewAPI 地址' };
        }
        return { valid: true, route: route };
    }

    function getPreviewRatioByModel(modelValue) {
        return '1:1';
    }

    function updatePreviewAspectByModel(modelValue) {
        const ratio = getPreviewRatioByModel(modelValue);

        const containers = [
            document.getElementById('selectionPreview'),
            document.getElementById('chatSelectionPreview')
        ];

        containers.forEach(container => {
            if (!container) return;

            container.classList.remove('preview-ratio-square', 'preview-ratio-wide', 'preview-ratio-auto');

            if (ratio === '16:9') {
                container.classList.add('preview-ratio-wide');
            } else {
                container.classList.add('preview-ratio-square');
            }
        });
    }

    function updateImageProviderSummary(modelValue) {
        const summary = document.getElementById('imageProviderSummary');
        const nameEl = document.getElementById('imageProviderName');
        const detailEl = document.getElementById('imageProviderDetail');
        if (!summary || !nameEl || !detailEl) return;

        const parsed = parseModelSelection(modelValue);
        let provider = parsed.provider || 'photoshop';
        let name = 'Photoshop 原生';
        let detail = '不需要 API Key，直接使用 Photoshop 生成式填充。';

        if (provider === 'grs') {
            name = 'GRS 云端';
            detail = '支持选区与 4 张追加参考图，比例根据选区自动适配。';
        } else if (provider === 'xai') {
            name = 'Grok Imagine · xAI';
            detail = '文生图走 generations；有选区时自动走 edits，最多取 3 张输入图，4K 自动按 2K 请求。';
        } else if (provider === 'grok2api') {
            name = 'Grok Imagine · grok2api';
            detail = '连接本地 grok2api；使用 g2a_... Client Key。Web 模型编辑时自动切换到 grok-imagine-image-edit。';
        } else if (provider === 'sub2api') {
            name = 'Grok Imagine · Sub2API';
            detail = '连接本地 Sub2API；使用 sk-... 用户 API Key。图像编辑会自动使用 Grok 编辑模型。';
        } else if (provider === 'firefly') {
            name = 'Firefly 本地网关';
            detail = '选区会先上传到 Firefly 逆向服务，再用同一账号生成；追加参考图取第 1 张。';
        } else if (isNewApiProvider(provider)) {
            name = 'NewAPI';
            detail = '优先尝试 Images API，Auto 模式失败后回退到多模态 Chat。';
        } else if (provider === 'google') {
            name = 'Google AI Studio';
            detail = '使用 Google 原生多模态图像接口。';
        }

        summary.dataset.provider = provider;
        nameEl.textContent = name;
        detailEl.textContent = detail;
    }

    function normalizeApiKey(key) {
        return (key || '')
            .replace(/^Bearer\s+/i, '')  // 去掉 Bearer
            .replace(/[\s\r\n]+/g, '')   // 去空格和换行
            .trim();
    }

    function toNumber(value) {
        let parsed = Number(value);
        if (!Number.isFinite(parsed) && value && typeof value === "object") {
            if (Number.isFinite(Number(value._value))) {
                parsed = Number(value._value);
            } else if (Number.isFinite(Number(value.value))) {
                parsed = Number(value.value);
            }
        }
        return Number.isFinite(parsed) ? parsed : NaN;
    }



    function getBitsPerChannelValue(bitsPerChannel) {
        if (bitsPerChannel && typeof bitsPerChannel === "object") {
            if (typeof bitsPerChannel._value !== "undefined") {
                return bitsPerChannel._value;
            }
            if (typeof bitsPerChannel.value !== "undefined") {
                return bitsPerChannel.value;
            }
        }
        return bitsPerChannel;
    }

    // 抓取完选区后取消蚂蚁线。回写定位走的是 savedSelectionBounds 快照，
    // 不依赖文档里的活动选区，所以取消是安全的。
    async function deselectAll() {
        initCompatibility();
        if (!psAPI.isAvailable || !psAPI.core || !psAPI.app || !psAPI.app.activeDocument) return;
        try {
            await psAPI.core.executeAsModal(async function() {
                const doc = psAPI.app.activeDocument;
                if (doc && doc.selection) await doc.selection.deselect();
            }, { commandName: '取消选区' });
        } catch (error) {
            debugLog('取消选区失败:', error && error.message);
        }
    }

    async function getSelectionBoundsInPixels() {
        initCompatibility();
        try {
            const doc = psAPI.app && psAPI.app.activeDocument;
            const selection = doc && doc.selection;
            const b = selection && selection.bounds;
            if (!b) return null;
            const bounds = {
                left: toNumber(b.left),
                top: toNumber(b.top),
                right: toNumber(b.right),
                bottom: toNumber(b.bottom)
            };
            bounds.width = bounds.right - bounds.left;
            bounds.height = bounds.bottom - bounds.top;
            if (![bounds.left, bounds.top, bounds.right, bounds.bottom, bounds.width, bounds.height].every(Number.isFinite)) return null;
            if (bounds.width <= 0 || bounds.height <= 0) return null;
            return bounds;
        } catch (error) {
            debugLog('读取 Photoshop 选区范围失败:', error);
            return null;
        }
    }

    function isSixteenBitDocument() {
        if (!psAPI.app || !psAPI.constants) return false;
        const rawBits = getBitsPerChannelValue(psAPI.app?.activeDocument?.bitsPerChannel);
        const sixteenEnum = psAPI.constants?.BitsPerChannelType?.SIXTEEN;

        if (rawBits === sixteenEnum) {
            return true;
        }
        if (typeof rawBits === "number") {
            return rawBits === 16;
        }

        const bitsText = String(rawBits || "").toUpperCase();
        if (bitsText === "16" || bitsText.includes("SIXTEEN")) {
            return true;
        }

        const enumText = String(sixteenEnum || "").toUpperCase();
        return enumText.length > 0 && bitsText === enumText;
    }

    function buildGetPixelsOptions(bounds, options = {}) {
        const getPixelsOptions = {
            sourceBounds: {
                left: bounds.left,
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom
            },
            applyAlpha: true
        };

        if (options.forceEightBit) {
            getPixelsOptions.componentSize = 8;
        }
        if (options.forceRgbSrgb) {
            getPixelsOptions.colorSpace = "RGB";
            getPixelsOptions.colorProfile = "sRGB IEC61966-2.1";
        }

        return getPixelsOptions;
    }

    function disposeImageData(imageData) {
        if (imageData && typeof imageData.dispose === "function") {
            imageData.dispose();
        }
    }

    async function getImageDataFromSelection(bounds, options = {}) {
        if (!bounds) {
            throw new Error("No Selection");
        }

        const isSixteenBit = isSixteenBitDocument();
        const getPixelsOptions = buildGetPixelsOptions(bounds, {
            forceEightBit: isSixteenBit,
            forceRgbSrgb: options.forceRgbSrgb === true
        });

        try {
            if (isSixteenBit) {
                debugLog("16-bit compatibility mode: forcing 8-bit pixels for encode.");
            }

            if (!psAPI.imaging) {
                throw new Error("Imaging API not available");
            }

            const result = await psAPI.imaging.getPixels(getPixelsOptions);
            debugLog("image data obtained from selection.");
            return result.imageData;
        } catch (error) {
            debugLog("error getting image data from selection: " + error);
            throw error;
        }
    }

    async function getImageDataToBase64(bounds) {
        initCompatibility();
        if (!psAPI.core) {
            return "";
        }
        
        return psAPI.core.executeAsModal(async () => {
            let imageData = null;
            const isSixteenBit = isSixteenBitDocument();
            try {
                imageData = await getImageDataFromSelection(bounds);
            } catch (error) {
                console.error("Error getting imageData from selection: " + error);
                return "";
            }

            try {
                if (!psAPI.imaging) {
                    throw new Error("Imaging API not available");
                }
                const base64Data = await psAPI.imaging.encodeImageData({
                    imageData: imageData,
                    base64: true,
                    quality: 100
                });
                return base64Data;
            } catch (error) {
                if (!isSixteenBit) {
                    console.error(error);
                    throw error;
                }

                debugLog("16-bit compatibility fallback: retrying encode with RGB/sRGB 8-bit pixels.");

                disposeImageData(imageData);
                imageData = null;

                try {
                    imageData = await getImageDataFromSelection(bounds, { forceRgbSrgb: true });
                    if (!psAPI.imaging) {
                        throw new Error("Imaging API not available");
                    }
                    const base64Data = await psAPI.imaging.encodeImageData({
                        imageData: imageData,
                        base64: true,
                        quality: 100
                    });
                    return base64Data;
                } catch (fallbackError) {
                    console.error(fallbackError);
                    throw fallbackError;
                }
            } finally {
                disposeImageData(imageData);
            }
        });
    }

    function normalizeBoundsObject(rawBounds) {
        if (!rawBounds) return null;
        const left = toNumber(rawBounds.left);
        const top = toNumber(rawBounds.top);
        const right = toNumber(rawBounds.right);
        const bottom = toNumber(rawBounds.bottom);
        if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
        return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
    }

    async function getActiveLayerBounds() {
        initCompatibility();
        if (!psAPI.core || !psAPI.action) return null;
        return psAPI.core.executeAsModal(async function() {
            const result = await psAPI.action.batchPlay([{
                _obj: 'get',
                _target: [{ _property: 'boundsNoEffects' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
            }], { synchronousExecution: true, modalBehavior: 'execute' });
            return normalizeBoundsObject(result && result[0] && (result[0].boundsNoEffects || result[0].bounds));
        }, { commandName: '读取活动图层范围' });
    }

    async function getLayerDataToBase64(layer, bounds) {
        initCompatibility();
        if (!layer || !bounds || !psAPI.core || !psAPI.imaging || !psAPI.app.activeDocument) return '';
        return psAPI.core.executeAsModal(async function() {
            let imageData = null;
            try {
                const result = await psAPI.imaging.getPixels({
                    documentID: psAPI.app.activeDocument.id,
                    layerID: layer.id,
                    sourceBounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
                    targetSize: { width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) },
                    colorSpace: 'RGB',
                    colorProfile: 'sRGB IEC61966-2.1',
                    componentSize: 8,
                    applyAlpha: true
                });
                imageData = result.imageData;
                return await psAPI.imaging.encodeImageData({ imageData: imageData, base64: true, quality: 100 });
            } finally {
                disposeImageData(imageData);
            }
        }, { commandName: '读取活动图层像素' });
    }

    async function calibrateReturnedImageDataUrl(dataUrl, referenceDataUrl, method) {
        if (!window.HuanmengColorMatch) return dataUrl;
        if (referenceDataUrl) {
            const options = method && typeof method === 'object'
                ? method
                : { method: method === 'reinhard' ? 'reinhard' : 'wavelet', strength: 100 };
            return window.HuanmengColorMatch.matchDataUrls(referenceDataUrl, dataUrl, options);
        }
        return window.HuanmengColorMatch.normalizeToSrgbPng(dataUrl);
    }

    async function maybeAutoColorMatchReturnedImage(dataUrl) {
        // 当前版本的生成回图阶段统一跳过自动校色：先确保原始生成结果能够
        // 立即进入画廊并准确回写。工具箱中的手动“融合校色”仍可单独使用。
        skipAutoColorMatchOnce = false;
        return dataUrl;
        /* istanbul ignore next -- 保留实现，后续重新开放自动校色时直接启用 */
        /*
        const shouldSkip = skipAutoColorMatchOnce;
        skipAutoColorMatchOnce = false;
        if (shouldSkip || (currentSettings && currentSettings.autoColorMatchEnabled === false)) return dataUrl;
        try {
            const method = currentSettings && currentSettings.autoColorMatchMethod === 'reinhard' ? 'reinhard' : 'wavelet';
            const imageInfo = window.HuanmengColorMatch && typeof window.HuanmengColorMatch.inspectDataUrl === 'function'
                ? await window.HuanmengColorMatch.inspectDataUrl(dataUrl)
                : null;
            const pixels = imageInfo && Number(imageInfo.pixels) || 0;
            const maxAutomaticPixels = 2000000;
            if (pixels > maxAutomaticPixels) {
                const sizeLabel = imageInfo.width + '×' + imageInfo.height;
                debugLog('回图尺寸 ' + sizeLabel + '，跳过高负载自动融合校色并继续回写');
                Config.addLog({
                    timestamp: new Date().toLocaleString('zh-CN'),
                    model: '自动融合校色',
                    prompt: '高分辨率回图 ' + sizeLabel,
                    type: 'color-match',
                    status: '跳过',
                    error: '超过自动校色安全上限（200 万像素），已保留原图并继续回写'
                });
                showStatus('高分辨率回图已跳过自动融合校色，正在回写...', 'info');
                return dataUrl;
            }
            showStatus(selectedImageBase64 ? '正在自动融合校色...' : '正在统一 sRGB 色彩空间...', 'info');
            const automaticOptions = {
                method: method,
                strength: 100,
                alignmentEnabled: pixels > 0 && pixels <= 800000,
                sharedMaskEnabled: pixels > 0 && pixels <= 800000,
                featherRadius: 12,
                alignmentMaxOffset: 80
            };
            const result = await calibrateReturnedImageDataUrl(dataUrl, selectedImageBase64, automaticOptions);
            debugLog('回图自动校色完成，方法:', selectedImageBase64 ? method : 'sRGB');
            return result;
        } catch (error) {
            console.warn('自动校色失败，使用原回图:', error);
            Config.addLog({
                timestamp: new Date().toLocaleString('zh-CN'),
                model: '自动融合校色',
                prompt: '回图色彩校准',
                type: 'color-match',
                status: '跳过',
                error: error && error.message ? error.message : String(error)
            });
            return dataUrl;
        }
        */
    }

    async function runManualColorMatch(settingsOverride, capturedSources) {
        initCompatibility();
        if (!psAPI.isAvailable || !psAPI.app || !psAPI.core || !psAPI.imaging) {
            throw new Error('Photoshop API 不可用，请在 Photoshop 中加载插件');
        }
        const doc = psAPI.app.activeDocument;
        const layer = doc && doc.activeLayers && doc.activeLayers[0];
        if (!doc || !layer) throw new Error('请先选择 AI 回图图层');
        const bounds = await getActiveLayerBounds();
        if (!bounds) throw new Error('无法读取当前图层范围');
        const boundCapture = capturedSources && typeof capturedSources === 'object' ? capturedSources : null;
        const methodEl = document.getElementById('toolColorMatchMethod');
        const override = settingsOverride && typeof settingsOverride === 'object' ? settingsOverride : {};
        const method = override.method === 'reinhard' || (!override.method && methodEl && methodEl.value === 'reinhard')
            ? 'reinhard'
            : 'wavelet';
        const strength = Math.max(0, Math.min(100, Number(override.strength == null ? 100 : override.strength) || 0));

        if (boundCapture && boundCapture.outputFullSample && boundCapture.referenceFullSample) {
            let referenceSample = boundCapture.referenceFullSample;
            const outputSample = boundCapture.outputFullSample;
            if (referenceSample.width !== outputSample.width || referenceSample.height !== outputSample.height) {
                referenceSample = resizeRgbaImageData(referenceSample, outputSample.width, outputSample.height);
            }
            const correctedImageData = window.HuanmengColorMatch.matchImageData(
                referenceSample,
                outputSample,
                Object.assign({}, override, { method: method, strength: strength })
            );
            const placedLayer = await placeRgbaImageDataIntoDoc(
                correctedImageData,
                bounds,
                '融合校色 · ' + (method === 'reinhard' ? 'Lab' : '小波低频') + ' · ' + Math.round(strength) + '%',
                doc.id,
                { commandName: '精确回写融合校色' }
            );
            if (!placedLayer) throw new Error('融合校色未创建结果图层');
            return '融合校色完成';
        }

        const outputBase64 = boundCapture && boundCapture.outputDataUrl
            ? String(boundCapture.outputDataUrl).replace(/^data:image\/\w+;base64,/, '')
            : await getLayerDataToBase64(layer, bounds);
        if (!outputBase64) throw new Error('无法读取当前图层像素');
        let reference = boundCapture && boundCapture.referenceDataUrl
            ? String(boundCapture.referenceDataUrl)
            : selectedImageBase64;
        let restoreVisibility = null;
        if (!reference) {
            const wasVisible = layer.visible !== false;
            await psAPI.core.executeAsModal(async function() { layer.visible = false; }, { commandName: '读取图层下方原画面' });
            restoreVisibility = async function() {
                await psAPI.core.executeAsModal(async function() { layer.visible = wasVisible; }, { commandName: '恢复活动图层' });
            };
            try {
                const compositeBase64 = await getImageDataToBase64(bounds);
                reference = compositeBase64 ? 'data:image/png;base64,' + compositeBase64.replace(/^data:image\/\w+;base64,/, '') : '';
            } finally {
                await restoreVisibility();
            }
        }
        if (!reference) throw new Error('没有可用的原图参考；请先读取选区或确保图层下方有画面');
        const corrected = await calibrateReturnedImageDataUrl(
            'data:image/png;base64,' + outputBase64.replace(/^data:image\/\w+;base64,/, ''),
            reference,
            { method: method, strength: strength }
        );
        const previousBounds = savedSelectionBounds;
        const previousDocumentId = savedDocumentId;
        skipAutoColorMatchOnce = true;
        savedSelectionBounds = bounds;
        savedDocumentId = doc.id;
        try {
            await downloadAndPlaceDocument(corrected, bounds.width, bounds.height, '融合校色', 'color-match', new Date().toLocaleString('zh-CN'), method);
            const placed = doc.activeLayers && doc.activeLayers[0];
            if (placed) placed.name = '融合校色 · ' + (method === 'reinhard' ? 'Lab' : '小波低频') + ' · ' + Math.round(strength) + '%';
        } finally {
            savedSelectionBounds = previousBounds;
            savedDocumentId = previousDocumentId;
        }
        return '融合校色完成';
    }

    const API = {
        async listModels(apiKey, abortSignal) {
            const maxRetries = 3;
            let retryCount = 0;
            
            // 验证API密钥
            apiKey = normalizeApiKey(apiKey);
            if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
                return { error: 'API密钥无效，请检查您的API密钥设置' };
            }
            
            // 仅允许 GRS 官方域名
            const baseUrl = getGrsDrawBaseUrl();
            
            while (retryCount < maxRetries) {
                try {
                    const url = joinApiUrl(baseUrl, "/v1beta/models");
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 180000);
                    let response;
                    
                    // 监听外部取消信号
                    if (abortSignal) {
                        abortSignal.addEventListener('abort', () => controller.abort());
                    }
                    
                    // 添加请求间隔，避免请求频率过高
                    if (retryCount > 0) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                    
                    // 检查是否已被取消
                    if (abortSignal && abortSignal.aborted) {
                        clearTimeout(timeoutId);
                        return { error: '请求已取消' };
                    }
                    
                    try {
                        response = await fetch(url, {
                            method: 'GET',
                            headers: {
                                'Authorization': 'Bearer ' + apiKey
                            },
                            signal: controller.signal
                        });
                    } finally {
                        clearTimeout(timeoutId);
                    }
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        let errorMsg = '请求失败: ' + response.status + ' - ' + errorText;
                        
                        // 简化错误信息，使其更友好
                        if (errorText.includes('invalid_api_key')) {
                            errorMsg = 'API密钥无效，请检查您的API密钥';
                        } else if (errorText.includes('quota_exceeded')) {
                            errorMsg = 'API配额已用尽，请稍后再试';
                        } else if (errorText.includes('rate_limit_exceeded')) {
                            errorMsg = '请求频率过高，请稍后再试';
                        }
                        
                        // 对于500错误，进行重试
                        if (response.status >= 500 && retryCount < maxRetries - 1) {
                            retryCount++;
                            debugLog(`服务器错误，正在重试 ${retryCount}/${maxRetries}...`);
                            continue;
                        }
                        
                        throw new Error(errorMsg);
                    }
                    
                    const data = await response.json();
                    return { success: true, data: data };
                } catch (e) {
                    if (e.name === 'AbortError') {
                        return { error: '请求超时，请稍后重试' };
                    }
                    
                    // 对于网络错误，进行重试
                    if (e.message.includes('network') || e.message.includes('Network') || e.message.includes('fetch')) {
                        if (retryCount < maxRetries - 1) {
                            retryCount++;
                            debugLog(`网络错误，正在重试 ${retryCount}/${maxRetries}...`);
                            continue;
                        } else {
                            return { error: '网络连接失败，请检查您的网络连接' };
                        }
                    }
                    
                    return { error: e.message };
                }
            }
            
            return { error: '请求失败，已达到最大重试次数' };
        },

        async listNewApiModels(apiKey, baseUrl, abortSignal) {
            const maxRetries = 3;
            let retryCount = 0;

            apiKey = normalizeApiKey(apiKey);
            baseUrl = normalizeBaseUrl(baseUrl, '');
            if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
                return { error: 'NewAPI密钥无效，请检查您的API密钥设置' };
            }
            if (!baseUrl) {
                return { error: 'NewAPI地址无效，请先在设置中填写NewAPI地址' };
            }

            while (retryCount < maxRetries) {
                try {
                    const url = joinApiUrl(baseUrl, "/v1/models");
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 180000);
                    let response;

                    if (abortSignal) {
                        abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
                    }

                    if (retryCount > 0) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                    if (abortSignal && abortSignal.aborted) {
                        clearTimeout(timeoutId);
                        return { error: '请求已取消' };
                    }

                    try {
                        response = await fetch(url, {
                            method: 'GET',
                            headers: {
                                'Authorization': 'Bearer ' + apiKey
                            },
                            signal: controller.signal
                        });
                    } finally {
                        clearTimeout(timeoutId);
                    }

                    if (!response.ok) {
                        const errorText = await response.text();
                        let errorMsg = '请求失败: ' + response.status + ' - ' + errorText;

                        if (errorText.includes('invalid_api_key')) {
                            errorMsg = 'NewAPI密钥无效，请检查您的API密钥';
                        } else if (errorText.includes('quota_exceeded')) {
                            errorMsg = 'NewAPI配额已用尽，请稍后再试';
                        } else if (errorText.includes('rate_limit_exceeded')) {
                            errorMsg = '请求频率过高，请稍后再试';
                        }

                        if (response.status >= 500 && retryCount < maxRetries - 1) {
                            retryCount++;
                            continue;
                        }

                        throw new Error(errorMsg);
                    }

                    const data = await response.json();
                    return { success: true, data: data };
                } catch (e) {
                    if (e.name === 'AbortError') {
                        return { error: '请求超时，请稍后重试' };
                    }

                    if (e.message.includes('network') || e.message.includes('Network') || e.message.includes('fetch')) {
                        if (retryCount < maxRetries - 1) {
                            retryCount++;
                            continue;
                        }
                        return { error: '网络连接失败，请检查您的网络连接' };
                    }

                    return { error: e.message };
                }
            }

            return { error: '请求失败，已达到最大重试次数' };
        },

        async chatNewApi(options) {
            const apiKey = normalizeApiKey(options.apiKey);
            const baseUrl = normalizeBaseUrl(options.baseUrl, '');
            if (!apiKey) return { error: 'NewAPI密钥无效，请检查您的API密钥设置' };
            if (!baseUrl) return { error: 'NewAPI地址无效，请先在设置中填写NewAPI地址' };

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 180000);
                if (options.abortSignal) {
                    options.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
                }

                let response;
                try {
                    response = await fetch(joinApiUrl(baseUrl, '/v1/chat/completions'), {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + apiKey
                        },
                        body: JSON.stringify({
                            model: getModelName(options.model),
                            stream: false,
                            messages: Array.isArray(options.messages) && options.messages.length ? options.messages : [
                                { role: 'user', content: options.prompt || '' }
                            ]
                        }),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    return { error: 'NewAPI请求失败: ' + response.status + ' - ' + errorText };
                }

                return { success: true, data: await response.json() };
            } catch (e) {
                return { error: e.name === 'AbortError' ? '请求已取消' : e.message };
            }
        },

        async chatOpenAICompatible(options) {
            const apiKey = normalizeApiKey(options.apiKey);
            const baseUrl = normalizeBaseUrl(options.baseUrl, '');
            if (!apiKey) return { error: 'API Key 无效或未配置' };
            if (!baseUrl) return { error: 'API 地址无效' };
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(function() { controller.abort(); }, 180000);
                if (options.abortSignal) options.abortSignal.addEventListener('abort', function() { controller.abort(); }, { once: true });
                let response;
                try {
                    response = await fetch(joinApiUrl(baseUrl, '/chat/completions'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
                        body: JSON.stringify({
                            model: getModelName(options.model),
                            stream: false,
                            messages: Array.isArray(options.messages) && options.messages.length ? options.messages : [{ role: 'user', content: options.prompt || '' }]
                        }),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
                if (!response.ok) return { error: '请求失败: ' + response.status + ' - ' + await response.text() };
                return { success: true, data: await response.json() };
            } catch (error) {
                return { error: error.name === 'AbortError' ? '请求已取消或超时' : error.message };
            }
        },

        async generateImageVolcengine(options) {
            const apiKey = normalizeApiKey(options.apiKey);
            const baseUrl = normalizeBaseUrl(options.baseUrl, VOLCENGINE_DEFAULT_BASE_URL);
            if (!apiKey) return { error: '请先配置火山方舟 API Key' };
            const images = []
                .concat(options.imageBase64 ? [options.imageBase64] : [])
                .concat(Array.isArray(options.referenceImages) ? options.referenceImages : [])
                .map(normalizeReferenceImageData).filter(Boolean).slice(0, 10);
            const resolution = normalizeImageResolution(options.imageResolution || options.imageSize || '2K');
            const body = {
                model: getModelName(options.model) || VOLCENGINE_DEFAULT_IMAGE_MODEL,
                prompt: options.prompt || '',
                size: resolution === '4K' ? '4K' : resolution === '1K' ? '1K' : '2K',
                response_format: 'url',
                watermark: false
                // 不再显式发送 stream / sequential_image_generation：
                // 二者取值（false / 'disabled'）与官方默认值完全相同，发了不改变行为；
                // 而 Seedream 5.0 pro 文档明确不支持配置 sequential_image_generation、
                // 也不支持流式输出，显式发送反而可能被拒。新模型接入时保留默认即可。
            };
            if (images.length) body.image = images.length === 1 ? images[0] : images;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(function() { controller.abort(); }, 300000);
                if (options.abortSignal) options.abortSignal.addEventListener('abort', function() { controller.abort(); }, { once: true });
                let response;
                try {
                    response = await fetch(joinApiUrl(baseUrl, '/images/generations'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
                        body: JSON.stringify(body),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
                if (!response.ok) return { error: '火山方舟生图失败: ' + response.status + ' - ' + await response.text() };
                return { success: true, data: await response.json() };
            } catch (error) {
                return { error: error.name === 'AbortError' ? '火山方舟请求已取消或超时' : error.message };
            }
        },

        async generateImageXai(options) {
            const apiKey = normalizeApiKey(options.apiKey);
            const baseUrl = normalizeBaseUrl(options.baseUrl, XAI_DEFAULT_BASE_URL);
            if (!apiKey) return { error: 'xAI API Key 无效，请检查设置' };

            const sourceImages = []
                .concat(options.imageBase64 ? [options.imageBase64] : [])
                .concat(Array.isArray(options.referenceImages) ? options.referenceImages : [])
                .map(normalizeReferenceImageData)
                .filter(Boolean)
                .slice(0, 3);
            const model = getModelName(options.model) || 'grok-imagine-image-quality';
            const requestedAspectRatio = options.aspectRatio && String(options.aspectRatio).toLowerCase() !== 'auto'
                ? options.aspectRatio
                : getAspectRatioLabelByHint(options.sizeHint);
            const aspectRatio = normalizeSupportedAspectRatio(requestedAspectRatio);
            const body = {
                model: model,
                prompt: options.prompt || '',
                n: Math.max(1, Math.min(10, Number(options.n) || 1)),
                resolution: normalizeXaiResolution(options.imageResolution || options.imageSize, options.sizeHint),
                response_format: 'url'
            };
            let endpoint = '/v1/images/generations';

            if (sourceImages.length === 1) {
                endpoint = '/v1/images/edits';
                body.image = { type: 'image_url', url: sourceImages[0] };
            } else if (sourceImages.length > 1) {
                endpoint = '/v1/images/edits';
                body.images = sourceImages.map(function(image) {
                    return { type: 'image_url', url: image };
                });
                body.aspect_ratio = aspectRatio;
            } else {
                body.aspect_ratio = aspectRatio;
            }

            let timeoutId = null;
            try {
                const controller = new AbortController();
                timeoutId = setTimeout(() => controller.abort(), 240000);
                if (options.abortSignal) {
                    options.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
                }
                let response;
                try {
                    response = await fetch(joinApiUrl(baseUrl, endpoint), {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + apiKey
                        },
                        body: JSON.stringify(body),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
                const responseText = await response.text();
                let data = {};
                try { data = responseText ? JSON.parse(responseText) : {}; } catch (e) {}
                if (!response.ok) {
                    const message = data && data.error && (data.error.message || data.error) || responseText || '未知错误';
                    return { error: 'xAI 请求失败: ' + response.status + ' - ' + message };
                }
                return { success: true, data: data };
            } catch (e) {
                return { error: e.name === 'AbortError' ? '请求已取消或超时' : e.message };
            }
        },

        async generateImageGrok2Api(options) {
            const apiKey = normalizeApiKey(options.apiKey);
            const baseUrl = normalizeBaseUrl(options.baseUrl, GROK2API_DEFAULT_BASE_URL).replace(/\/v1$/i, '');
            if (!apiKey) {
                return { error: '缺少 grok2api Client Key：请在 grok2api → Client Keys 创建 g2a_...，不要填写管理员密码或 xAI 官方 Key' };
            }

            const sourceImages = []
                .concat(options.imageBase64 ? [options.imageBase64] : [])
                .concat(Array.isArray(options.referenceImages) ? options.referenceImages : [])
                .map(normalizeReferenceImageData)
                .filter(Boolean)
                .slice(0, 8);
            // 兜底模型必须是 grok2api 内置目录里真实存在的名字，
            // 原先的 'grok-imagine-image-quality-lite' 不属于任何目录。
            const selectedModel = getModelName(options.model) || 'grok-imagine-image-2.0';
            const editModel = /-lite$/i.test(selectedModel) ? 'grok-imagine-image-edit' : selectedModel;
            const requestedAspectRatio = options.aspectRatio && String(options.aspectRatio).toLowerCase() !== 'auto'
                ? options.aspectRatio
                : getAspectRatioLabelByHint(options.sizeHint);
            const body = {
                model: sourceImages.length ? editModel : selectedModel,
                prompt: options.prompt || '',
                n: Math.max(1, Math.min(10, Number(options.n) || 1)),
                aspect_ratio: normalizeSupportedAspectRatio(requestedAspectRatio),
                resolution: normalizeXaiResolution(options.imageResolution || options.imageSize, options.sizeHint),
                response_format: 'url',
                stream: false
            };
            const endpoint = sourceImages.length ? '/v1/images/edits' : '/v1/images/generations';
            if (sourceImages.length === 1) {
                body.image = { url: sourceImages[0] };
            } else if (sourceImages.length > 1) {
                body.images = sourceImages.map(function(image) { return { url: image }; });
            }

            let timeoutId = null;
            try {
                const controller = new AbortController();
                timeoutId = setTimeout(() => controller.abort(), 240000);
                if (options.abortSignal) {
                    options.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
                }
                let response;
                try {
                    response = await fetch(joinApiUrl(baseUrl, endpoint), {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'Authorization': 'Bearer ' + apiKey
                        },
                        body: JSON.stringify(body),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
                const responseText = await response.text();
                let data = {};
                try { data = responseText ? JSON.parse(responseText) : {}; } catch (e) {}
                if (!response.ok) {
                    const message = data && data.error && (data.error.message || data.error) || responseText || '未知错误';
                    if (response.status === 401) {
                        return { error: 'grok2api 鉴权失败（401）：请填写 Client Keys 页面创建的 g2a_... 密钥；管理员密码和 xAI 官方 Key 均不能用于此处' };
                    }
                    return { error: 'grok2api 请求失败: ' + response.status + ' - ' + message };
                }
                return { success: true, data: data };
            } catch (e) {
                return { error: e.name === 'AbortError' ? 'grok2api 请求已取消或超时' : '无法连接 grok2api：' + e.message };
            }
        },

        async generateImageSub2Api(options) {
            const apiKey = normalizeApiKey(options.apiKey);
            const baseUrl = normalizeBaseUrl(options.baseUrl, SUB2API_DEFAULT_BASE_URL).replace(/\/v1$/i, '');
            if (!apiKey) return { error: '缺少 Sub2API API Key：请在用户 API Key 页面创建 sk-... 密钥' };

            const sourceImages = []
                .concat(options.imageBase64 ? [options.imageBase64] : [])
                .concat(Array.isArray(options.referenceImages) ? options.referenceImages : [])
                .map(normalizeReferenceImageData)
                .filter(Boolean)
                // Sub2API 的 edits 端点硬上限是 3 张源图（grokMediaMaxEditSourceImages），
                // 超出会直接返回 "a maximum of 3 source images is supported"。
                // 之前写 8，用户加第 4 张参考图就必然失败。
                .slice(0, 3);
            const selectedModel = getModelName(options.model) || 'grok-imagine-image-quality';
            const requestedAspectRatio = options.aspectRatio && String(options.aspectRatio).toLowerCase() !== 'auto'
                ? options.aspectRatio
                : getAspectRatioLabelByHint(options.sizeHint);
            const body = {
                model: sourceImages.length ? 'grok-imagine-edit' : selectedModel,
                prompt: options.prompt || '',
                n: Math.max(1, Math.min(10, Number(options.n) || 1)),
                aspect_ratio: normalizeSupportedAspectRatio(requestedAspectRatio),
                // Sub2API 认 resolution 的 1k/2k；不发的话上游按默认 1k 处理，
                // 界面里选的 2K 会被静默忽略。
                resolution: normalizeXaiResolution(options.imageResolution || options.imageSize, options.sizeHint),
                response_format: 'url'
            };
            if (sourceImages.length === 1) body.image = { url: sourceImages[0] };
            if (sourceImages.length > 1) body.images = sourceImages.map(function(image) { return { url: image }; });

            const endpoint = sourceImages.length ? '/v1/images/edits' : '/v1/images/generations';
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 240000);
                if (options.abortSignal) options.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
                let response;
                try {
                    response = await fetch(joinApiUrl(baseUrl, endpoint), {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'Authorization': 'Bearer ' + apiKey
                        },
                        body: JSON.stringify(body),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
                const responseText = await response.text();
                let data = {};
                try { data = responseText ? JSON.parse(responseText) : {}; } catch (e) {}
                if (!response.ok) {
                    const message = data && data.error && (data.error.message || data.error) || responseText || '未知错误';
                    if (response.status === 401) return { error: 'Sub2API 鉴权失败（401）：请填写用户后台创建的 sk-... API Key' };
                    if (response.status === 503) return { error: 'Sub2API 暂无可用的 Grok 图片账号或图片权限：' + message };
                    return { error: 'Sub2API 请求失败: ' + response.status + ' - ' + message };
                }
                return { success: true, data: data };
            } catch (e) {
                return { error: e.name === 'AbortError' ? 'Sub2API 请求已取消或超时' : '无法连接 Sub2API：' + e.message };
            }
        },

        async generateImageFirefly(options) {
            const apiKey = normalizeApiKey(options.apiKey);
            const baseUrl = normalizeBaseUrl(options.baseUrl, FIREFLY_DEFAULT_BASE_URL);
            if (!baseUrl) return { error: 'Firefly 服务地址无效' };

            const sourceImage = normalizeReferenceImageData(options.imageBase64)
                || (Array.isArray(options.referenceImages) ? options.referenceImages.map(normalizeReferenceImageData).find(Boolean) : '');
            const imageConfig = getModelImageConfig(options.model, options.sizeHint, options.imageResolution || options.imageSize);
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
            const body = {
                channel: 'firefly',
                model: getModelName(options.model) || 'google:firefly:colligo:gemini-flash',
                prompt: options.prompt || '',
                aspectRatio: normalizeSupportedAspectRatio(options.aspectRatio && String(options.aspectRatio).toLowerCase() !== 'auto' ? options.aspectRatio : imageConfig.aspectRatio),
                resolution: 'full',
                size: { width: imageConfig.width, height: imageConfig.height },
                groundSearchEnabled: false,
                generationQuality: 'low'
            };

            let timeoutId = null;
            try {
                const controller = new AbortController();
                timeoutId = setTimeout(() => controller.abort(), 240000);
                if (options.abortSignal) {
                    options.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
                }

                if (sourceImage) {
                    const commaIndex = sourceImage.indexOf(',');
                    const encoded = commaIndex > -1 ? sourceImage.slice(commaIndex + 1) : sourceImage;
                    const mediaType = getReferenceImageMediaType(sourceImage);
                    const uploadHeaders = { 'Content-Type': mediaType };
                    if (apiKey) uploadHeaders.Authorization = 'Bearer ' + apiKey;
                    const uploadResponse = await fetch(joinApiUrl(baseUrl, '/v1/storage/image'), {
                        method: 'POST',
                        headers: uploadHeaders,
                        body: base64ToArrayBuffer(encoded),
                        signal: controller.signal
                    });
                    const uploadText = await uploadResponse.text();
                    let uploadData = {};
                    try { uploadData = uploadText ? JSON.parse(uploadText) : {}; } catch (e) {}
                    if (!uploadResponse.ok) {
                        const uploadMessage = uploadData && uploadData.error && (uploadData.error.message || uploadData.error) || uploadText || '未知错误';
                        clearTimeout(timeoutId);
                        return { error: 'Firefly 参考图上传失败: ' + uploadResponse.status + ' - ' + uploadMessage };
                    }
                    const uploadedImage = uploadData && Array.isArray(uploadData.images) ? uploadData.images[0] : null;
                    if (!uploadedImage || !uploadedImage.id) {
                        clearTimeout(timeoutId);
                        return { error: 'Firefly 上传成功，但未返回图片 ID' };
                    }
                    body.referenceImageId = uploadedImage.id;
                    if (uploadData.accountHandle) body.accountHandle = uploadData.accountHandle;
                }

                let response;
                try {
                    response = await fetch(joinApiUrl(baseUrl, '/v1/images/generations'), {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(body),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
                const responseText = await response.text();
                let data = {};
                try { data = responseText ? JSON.parse(responseText) : {}; } catch (e) {}
                if (!response.ok) {
                    const message = data && data.error && (data.error.message || data.error) || responseText || '未知错误';
                    return { error: 'Firefly 请求失败: ' + response.status + ' - ' + message };
                }
                return { success: true, data: data };
            } catch (e) {
                if (timeoutId) clearTimeout(timeoutId);
                return { error: e.name === 'AbortError' ? 'Firefly 请求已取消或超时' : e.message };
            }
        },

        async generateImageNewApiImages(options) {
            const apiKey = normalizeApiKey(options.apiKey);
            const baseUrl = normalizeBaseUrl(options.baseUrl, '');
            if (!apiKey) return { error: 'NewAPI密钥无效，请检查您的API密钥设置' };
            if (!baseUrl) return { error: 'NewAPI地址无效，请先在设置中填写NewAPI地址' };

            const sourceImages = []
                .concat(options.imageBase64 ? [options.imageBase64] : [])
                .concat(Array.isArray(options.referenceImages) ? options.referenceImages : [])
                .map(normalizeReferenceImageData)
                .filter(Boolean)
                .slice(0, 16);
            const endpoint = sourceImages.length ? '/v1/images/edits' : '/v1/images/generations';
            const requestBody = {
                model: getModelName(options.model),
                prompt: options.prompt || '',
                n: Math.max(1, Math.min(10, Number(options.n) || 1))
            };
            if (options.size && options.size !== 'auto') requestBody.size = options.size;
            if (sourceImages.length) {
                // OpenAI-compatible JSON edits uses `images` (plural). A data URL keeps
                // the request inside UXP without relying on Node streams or native paths.
                requestBody.images = sourceImages.map(function(image) {
                    return { image_url: image };
                });
            }

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 240000);
                if (options.abortSignal) {
                    options.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
                }

                let response;
                try {
                    response = await fetch(joinApiUrl(baseUrl, endpoint), {
                        method: 'POST',
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + apiKey
                        },
                        body: JSON.stringify(requestBody),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }

                const responseText = await response.text();
                let responseData = {};
                try { responseData = responseText ? JSON.parse(responseText) : {}; } catch (parseError) {}
                if (!response.ok) {
                    const message = responseData && responseData.error && (responseData.error.message || responseData.error)
                        || responseText || '未知错误';
                    return { error: 'NewAPI ' + (sourceImages.length ? '图像编辑' : '图像生成') + '请求失败: ' + response.status + ' - ' + message };
                }

                return { success: true, data: responseData };
            } catch (e) {
                return { error: e.name === 'AbortError' ? '请求已取消' : e.message };
            }
        },

        async generateImageNewApiChat(options) {
            const images = []
                .concat(options.imageBase64 ? [options.imageBase64] : [])
                .concat(Array.isArray(options.referenceImages) ? options.referenceImages.map(normalizeReferenceImageData).filter(Boolean) : []);
            const content = [{ type: 'text', text: options.prompt || '' }].concat(images.map(function(image) {
                return { type: 'image_url', image_url: { url: image } };
            }));
            return API.chatNewApi(Object.assign({}, options, {
                messages: [{ role: 'user', content: content }]
            }));
        },
        
        async checkNewApiCredits(options) {
            const apiKey = normalizeApiKey(options && options.apiKey);
            const baseUrl = normalizeBaseUrl(options && options.baseUrl, '');
            if (!baseUrl) {
                return { success: false, error: '请先填写 NewAPI 地址' };
            }
            if (!apiKey) {
                return { success: false, error: '请先填写 NewAPI 密钥' };
            }
            const paths = ['/dashboard/billing/credit_grants', '/v1/dashboard/billing/credit_grants', '/api/user/self'];
            let lastError = '';
            for (let i = 0; i < paths.length; i++) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 12000);
                    let response;
                    try {
                        response = await fetch(joinApiUrl(baseUrl, paths[i]), {
                            method: 'GET',
                            headers: {
                                'Accept': 'application/json',
                                'Authorization': 'Bearer ' + apiKey
                            },
                            signal: controller.signal
                        });
                    } finally {
                        clearTimeout(timeoutId);
                    }
                    if (!response.ok) {
                        lastError = '余额查询失败: ' + response.status;
                        continue;
                    }
                    return { success: true, data: await response.json(), path: paths[i] };
                } catch (e) {
                    lastError = e.name === 'AbortError' ? '余额查询超时' : e.message;
                }
            }
            return { success: false, error: lastError || '余额查询失败' };
        },

        async checkGrsCredits(options) {
            const apiKey = normalizeApiKey(options && options.apiKey);
            const baseUrl = getGrsDrawBaseUrlFromSettings(options || {});
            if (!apiKey) {
                return { success: false, error: '请先填写 GRS API 密钥' };
            }
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000);
                let response;
                try {
                    response = await fetch(joinApiUrl(baseUrl, '/client/openapi/getAPIKeyCredits'), {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'Authorization': 'Bearer ' + apiKey,
                            'x-api-key': apiKey
                        },
                        body: JSON.stringify({ apiKey: apiKey, key: apiKey }),
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
                if (!response.ok) {
                    return { success: false, error: '积分查询失败: ' + response.status };
                }
                return { success: true, data: await response.json() };
            } catch (e) {
                return { success: false, error: e.name === 'AbortError' ? '积分查询超时' : e.message };
            }
        },

        async getServerStatus(baseUrl) {
            return API.fetchServerJson(baseUrl, '/api/status');
        },

        async getAnnouncements(baseUrl) {
            return API.fetchServerJson(baseUrl, '/api/announcements');
        },

        async getProjectContent(baseUrl) {
            return API.fetchServerJson(baseUrl, '/api/content/project');
        },

        async getVersion(baseUrl) {
            return API.fetchServerJson(baseUrl, '/api/version');
        },

        async checkUpdate(baseUrl, currentVersion) {
            return API.fetchServerJson(baseUrl, '/api/check-update?version=' + encodeURIComponent(currentVersion || PLUGIN_VERSION));
        },

        async fetchServerJson(baseUrl, path) {
            const normalizedBaseUrl = normalizeBaseUrl(baseUrl, DEFAULT_SERVER_API_URL);
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000);
                let response;
                try {
                    response = await fetch(joinApiUrl(normalizedBaseUrl, path), {
                        method: 'GET',
                        headers: { 'Accept': 'application/json' },
                        signal: controller.signal
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
                if (!response.ok) {
                    return { success: false, error: '服务器请求失败: ' + response.status };
                }
                return { success: true, data: await response.json() };
            } catch (e) {
                return { success: false, error: e.name === 'AbortError' ? '服务器连接超时' : e.message };
            }
        },

        async generateImageGoogle(options) {
            const maxRetries = 3;
            let retryCount = 0;
            const abortSignal = options.abortSignal;
            
            while (retryCount < maxRetries) {
                try {
                    const apiKey = normalizeApiKey(options.apiKey);
                    // 兜底模型必须是官方图像模型。原先用的 gemini-3-flash-preview
                    // 不在 Google 图像生成文档列出的模型里，只会返回文字，
                    // 表现为「请求成功但提取不到图像」。
                    const model = options.model || "gemini-2.5-flash-image";
                    const prompt = options.prompt;
                    const imageBase64 = options.imageBase64;
                    const referenceImages = Array.isArray(options.referenceImages)
                        ? options.referenceImages.map(normalizeReferenceImageData).filter(Boolean).slice(0, MAX_REFERENCE_IMAGES)
                        : [];
                    const requestImages = (imageBase64 ? [imageBase64] : []).concat(referenceImages);

                    // Google AI Studio API endpoint
                    // 文档格式是 models/{model}，这里手动拼前缀，模型名若已带 models/ 要去重，
                    // 否则会出现 /v1beta/models/models/xxx:generateContent。
                    const modelPath = String(model).replace(/^models\//i, '');
                    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + modelPath + ":generateContent";

                    const contents = [{
                        role: "user",
                        parts: [{
                            text: prompt
                        }]
                    }];
                    
                    debugLog("【排查点】当前 requestImages 数量", requestImages.length);
                    requestImages.forEach(function(imageData) {
                        let mimeType = "image/png";
                        const mimeMatch = imageData.match(/^data:(image\/\w+);base64,/);
                        if (mimeMatch) {
                            mimeType = mimeMatch[1];
                        }
                        contents[0].parts.push({
                            inlineData: {
                                mimeType: mimeType,
                                data: imageData.replace(/^data:image\/\w+;base64,/, "")
                            }
                        });
                    });
                    
                    // 画幅：与 xAI / grok2api 用同一套推导，最终收敛到预设标签（1:1、16:9 等），
                    // 这些比例 Gemini 图像模型都支持。
                    const requestedAspectRatio = options.aspectRatio && String(options.aspectRatio).toLowerCase() !== 'auto'
                        ? options.aspectRatio
                        : getAspectRatioLabelByHint(options.sizeHint);
                    const body = {
                        contents: contents,
                        // Gemini 图像模型（gemini-2.5-flash-image / gemini-3-pro-image 等
                        // Nano Banana 系列）必须显式声明输出模态，否则只返回文字，
                        // 表现为「请求成功但提取不到图像」。官方 REST 示例即 ["TEXT", "IMAGE"]。
                        generationConfig: {
                            responseModalities: ["TEXT", "IMAGE"],
                            // 不发这个字段时，界面里选的画幅对 Google 渠道完全不生效。
                            // 这里只发 aspectRatio；imageSize（1K/2K/4K）各图像模型支持范围
                            // 不一致（gemini-2.5-flash-image 上限约 1K，gemini-3-pro-image 才支持
                            // 到 4K），未经真机验证前不发，避免所有请求直接 400。
                            imageConfig: {
                                aspectRatio: normalizeSupportedAspectRatio(requestedAspectRatio)
                            }
                        }
                    };

                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 180000);
                    let response;
                    
                    // 监听外部取消信号
                    if (abortSignal) {
                        abortSignal.addEventListener('abort', () => controller.abort());
                    }
                    
                    // 添加请求间隔，避免请求频率过高
                    if (retryCount > 0) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                    
                    try {
                        response = await fetch(url, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-goog-api-key': apiKey
                            },
                            body: JSON.stringify(body),
                            signal: controller.signal
                        });
                    } finally {
                        clearTimeout(timeoutId);
                    }
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        let errorMsg = '请求失败: ' + response.status + ' - ' + errorText;
                        
                        // 简化错误信息，使其更友好
                        if (errorText.includes('invalid_api_key')) {
                            errorMsg = 'API密钥无效，请检查您的API密钥';
                        } else if (errorText.includes('quota_exceeded')) {
                            errorMsg = 'API配额已用尽，请稍后再试';
                        } else if (errorText.includes('rate_limit_exceeded')) {
                            errorMsg = '请求频率过高，请稍后再试';
                        }
                        
                        // 对于500错误，进行重试
                        if (response.status >= 500 && retryCount < maxRetries - 1) {
                            retryCount++;
                            debugLog(`服务器错误，正在重试 ${retryCount}/${maxRetries}...`);
                            continue;
                        }
                        
                        throw new Error(errorMsg);
                    }
                    
                    const data = await response.json();
                    return { success: true, data: data };
                } catch (e) {
                    if (e.name === 'AbortError') {
                        return { error: '请求已取消' };
                    }
                    
                    // 对于网络错误，进行重试
                    if (e.message.includes('network') || e.message.includes('Network') || e.message.includes('fetch')) {
                        if (retryCount < maxRetries - 1) {
                            retryCount++;
                            debugLog(`网络错误，正在重试 ${retryCount}/${maxRetries}...`);
                            continue;
                        } else {
                            return { error: '网络连接失败，请检查您的网络连接' };
                        }
                    }
                    
                    return { error: e.message };
                }
            }
            
            return { error: '请求失败，已达到最大重试次数' };
        },
        
        async generateImage(options) {
            options = applySystemPromptToApiOptions(options);
            const maxRetries = 3;
            let retryCount = 0;
            const abortSignal = options.abortSignal;

            const getTaskId = function(payload) {
                if (!payload || typeof payload !== 'object') return '';
                const directCandidates = [
                    payload.id,
                    payload.taskId,
                    payload.task_id,
                    payload.jobId,
                    payload.job_id,
                    payload.requestId,
                    payload.request_id,
                    payload.recordId,
                    payload.record_id,
                    payload.data && payload.data.id,
                    payload.data && payload.data.taskId,
                    payload.data && payload.data.task_id,
                    payload.data && payload.data.jobId,
                    payload.data && payload.data.job_id,
                    payload.data && payload.data.requestId,
                    payload.data && payload.data.request_id,
                    payload.result && payload.result.id,
                    payload.result && payload.result.taskId,
                    payload.result && payload.result.task_id,
                    payload.result && payload.result.jobId,
                    payload.result && payload.result.job_id
                ];

                for (let i = 0; i < directCandidates.length; i++) {
                    const candidate = directCandidates[i];
                    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
                    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
                }

                return '';
            };

            const unwrapResultPayload = function(payload) {
                if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
                    return payload.data;
                }
                return payload;
            };

            const getTaskStatus = function(payload) {
                return String(payload && (payload.status || payload.state) || '').toLowerCase();
            };

            const describeResultPayload = function(payload) {
                if (!payload || typeof payload !== 'object') return '无有效响应体';
                const fields = Object.keys(payload).slice(0, 10).join(', ') || '无字段';
                const message = payload.message || payload.error || payload.failure_reason || payload.detail || '';
                return '状态: ' + (getTaskStatus(payload) || 'unknown') + '；字段: ' + fields + (message ? '；消息: ' + message : '');
            };

            const extractImageFromTaskPayload = function(payload) {
                if (!payload || typeof payload !== 'object') return null;
                return extractImageFromResponse(payload.data && typeof payload.data === 'object' ? payload.data : payload);
            };

            const pollGrsResult = async function(baseUrl, authKey, taskId, signal) {
                const maxAttempts = 120;
                const intervalMs = 2500;
                const resultUrl = joinApiUrl(baseUrl, '/v1/draw/result');

                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    if (signal && signal.aborted) {
                        return { error: '请求已取消' };
                    }

                    if (attempt > 0) {
                        await new Promise(resolve => setTimeout(resolve, intervalMs));
                    }

                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 60000);

                    if (signal) {
                        signal.addEventListener('abort', () => controller.abort(), { once: true });
                    }

                    try {
                        const response = await fetch(resultUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + authKey
                            },
                            body: JSON.stringify({ id: taskId }),
                            signal: controller.signal
                        });

                        if (!response.ok) {
                            const errorText = await response.text();
                            if (response.status >= 500) {
                                continue;
                            }
                            return { error: '轮询任务失败: ' + response.status + ' - ' + errorText };
                        }

                        const resultData = await response.json();
                        const directImage = extractImageFromResponse(resultData);
                        if (directImage) {
                            return { success: true, data: resultData };
                        }

                        const resultPayload = unwrapResultPayload(resultData) || {};
                        const payloadImage = extractImageFromTaskPayload(resultPayload);
                        if (payloadImage) {
                            return { success: true, data: resultData };
                        }

                        const status = getTaskStatus(resultPayload);
                        // violation 是官方状态机里的终止态（内容违规），
                        // 原先没列进来，违规任务会被当成「进行中」一直轮询到 120 次超时。
                        if (status === 'failed' || status === 'failure' || status === 'error' || status === 'cancelled' || status === 'canceled' || status === 'violation') {
                            const failureReason = resultPayload.error || resultPayload.failure_reason || resultPayload.message
                                || (status === 'violation' ? '内容违规，已被拒绝生成' : '绘图任务失败');
                            return { error: failureReason };
                        }
                        if (status === 'succeeded' || status === 'success' || status === 'completed' || status === 'done') {
                            return { error: '任务已完成但未返回可用图像。' + describeResultPayload(resultPayload) };
                        }
                    } catch (pollError) {
                        if (pollError.name === 'AbortError') {
                            if (signal && signal.aborted) {
                                return { error: '请求已取消' };
                            }
                            continue;
                        }
                        if (!(pollError.message.includes('network') || pollError.message.includes('Network') || pollError.message.includes('fetch'))) {
                            return { error: pollError.message };
                        }
                    } finally {
                        clearTimeout(timeoutId);
                    }
                }

                return { error: '任务仍在处理中，请稍后重试' };
            };
            
            while (retryCount < maxRetries) {
                try {
                    const apiKey = normalizeApiKey(options.apiKey);
                    const parsedModel = parseModelSelection(options.model);
                    const model = parsedModel.model || getModelName(options.model) || "gemini-2.0-flash-exp";
                    const modelKey = getModelKey(model);
                    const requestedProvider = String(options.provider || parsedModel.provider || '').toLowerCase();

                    if (requestedProvider === 'xai') {
                        return API.generateImageXai(Object.assign({}, options, {
                            apiKey: apiKey,
                            model: model
                        }));
                    }
                    if (requestedProvider === 'grok2api') {
                        return API.generateImageGrok2Api(Object.assign({}, options, {
                            apiKey: apiKey,
                            model: model
                        }));
                    }
                    if (requestedProvider === 'sub2api') {
                        return API.generateImageSub2Api(Object.assign({}, options, {
                            apiKey: apiKey,
                            model: model
                        }));
                    }
                    if (requestedProvider === 'firefly') {
                        return API.generateImageFirefly(Object.assign({}, options, {
                            apiKey: apiKey,
                            model: model
                        }));
                    }
                    if (requestedProvider === 'volcengine') {
                        return API.generateImageVolcengine(Object.assign({}, options, {
                            apiKey: apiKey,
                            model: model
                        }));
                    }
                    if (requestedProvider === 'google') {
                        // 部分调用点（AI超清、特效迁移）会把 resolveImageApiRouting 的结果
                        // 直接交给 generateImage，而这里原先没有 google 分支，
                        // 请求会掉进下面的默认 GRS 分支、打到错误端点。
                        return API.generateImageGoogle(Object.assign({}, options, {
                            apiKey: apiKey,
                            model: model
                        }));
                    }

                    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
                        return { error: 'API密钥无效，请检查您的API密钥设置' };
                    }

                    const prompt = options.prompt;
                    const imageBase64 = options.imageBase64;
                    const referenceImages = Array.isArray(options.referenceImages)
                        ? options.referenceImages.map(normalizeReferenceImageData).filter(Boolean).slice(0, MAX_REFERENCE_IMAGES)
                        : [];
                    const requestImages = (imageBase64 ? [imageBase64] : []).concat(referenceImages);
                    const n = options.n || 1;
                    const imageConfig = getModelImageConfig(
                        model,
                        options.sizeHint || options.selectionBounds || savedSelectionBounds,
                        options.imageResolution || options.imageSize
                    );

                    if (isNewApiProvider(requestedProvider)) {
                        const imageMode = (options.newApiImageMode || (currentSettings && currentSettings.newApiImageMode) || 'auto').toLowerCase();
                        const imagesResult = imageMode === 'chat'
                            ? { error: 'skip images api' }
                            : await API.generateImageNewApiImages(Object.assign({}, options, {
                                apiKey: apiKey,
                                baseUrl: options.baseUrl,
                                model: model,
                                size: imageConfig.size && imageConfig.size !== 'auto' ? imageConfig.size : '1024x1024'
                            }));

                        if (imagesResult.success && extractImageFromResponse(imagesResult.data)) {
                            return imagesResult;
                        }
                        if (imageMode === 'images') {
                            return imagesResult;
                        }

                        return API.generateImageNewApiChat(Object.assign({}, options, {
                            apiKey: apiKey,
                            baseUrl: options.baseUrl,
                            model: model,
                            prompt: prompt,
                            imageBase64: imageBase64,
                            referenceImages: referenceImages
                        }));
                    }

                    let url;
                    let body;
                    let shouldPollGrsResult = false;
                    let requestBaseUrl = '';
                    
                    if (isGrsNanoBananaModel(modelKey) || isGrsGptImageModel(modelKey)) {
                        requestBaseUrl = getGrsDrawBaseUrl();
                        url = joinApiUrl(requestBaseUrl, '/v1/api/generate');
                        body = {
                            model: normalizeGrsModelName(model),
                            prompt: prompt,
                            // 这里必须原样透传 options.aspectRatio（主生成路径固定传 'auto'）。
                            // 曾改成「优先用选区比例」，结果发送的是吸附到 7 个预设后的比例
                            // （例如 1.4:1 的选区会被吸附成 4:3），模型按 4:3 出图，
                            // 回贴时又被 putImageDataAtBounds 拉伸到真实选区比例 —— 表现为错位。
                            // 传 'auto' 时 GRS 会按输入图的比例出图，比例天然一致。
                            aspectRatio: options.aspectRatio || imageConfig.aspectRatio || 'auto',
                            imageSize: options.imageSize || imageConfig.imageSize || '1K',
                            replyType: 'json'
                        };
                        if (requestImages.length) {
                            body.images = requestImages;
                        }
                        shouldPollGrsResult = true;
                    } else if (requestedProvider === 'grs' && isGrsChatModel(modelKey)) {
                        requestBaseUrl = getGrsDrawBaseUrlFromSettings({ imgApiUrl: options.baseUrl });
                        url = joinApiUrl(requestBaseUrl, '/v1/chat/completions');

                        body = {
                            model: model,
                            stream: false,
                            messages: Array.isArray(options.messages) && options.messages.length ? options.messages : [
                                {
                                    role: "user",
                                    content: prompt
                                }
                            ]
                        };

                        if ((!options.messages || !options.messages.length) && requestImages.length) {
                            body.messages[0].content = [
                                {
                                    type: "text",
                                    text: prompt
                                }
                            ].concat(requestImages.map(function(image) {
                                return {
                                    type: "image_url",
                                    image_url: {
                                        url: image
                                    }
                                };
                            }));
                        }
                    } else {
                        throw new Error('当前模型不受支持。请使用 GRS、Grok Imagine、Firefly 或 NewAPI 模型');
                    }
                    
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 180000);
                    let response;
                    
                    if (abortSignal) {
                        abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
                    }
                    
                    if (retryCount > 0) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                    
                    try {
                        response = await fetch(url, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + apiKey
                            },
                            body: JSON.stringify(body),
                            signal: controller.signal
                        });
                    } finally {
                        clearTimeout(timeoutId);
                    }
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        let apiErrorMessage = '';
                        try {
                            const errorJson = JSON.parse(errorText);
                            // GRS 的 400 返回 { id, status, error }，error 是纯字符串；
                            // 部分网关则用 { error: { message } }。两种都要认，
                            // 否则报错信息会退化成整段原始 JSON 文本。
                            if (errorJson) {
                                if (errorJson.error && errorJson.error.message) {
                                    apiErrorMessage = errorJson.error.message;
                                } else if (typeof errorJson.error === 'string') {
                                    apiErrorMessage = errorJson.error;
                                }
                            }
                        } catch (parseError) {}
                        let errorMsg = '请求失败: ' + response.status + ' - ' + (apiErrorMessage || errorText);

                        if ((apiErrorMessage || errorText).includes('invalid_api_key')) {
                            errorMsg = 'API密钥无效，请检查您的API密钥';
                        } else if ((apiErrorMessage || errorText).includes('quota_exceeded')) {
                            errorMsg = 'API配额已用尽，请稍后再试';
                        } else if ((apiErrorMessage || errorText).includes('rate_limit_exceeded')) {
                            errorMsg = '请求频率过高，请稍后再试';
                        }
                        
                        if (response.status >= 500 && retryCount < maxRetries - 1) {
                            retryCount++;
                            debugLog(`服务器错误，正在重试 ${retryCount}/${maxRetries}...`);
                            continue;
                        }
                        
                        throw new Error(errorMsg);
                    }
                    
                    const data = await response.json();

                    if (shouldPollGrsResult) {
                        const directImage = extractImageFromResponse(data);
                        if (directImage) {
                            return { success: true, data: data };
                        }

                        // 首次响应可能就是终止态（官方状态机：running / violation /
                        // succeeded / failed）。这种情况带 id 也不该再轮询——
                        // 否则一个已经失败的任务会白等 120 次 × 2.5 秒。
                        const initialStatus = getTaskStatus(unwrapResultPayload(data) || data);
                        if (initialStatus === 'failed' || initialStatus === 'violation'
                            || initialStatus === 'error' || initialStatus === 'cancelled' || initialStatus === 'canceled') {
                            const initialPayload = unwrapResultPayload(data) || data;
                            return {
                                error: initialPayload.error || initialPayload.message
                                    || (initialStatus === 'violation' ? '内容违规，已被拒绝生成' : '绘图任务失败')
                            };
                        }

                        const taskId = getTaskId(data);
                        if (taskId) {
                            return await pollGrsResult(requestBaseUrl, apiKey, taskId, abortSignal);
                        }

                        return { error: '绘图请求已返回，但未提取到任务ID或图像结果。' + describeResultPayload(unwrapResultPayload(data) || data) };
                    }

                    return { success: true, data: data };
                } catch (e) {
                    if (e.name === 'AbortError') {
                        return { error: '请求已取消' };
                    }
                    
                    if (e.message.includes('network') || e.message.includes('Network') || e.message.includes('fetch')) {
                        if (retryCount < maxRetries - 1) {
                            retryCount++;
                            debugLog(`网络错误，正在重试 ${retryCount}/${maxRetries}...`);
                            continue;
                        }
                        return { error: '网络连接失败，请检查您的网络连接' };
                    }
                    
                    return { error: e.message };
                }
            }
            
            return { error: '请求失败，已达到最大重试次数' };
        },
    };

    const Config = {
        read() {
            try {
                const content = localStorage.getItem('huanmeng_config');
                if (content) {
                    return JSON.parse(content);
                }
            } catch (e) {
                console.error('读取配置失败:', e);
            }
            
            return {
                log: [],
                settings: {
                    chatApiKey: "",
                    imgApiKey: "",
                    chatApiUrl: OPENAI_OFFICIAL_BASE_URL,
                    imgApiUrl: GRS_DEFAULT_BASE_URL,
                    grsRegion: "overseas",
                    volcengineApiUrl: VOLCENGINE_DEFAULT_BASE_URL,
                    volcengineApiKey: "",
                    volcengineImageModel: VOLCENGINE_DEFAULT_IMAGE_MODEL,
                    volcengineChatModel: VOLCENGINE_DEFAULT_CHAT_MODEL,
                    newApiUrl: NEWAPI_DEFAULT_BASE_URL,
                    newApiKey: "",
                    newApiImageModel: "",
                    xaiApiUrl: XAI_DEFAULT_BASE_URL,
                    xaiApiKey: "",
                    grok2apiApiUrl: GROK2API_DEFAULT_BASE_URL,
                    grok2apiApiKey: "",
                    sub2apiApiUrl: SUB2API_DEFAULT_BASE_URL,
                    sub2apiApiKey: "",
                    fireflyApiUrl: FIREFLY_DEFAULT_BASE_URL,
                    fireflyApiKey: "",
                    googleApiKey: "",
                    googleAiEnabled: true,
                    chatModel: DEFAULT_GRS_CHAT_MODEL,
                    imgModel: DEFAULT_IMAGE_MODEL,
                    imgResolution: DEFAULT_IMAGE_RESOLUTION,
                    textSystemPromptPositive: DEFAULT_TEXT_SYSTEM_PROMPT_POSITIVE,
                    textSystemPromptNegative: DEFAULT_TEXT_SYSTEM_PROMPT_NEGATIVE,
                    imageSystemPromptPositive: DEFAULT_IMAGE_SYSTEM_PROMPT_POSITIVE,
                    imageSystemPromptNegative: DEFAULT_IMAGE_SYSTEM_PROMPT_NEGATIVE,
                    model: "gemini-2.0-flash-exp",
                    imageWidth: 1024,
                    imageHeight: 1024,
                    widthUnit: "pixel",
                    heightUnit: "pixel",
                    textSizeMultiplier: 1,
                    galleryRetentionMode: "count",
                    galleryMaxCount: 30,
                    galleryMaxDays: 30,
                    // 圆环六个按钮的动作与名称。空对象 = 全部用默认，
                    // 也就是每个按钮干自己本来该干的事。
                    ring: { sectors: {} }
                },
                presets: []
            };
        },
        
        write(config) {
            try {
                localStorage.setItem('huanmeng_config', JSON.stringify(config));
                return true;
            } catch (e) {
                console.error('保存配置失败:', e);
                return false;
            }
        },
        
        saveSettings(settings) {
            const config = this.read();
            // 设置页那边是**按表单字段重建**整个 settings 对象的
            // （saveSettings() 里那个 Object.assign 只有表单字段，没有第二个参数）。
            // 只写 config.settings = settings 的话，表单里没有的键会被整块抹掉 ——
            // 圆环槽位、对话快捷提问这些「不在表单里的配置」，
            // 用户点一次「保存全部设置」就丢一次，而且没有任何提示。
            // 这里以旧值为底、新值覆盖：表单认识的键照常更新，
            // 不认识的键原样保留。
            config.settings = Object.assign({}, config.settings, settings);
            return this.write(config);
        },
        
        getSettings() {
            const config = this.read();
            return config.settings;
        },
        
        addLog(logEntry) {
            const config = this.read();
            config.log = config.log || [];
            config.log.unshift(logEntry);
            if (config.log.length > 100) {
                config.log = config.log.slice(0, 100);
            }
            return this.write(config);
        },
        
        getLogs() {
            const config = this.read();
            return config.log || [];
        },
        
        clearLogs() {
            const config = this.read();
            config.log = [];
            return this.write(config);
        },

        getTasks() {
            const config = this.read();
            return Array.isArray(config.tasks) ? config.tasks : [];
        },

        saveTasks(tasks) {
            const config = this.read();
            config.tasks = Array.isArray(tasks) ? tasks.slice(0, 80) : [];
            return this.write(config);
        },

        getServerPresets() {
            const config = this.read();
            return Array.isArray(config.serverPresets) ? config.serverPresets : [];
        },

        saveServerPresets(presets) {
            const config = this.read();
            config.serverPresets = Array.isArray(presets) ? presets : [];
            return this.write(config);
        },
        
        getPresets() {
            const config = this.read();
            return config.presets || [];
        },
    };
    
    function escapeHTML(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeHexColor(color, fallback) {
        const safeFallback = typeof fallback === 'string' && /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback.toLowerCase() : '#00f0ff';
        const raw = String(color || '').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
        if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
            return '#' + raw.slice(1).split('').map(function(ch) { return ch + ch; }).join('').toLowerCase();
        }
        return safeFallback;
    }

    function clampVfxSliderValue(value, fallback) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fallback;
        return Math.max(0, Math.min(100, Math.round(numeric)));
    }

    function normalizeVfxText(value, fallback) {
        const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
        if (text) return text;
        return String(fallback || '').trim();
    }

    function normalizeVfxReferenceImage(item) {
        if (!item || typeof item !== 'object') return null;
        const base64 = normalizeReferenceImageData(item.base64 || item);
        if (!base64) return null;
        return {
            base64: base64,
            label: String(item.label || '轨迹图').trim() || '轨迹图',
            bounds: item.bounds ? JSON.parse(JSON.stringify(item.bounds)) : null,
            role: 'vfx-trajectory'
        };
    }

    function getVfxEffectLabel(value) {
        const preset = VFX_EFFECT_PRESETS.find(function(item) { return item.value === value; });
        return preset ? preset.label : 'Energy Trail';
    }



    function getVfxMaterialLabel(value) {
        const preset = VFX_MATERIAL_PRESETS.find(function(item) { return item.value === value; });
        return preset ? preset.label : 'plasma light';
    }



    function normalizeVfxConfig(config) {
        const source = config && typeof config === 'object' ? config : {};
        const legacyStyle = ['neon', 'energy', 'glitch', 'dream'].indexOf(source.style) > -1 ? source.style : '';
        const effectPreset = ['energy-trail', 'neon-outline', 'glitch-shards', 'magic-circle', 'light-ribbon', 'custom'].indexOf(source.effectPreset) > -1
            ? source.effectPreset
            : (legacyStyle === 'neon' ? 'neon-outline' : legacyStyle === 'glitch' ? 'glitch-shards' : legacyStyle === 'dream' ? 'magic-circle' : 'energy-trail');
        const materialPreset = ['plasma', 'glassy', 'electric-particles', 'liquid-fire', 'dusty-aura', 'custom'].indexOf(source.materialPreset) > -1
            ? source.materialPreset
            : (legacyStyle === 'glitch' ? 'electric-particles' : legacyStyle === 'dream' ? 'glassy' : 'plasma');
        const motionPathText = normalizeVfxText(source.motionPathText || source.motion_shape || source.flowText, '');
        const particleText = normalizeVfxText(source.particleText || source.particle_style, '');
        const smokeText = normalizeVfxText(source.smokeText || source.smoke_style, '');
        const color = normalizeHexColor(source.color || source.colorHex, DEFAULT_VFX_CONFIG.color);
        const colorHsv = hexColorToHsv(color);
        return {
            enabled: !!source.enabled,
            color: color,
            saturation: clampVfxSliderValue(source.saturation, Math.round(colorHsv.s * 100)),
            brightness: clampVfxSliderValue(source.brightness != null ? source.brightness : source.value, Math.round(colorHsv.v * 100)),
            effectPreset: effectPreset,
            effectCustomName: normalizeVfxText(source.effectCustomName || source.effectName || '', ''),
            motionPathText: motionPathText,
            trajectoryReferenceImage: normalizeVfxReferenceImage(source.trajectoryReferenceImage),
            materialPreset: materialPreset,
            materialCustomName: normalizeVfxText(source.materialCustomName || source.materialName || '', ''),
            particleText: particleText,
            smokeEnabled: !!(source.smokeEnabled || smokeText),
            smokeText: smokeText
        };
    }

    function hexToRgbText(hex) {
        const safeHex = normalizeHexColor(hex, '#00f0ff');
        const value = safeHex.slice(1);
        const r = parseInt(value.slice(0, 2), 16);
        const g = parseInt(value.slice(2, 4), 16);
        const b = parseInt(value.slice(4, 6), 16);
        return 'RGB(' + r + ', ' + g + ', ' + b + ')';
    }

    function buildVfxPrompt(config) {
        const normalized = normalizeVfxConfig(config);
        const effectType = normalized.effectPreset === 'custom'
            ? normalizeVfxText(normalized.effectCustomName, 'cinematic energy effect')
            : getVfxEffectLabel(normalized.effectPreset);
        const materialStyle = normalized.materialPreset === 'custom'
            ? normalizeVfxText(normalized.materialCustomName, 'plasma light')
            : getVfxMaterialLabel(normalized.materialPreset);
        const baseMotionShape = normalizeVfxText(normalized.motionPathText, 'flowing arc around the body');
        const motionShape = normalized.trajectoryReferenceImage
            ? baseMotionShape + ', following the uploaded red trajectory guide reference'
            : baseMotionShape;
        const particleStyle = normalizeVfxText(normalized.particleText, 'glowing particles and trailing sparks');
        const smokeStyle = normalized.smokeEnabled
            ? normalizeVfxText(normalized.smokeText, 'dense volumetric smoke clouds, procedural fluid dynamics turbulence, intense bloom effect, ray-traced light bounce on environment and floor reflection')
            : 'no smoke or haze';
        return [
            VFX_PROMPT_BASE_TEMPLATE,
            '',
            'VFX generation area rule:',
            'Use the current image/selection only as the visual source. Do not force square ratio, do not crop to a small local patch, and do not restrict the effect to a tiny mask area. Let the effect expand naturally across the needed surrounding space while preserving the subject and composition.',
            '',
            'Effect parameters:',
            '- Color: ' + normalized.color + ' (' + hexToRgbText(normalized.color) + ')',
            '- Effect type: ' + effectType,
            '- Motion path: ' + motionShape,
            '- Material style: ' + materialStyle,
            '- Particle details: ' + particleStyle,
            '- Smoke details: ' + smokeStyle,
            '',
            'Add a ' + normalized.color + ' ' + effectType + ' around the subject,',
            'moving in a ' + motionShape + ' pattern,',
            'rendered as ' + materialStyle + ',',
            'with ' + particleStyle + ',',
            (normalized.smokeEnabled
                ? 'and accompanied by ' + smokeStyle + '.'
                : 'with a clean, restrained finish and no extra smoke.'),
            '',
            'The final effect must feel volumetric, premium, cinematic, spatially grounded, naturally composited into the original image, and driven by industrial-grade turbulence, bloom, reflection, and light bounce.'
        ].join('\n');
    }

    function rgbToHexColor(r, g, b) {
        const clamp = function(value) {
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) return 0;
            return Math.max(0, Math.min(255, Math.round(numeric)));
        };
        return '#' + [clamp(r), clamp(g), clamp(b)].map(function(value) {
            return value.toString(16).padStart(2, '0');
        }).join('');
    }

    function hsvToHexColor(h, s, v) {
        let hue = Number(h);
        let saturation = Number(s);
        let value = Number(v);
        if (!Number.isFinite(hue)) hue = 0;
        if (!Number.isFinite(saturation)) saturation = 1;
        if (!Number.isFinite(value)) value = 1;
        hue = ((hue % 360) + 360) % 360;
        saturation = Math.max(0, Math.min(1, saturation));
        value = Math.max(0, Math.min(1, value));
        const chroma = value * saturation;
        const segment = hue / 60;
        const x = chroma * (1 - Math.abs(segment % 2 - 1));
        let r1 = 0;
        let g1 = 0;
        let b1 = 0;
        if (segment >= 0 && segment < 1) {
            r1 = chroma; g1 = x; b1 = 0;
        } else if (segment < 2) {
            r1 = x; g1 = chroma; b1 = 0;
        } else if (segment < 3) {
            r1 = 0; g1 = chroma; b1 = x;
        } else if (segment < 4) {
            r1 = 0; g1 = x; b1 = chroma;
        } else if (segment < 5) {
            r1 = x; g1 = 0; b1 = chroma;
        } else {
            r1 = chroma; g1 = 0; b1 = x;
        }
        const m = value - chroma;
        return rgbToHexColor((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
    }

    function hexColorToHue(hex) {
        return hexColorToHsv(hex).h;
    }

    function hexColorToHsv(hex) {
        const safeHex = normalizeHexColor(hex, '#00f0ff').slice(1);
        const r = parseInt(safeHex.slice(0, 2), 16) / 255;
        const g = parseInt(safeHex.slice(2, 4), 16) / 255;
        const b = parseInt(safeHex.slice(4, 6), 16) / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const delta = max - min;
        let hue = 0;
        if (delta) {
            if (max === r) {
                hue = ((g - b) / delta) % 6;
            } else if (max === g) {
                hue = (b - r) / delta + 2;
            } else {
                hue = (r - g) / delta + 4;
            }
            hue = (((hue * 60) % 360) + 360) % 360;
        }
        const saturation = max === 0 ? 0 : delta / max;
        return {
            h: Math.round(hue),
            s: saturation,
            v: max
        };
    }

    function getVfxColorControlState() {
        const nativeColor = document.getElementById('vfxColor');
        const color = normalizeHexColor(nativeColor ? nativeColor.value : DEFAULT_VFX_CONFIG.color, DEFAULT_VFX_CONFIG.color);
        const fallbackHsv = hexColorToHsv(color);
        const saturationInput = document.getElementById('vfxColorSaturation');
        const brightnessInput = document.getElementById('vfxColorBrightness');
        return {
            color: color,
            hue: fallbackHsv.h,
            saturation: clampVfxSliderValue(saturationInput ? saturationInput.value : null, Math.round(fallbackHsv.s * 100)),
            brightness: clampVfxSliderValue(brightnessInput ? brightnessInput.value : null, Math.round(fallbackHsv.v * 100))
        };
    }

    function syncVfxSliderValueLabel(sliderId, value) {
        const display = document.getElementById(sliderId + 'Value');
        if (display) {
            display.textContent = clampVfxSliderValue(value, 0) + '%';
        }
    }

    function updateVfxColorFromControls(controlOverrides) {
        const state = Object.assign({}, getVfxColorControlState(), controlOverrides || {});
        state.hue = Number.isFinite(Number(state.hue)) ? ((Math.round(Number(state.hue)) % 360) + 360) % 360 : 0;
        state.saturation = clampVfxSliderValue(state.saturation, DEFAULT_VFX_CONFIG.saturation);
        state.brightness = clampVfxSliderValue(state.brightness, DEFAULT_VFX_CONFIG.brightness);
        const nextColor = hsvToHexColor(state.hue, state.saturation / 100, state.brightness / 100);
        setVfxColorValue(nextColor, {
            hue: state.hue,
            saturation: state.saturation,
            brightness: state.brightness
        });
        const nativeColor = document.getElementById('vfxColor');
        if (nativeColor) {
            nativeColor.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return nextColor;
    }

    async function createVfxDoodleLayer() {
        initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.action) {
            showStatus('Photoshop API 不可用，无法创建特效涂鸦层', 'error');
            return;
        }

        try {
            await psAPI.core.executeAsModal(async function() {
                const doc = psAPI.app.activeDocument;
                if (!doc) {
                    throw new Error('请先打开一张图片');
                }

                await psAPI.action.batchPlay([
                    {
                        _obj: 'make',
                        _target: [{ _ref: 'layer' }],
                        using: {
                            _obj: 'layer',
                            name: 'VFX-Draw-Here'
                        }
                    },
                    {
                        _obj: 'set',
                        _target: [{ _ref: 'color', _property: 'foregroundColor' }],
                        to: {
                            _obj: 'RGBColor',
                            red: 255,
                            grain: 64,
                            blue: 180
                        }
                    },
                    {
                        _obj: 'select',
                        _target: [{ _ref: 'paintbrushTool' }]
                    }
                ], {
                    synchronousExecution: true,
                    modalBehavior: 'execute'
                });
            }, { commandName: '创建特效涂鸦层' });

            showStatus('已创建 VFX-Draw-Here，并切换到画笔工具', 'success');
            showToast('已切到特效涂鸦层');
        } catch (error) {
            console.error('创建特效涂鸦层失败:', error);
            showStatus('创建特效涂鸦层失败: ' + error.message, 'error');
        }
    }

    async function syncVfxColorFromForeground() {
        initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.action) {
            showStatus('Photoshop API 不可用，无法吸取前景色', 'error');
            return;
        }

        try {
            let sampledHex = null;
            await psAPI.core.executeAsModal(async function() {
                const result = await psAPI.action.batchPlay([
                    {
                        _obj: 'get',
                        _target: [{ _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }]
                    }
                ], {
                    synchronousExecution: true,
                    modalBehavior: 'execute'
                });

                const foreground = result && result[0] ? result[0].foregroundColor : null;
                if (!foreground) {
                    throw new Error('无法读取当前前景色');
                }
                sampledHex = rgbToHexColor(foreground.red, foreground.grain, foreground.blue);
            }, { commandName: '吸取 Photoshop 前景色' });

            if (!sampledHex) {
                throw new Error('未获取到前景色');
            }

            const colorEl = document.getElementById('vfxColor');
            if (colorEl) {
                setVfxColorValue(sampledHex);
            }
            const config = collectVfxFormConfig();
            currentVfxConfig = config;
            if (config.enabled) {
                applyVfxPromptToTextarea();
            }
            showStatus('已同步 Photoshop 当前前景色', 'success');
            showToast('已吸取画面主色');
        } catch (error) {
            console.error('吸取 Photoshop 前景色失败:', error);
            showStatus('吸取前景色失败: ' + error.message, 'error');
        }
    }

    async function applyVfxBlendModeToActiveLayer() {
        initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.action) return;

        try {
            await psAPI.core.executeAsModal(async function() {
                await psAPI.action.batchPlay([
                    {
                        _obj: 'set',
                        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                        to: {
                            _obj: 'layer',
                            mode: {
                                _enum: 'blendMode',
                                _value: 'normal'
                            }
                        }
                    }
                ], {
                    synchronousExecution: true,
                    modalBehavior: 'execute'
                });
            }, { commandName: '应用正常混合模式' });
        } catch (error) {
            console.warn('设置图层正常混合模式失败:', error);
        }
    }

    async function runPhotoshopToolboxAction(actionName) {
        initCompatibility();
        if (!psAPI.isAvailable || !psAPI.app || !psAPI.core || !psAPI.action) {
            throw new Error('Photoshop API 不可用，请在 Photoshop 中加载插件');
        }
        const doc = psAPI.app.activeDocument;
        if (!doc) throw new Error('请先打开一张图片');

        const action = String(actionName || '');
        const interactiveActions = {
            gaussian: {
                commandName: '高斯模糊',
                descriptor: { _obj: 'gaussianBlur', radius: { _unit: 'pixelsUnit', _value: 4 } }
            },
            sharpen: {
                commandName: '智能锐化',
                descriptor: { _obj: 'smartSharpen' }
            },
            'high-pass': {
                commandName: '高反差保留',
                descriptor: { _obj: 'highPass', radius: { _unit: 'pixelsUnit', _value: 2 } }
            }
        };

        if (interactiveActions[action]) {
            const item = interactiveActions[action];
            const descriptor = Object.assign({}, item.descriptor, { _options: { dialogOptions: 'display' } });
            await psAPI.core.executeAsModal(async function() {
                await psAPI.action.batchPlay([descriptor], {
                    synchronousExecution: false,
                    modalBehavior: 'execute'
                });
            }, { commandName: item.commandName, interactive: true });
            return item.commandName + '已打开';
        }

        if (action === 'content-aware' || action === 'select-mask') {
            const bounds = await getSelectionBoundsInPixels();
            if (!bounds) throw new Error('请先创建有效选区');
            const menuValue = action === 'content-aware' ? 'contentAwareFill' : 'selectAndMask';
            const commandName = action === 'content-aware' ? '内容识别填充' : '选择并遮住';
            await psAPI.core.executeAsModal(async function() {
                await psAPI.action.batchPlay([{
                    _obj: 'select',
                    _target: [{ _ref: 'menuItem', _enum: 'menuItemType', _value: menuValue }]
                }], { synchronousExecution: false, modalBehavior: 'execute' });
            }, { commandName: commandName, interactive: true });
            return commandName + '已打开';
        }

        // 辉光流程会分阶段读取、计算并回写像素，各阶段自行管理 modal，不能包在外层 modal 中。
        if (action === 'glow') {
            await runGlowAction();
            return '辉光图层已创建';
        }

        await psAPI.core.executeAsModal(async function() {
            if (action === 'observer') {
                await psAPI.action.batchPlay([{
                    _obj: 'make',
                    _target: [{ _ref: 'adjustmentLayer' }],
                    using: {
                        _obj: 'adjustmentLayer',
                        name: '黑白观察层',
                        type: { _obj: 'blackAndWhite' }
                    }
                }], { synchronousExecution: true, modalBehavior: 'execute' });
                return;
            }

            if (action === 'neutral-gray') {
                await doc.createLayer({
                    name: '中性灰修图层',
                    blendMode: psAPI.constants && psAPI.constants.BlendMode ? psAPI.constants.BlendMode.SOFTLIGHT : undefined,
                    fillNeutral: true,
                    opacity: 100
                });
                return;
            }

            if (action === 'stamp') {
                await psAPI.action.batchPlay([{
                    _obj: 'mergeVisible',
                    duplicate: true
                }, {
                    _obj: 'set',
                    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                    to: { _obj: 'layer', name: '盖印图层' }
                }], { synchronousExecution: true, modalBehavior: 'execute' });
                return;
            }

            if (action === 'frequency') {
                const radiusEl = document.getElementById('ttToolFreqRadius');
                const radius = Math.max(1, Math.min(50, Number(radiusEl && radiusEl.value) || 10));
                const source = doc.activeLayers && doc.activeLayers[0];
                if (!source || typeof source.duplicate !== 'function') throw new Error('请先选择一个可复制的像素图层');

                const lowLayer = await source.duplicate();
                lowLayer.name = '低频 · 色彩光影';
                await psAPI.action.batchPlay([{
                    _obj: 'select',
                    _target: [{ _ref: 'layer', _id: lowLayer.id }],
                    makeVisible: false
                }, {
                    _obj: 'gaussianBlur',
                    radius: { _unit: 'pixelsUnit', _value: radius }
                }], { synchronousExecution: true, modalBehavior: 'execute' });

                const highLayer = await source.duplicate();
                highLayer.name = '高频 · 纹理细节';
                await psAPI.action.batchPlay([{
                    _obj: 'select',
                    _target: [{ _ref: 'layer', _id: highLayer.id }],
                    makeVisible: false
                }, {
                    _obj: 'highPass',
                    radius: { _unit: 'pixelsUnit', _value: radius }
                }, {
                    _obj: 'set',
                    _target: [{ _ref: 'layer', _id: highLayer.id }],
                    to: {
                        _obj: 'layer',
                        mode: { _enum: 'blendMode', _value: 'linearLight' }
                    }
                }], { synchronousExecution: true, modalBehavior: 'execute' });
                return;
            }

            throw new Error('未知工具动作：' + action);
        }, { commandName: '幻梦 工具箱' });

        const labels = {
            observer: '黑白观察层已创建',
            'neutral-gray': '中性灰修图层已创建',
            frequency: '高低频图层已创建',
            stamp: '盖印图层已创建',
            glow: '辉光图层已创建'
        };
        return labels[action] || '工具执行完成';
    }

    function loadTaskEntries() {
        taskEntries = Config.getTasks().map(function(task) {
            if (task && (task.state === 'running' || task.state === 'queued' || task.state === 'returning')) {
                return Object.assign({}, task, { state: 'cancelled', detail: '插件重载，任务状态已结束' });
            }
            return task;
        }).filter(Boolean);
        Config.saveTasks(taskEntries);
        renderTaskCenter();
    }

    function createTaskEntry(meta) {
        const task = Object.assign({
            id: 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            title: '图像生成',
            state: 'queued',
            progress: 0,
            completed: 0,
            total: 1,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            model: '',
            provider: '',
            prompt: '',
            detail: '等待提交'
        }, meta || {});
        taskEntries.unshift(task);
        taskEntries = taskEntries.slice(0, 80);
        Config.saveTasks(taskEntries);
        renderTaskCenter();
        return task.id;
    }

    function updateTaskEntry(taskId, patch) {
        const index = taskEntries.findIndex(function(task) { return task.id === taskId; });
        if (index < 0) return;
        taskEntries[index] = Object.assign({}, taskEntries[index], patch || {}, { updatedAt: Date.now() });
        if (['completed', 'failed', 'cancelled'].indexOf(taskEntries[index].state) >= 0) taskEntries[index].finishedAt = Date.now();
        Config.saveTasks(taskEntries);
        renderTaskCenter();
    }

    function taskStateLabel(state) {
        return ({ queued: '等待中', running: '生成中', returning: '正在回传', waiting_return: '等待回传', completed: '已完成', failed: '失败', cancelled: '已取消' })[state] || state;
    }

    function renderTaskCenter() {
        const list = document.getElementById('taskCenterList');
        const badge = document.getElementById('taskRunningBadge');
        const runningCount = taskEntries.filter(function(task) { return ['queued', 'running', 'returning', 'waiting_return'].indexOf(task.state) >= 0; }).length;
        if (badge) badge.textContent = runningCount + ' RUNNING';
        if (!list) return;
        if (!taskEntries.length) {
            list.innerHTML = '<div class="info-text empty-state">暂无任务</div>';
            return;
        }
        list.innerHTML = taskEntries.map(function(task) {
            const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
            const canReturn = task.state === 'waiting_return' && !!pendingReturnCache[task.id];
            // 取消按钮按「这个任务是否还有活的上下文」判断，而不是「它是不是
            // 当前唯一那个任务」—— 并发下同时有好几个任务在跑，每个都要能取消。
            const canCancel = generationContexts.has(task.id) && ['queued', 'running'].indexOf(task.state) >= 0;
            return '<div class="task-card" data-task-id="' + escapeHTML(task.id) + '">' +
                '<div class="task-card-head"><div class="task-card-title">' + escapeHTML(task.title || '图像生成') + '</div><span class="task-state ' + escapeHTML(task.state) + '">' + escapeHTML(taskStateLabel(task.state)) + '</span></div>' +
                '<div class="task-progress-track"><div class="task-progress-bar" style="width:' + progress + '%"></div></div>' +
                '<div class="task-card-meta">' + escapeHTML(task.detail || '') + '<br>' + escapeHTML(task.model || '') + (task.total ? ' · ' + (task.completed || 0) + '/' + task.total : '') + '</div>' +
                ((canReturn || canCancel) ? '<div class="task-card-actions">' +
                    (canReturn ? '<button class="btn btn-primary" data-task-action="return">重新回传</button>' : '') +
                    (canCancel ? '<button class="btn btn-secondary" data-task-action="cancel">取消任务</button>' : '') +
                '</div>' : '') +
            '</div>';
        }).join('');
    }

    function getGalleryPolicy() {
        const settings = currentSettings || Config.getSettings() || {};
        return {
            mode: settings.galleryRetentionMode || 'count',
            maxCount: Number(settings.galleryMaxCount) || 30,
            maxDays: Number(settings.galleryMaxDays) || 30
        };
    }

    function getGenerationSourceLabel(type, model) {
        const labels = {
            'img2img': '图像生成',
            'runninghub': 'RunningHub',
            'space-fx': '空间特效',
            'color-match': '融合校色',
            'effect-transfer': '特效迁移',
            'ai-super-resolution': 'AI 超分辨率',
            'composite-assistant': '融合助手',
            'glow': '辉光'
        };
        return labels[type] || model || type || '幻梦 AI';
    }

    // 为画廊卡片生成缩略图（仅浏览器 / H5 环境）。
    // 卡片只有约 180×132，而原图 base64 常有数 MB；UXP 对超大 data URL 的
    // <img> 既不渲染也不触发 onerror，画廊就是一片空白且无任何报错。
    // 注意：这条路径内部是 new Image() 解码，UXP 下同样会失败，
    // 所以 Photoshop 环境不走这里，缩略图由回图成功后从画布抓取补写。
    async function createGalleryThumbnail(dataUrl) {
        try {
            const canvas = await loadPngToCanvas(dataUrl, 320);
            if (!canvas || !canvas.width || !canvas.height) return '';
            if (typeof canvas.toDataURL === 'function') {
                try {
                    const jpeg = canvas.toDataURL('image/jpeg', 0.72);
                    if (jpeg && jpeg.indexOf('data:image/jpeg') === 0) return jpeg;
                } catch (error) {
                    // 部分 UXP 版本不支持 canvas.toDataURL，走下面的成像 API
                }
            }
            const context = canvas.getContext('2d', { willReadFrequently: true });
            return await encodeBrowserImageDataToDataUrl(
                context.getImageData(0, 0, canvas.width, canvas.height)
            );
        } catch (error) {
            console.warn('生成画廊缩略图失败，预览将回退到原图:', error);
            return '';
        }
    }

    async function archiveGeneratedImage(dataUrl, metadata) {
        if (!window.HuanmengGalleryStore || !dataUrl) return null;
        try {
            // Photoshop 环境不在这一刻生成缩略图（只能靠 new Image() 解码，UXP 解不了），
            // 改由回图成功后的 setThumbnail 从画布抓取补写。
            const thumb = isGalleryBrowserMode() ? await createGalleryThumbnail(dataUrl) : '';
            return await window.HuanmengGalleryStore.add(dataUrl, metadata, getGalleryPolicy(), thumb);
        } catch (error) {
            console.warn('生成图已完成，但保存到画廊失败:', error);
            return null;
        }
    }

    function isGalleryBrowserMode() {
        return !initCompatibility();
    }

    function closeGalleryPreview() {
        const overlay = document.querySelector('.gallery-lightbox');
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    async function downloadGalleryItem(itemId) {
        const store = window.HuanmengGalleryStore;
        const item = store && store.list().find(function(entry) { return entry.id === itemId; });
        if (!item) throw new Error('画廊记录不存在');
        const dataUrl = await store.getDataUrl(itemId);
        if (!dataUrl) throw new Error('画廊图片文件不存在');
        const extension = /^data:image\/jpe?g/i.test(dataUrl) ? 'jpg' : /^data:image\/webp/i.test(dataUrl) ? 'webp' : 'png';
        const source = String(item.sourceLabel || item.model || 'huanmeng-ai').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 48);
        const anchor = document.createElement('a');
        anchor.href = dataUrl;
        anchor.download = source + '-' + new Date(Number(item.createdAt) || Date.now()).toISOString().replace(/[:.]/g, '-') + '.' + extension;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        showToast('图片已下载');
    }

    async function openGalleryPreview(itemId) {
        const store = window.HuanmengGalleryStore;
        const item = store && store.list().find(function(entry) { return entry.id === itemId; });
        if (!item) throw new Error('画廊记录不存在');
        const dataUrl = await store.getDataUrl(itemId);
        if (!dataUrl) throw new Error('画廊图片文件不存在');
        closeGalleryPreview();
        const overlay = document.createElement('div');
        overlay.className = 'gallery-lightbox';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        const panel = document.createElement('div');
        panel.className = 'gallery-lightbox-panel';
        const image = document.createElement('img');
        image.src = dataUrl;
        image.alt = item.sourceLabel || '生成图片大图预览';
        image.title = '双击下载原图';
        image.ondblclick = function(event) {
            event.preventDefault();
            downloadGalleryItem(itemId).catch(function(error) { showStatus('下载失败：' + error.message, 'error'); });
        };
        const footer = document.createElement('div');
        footer.className = 'gallery-lightbox-footer';
        const info = document.createElement('div');
        info.className = 'gallery-lightbox-info';
        info.textContent = (item.sourceLabel || '生成图片') + (item.model ? ' · ' + item.model : '') + ' · 双击图片下载';
        const actions = document.createElement('div');
        actions.className = 'gallery-lightbox-actions';
        const downloadButton = document.createElement('button');
        downloadButton.type = 'button';
        downloadButton.className = 'btn btn-primary';
        downloadButton.textContent = '下载原图';
        downloadButton.onclick = function() { downloadGalleryItem(itemId).catch(function(error) { showStatus('下载失败：' + error.message, 'error'); }); };
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'btn btn-secondary';
        closeButton.textContent = '关闭';
        closeButton.onclick = closeGalleryPreview;
        actions.appendChild(downloadButton);
        actions.appendChild(closeButton);
        footer.appendChild(info);
        footer.appendChild(actions);
        panel.appendChild(image);
        panel.appendChild(footer);
        overlay.appendChild(panel);
        overlay.onclick = function(event) { if (event.target === overlay) closeGalleryPreview(); };
        document.body.appendChild(overlay);
    }

    async function renderGallery() {
        const grid = document.getElementById('galleryGrid');
        const summary = document.getElementById('gallerySummary');
        if (!grid || !window.HuanmengGalleryStore) return;
        const items = window.HuanmengGalleryStore.list();
        const browserMode = isGalleryBrowserMode();
        if (summary) summary.textContent = browserMode
            ? '已保存 ' + items.length + ' 张 · 单击放大，双击下载原图'
            : '已保存 ' + items.length + ' 张 · 点击图片回放到原文档原位置';
        if (!items.length) {
            grid.innerHTML = '<div class="info-text empty-state">暂无生成图片</div>';
            return;
        }
        grid.innerHTML = '';
        for (const item of items) {
            const target = item.documentName || (item.documentId != null ? '文档 #' + item.documentId : '新文档');
            const status = item.placed ? '已回图' : '等待回放';
            const card = document.createElement('div');
            card.className = 'gallery-card';
            card.setAttribute('data-gallery-id', item.id);

            // 预览区用 div 而不是 button：
            // UXP 会给原生 <button> 画上自己的边框和圆角，`.gallery-card button`
            // 里的 border:0 压不住，实测整个预览区被渲染成一个大椭圆。
            // 点击是事件委托（closest('[data-gallery-action]')），div 一样能触发。
            const thumbBox = document.createElement('div');
            thumbBox.className = 'gallery-card-thumb';
            thumbBox.setAttribute('data-gallery-action', 'replay');
            thumbBox.title = browserMode ? '单击放大，双击下载' : '回放到原位置';
            const previewImage = document.createElement('img');
            previewImage.alt = item.sourceLabel || '生成图片';
            // 图片解码失败时 UXP 只会渲染出一个空白方块，没有任何提示。
            // 挂上 onerror 至少让失败可见、能定位。
            previewImage.onerror = function() {
                console.warn('画廊缩略图解码失败:', item.id, item.fileName || '');
                thumbBox.classList.add('gallery-preview-error');
                thumbBox.textContent = '缩略图无法解码';
            };
            thumbBox.appendChild(previewImage);
            card.appendChild(thumbBox);

            const body = document.createElement('div');
            body.className = 'gallery-card-body';
            const title = document.createElement('div');
            title.className = 'gallery-card-title';
            title.textContent = item.sourceLabel || '生成图片';
            body.appendChild(title);
            const meta = document.createElement('div');
            meta.className = 'gallery-card-meta';
            meta.textContent = new Date(Number(item.createdAt) || Date.now()).toLocaleString('zh-CN') + ' · ' + (item.model || '') + ' · ' + target + ' · ' + status;
            body.appendChild(meta);
            const actions = document.createElement('div');
            actions.className = 'gallery-card-actions';
            const replayButton = document.createElement('button');
            replayButton.className = 'btn btn-primary';
            replayButton.type = 'button';
            replayButton.textContent = browserMode ? '查看' : '放回';
            replayButton.setAttribute('data-gallery-action', 'replay');
            const deleteButton = document.createElement('button');
            deleteButton.className = 'btn btn-secondary';
            deleteButton.type = 'button';
            deleteButton.textContent = '删除';
            deleteButton.setAttribute('data-gallery-action', 'delete');
            actions.appendChild(replayButton);
            actions.appendChild(deleteButton);
            body.appendChild(actions);
            card.appendChild(body);
            grid.appendChild(card);

            try {
                const store = window.HuanmengGalleryStore;
                // 优先取缩略图。老记录没有缩略图时 getThumbnail 内部会回退到原图。
                const src = typeof store.getThumbnail === 'function'
                    ? await store.getThumbnail(item.id)
                    : await store.getDataUrl(item.id);
                if (!src) {
                    // 没有缩略图多是升级前存下的旧记录：UXP 解不了原图那种几 MB 的
                    // data URL，所以直接提示「无预览」，而不是渲染一个空白框。
                    thumbBox.classList.add('gallery-preview-error');
                    thumbBox.textContent = '无预览';
                    meta.textContent += ' · 无预览';
                    continue;
                }
                // 解码成功但一个像素都没出来，说明 UXP 吃不下这个 data URL。
                // 这种情况不会触发 onerror，只能靠 naturalWidth 判断。
                previewImage.onload = function() {
                    if (!previewImage.naturalWidth || !previewImage.naturalHeight) {
                        console.warn('画廊缩略图加载后无像素，data URL 长度:', src.length);
                        thumbBox.classList.add('gallery-preview-error');
                        thumbBox.textContent = '预览不可用（' + Math.round(src.length / 1024) + 'KB）';
                        return;
                    }
                    fitThumbInside(previewImage);
                };
                previewImage.src = src;
            } catch (error) {
                console.warn('读取画廊缩略图失败:', error);
                thumbBox.classList.add('gallery-preview-error');
                thumbBox.textContent = '缩略图不可用';
                meta.textContent += ' · 图片读取失败';
            }
        }
        // 卡片宽度由 flex 决定，渲染完才知道，所以方形尺寸在这里统一校正
        requestAnimationFrame(squareGalleryThumbs);
    }

    // 把缩略图按原始比例缩放到刚好放进方形预览区（contain），不裁切也不变形。
    // 不用 object-fit: UXP 对 img 的 object-fit 支持不稳定，实测 width/height:100%
    // 会把竖图拉变形，所以这里算好像素尺寸直接写死。
    function fitThumbInside(img) {
        const box = img.parentElement;
        if (!box) return;
        // 先把盒子撑成正方形（高度跟随宽度），再按这个尺寸做 contain
        const boxWidth = Math.round(box.clientWidth || 0);
        if (boxWidth > 0) box.style.height = boxWidth + 'px';
        const boxHeight = Math.round(box.clientHeight || boxWidth || 0);
        const naturalWidth = Number(img.naturalWidth) || 0;
        const naturalHeight = Number(img.naturalHeight) || 0;
        if (!boxWidth || !boxHeight || !naturalWidth || !naturalHeight) return;
        const scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
        img.style.width = Math.max(1, Math.round(naturalWidth * scale)) + 'px';
        img.style.height = Math.max(1, Math.round(naturalHeight * scale)) + 'px';
    }

    function squareGalleryThumbs() {
        const grid = document.getElementById('galleryGrid');
        if (!grid) return;
        Array.from(grid.querySelectorAll('.gallery-card-thumb')).forEach(function(box) {
            const width = Math.round(box.clientWidth || 0);
            if (width > 0) box.style.height = width + 'px';
            const img = box.querySelector('img');
            if (img) fitThumbInside(img);
        });
    }

    async function replayGalleryItem(itemId) {
        const store = window.HuanmengGalleryStore;
        const item = store && store.list().find(function(entry) { return entry.id === itemId; });
        if (!item) throw new Error('画廊记录不存在');
        const dataUrl = await store.getDataUrl(itemId);
        if (!dataUrl) throw new Error('画廊图片文件不存在');
        const ok = await downloadAndPlaceDocument(dataUrl, item.width, item.height, item.prompt, item.type, new Date().toLocaleString('zh-CN'), item.model, {
            bounds: item.bounds || null,
            documentId: item.documentId == null ? null : item.documentId,
            documentName: item.documentName || '',
            galleryItemId: item.id,
            skipArchive: true
        });
        if (ok === false) throw new Error('回放失败');
        await renderGallery();
    }

    async function retryTaskReturn(taskId) {
        const cached = pendingReturnCache[taskId];
        if (!cached) throw new Error('回图缓存已失效，请重新生成');
        const previousBounds = savedSelectionBounds;
        const previousDocumentId = savedDocumentId;
        updateTaskEntry(taskId, { state: 'returning', detail: '正在重新回传 Photoshop', progress: 92 });
        try {
            const items = Array.isArray(cached.items) ? cached.items : [cached];
            let completed = 0;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                savedSelectionBounds = item.bounds || previousBounds;
                savedDocumentId = item.documentId == null ? previousDocumentId : item.documentId;
                const ok = await downloadAndPlaceDocument(item.imageUrl, item.width, item.height, item.prompt, item.type, item.timestamp, item.model, item);
                if (ok === false) throw new Error('第 ' + (i + 1) + ' 张图片回传失败');
                completed++;
                updateTaskEntry(taskId, { state: 'returning', completed: completed, total: items.length, detail: '正在回传 ' + completed + '/' + items.length, progress: 92 + Math.round(completed / items.length * 7) });
            }
            delete pendingReturnCache[taskId];
            updateTaskEntry(taskId, { state: 'completed', detail: '回传完成', progress: 100, completed: items.length, total: items.length });
        } finally {
            savedSelectionBounds = previousBounds;
            savedDocumentId = previousDocumentId;
        }
    }

    function getToolPreviewDataUrl() {
        const preview = document.getElementById('previewImage');
        return selectedImageBase64 || (preview && preview.src && preview.src.indexOf('data:image') === 0 ? preview.src : '');
    }

    async function captureToolSourceImage() {
        const isUxp = initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.imaging || !psAPI.app.activeDocument) {
            const existing = getToolPreviewDataUrl();
            if (existing) return existing;
            if (!isUxp) {
                const upload = await pickBrowserImage('上传工具输入图片');
                selectedImageBase64 = upload.base64;
                savedSelectionBounds = upload.bounds;
                savedDocumentId = null;
                updatePrimaryImagePreview(upload.base64, upload.bounds, upload.label);
                return upload.base64;
            }
            throw new Error('请在 Photoshop 中打开图片');
        }
        let bounds = await getSelectionBoundsInPixels();
        if (!bounds) {
            const doc = psAPI.app.activeDocument;
            const width = toNumber(doc.width);
            const height = toNumber(doc.height);
            bounds = { left: 0, top: 0, right: width, bottom: height, width: width, height: height };
        }
        const base64 = await getImageDataToBase64(bounds);
        if (!base64) throw new Error('读取画面失败');
        selectedImageBase64 = 'data:image/png;base64,' + base64.replace(/^data:image\/\w+;base64,/, '');
        savedSelectionBounds = bounds;
        savedDocumentId = psAPI.app.activeDocument ? psAPI.app.activeDocument.id : null;
        return selectedImageBase64;
    }

    function rgbaImageDataFromPhotoshopBuffer(rawData, width, height, components) {
        const pixelCount = Math.max(1, width * height);
        const source = rawData instanceof Uint8Array
            ? rawData
            : (rawData && rawData.buffer instanceof ArrayBuffer
                ? new Uint8Array(rawData.buffer, rawData.byteOffset || 0, rawData.byteLength || rawData.buffer.byteLength)
                : new Uint8Array(rawData || 0));
        const channelCount = Math.max(1, Number(components) || Math.round(source.length / pixelCount) || 4);
        const rgba = new Uint8ClampedArray(pixelCount * 4);
        if (channelCount === 4 && source.length >= rgba.length) {
            rgba.set(source.subarray(0, rgba.length));
        } else {
            for (let pixel = 0; pixel < pixelCount; pixel++) {
                const sourceOffset = pixel * channelCount;
                const targetOffset = pixel * 4;
                if (channelCount === 1) {
                    rgba[targetOffset] = source[sourceOffset] || 0;
                    rgba[targetOffset + 1] = source[sourceOffset] || 0;
                    rgba[targetOffset + 2] = source[sourceOffset] || 0;
                } else {
                    rgba[targetOffset] = source[sourceOffset] || 0;
                    rgba[targetOffset + 1] = source[sourceOffset + 1] || 0;
                    rgba[targetOffset + 2] = source[sourceOffset + 2] || 0;
                }
                rgba[targetOffset + 3] = channelCount > 3 ? source[sourceOffset + 3] : 255;
            }
        }
        return { width: width, height: height, data: rgba };
    }

    async function captureBoundsToBrowserImageData(bounds, maxDimension, layerId) {
        initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.imaging || !psAPI.app.activeDocument) {
            throw new Error('Photoshop Imaging API 不可用');
        }
        const normalized = normalizeBoundsObject(bounds);
        if (!normalized) throw new Error('画面范围无效');
        const sourceWidth = Math.max(1, Math.round(normalized.width));
        const sourceHeight = Math.max(1, Math.round(normalized.height));
        const limit = Math.max(1, Number(maxDimension) || Math.max(sourceWidth, sourceHeight));
        const scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
        const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
        const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
        const documentId = psAPI.app.activeDocument.id;
        const requestedLayerId = Number(layerId);

        return psAPI.core.executeAsModal(async function() {
            let imageData = null;
            try {
                const request = {
                    documentID: documentId,
                    sourceBounds: {
                        left: normalized.left,
                        top: normalized.top,
                        right: normalized.right,
                        bottom: normalized.bottom
                    },
                    targetSize: { width: targetWidth, height: targetHeight },
                    colorSpace: 'RGB',
                    colorProfile: 'sRGB IEC61966-2.1',
                    componentSize: 8,
                    applyAlpha: true
                };
                if (Number.isFinite(requestedLayerId)) request.layerID = requestedLayerId;
                const result = await psAPI.imaging.getPixels(request);
                imageData = result && result.imageData;
                if (!imageData || typeof imageData.getData !== 'function') throw new Error('Photoshop 未返回可读像素');
                const rawData = await imageData.getData({ chunky: true });
                const width = Math.max(1, Number(imageData.width) || targetWidth);
                const height = Math.max(1, Number(imageData.height) || targetHeight);
                return rgbaImageDataFromPhotoshopBuffer(rawData, width, height, imageData.components);
            } finally {
                disposeImageData(imageData);
            }
        }, { commandName: Number.isFinite(requestedLayerId) ? '读取图层像素' : '读取画面像素' });
    }

    function resizeImageDataMaxDimension(imageData, maxDimension) {
        const width = Math.max(1, Number(imageData && imageData.width) || 1);
        const height = Math.max(1, Number(imageData && imageData.height) || 1);
        const limit = Math.max(1, Number(maxDimension) || Math.max(width, height));
        const scale = Math.min(1, limit / Math.max(width, height));
        return resizeRgbaImageData(imageData, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    }

    async function captureCurrentGlowPreviewImageData() {
        initCompatibility();
        if (!psAPI.app || !psAPI.app.activeDocument) {
            const dataUrl = await captureToolSourceImage();
            const canvas = await loadPngToCanvas(dataUrl, 1600);
            if (!canvas) throw new Error('上传图片无法解码');
            return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
        }
        let bounds = await getSelectionBoundsInPixels();
        if (!bounds) {
            const doc = psAPI.app.activeDocument;
            const width = toNumber(doc.width);
            const height = toNumber(doc.height);
            bounds = { left: 0, top: 0, right: width, bottom: height, width: width, height: height };
        }
        savedSelectionBounds = bounds;
        savedDocumentId = psAPI.app.activeDocument.id;
        return captureBoundsToBrowserImageData(bounds, 192);
    }

    async function encodeBrowserImageDataToDataUrl(browserImageData) {
        if (!browserImageData || !browserImageData.data || !browserImageData.width || !browserImageData.height) {
            throw new Error('待编码辉光像素无效');
        }
        if (!psAPI.imaging || typeof psAPI.imaging.createImageDataFromBuffer !== 'function') {
            const canvas = document.createElement('canvas');
            canvas.width = browserImageData.width;
            canvas.height = browserImageData.height;
            const context = canvas.getContext('2d');
            const output = context.createImageData(browserImageData.width, browserImageData.height);
            output.data.set(browserImageData.data);
            context.putImageData(output, 0, 0);
            return canvas.toDataURL('image/png');
        }
        const source = browserImageData.data;
        const pixelCount = browserImageData.width * browserImageData.height;
        // UXP encodeImageData 只支持 JPEG；编码前移除 alpha，避免 RGBA 被拒绝。
        const pixelBytes = new Uint8Array(pixelCount * 3);
        for (let pixel = 0; pixel < pixelCount; pixel++) {
            pixelBytes[pixel * 3] = source[pixel * 4];
            pixelBytes[pixel * 3 + 1] = source[pixel * 4 + 1];
            pixelBytes[pixel * 3 + 2] = source[pixel * 4 + 2];
        }
        let photoshopImageData = null;
        try {
            photoshopImageData = await psAPI.imaging.createImageDataFromBuffer(pixelBytes, {
                width: browserImageData.width,
                height: browserImageData.height,
                components: 3,
                chunky: true,
                colorSpace: 'RGB',
                colorProfile: 'sRGB IEC61966-2.1'
            });
            const encoded = await psAPI.imaging.encodeImageData({
                imageData: photoshopImageData,
                base64: true
            });
            const payload = String(encoded || '').replace(/^data:image\/\w+;base64,/, '');
            if (!payload) throw new Error('Photoshop 未返回 PNG 数据');
            return 'data:image/jpeg;base64,' + payload;
        } finally {
            disposeImageData(photoshopImageData);
        }
    }

    function toolEditorShell(title, desc, body) {
        const backLabel = toolEditorReturnTab === 'apps' ? '返回快速' : '返回工具箱';
        const routeControls = ['vfx', 'light'].indexOf(activeToolEditor) > -1
            ? buildIndependentGenerationControls('tool:' + activeToolEditor, 'toolRoute', '本工具独立生成参数')
            : '';
        return '<div class="tt-tool-editor">' +
            '<div class="module-hero"><div><div class="module-title">' + escapeHTML(title) + '</div><div class="module-desc">' + escapeHTML(desc) + '</div></div><div class="module-badge">LIVE</div></div>' +
            '<div class="module-card tt-tool-editor-head"><button id="btnBackFromToolEditor" class="btn btn-secondary" type="button">' + backLabel + '</button><button id="btnToolReadImage" class="btn btn-secondary" type="button">读取当前选区 / 画布</button></div>' + routeControls + body +
        '</div>';
    }

    function bindToolEditorCommon(onImage) {
        if (['vfx', 'light'].indexOf(activeToolEditor) > -1) {
            bindIndependentGenerationControls('tool:' + activeToolEditor, 'toolRoute', document.getElementById('toolEditorContent'));
        }
        const back = document.getElementById('btnBackFromToolEditor');
        if (back) back.onclick = function() {
            if (scopeRefreshTimer) clearInterval(scopeRefreshTimer);
            scopeRefreshTimer = null;
            const returnTab = toolEditorReturnTab === 'apps' ? 'apps' : 'toolbox';
            switchTab(returnTab);
        };
        const read = document.getElementById('btnToolReadImage');
        if (read) read.onclick = async function() {
            read.disabled = true;
            try {
                const dataUrl = await captureToolSourceImage();
                if (onImage) onImage(dataUrl);
                showStatus('已读取当前画面', 'success');
            } catch (error) {
                showStatus('读取失败：' + error.message, 'error');
            } finally { read.disabled = false; }
        };
    }

    function setPreviewImages(dataUrl) {
        document.querySelectorAll('#toolEditorContent [data-tool-preview-img]').forEach(function(image) {
            image.src = dataUrl || '';
            image.style.display = dataUrl ? 'block' : 'none';
        });
        document.querySelectorAll('#toolEditorContent .tt-live-preview-empty').forEach(function(empty) { empty.style.display = dataUrl ? 'none' : 'block'; });
    }

    function getRenderedRange(root, inputId) {
        const scope = root && root.querySelectorAll ? root : document;
        return Array.from(scope.querySelectorAll('[data-rendered-range-for]')).find(function(slider) {
            return slider.getAttribute('data-rendered-range-for') === inputId;
        }) || null;
    }

    function initAllRenderedRanges(root) {
        const scope = root && root.querySelectorAll ? root : document;
        Array.from(scope.querySelectorAll('input[type="range"]')).forEach(function(input, index) {
            if (!input.id) input.id = 'renderedRange_' + Date.now() + '_' + index;
            if (input.classList.contains('vfx-hidden-native') && input.parentElement && input.parentElement.querySelector('[data-slider-for="' + input.id + '"]')) return;
            if (input.closest('.tt-control-row')) return;
            const existing = getRenderedRange(document, input.id);
            if (existing) {
                if (typeof existing._syncRenderedRange === 'function') existing._syncRenderedRange();
                return;
            }

            const slider = document.createElement('div');
            slider.className = 'tt-glow-slider rendered-range';
            slider.dataset.renderedRangeFor = input.id;
            slider.tabIndex = input.disabled ? -1 : 0;
            slider.setAttribute('role', 'slider');
            slider.setAttribute('aria-label', input.getAttribute('aria-label') || input.title || input.id);
            slider.innerHTML = '<div class="tt-glow-slider-track"><div class="tt-glow-slider-fill"></div></div><div class="tt-glow-slider-thumb"></div>';
            const accent = input.classList.contains('cam3d-slider-az') ? '#54c2ff'
                : input.classList.contains('cam3d-slider-el') ? '#bb73ff'
                : input.classList.contains('cam3d-slider-ds') ? '#ff9438'
                : input.id === 'camZoomSlider' ? '#94a3b8'
                : '#38bdf8';
            slider.style.setProperty('--range-accent', accent);
            input.parentNode.insertBefore(slider, input);
            input.classList.add('range-native-rendered');

            const numberOfDecimals = function(step) {
                const text = String(step || '1');
                return text.indexOf('.') >= 0 ? text.length - text.indexOf('.') - 1 : 0;
            };
            const sync = function() {
                const min = Number(input.min || 0);
                const max = Number(input.max || 100);
                const value = Math.max(min, Math.min(max, Number(input.value || 0)));
                const percent = max === min ? 0 : (value - min) / (max - min) * 100;
                const fill = slider.querySelector('.tt-glow-slider-fill');
                const thumb = slider.querySelector('.tt-glow-slider-thumb');
                if (fill) fill.style.width = percent + '%';
                if (thumb) thumb.style.left = 'calc(7px + (' + percent + ' * (100% - 14px) / 100))';
                slider.setAttribute('aria-valuemin', String(min));
                slider.setAttribute('aria-valuemax', String(max));
                slider.setAttribute('aria-valuenow', String(value));
                slider.classList.toggle('disabled', !!input.disabled);
            };
            const setFromClientX = function(clientX) {
                if (input.disabled) return;
                const rect = slider.getBoundingClientRect();
                const usableWidth = Math.max(1, rect.width - 14);
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left - 7) / usableWidth));
                const min = Number(input.min || 0);
                const max = Number(input.max || 100);
                const step = Math.max(0.0001, Number(input.step) || 1);
                const raw = min + ratio * (max - min);
                const rounded = min + Math.round((raw - min) / step) * step;
                input.value = String(Number(Math.max(min, Math.min(max, rounded)).toFixed(numberOfDecimals(input.step))));
                input.dispatchEvent(new Event('input', { bubbles: true }));
                sync();
            };
            slider.addEventListener('pointerdown', function(event) {
                event.preventDefault();
                setFromClientX(event.clientX);
                const move = function(moveEvent) { setFromClientX(moveEvent.clientX); };
                const stop = function() {
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', stop);
                    window.removeEventListener('pointercancel', stop);
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', stop);
                window.addEventListener('pointercancel', stop);
            });
            slider.addEventListener('keydown', function(event) {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const min = Number(input.min || 0);
                const max = Number(input.max || 100);
                const step = Number(input.step) || 1;
                input.value = String(Math.max(min, Math.min(max, Number(input.value || 0) + (event.key === 'ArrowRight' ? step : -step))));
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                sync();
            });
            input.addEventListener('input', sync);
            input.addEventListener('change', sync);
            slider._syncRenderedRange = sync;
            sync();
        });
        if (scope === document && !document.documentElement.dataset.renderedRangeObserverBound && typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(function(mutations) {
                mutations.forEach(function(mutation) {
                    Array.from(mutation.addedNodes || []).forEach(function(node) {
                        if (!node || node.nodeType !== 1) return;
                        if (node.matches && node.matches('input[type="range"]')) initAllRenderedRanges(node.parentElement || document);
                        else if (node.querySelector && node.querySelector('input[type="range"]')) initAllRenderedRanges(node);
                    });
                });
            });
            observer.observe(document.body, { childList: true, subtree: true });
            document.documentElement.dataset.renderedRangeObserverBound = '1';
        }
    }

    function initToolRangeControls(root) {
        if (!root || !root.querySelectorAll) return;
        Array.from(root.querySelectorAll('.tt-control-row input[type="range"]')).forEach(function(input) {
            if (!input.id) return;
            const row = input.closest('.tt-control-row');
            if (!row || row.querySelector('[data-glow-slider-for="' + input.id + '"]') || row.querySelector('[data-tool-range-for="' + input.id + '"]')) return;
            const slider = document.createElement('div');
            slider.className = 'tt-glow-slider tt-tool-range-slider';
            slider.dataset.toolRangeFor = input.id;
            slider.tabIndex = 0;
            slider.setAttribute('role', 'slider');
            slider.setAttribute('aria-label', String((row.querySelector('label') || {}).textContent || input.id).trim());
            slider.innerHTML = '<div class="tt-glow-slider-track"><div class="tt-glow-slider-fill"></div></div><div class="tt-glow-slider-thumb"></div>';
            row.insertBefore(slider, input);

            const sync = function() {
                const min = Number(input.min || 0);
                const max = Number(input.max || 100);
                const value = Math.max(min, Math.min(max, Number(input.value || 0)));
                const percent = max === min ? 0 : (value - min) / (max - min) * 100;
                const fill = slider.querySelector('.tt-glow-slider-fill');
                const thumb = slider.querySelector('.tt-glow-slider-thumb');
                if (fill) fill.style.width = percent + '%';
                if (thumb) thumb.style.left = 'calc(7px + (' + percent + ' * (100% - 14px) / 100))';
                slider.setAttribute('aria-valuemin', String(min));
                slider.setAttribute('aria-valuemax', String(max));
                slider.setAttribute('aria-valuenow', String(value));
            };
            const setFromClientX = function(clientX) {
                const rect = slider.getBoundingClientRect();
                const usableWidth = Math.max(1, rect.width - 14);
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left - 7) / usableWidth));
                const min = Number(input.min || 0);
                const max = Number(input.max || 100);
                const step = Math.max(0.0001, Number(input.step) || 1);
                const raw = min + ratio * (max - min);
                input.value = String(Math.max(min, Math.min(max, Math.round(raw / step) * step)));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            };
            slider.addEventListener('pointerdown', function(event) {
                event.preventDefault();
                setFromClientX(event.clientX);
                const move = function(moveEvent) { setFromClientX(moveEvent.clientX); };
                const stop = function() {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', stop);
                    window.removeEventListener('pointercancel', stop);
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', stop);
                window.addEventListener('pointercancel', stop);
            });
            slider.addEventListener('keydown', function(event) {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const min = Number(input.min || 0);
                const max = Number(input.max || 100);
                const step = Number(input.step) || 1;
                input.value = String(Math.max(min, Math.min(max, Number(input.value || 0) + (event.key === 'ArrowRight' ? step : -step))));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            input.addEventListener('input', sync);
            sync();
        });
    }

    function renderGlowEditor() {
        const content = document.getElementById('toolEditorContent');
        if (!content) return;
        const glowSliderRow = function(id, label, value, min, max, output, group, extraLabel) {
            return '<div class="tt-control-row tt-glow-show' + (group === 'star' ? ' tt-glow-star' : group === 'streak' ? ' tt-glow-streak' : '') + '" data-glow="' + group + '">' +
                '<label>' + label + (extraLabel || '') + '</label>' +
                '<div class="tt-glow-slider" data-glow-slider-for="' + id + '" tabindex="0" role="slider" aria-label="' + label + '" aria-valuemin="' + min + '" aria-valuemax="' + max + '" aria-valuenow="' + value + '"><div class="tt-glow-slider-track"><div class="tt-glow-slider-fill"></div></div><div class="tt-glow-slider-thumb"></div></div>' +
                '<input id="' + id + '" type="range" min="' + min + '" max="' + max + '" step="1" value="' + value + '">' +
                '<output id="' + id + 'Out">' + output + '</output></div>';
        };
        const styleOptions = [
            ['none', '无'], ['darkSoft', '黑柔'], ['whiteSoft', '白柔'],
            ['shine', '辉光'], ['starburst', '星芒'], ['anamorphic', '宽幕拉丝']
        ];
        const styleSelect = styleOptions.map(function(s) {
            return '<option value="' + s[0] + '"' + (s[0] === 'shine' ? ' selected' : '') + '>' + s[1] + '</option>';
        }).join('');
        content.innerHTML = toolEditorShell('辉光面板', '实时预览高光辉光，确认后在 Photoshop 新图层执行。',
            '<div class="tt-tool-editor-grid"><div id="glowPreviewViewport" class="tt-live-preview tt-glow-preview"><div class="tt-live-preview-empty">读取选区后显示辉光预览</div><div class="tt-glow-preview-stage"><img id="glowPreviewImage" class="tt-glow-canvas" alt="辉光预览" style="display:none"></div><div class="tt-preview-zoom-controls"><button id="btnGlowZoomOut" class="tt-preview-zoom-btn" type="button" title="缩小预览">−</button><button id="btnGlowZoomReset" class="tt-preview-zoom-btn tt-preview-reset" type="button" title="适应窗口">适应</button><button id="btnGlowZoomIn" class="tt-preview-zoom-btn" type="button" title="放大预览">+</button></div></div>' +
            '<div class="tt-tool-controls"><div class="tt-control-card" id="glowControls">' +
            '<div class="tt-control-row tt-control-row-wide"><label>风格</label><select id="glowStyleSel">' + styleSelect + '</select></div>' +
            glowSliderRow('toolGlowStrength', '强度', 40, 0, 100, '40', 'effect') +
            glowSliderRow('toolGlowRadius', '扩散', 20, 1, 500, '20', 'bloom') +
            glowSliderRow('toolGlowThreshold', '阈值', 20, 0, 100, '0.20', 'effect') +
            glowSliderRow('toolGlowExposure', '曝光', 0, -100, 100, '0', 'tone') +
            '<div class="tt-control-row tt-glow-show" data-glow="tone"><label>高光色 <input id="toolGlowColorEnabled" type="checkbox" checked></label><div id="toolGlowColorPresets" class="tt-glow-color-presets"><button class="tt-glow-color-swatch selected" type="button" data-glow-color="#ffd27a" data-color-name="暖金" title="暖金"></button><button class="tt-glow-color-swatch" type="button" data-glow-color="#ffffff" data-color-name="纯白" title="纯白"></button><button class="tt-glow-color-swatch" type="button" data-glow-color="#8ad8ff" data-color-name="冰蓝" title="冰蓝"></button><button class="tt-glow-color-swatch" type="button" data-glow-color="#ff9f7a" data-color-name="珊瑚" title="珊瑚"></button><button class="tt-glow-color-swatch" type="button" data-glow-color="#c7a6ff" data-color-name="紫晶" title="紫晶"></button></div><input id="toolGlowColor" type="text" value="#ffd27a" style="display:none"><output id="toolGlowColorOut" class="tt-glow-color-name">暖金</output></div>' +
            glowSliderRow('toolGlowColorAmount', '色彩量', 0, 0, 100, '0', 'tone') +
            glowSliderRow('toolGlowChromatic', '色散', 0, 0, 100, '0', 'tone', ' <input id="toolGlowChromaticEnabled" type="checkbox" checked>') +
            glowSliderRow('toolGlowStarLength', '星芒长度', 58, 10, 220, '58', 'star') +
            glowSliderRow('toolGlowStarCount', '星芒边数', 6, 4, 12, '6', 'star') +
            glowSliderRow('toolGlowStarRotation', '星芒旋转', 0, -90, 90, '0', 'star') +
            glowSliderRow('toolGlowStarVisible', '星芒数量', 68, 0, 100, '68', 'star') +
            glowSliderRow('toolGlowStreakLength', '拉丝长度', 86, 16, 300, '86', 'streak') +
            glowSliderRow('toolGlowStreakVisible', '拉丝数量', 62, 0, 100, '62', 'streak') +
            '</div><div class="tt-tool-actions"><button id="btnToolGlow" class="btn btn-primary">应用辉光到新图层</button></div></div></div>');

        const numberValues = {
            toolGlowStrength: 'toolGlowStrengthOut',
            toolGlowRadius: 'toolGlowRadiusOut',
            toolGlowThreshold: 'toolGlowThresholdOut',
            toolGlowExposure: 'toolGlowExposureOut',
            toolGlowColorAmount: 'toolGlowColorAmountOut',
            toolGlowChromatic: 'toolGlowChromaticOut',
            toolGlowStarLength: 'toolGlowStarLengthOut',
            toolGlowStarCount: 'toolGlowStarCountOut',
            toolGlowStarRotation: 'toolGlowStarRotationOut',
            toolGlowStarVisible: 'toolGlowStarVisibleOut',
            toolGlowStreakLength: 'toolGlowStreakLengthOut',
            toolGlowStreakVisible: 'toolGlowStreakVisibleOut'
        };
        const glowSliderIds = [
            'toolGlowStrength', 'toolGlowRadius', 'toolGlowThreshold', 'toolGlowExposure',
            'toolGlowColorAmount', 'toolGlowChromatic', 'toolGlowStarLength', 'toolGlowStarCount',
            'toolGlowStarRotation', 'toolGlowStarVisible', 'toolGlowStreakLength', 'toolGlowStreakVisible'
        ];
        function readNum(id, fallback) {
            const el = document.getElementById(id);
            const numeric = Number(el ? el.value : '');
            return Math.max(-999, Math.min(9999, Number.isFinite(numeric) ? numeric : fallback));
        }
        function syncGlowSliderUi(id) {
            const input = document.getElementById(id);
            const slider = document.querySelector('[data-glow-slider-for="' + id + '"]');
            if (!input || !slider) return;
            const min = Number(input.min);
            const max = Number(input.max);
            const value = Math.max(min, Math.min(max, Number(input.value)));
            const percent = max === min ? 0 : (value - min) / (max - min) * 100;
            const fill = slider.querySelector('.tt-glow-slider-fill');
            const thumb = slider.querySelector('.tt-glow-slider-thumb');
            if (fill) fill.style.width = percent + '%';
            if (thumb) thumb.style.left = 'calc(7px + (' + percent + ' * (100% - 14px) / 100))';
            slider.setAttribute('aria-valuenow', String(value));
        }
        function updateOutputs() {
            const threshold = readNum('toolGlowThreshold', 20);
            document.getElementById('toolGlowThresholdOut').textContent = (threshold / 100).toFixed(2);
            ['toolGlowStrength', 'toolGlowRadius', 'toolGlowExposure', 'toolGlowColorAmount', 'toolGlowChromatic',
             'toolGlowStarLength', 'toolGlowStarCount', 'toolGlowStarRotation', 'toolGlowStarVisible',
             'toolGlowStreakLength', 'toolGlowStreakVisible'].forEach(function(id) {
                const out = document.getElementById(numberValues[id]);
                if (out) out.textContent = String(readNum(id, 0));
            });
            glowSliderIds.forEach(syncGlowSliderUi);
            const selectedColor = String((document.getElementById('toolGlowColor') || {}).value || '#ffd27a').toLowerCase();
            document.querySelectorAll('#toolGlowColorPresets .tt-glow-color-swatch').forEach(function(swatch) {
                const color = String(swatch.getAttribute('data-glow-color') || '').toLowerCase();
                swatch.style.background = color;
                swatch.classList.toggle('selected', color === selectedColor);
                if (color === selectedColor) {
                    const colorOutput = document.getElementById('toolGlowColorOut');
                    if (colorOutput) colorOutput.textContent = swatch.getAttribute('data-color-name') || color;
                }
            });
        }
        function applyStyleVisibility() {
            const style = String(document.getElementById('glowStyleSel').value || 'shine');
            const root = document.getElementById('glowControls');
            if (!root) return;
            root.querySelectorAll('.tt-glow-show, .tt-glow-star, .tt-glow-streak').forEach(function(row) {
                const group = row.getAttribute('data-glow') || '';
                let show = true;
                if (style === 'none') show = group !== 'effect' && group !== 'bloom' && group !== 'tone' && group !== 'star' && group !== 'streak';
                else if (style === 'starburst') show = group === 'star' || group === 'effect' || group === 'tone';
                else if (style === 'anamorphic') show = group === 'streak' || group === 'effect' || group === 'tone';
                else if (style === 'darkSoft' || style === 'whiteSoft') show = group === 'effect' || group === 'bloom' || group === 'tone';
                else show = group === 'effect' || group === 'bloom' || group === 'tone';
                row.style.display = show ? '' : 'none';
            });
        }

        let previewTimer = null;
        function schedulePreview() {
            if (previewTimer) clearTimeout(previewTimer);
            previewTimer = setTimeout(function() {
                renderGlowCanvasPreview().catch(function(error) { console.error('[glow] 预览失败:', error); });
            }, 120);
        }
        ['glowStyleSel', 'toolGlowStrength', 'toolGlowRadius', 'toolGlowThreshold', 'toolGlowExposure',
         'toolGlowColorEnabled', 'toolGlowColor', 'toolGlowColorAmount', 'toolGlowChromaticEnabled', 'toolGlowChromatic',
         'toolGlowStarLength', 'toolGlowStarCount', 'toolGlowStarRotation', 'toolGlowStarVisible',
         'toolGlowStreakLength', 'toolGlowStreakVisible'
        ].forEach(function(id) {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', function() { updateOutputs(); applyStyleVisibility(); schedulePreview(); });
        });
        document.getElementById('glowStyleSel').addEventListener('change', function() { applyStyleVisibility(); schedulePreview(); });

        document.querySelectorAll('#glowControls [data-glow-slider-for]').forEach(function(slider) {
            const inputId = slider.getAttribute('data-glow-slider-for');
            const input = document.getElementById(inputId);
            if (!input) return;
            const updateFromPointer = function(clientX) {
                const rect = slider.getBoundingClientRect();
                const usableWidth = Math.max(1, rect.width - 14);
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left - 7) / usableWidth));
                const min = Number(input.min);
                const max = Number(input.max);
                const step = Math.max(0.0001, Number(input.step) || 1);
                const rawValue = min + ratio * (max - min);
                const nextValue = Math.round(rawValue / step) * step;
                input.value = String(Math.max(min, Math.min(max, nextValue)));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            };
            slider.addEventListener('pointerdown', function(event) {
                event.preventDefault();
                updateFromPointer(event.clientX);
                const move = function(moveEvent) { updateFromPointer(moveEvent.clientX); };
                const end = function() {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', end);
                    window.removeEventListener('pointercancel', end);
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', end);
                window.addEventListener('pointercancel', end);
            });
            slider.addEventListener('keydown', function(event) {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const direction = event.key === 'ArrowRight' ? 1 : -1;
                const step = Number(input.step) || 1;
                const min = Number(input.min);
                const max = Number(input.max);
                input.value = String(Math.max(min, Math.min(max, Number(input.value) + direction * step)));
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
        });
        document.querySelectorAll('#toolGlowColorPresets .tt-glow-color-swatch').forEach(function(swatch) {
            swatch.onclick = function() {
                const colorInput = document.getElementById('toolGlowColor');
                if (!colorInput) return;
                colorInput.value = this.getAttribute('data-glow-color') || '#ffd27a';
                colorInput.dispatchEvent(new Event('input', { bubbles: true }));
            };
        });

        document.getElementById('btnToolGlow').onclick = async function() {
            const button = this;
            button.disabled = true;
            try {
                if (isMobileWebEnvironment()) {
                    const sourceUrl = await captureToolSourceImage();
                    const sourceCanvas = await loadPngToCanvas(sourceUrl, 2200);
                    if (!sourceCanvas) throw new Error('上传图片无法解码');
                    const sourceData = sourceCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
                    const result = window.GlowEngine.createPreview(sourceData, collectGlowUiParams(), true);
                    const outputUrl = await encodeBrowserImageDataToDataUrl(result.previewImageData);
                    const saved = await downloadAndPlaceDocument(outputUrl, result.previewImageData.width, result.previewImageData.height, '辉光参数处理', 'mobile-glow', new Date().toLocaleString('zh-CN'), '本地辉光引擎', { bounds: savedSelectionBounds, documentId: null });
                    if (!saved) throw new Error('辉光结果未能保存');
                    showStatus('辉光结果已保存到画廊', 'success');
                } else {
                    showStatus(await runPhotoshopToolboxAction('glow'), 'success');
                }
            } catch (error) {
                showStatus('辉光失败：' + error.message, 'error');
            } finally {
                button.disabled = false;
            }
        };
        bindToolEditorCommon(setGlowPreviewImage);
        glowPreviewZoom = 1;
        const zoomOutButton = document.getElementById('btnGlowZoomOut');
        const zoomResetButton = document.getElementById('btnGlowZoomReset');
        const zoomInButton = document.getElementById('btnGlowZoomIn');
        if (zoomOutButton) zoomOutButton.onclick = function() {
            glowPreviewZoom = Math.max(0.5, Math.round((glowPreviewZoom - 0.25) * 100) / 100);
            applyGlowPreviewZoom();
        };
        if (zoomResetButton) zoomResetButton.onclick = function() {
            glowPreviewZoom = 1;
            applyGlowPreviewZoom();
        };
        if (zoomInButton) zoomInButton.onclick = function() {
            glowPreviewZoom = Math.min(4, Math.round((glowPreviewZoom + 0.25) * 100) / 100);
            applyGlowPreviewZoom();
        };
        const glowReadButton = document.getElementById('btnToolReadImage');
        if (glowReadButton) glowReadButton.onclick = async function() {
            const version = ++glowPreviewRenderVersion;
            const empty = document.querySelector('#toolEditorContent .tt-live-preview-empty');
            this.disabled = true;
            glowPreviewSourceImageData = null;
            if (empty) { empty.textContent = '正在读取 Photoshop 像素…'; empty.style.display = 'block'; }
            try {
                const imageData = await captureCurrentGlowPreviewImageData();
                if (version !== glowPreviewRenderVersion) return;
                glowPreviewSourceImageData = imageData;
                if (empty) { empty.textContent = '正在计算辉光预览…'; empty.style.display = 'block'; }
                requestAnimationFrame(function() {
                    renderGlowCanvasPreview().catch(function(error) { console.error('[glow] 预览失败:', error); });
                });
                showStatus('已读取当前画面', 'success');
            } catch (error) {
                if (version === glowPreviewRenderVersion && empty) {
                    empty.textContent = '辉光预览读取失败：' + error.message;
                    empty.style.display = 'block';
                }
                showStatus('读取失败：' + error.message, 'error');
            } finally {
                this.disabled = false;
            }
        };
        updateOutputs();
        applyStyleVisibility();
        setGlowPreviewImage(getToolPreviewDataUrl());
    }

    // —— 辉光 CPU 预览：阈值 → 高斯模糊 → 屏幕混合（Canvas 2D，适配 UXP 无 WebGL/滑块） ——
    function loadPngToCanvas(dataUrl, maxDim) {
        return new Promise(function(resolve) {
            const img = new Image();
            let settled = false;
            const finish = function(value) {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                img.onload = null;
                img.onerror = null;
                resolve(value);
            };
            const timeoutId = setTimeout(function() { finish(null); }, 8000);
            img.onload = function() {
                const sourceWidth = Math.max(1, img.naturalWidth || img.width || 1);
                const sourceHeight = Math.max(1, img.naturalHeight || img.height || 1);
                const scale = Math.max(1, Math.max(sourceWidth, sourceHeight) / (maxDim || 900));
                const w = Math.max(1, Math.round(sourceWidth / scale));
                const h = Math.max(1, Math.round(sourceHeight / scale));
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                finish(c);
            };
            img.onerror = function() { finish(null); };
            img.src = dataUrl || '';
        });
    }



    function collectGlowUiParams() {
        const chk = function(id, dflt) {
            const el = document.getElementById(id);
            return el ? el.checked : dflt;
        };
        return {
            style: String((document.getElementById('glowStyleSel') || {}).value || 'shine'),
            strength: readNumFrom('toolGlowStrength', 47),
            radius: readNumFrom('toolGlowRadius', 81),
            threshold: readNumFrom('toolGlowThreshold', 81),
            exposure: readNumFrom('toolGlowExposure', 0),
            colorHex: String((document.getElementById('toolGlowColor') || {}).value || '#ffd27a'),
            colorAmount: readNumFrom('toolGlowColorAmount', 0),
            colorEnabled: chk('toolGlowColorEnabled', true),
            chromatic: readNumFrom('toolGlowChromatic', 0),
            chromaticEnabled: chk('toolGlowChromaticEnabled', true),
            starLength: readNumFrom('toolGlowStarLength', 58),
            starCount: readNumFrom('toolGlowStarCount', 6),
            starRotation: readNumFrom('toolGlowStarRotation', 0),
            starVisible: readNumFrom('toolGlowStarVisible', 68),
            streakLength: readNumFrom('toolGlowStreakLength', 86),
            streakVisible: readNumFrom('toolGlowStreakVisible', 62)
        };
    }

    function resizeRgbaImageData(sourceImageData, targetWidth, targetHeight) {
        const sourceWidth = Math.max(1, Number(sourceImageData && sourceImageData.width) || 1);
        const sourceHeight = Math.max(1, Number(sourceImageData && sourceImageData.height) || 1);
        const width = Math.max(1, Math.round(targetWidth));
        const height = Math.max(1, Math.round(targetHeight));
        if (sourceWidth === width && sourceHeight === height) return sourceImageData;
        const source = sourceImageData.data;
        const output = new Uint8ClampedArray(width * height * 4);
        const xScale = sourceWidth / width;
        const yScale = sourceHeight / height;
        for (let y = 0; y < height; y++) {
            const sourceY = Math.max(0, Math.min(sourceHeight - 1, (y + 0.5) * yScale - 0.5));
            const y0 = Math.floor(sourceY);
            const y1 = Math.min(sourceHeight - 1, y0 + 1);
            const fy = sourceY - y0;
            for (let x = 0; x < width; x++) {
                const sourceX = Math.max(0, Math.min(sourceWidth - 1, (x + 0.5) * xScale - 0.5));
                const x0 = Math.floor(sourceX);
                const x1 = Math.min(sourceWidth - 1, x0 + 1);
                const fx = sourceX - x0;
                const p00 = (y0 * sourceWidth + x0) * 4;
                const p10 = (y0 * sourceWidth + x1) * 4;
                const p01 = (y1 * sourceWidth + x0) * 4;
                const p11 = (y1 * sourceWidth + x1) * 4;
                const target = (y * width + x) * 4;
                for (let channel = 0; channel < 4; channel++) {
                    const top = source[p00 + channel] + (source[p10 + channel] - source[p00 + channel]) * fx;
                    const bottom = source[p01 + channel] + (source[p11 + channel] - source[p01 + channel]) * fx;
                    output[target + channel] = Math.round(top + (bottom - top) * fy);
                }
            }
        }
        return { width: width, height: height, data: output };
    }

    // 将内存 RGBA 按保存的文档 ROI 精确写入新像素图层。
    async function placeRgbaImageDataIntoDoc(sourceImageData, bounds, layerName, documentId, options) {
        const commitOptions = options && typeof options === 'object' ? options : {};
        const normalizedBounds = normalizeBoundsObject(bounds);
        if (!normalizedBounds) throw new Error('图像回写范围无效');
        const targetWidth = Math.max(1, Math.round(normalizedBounds.width));
        const targetHeight = Math.max(1, Math.round(normalizedBounds.height));
        const resized = resizeRgbaImageData(sourceImageData, targetWidth, targetHeight);
        const bytes = new Uint8Array(resized.data.buffer, resized.data.byteOffset || 0, resized.data.byteLength);
        const requestedDocumentId = Number(documentId);

        return psAPI.core.executeAsModal(async function() {
            let targetDocument = Number.isFinite(requestedDocumentId)
                ? Array.from(psAPI.app.documents || []).find(function(item) { return Number(item.id) === requestedDocumentId; })
                : null;
            if (Number.isFinite(requestedDocumentId) && !targetDocument) {
                throw new Error('预览绑定的 Photoshop 文档已关闭，为避免错贴已停止');
            }
            if (!targetDocument) targetDocument = psAPI.app.activeDocument;
            if (!targetDocument) throw new Error('原 Photoshop 文档已关闭');
            let layer = null;
            let photoshopImageData = null;
            try {
                const useScreen = commitOptions.blendMode === 'screen';
                const requestedBlendMode = useScreen && psAPI.constants && psAPI.constants.BlendMode
                    ? psAPI.constants.BlendMode.SCREEN
                    : undefined;
                layer = typeof targetDocument.createPixelLayer === 'function'
                    ? await targetDocument.createPixelLayer({ name: layerName, blendMode: requestedBlendMode })
                    : await targetDocument.createLayer({ name: layerName, blendMode: requestedBlendMode });
                if (!layer) throw new Error('无法创建回写像素图层');
                photoshopImageData = await psAPI.imaging.createImageDataFromBuffer(bytes, {
                    width: targetWidth,
                    height: targetHeight,
                    components: 4,
                    chunky: true,
                    colorSpace: 'RGB',
                    colorProfile: 'sRGB IEC61966-2.1'
                });
                await psAPI.imaging.putPixels({
                    documentID: targetDocument.id,
                    layerID: layer.id,
                    imageData: photoshopImageData,
                    replace: true,
                    targetBounds: {
                        left: Math.round(normalizedBounds.left),
                        top: Math.round(normalizedBounds.top)
                    }
                });
                if (useScreen) {
                    if (requestedBlendMode) layer.blendMode = requestedBlendMode;
                    await psAPI.action.batchPlay([{
                        _obj: 'set',
                        _target: [{ _ref: 'layer', _id: layer.id }],
                        to: {
                            _obj: 'layer',
                            mode: { _enum: 'blendMode', _value: 'screen' },
                            opacity: { _unit: 'percentUnit', _value: 100 }
                        }
                    }], { synchronousExecution: true });
                }
                layer.name = layerName;
                return layer;
            } catch (error) {
                if (layer) {
                    try { await layer.delete(); } catch (ignoreCleanupError) {}
                }
                throw error;
            } finally {
                disposeImageData(photoshopImageData);
            }
        }, { commandName: commitOptions.commandName || '精确回写图像图层' });
    }

    // 辉光使用同一条 ROI 写回通道，但固定为屏幕混合。
    async function placeGlowImageDataIntoDoc(glowImageData, bounds, layerName, documentId) {
        return placeRgbaImageDataIntoDoc(glowImageData, bounds, layerName, documentId, {
            blendMode: 'screen',
            commandName: '精确回写辉光图层'
        });
    }

    // 应用辉光到 Photoshop 新图层（照搬参考插件：纯辉光层 + 屏幕混合）
    async function runGlowAction() {
        initCompatibility();
        if (!psAPI.isAvailable || !psAPI.app || !psAPI.core || !psAPI.imaging) {
            throw new Error('Photoshop API 不可用，请在 Photoshop 中加载插件');
        }
        if (!window.GlowEngine) throw new Error('辉光引擎未加载');

        // 1. 读取源画面（优先选区，无选区则整幅画布）
        let bounds = await getSelectionBoundsInPixels();
        if (!bounds) {
            const doc = psAPI.app.activeDocument;
            const w = toNumber(doc.width), h = toNumber(doc.height);
            bounds = { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
        }
        // 2. 直接读取宿主像素，避免大体积 Base64 在 UXP Image 中二次解码卡死
        // CPU 引擎使用 720px 代理计算；辉光为低频模糊层，回写时再精确缩放到原始范围。
        const baseImgData = await captureBoundsToBrowserImageData(bounds, 720);
        const uiParams = collectGlowUiParams();
        const result = window.GlowEngine.createPreview(baseImgData, uiParams, false);
        const glowData = result.glowLayerImageData;

        // 3. 直接缩放 RGBA 并按原选区 left/top 精确回写，避免 placeEvent 居中错位
        savedSelectionBounds = bounds;
        savedDocumentId = psAPI.app.activeDocument ? psAPI.app.activeDocument.id : savedDocumentId;
        await placeGlowImageDataIntoDoc(glowData, bounds, '辉光 · ' + Math.round(uiParams.strength) + '%', savedDocumentId);
        return '辉光已应用到新图层';
    }

    function applyGlowPreviewZoom() {
        const viewport = document.getElementById('glowPreviewViewport');
        const previewImage = document.getElementById('glowPreviewImage');
        const resetButton = document.getElementById('btnGlowZoomReset');
        if (!viewport || !previewImage) return;
        const sourceWidth = Math.max(1, Number(previewImage.naturalWidth) || Number(glowPreviewSourceImageData && glowPreviewSourceImageData.width) || 1);
        const sourceHeight = Math.max(1, Number(previewImage.naturalHeight) || Number(glowPreviewSourceImageData && glowPreviewSourceImageData.height) || 1);
        const availableWidth = Math.max(80, Number(viewport.clientWidth) || 340);
        const fitScale = availableWidth / sourceWidth;
        const fittedHeight = Math.max(260, Math.round(sourceHeight * fitScale));
        if (glowPreviewZoom === 1) viewport.style.height = fittedHeight + 'px';
        const displayScale = Math.max(0.05, fitScale * glowPreviewZoom);
        previewImage.style.width = Math.max(1, Math.round(sourceWidth * displayScale)) + 'px';
        previewImage.style.height = Math.max(1, Math.round(sourceHeight * displayScale)) + 'px';
        if (resetButton) resetButton.textContent = glowPreviewZoom === 1 ? '适应' : Math.round(glowPreviewZoom * 100) + '%';
    }

    async function renderGlowCanvasPreview() {
        const previewImage = document.getElementById('glowPreviewImage');
        if (!previewImage) return;
        const drawVersion = ++glowPreviewDrawVersion;
        if (!glowPreviewSourceImageData) {
            const empty = document.querySelector('#toolEditorContent .tt-live-preview-empty');
            if (empty) empty.style.display = 'block';
            previewImage.style.display = 'none';
            return;
        }
        const empty = document.querySelector('#toolEditorContent .tt-live-preview-empty');
        const uiParams = collectGlowUiParams();
        if (!window.GlowEngine) {
            if (empty) { empty.textContent = '辉光引擎未加载，请重新载入插件'; empty.style.display = 'block'; }
            return;
        }
        try {
            const started = Date.now();
            const result = window.GlowEngine.createPreview(glowPreviewSourceImageData, uiParams, true);
            const outData = result.previewImageData;
            const dataUrl = await encodeBrowserImageDataToDataUrl(outData);
            if (drawVersion !== glowPreviewDrawVersion || !document.getElementById('glowPreviewImage')) return;
            previewImage.onload = function() { applyGlowPreviewZoom(); };
            previewImage.src = dataUrl;
            previewImage.style.display = 'block';
            requestAnimationFrame(applyGlowPreviewZoom);
            if (empty) { empty.textContent = '辉光预览已更新'; empty.style.display = 'none'; }
            console.log('[glow] 预览完成:', outData.width + 'x' + outData.height, Date.now() - started, 'ms');
        } catch (error) {
            console.error('[glow] 引擎执行失败:', error);
            if (empty) { empty.textContent = '辉光预览失败：' + error.message; empty.style.display = 'block'; }
        }
    }
    function readNumFrom(id, fallback) {
        const el = document.getElementById(id);
        const numeric = Number(el ? el.value : '');
        return Math.max(-999, Math.min(9999, Number.isFinite(numeric) ? numeric : fallback));
    }

    function setGlowPreviewImage(dataUrl) {
        const version = ++glowPreviewRenderVersion;
        const empty = document.querySelector('#toolEditorContent .tt-live-preview-empty');
        const previewImage = document.getElementById('glowPreviewImage');
        if (!dataUrl) {
            glowPreviewSourceImageData = null;
            if (empty) { empty.textContent = '读取选区后显示辉光预览'; empty.style.display = 'block'; }
            if (previewImage) previewImage.style.display = 'none';
            return;
        }
        // 有数据时显示 loading，等引擎异步完成后替换
        if (empty) { empty.textContent = '正在读取辉光预览像素…'; empty.style.display = 'block'; }
        if (previewImage) previewImage.style.display = 'none';
        glowPreviewSourceImageData = null;
        // 预览源图最长边。原来是 192，而预览视口宽度约 400px，
        // 等于把 192px 的图放大两倍显示，所以看起来一直很糊。提到 384 后基本 1:1。
        // 注意：改大后必须同步抬高 glow-engine 里的预览性能阈值（60000），
        // 否则像素数越过阈值会丢掉光学层，预览与最终结果不一致。
        const directCapture = savedSelectionBounds
            ? captureBoundsToBrowserImageData(savedSelectionBounds, 384)
            : Promise.reject(new Error('没有可用的 Photoshop 画面范围'));
        directCapture.catch(async function(error) {
            console.warn('[glow] 直接读取像素失败，尝试兼容解码:', error);
            const fallbackCanvas = await loadPngToCanvas(dataUrl, 192);
            if (!fallbackCanvas) throw new Error('UXP 无法解码当前画面，请重新读取');
            return fallbackCanvas.getContext('2d', { willReadFrequently: true })
                .getImageData(0, 0, fallbackCanvas.width, fallbackCanvas.height);
        }).then(function(imageData) {
            if (version !== glowPreviewRenderVersion) return;
            glowPreviewSourceImageData = imageData;
            if (empty) { empty.textContent = '正在计算辉光预览…'; empty.style.display = 'block'; }
            requestAnimationFrame(function() {
                renderGlowCanvasPreview().catch(function(error) { console.error('[glow] 预览失败:', error); });
            });
        }).catch(function(error) {
            if (version !== glowPreviewRenderVersion) return;
            console.error('[glow] 预览源读取失败:', error);
            if (empty) { empty.textContent = '辉光预览读取失败：' + error.message; empty.style.display = 'block'; }
        });
    }



    function renderNewVfxEditor() {
        const content = document.getElementById('toolEditorContent');
        if (!content) return;
        if (!window.HuanmengSpaceFx) {
            content.innerHTML = toolEditorShell('空间特效', '本地空间特效引擎未加载。', '<div class="module-card">请重新加载插件。</div>');
            bindToolEditorCommon();
            return;
        }
        const slider = function(id, label, value, min, max, suffix) {
            return '<div class="tt-control-row"><label>' + label + '</label><input id="' + id + '" type="range" min="' + min + '" max="' + max + '" value="' + value + '"><output id="' + id + 'Out">' + value + (suffix || '') + '</output></div>';
        };
        content.innerHTML = toolEditorShell('空间特效', '本地 Canvas 位移纹理，捕获一次后实时预览，应用时使用完整分辨率。',
            '<div class="tt-tool-editor-grid"><div><div class="tt-live-preview"><div class="tt-live-preview-empty">读取选区后显示空间特效</div><img id="spaceFxPreviewImage" class="tt-glow-canvas" alt="空间特效预览" style="display:none"></div><div id="spaceFxPreviewMeta" class="info-text" style="margin-top:8px">等待捕获</div></div>' +
            '<div class="tt-tool-controls"><div class="tt-control-card"><div class="tt-control-row tt-control-row-wide"><label>预设</label><select id="spaceFxPreset"><option value="heat">热浪</option><option value="airflow">气流</option><option value="slash">刀光</option></select></div>' +
            slider('spaceFxIntensity', '强度', 48, 0, 100, '%') + slider('spaceFxRange', '范围', 62, 10, 100, '%') + slider('spaceFxFeather', '羽化', 54, 0, 100, '%') + slider('spaceFxAngle', '角度', 90, -180, 180, '°') + slider('spaceFxDetail', '细节', 58, 0, 100, '%') + slider('spaceFxGlow', '光效', 12, 0, 100, '%') +
            '<div class="tt-control-row"><label>光效颜色 <input id="spaceFxGlowColorEnabled" type="checkbox" checked></label><input id="spaceFxGlowColor" type="color" value="#ffd27a"><output id="spaceFxGlowColorOut">#ffd27a</output></div>' +
            slider('spaceFxGlowColorAmount', '颜色量', 28, 0, 100, '%') + slider('spaceFxBrush', '画笔粗细', 42, 8, 120, '') +
            slider('spaceFxCenterX', '中心 X', 50, 0, 100, '%') + slider('spaceFxCenterY', '中心 Y', 50, 0, 100, '%') +
            '</div><div class="tt-tool-actions"><button id="btnSpaceFxRecapture" class="btn btn-secondary">重新捕获</button><button id="btnSpaceFxMap" class="btn btn-secondary">置换图新层</button><button id="btnSpaceFxApply" class="btn btn-primary">应用空间特效</button></div></div></div>');

        let sourceDataUrl = getToolPreviewDataUrl();
        let captureMeta = sourceDataUrl && savedSelectionBounds ? {
            bounds: Object.assign({}, savedSelectionBounds),
            documentId: savedDocumentId
        } : null;
        let previewSource = null;
        let previewImageData = null;
        let previewTimer = null;
        const ids = ['spaceFxIntensity', 'spaceFxRange', 'spaceFxFeather', 'spaceFxAngle', 'spaceFxDetail', 'spaceFxGlow', 'spaceFxGlowColorAmount', 'spaceFxBrush', 'spaceFxCenterX', 'spaceFxCenterY'];

        function readSettings() {
            return {
                effect: document.getElementById('spaceFxPreset').value,
                intensity: Number(document.getElementById('spaceFxIntensity').value),
                range: Number(document.getElementById('spaceFxRange').value),
                feather: Number(document.getElementById('spaceFxFeather').value),
                angle: Number(document.getElementById('spaceFxAngle').value),
                detail: Number(document.getElementById('spaceFxDetail').value),
                glow: Number(document.getElementById('spaceFxGlow').value),
                glowColor: document.getElementById('spaceFxGlowColor').value,
                glowColorAmount: Number(document.getElementById('spaceFxGlowColorAmount').value),
                glowColorEnabled: document.getElementById('spaceFxGlowColorEnabled').checked,
                brush: Number(document.getElementById('spaceFxBrush').value),
                centerX: Number(document.getElementById('spaceFxCenterX').value) / 100,
                centerY: Number(document.getElementById('spaceFxCenterY').value) / 100
            };
        }

        function updateOutputs() {
            ids.forEach(function(id) {
                const output = document.getElementById(id + 'Out');
                if (!output) return;
                const suffix = id === 'spaceFxAngle' ? '°' : (id === 'spaceFxBrush' ? '' : '%');
                output.textContent = document.getElementById(id).value + suffix;
            });
            document.getElementById('spaceFxGlowColorOut').textContent = document.getElementById('spaceFxGlowColor').value;
        }

        async function renderPreview() {
            const version = ++toolPreviewRenderVersion;
            const previewImage = document.getElementById('spaceFxPreviewImage');
            const empty = content.querySelector('.tt-live-preview-empty');
            if (!sourceDataUrl || !previewImage) {
                if (empty) empty.style.display = 'block';
                return;
            }
            if (empty) { empty.textContent = '正在计算预览…'; empty.style.display = 'block'; }
            if (!previewImageData && !previewSource) previewSource = await loadPngToCanvas(sourceDataUrl, 480);
            if (version !== toolPreviewRenderVersion || (!previewImageData && !previewSource)) return;
            await new Promise(function(resolve) { requestAnimationFrame(resolve); });
            const sourceImageData = previewImageData || previewSource.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, previewSource.width, previewSource.height);
            const started = Date.now();
            const result = window.HuanmengSpaceFx.render(sourceImageData, readSettings());
            if (version !== toolPreviewRenderVersion) return;
            previewImage.src = await encodeBrowserImageDataToDataUrl(result.imageData);
            if (version !== toolPreviewRenderVersion) return;
            previewImage.style.display = 'block';
            if (empty) empty.style.display = 'none';
            document.getElementById('spaceFxPreviewMeta').textContent = result.settings.label + ' · ' + result.imageData.width + '×' + result.imageData.height + ' · ' + (Date.now() - started) + 'ms';
        }

        function schedulePreview(immediate) {
            updateOutputs();
            if (previewTimer) clearTimeout(previewTimer);
            const delay = immediate ? 0 : 90;
            previewTimer = setTimeout(function() {
                renderPreview().catch(function(error) {
                    const empty = content.querySelector('.tt-live-preview-empty');
                    if (empty) { empty.textContent = '空间特效预览失败：' + error.message; empty.style.display = 'block'; }
                    showStatus('空间特效预览失败：' + error.message, 'error');
                });
            }, delay);
        }

        function applyPreset(name) {
            const value = window.HuanmengSpaceFx.preset(name);
            document.getElementById('spaceFxIntensity').value = value.intensity;
            document.getElementById('spaceFxRange').value = value.range;
            document.getElementById('spaceFxFeather').value = value.feather;
            document.getElementById('spaceFxAngle').value = value.angle;
            document.getElementById('spaceFxDetail').value = value.detail;
            document.getElementById('spaceFxGlow').value = value.glow;
            document.getElementById('spaceFxGlowColor').value = value.glowColor;
            document.getElementById('spaceFxGlowColorAmount').value = value.glowColorAmount;
            document.getElementById('spaceFxGlowColorEnabled').checked = value.glowColorEnabled !== false;
            document.getElementById('spaceFxBrush').value = value.brush;
            schedulePreview(true);
        }

        async function captureAndBindSource() {
            sourceDataUrl = await captureToolSourceImage();
            if (!savedSelectionBounds) throw new Error('未获得可用的图像范围');
            captureMeta = {
                bounds: Object.assign({}, savedSelectionBounds),
                documentId: savedDocumentId
            };
            previewSource = null;
            if (isMobileWebEnvironment()) {
                previewSource = await loadPngToCanvas(sourceDataUrl, 480);
                if (!previewSource) throw new Error('上传图片无法解码');
                previewImageData = previewSource.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, previewSource.width, previewSource.height);
            } else {
                previewImageData = await captureBoundsToBrowserImageData(captureMeta.bounds, 480);
            }
            return sourceDataUrl;
        }

        async function computeBoundCommitResult() {
            if (!captureMeta) await captureAndBindSource();
            if (isMobileWebEnvironment()) {
                const canvas = await loadPngToCanvas(sourceDataUrl, 2200);
                if (!canvas) throw new Error('上传图片无法解码');
                return window.HuanmengSpaceFx.render(canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height), readSettings());
            }
            const activeDocument = psAPI.app && psAPI.app.activeDocument;
            if (!activeDocument || Number(activeDocument.id) !== Number(captureMeta.documentId)) {
                throw new Error('请切回生成预览时的 Photoshop 文档后再应用');
            }
            // 参考像素起子的输出上限：完整 ROI 过大时以 2200px 代理运算，
            // 最终仍由统一 commit 通道按原 bounds 精确写回。
            const fullData = await captureBoundsToBrowserImageData(captureMeta.bounds, 2200);
            return window.HuanmengSpaceFx.render(fullData, readSettings());
        }

        content.querySelectorAll('input').forEach(function(element) { element.addEventListener('input', function() { schedulePreview(false); }); });
        document.getElementById('spaceFxPreset').addEventListener('change', function() { applyPreset(this.value); });
        document.getElementById('spaceFxPreviewImage').addEventListener('click', function(event) {
            const rect = this.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            document.getElementById('spaceFxCenterX').value = String(Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 100));
            document.getElementById('spaceFxCenterY').value = String(Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * 100));
            schedulePreview(true);
        });
        document.getElementById('btnSpaceFxRecapture').onclick = async function() {
            try {
                await captureAndBindSource();
                schedulePreview(true);
            } catch (error) { showStatus('捕获失败：' + error.message, 'error'); }
        };
        document.getElementById('btnSpaceFxMap').onclick = async function() {
            const button = this;
            button.disabled = true;
            button.textContent = '正在生成…';
            try {
                const result = await computeBoundCommitResult();
                if (isMobileWebEnvironment()) {
                    const outputUrl = await encodeBrowserImageDataToDataUrl(result.displacementMap);
                    await downloadAndPlaceDocument(outputUrl, result.displacementMap.width, result.displacementMap.height, result.settings.label, 'mobile-spacefx-map', new Date().toLocaleString('zh-CN'), '空间特效置换图', { bounds: captureMeta.bounds, documentId: null });
                    showStatus('置换图已保存到画廊', 'success');
                } else {
                    await placeRgbaImageDataIntoDoc(result.displacementMap, captureMeta.bounds, '空间特效置换图 · ' + result.settings.label, captureMeta.documentId, { commandName: '写回空间特效置换图' });
                    showStatus('置换图已生成到新图层', 'success');
                }
            } catch (error) {
                showStatus('置换图失败：' + error.message, 'error');
            } finally {
                button.disabled = false;
                button.textContent = '置换图新层';
            }
        };
        document.getElementById('btnSpaceFxApply').onclick = async function() {
            const button = this;
            button.disabled = true;
            button.textContent = '正在应用…';
            try {
                const result = await computeBoundCommitResult();
                if (isMobileWebEnvironment()) {
                    const outputUrl = await encodeBrowserImageDataToDataUrl(result.imageData);
                    await downloadAndPlaceDocument(outputUrl, result.imageData.width, result.imageData.height, result.settings.label, 'mobile-spacefx', new Date().toLocaleString('zh-CN'), '空间特效', { bounds: captureMeta.bounds, documentId: null });
                    showStatus('空间特效已保存到画廊', 'success');
                } else {
                    await placeRgbaImageDataIntoDoc(result.imageData, captureMeta.bounds, '空间特效 · ' + result.settings.label, captureMeta.documentId, { commandName: '精确回写空间特效' });
                    showStatus('空间特效已应用', 'success');
                }
            } catch (error) {
                showStatus('空间特效失败：' + error.message, 'error');
            } finally {
                button.disabled = false;
                button.textContent = '应用空间特效';
            }
        };
        bindToolEditorCommon(function(dataUrl) {
            sourceDataUrl = dataUrl;
            captureMeta = savedSelectionBounds ? {
                bounds: Object.assign({}, savedSelectionBounds),
                documentId: savedDocumentId
            } : null;
            previewSource = null;
            previewImageData = null;
            if (captureMeta) {
                captureBoundsToBrowserImageData(captureMeta.bounds, 480).then(function(imageData) {
                    previewImageData = imageData;
                    schedulePreview(true);
                }).catch(function(error) { showStatus('空间特效预览读取失败：' + error.message, 'error'); });
            } else {
                schedulePreview(true);
            }
        });
        const commonReadButton = document.getElementById('btnToolReadImage');
        if (commonReadButton) commonReadButton.onclick = async function() {
            this.disabled = true;
            try {
                await captureAndBindSource();
                schedulePreview(true);
                showStatus('已读取当前画面', 'success');
            } catch (error) {
                showStatus('读取失败：' + error.message, 'error');
            } finally {
                this.disabled = false;
            }
        };
        updateOutputs();
        if (sourceDataUrl) schedulePreview(true);
    }

    async function captureBlendMatchPreviewSources() {
        initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.imaging || !psAPI.app.activeDocument) {
            const outputUpload = await pickBrowserImage('上传需要校色的输出图');
            const referenceUpload = await pickBrowserImage('上传作为色彩参考的原图');
            const outputCanvas = await loadPngToCanvas(outputUpload.base64, 2200);
            const referenceCanvas = await loadPngToCanvas(referenceUpload.base64, 2200);
            if (!outputCanvas || !referenceCanvas) throw new Error('上传图片无法解码');
            const outputFullSample = outputCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, outputCanvas.width, outputCanvas.height);
            let referenceFullSample = referenceCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, referenceCanvas.width, referenceCanvas.height);
            if (referenceFullSample.width !== outputFullSample.width || referenceFullSample.height !== outputFullSample.height) {
                referenceFullSample = resizeRgbaImageData(referenceFullSample, outputFullSample.width, outputFullSample.height);
            }
            selectedImageBase64 = outputUpload.base64;
            savedSelectionBounds = outputUpload.bounds;
            savedDocumentId = null;
            blendMatchPreviewSources = {
                bounds: outputUpload.bounds,
                documentId: null,
                layerId: null,
                outputFullSample: outputFullSample,
                referenceFullSample: referenceFullSample,
                outputSample: resizeImageDataMaxDimension(outputFullSample, 512),
                referenceSample: resizeImageDataMaxDimension(referenceFullSample, 512)
            };
            return blendMatchPreviewSources;
        }
        const documentModel = psAPI.app.activeDocument;
        const layer = documentModel.activeLayers && documentModel.activeLayers[0];
        if (!layer) throw new Error('请先选中 AI 回图图层');
        const bounds = await getActiveLayerBounds();
        if (!bounds) throw new Error('无法读取当前图层范围');
        const outputFullSample = await captureBoundsToBrowserImageData(bounds, 2200, layer.id);
        if (!outputFullSample || !outputFullSample.data) throw new Error('无法读取当前图层像素');
        const wasVisible = layer.visible !== false;
        let referenceFullSample = null;
        try {
            await psAPI.core.executeAsModal(async function() { layer.visible = false; }, { commandName: '取样融合背景' });
            referenceFullSample = await captureBoundsToBrowserImageData(bounds, 2200);
        } finally {
            await psAPI.core.executeAsModal(async function() { layer.visible = wasVisible; }, { commandName: '恢复融合图层' });
        }
        if (!referenceFullSample || !referenceFullSample.data) throw new Error('图层下方没有可用的原画面');
        blendMatchPreviewSources = {
            bounds: bounds,
            documentId: documentModel.id,
            layerId: layer.id,
            outputFullSample: outputFullSample,
            referenceFullSample: referenceFullSample,
            outputSample: resizeImageDataMaxDimension(outputFullSample, 512),
            referenceSample: resizeImageDataMaxDimension(referenceFullSample, 512)
        };
        return blendMatchPreviewSources;
    }

    function renderBlendMatchEditor() {
        const content = document.getElementById('toolEditorContent');
        if (!content) return;
        content.innerHTML = toolEditorShell('融合校色', '匹配 AI 回图与下方原画面，左右拉杆实时对比，确认后生成可编辑新图层。',
            '<div class="tt-tool-editor-grid"><div><div class="tt-live-preview"><div class="tt-live-preview-empty">选中 AI 回图图层后点击刷新预览</div><img id="blendMatchPreviewImage" class="tt-glow-canvas" alt="融合校色预览" style="display:none"><div id="blendMatchDivider" class="tt-blend-divider" style="display:none"></div></div><div id="blendMatchMeta" class="info-text" style="margin-top:8px">左侧融合前 / 右侧融合后</div></div>' +
            '<div class="tt-tool-controls"><div class="tt-control-card"><div class="tt-control-row tt-control-row-wide"><label>模式</label><select id="blendMatchMode"><option value="natural">自然</option><option value="balanced" selected>均衡</option><option value="strong">强融合</option></select></div>' +
            '<div class="tt-control-row tt-control-row-wide"><label>方法</label><select id="blendMatchMethod"><option value="wavelet">小波低频</option><option value="reinhard">Lab 整体匹配</option></select></div>' +
            '<div class="tt-control-row"><label>总强度</label><input id="blendMatchStrength" type="range" min="0" max="100" value="78"><output id="blendMatchStrengthOut">78%</output></div>' +
            '<div class="tt-control-row"><label>羽化半径</label><input id="blendMatchFeather" type="range" min="0" max="128" value="16"><output id="blendMatchFeatherOut">16px</output></div>' +
            '<div class="tt-control-row"><label>对比分割</label><input id="blendMatchSplit" type="range" min="0" max="100" value="50"><output id="blendMatchSplitOut">50%</output></div>' +
            '<div class="tt-control-row"><label>像素对齐</label><label class="checkbox-row"><input id="blendMatchAlignment" type="checkbox" checked> Sobel 精确定位</label><output>CPU</output></div>' +
            '</div><div class="tt-tool-actions"><button id="btnBlendMatchRefresh" class="btn btn-secondary">刷新预览</button><button id="btnBlendMatchApply" class="btn btn-primary">分析并融合</button></div></div></div>');

        let previewTimer = null;
        let previewCache = null;

        function currentOptions() {
            return {
                method: document.getElementById('blendMatchMethod').value === 'reinhard' ? 'reinhard' : 'wavelet',
                strength: Number(document.getElementById('blendMatchStrength').value) || 0,
                featherRadius: Number(document.getElementById('blendMatchFeather').value) || 0,
                alignmentEnabled: document.getElementById('blendMatchAlignment').checked,
                alignmentMaxOffset: 120,
                sharedMaskEnabled: true
            };
        }

        async function drawSplit() {
            const previewImage = document.getElementById('blendMatchPreviewImage');
            if (!previewImage || !previewCache) return;
            const split = Math.max(0, Math.min(1, Number(document.getElementById('blendMatchSplit').value) / 100));
            const before = previewCache.before;
            const after = previewCache.after;
            const output = new Uint8ClampedArray(before.data);
            const splitX = Math.round(before.width * split);
            for (let y = 0; y < before.height; y++) {
                for (let x = splitX; x < before.width; x++) {
                    const index = (y * before.width + x) * 4;
                    output[index] = after.data[index];
                    output[index + 1] = after.data[index + 1];
                    output[index + 2] = after.data[index + 2];
                    output[index + 3] = after.data[index + 3];
                }
            }
            const imageData = { data: output, width: before.width, height: before.height };
            previewImage.src = await encodeBrowserImageDataToDataUrl(imageData);
            previewImage.style.display = 'block';
            const divider = document.getElementById('blendMatchDivider');
            if (divider) { divider.style.left = (split * 100) + '%'; divider.style.display = 'block'; }
            const empty = content.querySelector('.tt-live-preview-empty');
            if (empty) empty.style.display = 'none';
            document.getElementById('blendMatchSplitOut').textContent = Math.round(split * 100) + '%';
        }

        async function computePreview() {
            const version = ++toolPreviewRenderVersion;
            const sources = blendMatchPreviewSources || await captureBlendMatchPreviewSources();
            const empty = content.querySelector('.tt-live-preview-empty');
            if (empty) { empty.textContent = '正在分析低频色彩…'; empty.style.display = 'block'; }
            const before = sources.outputSample;
            let reference = sources.referenceSample;
            if (version !== toolPreviewRenderVersion || !before || !reference) return;
            const width = before.width;
            const height = before.height;
            if (reference.width !== width || reference.height !== height) {
                reference = resizeRgbaImageData(reference, width, height);
            }
            const started = Date.now();
            const after = window.HuanmengColorMatch.matchImageData(reference, before, currentOptions());
            if (version !== toolPreviewRenderVersion) return;
            previewCache = { before: before, after: after };
            await drawSplit();
            const analysis = after.analysis || {};
            const alignment = analysis.alignment || {};
            const analysisLabel = 'dx ' + Number(alignment.dx || 0).toFixed(1) + ' / dy ' + Number(alignment.dy || 0).toFixed(1) +
                ' / 共享 ' + Math.round(Number(analysis.sharedRatio == null ? 1 : analysis.sharedRatio) * 100) + '%';
            document.getElementById('blendMatchMeta').textContent = (currentOptions().method === 'reinhard' ? 'Lab 整体匹配' : '小波低频') +
                ' · ' + analysisLabel + ' · ' + width + '×' + height + ' · ' + (Date.now() - started) + 'ms';
        }

        function schedulePreview(immediate) {
            document.getElementById('blendMatchStrengthOut').textContent = document.getElementById('blendMatchStrength').value + '%';
            document.getElementById('blendMatchFeatherOut').textContent = document.getElementById('blendMatchFeather').value + 'px';
            if (previewTimer) clearTimeout(previewTimer);
            previewTimer = setTimeout(function() {
                computePreview().catch(function(error) {
                    const empty = content.querySelector('.tt-live-preview-empty');
                    if (empty) { empty.textContent = '融合校色预览失败：' + error.message; empty.style.display = 'block'; }
                    showStatus('融合校色预览失败：' + error.message, 'error');
                });
            }, immediate ? 0 : 120);
        }

        document.getElementById('blendMatchMode').addEventListener('change', function() {
            const presets = { natural: ['wavelet', 68, 24], balanced: ['wavelet', 78, 16], strong: ['reinhard', 90, 36] };
            const value = presets[this.value] || presets.balanced;
            document.getElementById('blendMatchMethod').value = value[0];
            document.getElementById('blendMatchStrength').value = value[1];
            document.getElementById('blendMatchFeather').value = value[2];
            refreshCustomSelectById('blendMatchMethod');
            schedulePreview(true);
        });
        document.getElementById('blendMatchMethod').addEventListener('change', function() { schedulePreview(false); });
        document.getElementById('blendMatchStrength').addEventListener('input', function() { schedulePreview(false); });
        document.getElementById('blendMatchFeather').addEventListener('input', function() { schedulePreview(false); });
        document.getElementById('blendMatchAlignment').addEventListener('change', function() { schedulePreview(true); });
        document.getElementById('blendMatchSplit').addEventListener('input', function() {
            drawSplit().catch(function(error) { showStatus('融合对比更新失败：' + error.message, 'error'); });
        });
        document.getElementById('btnBlendMatchRefresh').onclick = async function() {
            blendMatchPreviewSources = null;
            previewCache = null;
            schedulePreview(true);
        };
        document.getElementById('btnBlendMatchApply').onclick = async function() {
            const button = this;
            button.disabled = true;
            button.textContent = '正在融合…';
            try {
                showStatus('正在融合校色...', 'info');
                const boundSources = blendMatchPreviewSources || await captureBlendMatchPreviewSources();
                if (isMobileWebEnvironment()) {
                    let reference = boundSources.referenceFullSample;
                    const output = boundSources.outputFullSample;
                    if (reference.width !== output.width || reference.height !== output.height) {
                        reference = resizeRgbaImageData(reference, output.width, output.height);
                    }
                    const matched = window.HuanmengColorMatch.matchImageData(reference, output, currentOptions());
                    const outputUrl = await encodeBrowserImageDataToDataUrl(matched);
                    const stored = await downloadAndPlaceDocument(outputUrl, matched.width, matched.height, '融合校色', 'mobile-blend-match', new Date().toLocaleString('zh-CN'), currentOptions().method, { bounds: boundSources.bounds, documentId: null });
                    if (!stored) throw new Error('融合结果未能保存');
                    blendMatchPreviewSources = null;
                    previewCache = null;
                    showStatus('融合校色结果已保存到画廊', 'success');
                    return;
                }
                const activeDocument = psAPI.app && psAPI.app.activeDocument;
                const activeLayer = activeDocument && activeDocument.activeLayers && activeDocument.activeLayers[0];
                const activeBounds = activeLayer ? await getActiveLayerBounds() : null;
                const bound = normalizeBoundsObject(boundSources.bounds);
                const unchangedBounds = activeBounds && bound && ['left', 'top', 'right', 'bottom'].every(function(key) {
                    return Math.abs(Number(activeBounds[key]) - Number(bound[key])) <= 1;
                });
                if (!activeDocument || !activeLayer || Number(activeDocument.id) !== Number(boundSources.documentId) ||
                    Number(activeLayer.id) !== Number(boundSources.layerId) || !unchangedBounds) {
                    throw new Error('当前文档、图层或范围已变化，请先刷新预览再融合');
                }
                await runManualColorMatch(currentOptions(), boundSources);
                blendMatchPreviewSources = null;
                previewCache = null;
                showStatus('融合校色完成', 'success');
            } catch (error) {
                showStatus('融合校色失败：' + error.message, 'error');
            } finally {
                button.disabled = false;
                button.textContent = '分析并融合';
            }
        };
        bindToolEditorCommon(function() {
            blendMatchPreviewSources = null;
            previewCache = null;
            schedulePreview(true);
        });
        if (!isMobileWebEnvironment()) {
            schedulePreview(true);
        } else {
            const empty = content.querySelector('.tt-live-preview-empty');
            if (empty) empty.textContent = '点击“刷新预览”依次上传输出图和参考原图';
        }
    }

    function setupScopeCanvas(canvas) {
        // 按元素实际渲染尺寸设定画布内部分辨率。
        // 高度优先取 clientHeight（由 .scope-cell 的固定高度决定），
        // 拿不到时再按 16:11 估算，避免画布被拉伸变形。
        const width = Math.max(280, Math.round(canvas.clientWidth || 360));
        const height = Math.max(180, Math.round(canvas.clientHeight || width * 0.72));
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, width, height);
        return { ctx: ctx, width: width, height: height };
    }

    function drawScopeGrid(ctx, width, height) {
        ctx.strokeStyle = 'rgba(255,255,255,.1)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
            ctx.beginPath(); ctx.moveTo(0, height * i / 4); ctx.lineTo(width, height * i / 4); ctx.stroke();
        }
    }

    function drawScopeFrame(pixels, sampleWidth, sampleHeight) {
        const lumaCanvas = document.querySelector('[data-scope="luma"]');
        const rgbCanvas = document.querySelector('[data-scope="rgb"]');
        const vecCanvas = document.querySelector('[data-scope="vec"]');
        const histCanvas = document.querySelector('[data-scope="hist"]');
        if (!lumaCanvas || !rgbCanvas || !vecCanvas || !histCanvas) return;
        const luma = setupScopeCanvas(lumaCanvas);
        const rgb = setupScopeCanvas(rgbCanvas);
        const vec = setupScopeCanvas(vecCanvas);
        const hist = setupScopeCanvas(histCanvas);
        drawScopeGrid(luma.ctx, luma.width, luma.height);
        drawScopeGrid(rgb.ctx, rgb.width, rgb.height);

        const channels = [];
        if (scopeOptions.showR) channels.push(0);
        if (scopeOptions.showG) channels.push(1);
        if (scopeOptions.showB) channels.push(2);
        const colors = ['rgba(255,80,80,.12)', 'rgba(80,255,110,.12)', 'rgba(80,140,255,.15)'];
        const histColors = ['rgba(255,60,60,.55)', 'rgba(60,255,60,.55)', 'rgba(60,140,255,.65)'];
        const hists = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
        const step = Math.max(1, Math.round(Math.sqrt((sampleWidth * sampleHeight) / 12000)));

        luma.ctx.fillStyle = 'rgba(90,255,110,.13)';
        for (let sy = 0; sy < sampleHeight; sy += step) {
            for (let sx = 0; sx < sampleWidth; sx += step) {
                const index = (sy * sampleWidth + sx) * 4;
                const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
                hists[0][r]++; hists[1][g]++; hists[2][b]++;
                const lum = .2126 * r + .7152 * g + .0722 * b;
                const lx = sx / Math.max(1, sampleWidth - 1) * luma.width;
                const ly = luma.height - lum / 255 * luma.height;
                luma.ctx.fillRect(lx, ly, 1.4, 1.4);
                channels.forEach(function(channel, bandIndex) {
                    const bandWidth = rgb.width / Math.max(1, channels.length);
                    const rx = bandIndex * bandWidth + sx / Math.max(1, sampleWidth - 1) * bandWidth;
                    const ry = rgb.height - pixels[index + channel] / 255 * rgb.height;
                    rgb.ctx.fillStyle = colors[channel];
                    rgb.ctx.fillRect(rx, ry, 1.3, 1.3);
                });
            }
        }

        const vctx = vec.ctx;
        const cx = vec.width / 2, cy = vec.height / 2;
        const radius = Math.min(vec.width, vec.height) / 2 - 12;
        vctx.strokeStyle = 'rgba(255,255,255,.12)';
        [0.25, 0.5, 0.75, 1].forEach(function(scale) { vctx.beginPath(); vctx.arc(cx, cy, radius * scale, 0, Math.PI * 2); vctx.stroke(); });
        vctx.beginPath(); vctx.moveTo(cx - radius, cy); vctx.lineTo(cx + radius, cy); vctx.moveTo(cx, cy - radius); vctx.lineTo(cx, cy + radius); vctx.stroke();
        if (scopeOptions.skin) {
            const angle = -123 * Math.PI / 180;
            vctx.strokeStyle = 'rgba(255,180,140,.48)';
            vctx.beginPath(); vctx.moveTo(cx - Math.cos(angle) * radius, cy - Math.sin(angle) * radius); vctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius); vctx.stroke();
        }
        vctx.fillStyle = 'rgba(90,255,120,.12)';
        for (let sy = 0; sy < sampleHeight; sy += step) {
            for (let sx = 0; sx < sampleWidth; sx += step) {
                const index = (sy * sampleWidth + sx) * 4;
                const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
                const cb = -.1146 * r - .3854 * g + .5 * b;
                const cr = .5 * r - .4542 * g - .0458 * b;
                const px = cx + cb / 128 * radius * scopeOptions.vecGain;
                const py = cy - cr / 128 * radius * scopeOptions.vecGain;
                if (px >= 0 && px < vec.width && py >= 0 && py < vec.height) vctx.fillRect(px, py, 1.5, 1.5);
            }
        }

        let maxHist = 1;
        channels.forEach(function(channel) { for (let i = 0; i < 256; i++) maxHist = Math.max(maxHist, hists[channel][i]); });
        hist.ctx.globalCompositeOperation = 'lighter';
        channels.forEach(function(channel) {
            hist.ctx.fillStyle = histColors[channel];
            for (let i = 0; i < 256; i++) {
                const ratio = scopeOptions.histScale === 'log' ? Math.log(hists[channel][i] + 1) / Math.log(maxHist + 1) : hists[channel][i] / maxHist;
                const height = ratio * (hist.height - 8);
                hist.ctx.fillRect(i / 256 * hist.width, hist.height - height, Math.max(1, hist.width / 256), height);
            }
        });
        hist.ctx.globalCompositeOperation = 'source-over';
        const labels = [[luma.ctx, 'LUMA · ' + scopeOptions.range.toUpperCase()], [rgb.ctx, 'RGB PARADE'], [vctx, 'VECTOR · ' + scopeOptions.vecGain + '×'], [hist.ctx, 'HIST · ' + scopeOptions.histScale.toUpperCase()]];
        labels.forEach(function(item) { item[0].fillStyle = 'rgba(255,255,255,.72)'; item[0].font = '11px monospace'; item[0].fillText(item[1], 7, 15); });
    }

    async function drawScopeFromDataUrl(dataUrl) {
        if (!dataUrl) return;
        scopeLastDataUrl = dataUrl;
        const info = document.getElementById('scopeInfo');
        if (info) info.textContent = '正在解码采样…';
        // 这里必须用 loadPngToCanvas，不能用裸 new Image() + onload。
        // 裸 onload 在 UXP 下偶发不触发，而 #scopeInfo 只在 onload 里更新，
        // 于是状态永远停在「等待读取画面」、四块画布保持全黑，
        // 表现就是「示波器不显示」且没有任何报错。
        // loadPngToCanvas 带 8 秒超时和 onerror 兜底，失败会返回 null。
        const sample = await loadPngToCanvas(dataUrl, scopeOptions.quality || 360);
        if (!sample) {
            if (info) info.textContent = '画面解码失败，请点「读取当前选区 / 画布」重试';
            return;
        }
        const context = sample.getContext('2d', { willReadFrequently: true });
        drawScopeFrame(context.getImageData(0, 0, sample.width, sample.height).data, sample.width, sample.height);
        if (info) info.textContent = '采样 ' + sample.width + ' × ' + sample.height + ' · ' + new Date().toLocaleTimeString('zh-CN');
    }

    function renderScopeEditor() {
        const content = document.getElementById('toolEditorContent');
        if (!content) return;
        const group = function(action, values, current) { return '<div class="scope-btng" data-scope-action="' + action + '">' + values.map(function(value) { return '<button class="scope-btng-btn' + (String(value) === String(current) ? ' is-on' : '') + '" data-value="' + value + '" type="button">' + value + (action === 'vecGain' ? '×' : '') + '</button>'; }).join('') + '</div>'; };
        content.innerHTML = toolEditorShell('示波器', '参考项目四联示波器：亮度波形、RGB Parade、Vectorscope 与 RGB 直方图。',
            '<div class="module-card"><div class="tt-tool-actions"><button id="btnScopeRefresh" class="btn btn-primary">刷新示波器</button><label class="checkbox-row"><input id="scopeAutoRefresh" type="checkbox"> 自动刷新</label></div><div id="scopeInfo" class="info-text">等待读取画面</div></div>' +
            '<div class="scope-panel"><div class="scope-grid">' +
            '<div class="scope-cell"><canvas data-scope="luma"></canvas><div class="scope-celltool"><span class="scope-toollabel">范围</span>' + group('range', ['full','video','hdr'], scopeOptions.range) + '</div></div>' +
            '<div class="scope-cell"><canvas data-scope="rgb"></canvas><div class="scope-celltool"><button class="scope-tbtn is-on" data-scope-toggle="showR">R</button><button class="scope-tbtn is-on" data-scope-toggle="showG">G</button><button class="scope-tbtn is-on" data-scope-toggle="showB">B</button></div></div>' +
            '<div class="scope-cell"><canvas data-scope="vec"></canvas><div class="scope-celltool"><span class="scope-toollabel">放大</span>' + group('vecGain', [1,2,4,8], scopeOptions.vecGain) + '<button class="scope-tbtn' + (scopeOptions.skin ? ' is-on' : '') + '" data-scope-toggle="skin">肤</button></div></div>' +
            '<div class="scope-cell"><canvas data-scope="hist"></canvas><div class="scope-celltool"><span class="scope-toollabel">纵向</span>' + group('histScale', ['log','lin'], scopeOptions.histScale) + '</div></div>' +
            '</div><div class="scope-bar"><span class="scope-toollabel">采样</span>' + group('quality', [180,360,720], scopeOptions.quality) + '<span class="scope-status">实时读取当前选区 / 画布</span></div></div>');
        async function refresh() { try { drawScopeFromDataUrl(await captureToolSourceImage()); } catch (error) { showStatus('示波器读取失败：' + error.message, 'error'); } }
        document.getElementById('btnScopeRefresh').onclick = refresh;
        document.getElementById('scopeAutoRefresh').onchange = function() { if (scopeRefreshTimer) clearInterval(scopeRefreshTimer); scopeRefreshTimer = this.checked ? setInterval(refresh, 1200) : null; };
        content.querySelectorAll('[data-scope-action] .scope-btng-btn').forEach(function(button) {
            button.onclick = function() {
                const groupEl = button.closest('[data-scope-action]');
                const action = groupEl.getAttribute('data-scope-action');
                scopeOptions[action] = action === 'quality' || action === 'vecGain' ? Number(button.getAttribute('data-value')) : button.getAttribute('data-value');
                groupEl.querySelectorAll('.scope-btng-btn').forEach(function(item) { item.classList.toggle('is-on', item === button); });
                if (scopeLastDataUrl) drawScopeFromDataUrl(scopeLastDataUrl);
            };
        });
        content.querySelectorAll('[data-scope-toggle]').forEach(function(button) {
            const key = button.getAttribute('data-scope-toggle');
            button.classList.toggle('is-on', !!scopeOptions[key]);
            button.onclick = function() { scopeOptions[key] = !scopeOptions[key]; button.classList.toggle('is-on', scopeOptions[key]); if (scopeLastDataUrl) drawScopeFromDataUrl(scopeLastDataUrl); };
        });
        bindToolEditorCommon(drawScopeFromDataUrl);
        const current = getToolPreviewDataUrl(); if (current) drawScopeFromDataUrl(current);
    }

    function buildLightPrompt() {
        const color = document.getElementById('lightColor').value;
        const intensity = document.getElementById('lightIntensity').value;
        const radius = document.getElementById('lightRadius').value;
        const angle = document.getElementById('lightAngle').value;
        const x = document.getElementById('lightX').value;
        const y = document.getElementById('lightY').value;
        return 'Preserve the subject identity, face, pose, clothing, geometry and composition exactly. Relight the original image with a physically realistic soft key light. Light color ' + color + ', intensity ' + intensity + '%, radius/softness ' + radius + '%, direction angle ' + angle + ' degrees, light center at ' + x + '% horizontal and ' + y + '% vertical. Add natural cast shadows, contact shadows, reflected fill, skin-safe highlights and environment color bounce. Keep original texture and color grading; do not redraw or change objects. Photorealistic cinematic lighting, seamless composite, no text, no watermark.';
    }

    function renderLightEditor() {
        const content = document.getElementById('toolEditorContent');
        if (!content) return;
        const slider = function(id, label, value, max) { return '<div class="tt-control-row"><label>' + label + '</label><input id="' + id + '" type="range" min="0" max="' + (max || 100) + '" value="' + value + '"><output id="' + id + 'Out">' + value + '</output></div>'; };
        content.innerHTML = toolEditorShell('灯光修改', '在画面中点击定位灯光，实时预览颜色、强度、范围与方向。',
            '<div class="tt-tool-editor-grid"><div><div id="lightPreview" class="tt-live-preview"><div class="tt-live-preview-empty">读取选区后点击画面定位灯光</div><img data-tool-preview-img style="display:none"><div id="lightOrb" class="tt-light-orb"></div><div id="lightDirection" class="tt-light-direction"></div></div><div class="module-card" style="margin-top:8px"><label for="lightPromptPreview">灯光提示词预览</label><textarea id="lightPromptPreview" class="tt-prompt-preview"></textarea></div></div>' +
            '<div class="tt-tool-controls"><div class="tt-control-card"><div class="tt-control-row"><label>灯光颜色</label><input id="lightColor" type="color" value="#ffd8b0"><output id="lightColorOut">#ffd8b0</output></div>' + slider('lightIntensity','强度',72) + slider('lightRadius','范围/柔度',46) + slider('lightAngle','方向角度',315,360) + slider('lightX','水平位置',62) + slider('lightY','垂直位置',30) +
            '</div><div class="tt-tool-actions"><button id="btnLightGenerate" class="btn btn-primary">生成灯光修改</button></div></div></div>');
        function update() {
            ['lightIntensity','lightRadius','lightAngle','lightX','lightY'].forEach(function(id) { document.getElementById(id + 'Out').textContent = document.getElementById(id).value + (id === 'lightAngle' ? '°' : '%'); });
            const color = document.getElementById('lightColor').value; document.getElementById('lightColorOut').textContent = color;
            const orb = document.getElementById('lightOrb'); const x = document.getElementById('lightX').value; const y = document.getElementById('lightY').value; const radius = document.getElementById('lightRadius').value; const intensity = document.getElementById('lightIntensity').value;
            orb.style.left = x + '%'; orb.style.top = y + '%'; orb.style.width = Math.max(12, radius) + '%'; orb.style.background = 'radial-gradient(circle, ' + color + ' ' + Math.max(5, intensity / 8) + '%, transparent 68%)'; orb.style.opacity = Math.max(.18, intensity / 100);
            const direction = document.getElementById('lightDirection'); direction.style.left = x + '%'; direction.style.top = y + '%'; direction.style.transform = 'rotate(' + document.getElementById('lightAngle').value + 'deg)';
            document.getElementById('lightPromptPreview').value = buildLightPrompt();
        }
        content.querySelectorAll('input').forEach(function(el) { el.oninput = update; });
        document.getElementById('lightPreview').onclick = function(event) { const r = this.getBoundingClientRect(); document.getElementById('lightX').value = Math.round((event.clientX-r.left)/r.width*100); document.getElementById('lightY').value = Math.round((event.clientY-r.top)/r.height*100); update(); };
        document.getElementById('btnLightGenerate').onclick = function() { generateToolImage(document.getElementById('lightPromptPreview').value, 'relight', '灯光修改', this); };
        bindToolEditorCommon(setPreviewImages);
        setPreviewImages(getToolPreviewDataUrl());
        update();
    }

    async function generateToolImage(prompt, type, title, triggerButton) {
        if (!prompt) return;
        try {
            if (!selectedImageBase64) await captureToolSourceImage();
            const route = readIndependentGenerationControls('tool:' + activeToolEditor, 'toolRoute');
            await img2Img({
                prompt: prompt,
                model: route.model,
                imageResolution: route.imageResolution,
                imageCount: route.imageCount,
                type: type,
                title: title,
                button: triggerButton,
                idleButtonLabel: triggerButton ? triggerButton.textContent : title
            });
        } catch (error) {
            showStatus((title || '工具生成') + '失败：' + (error.message || error), 'error');
        }
    }

    function openToolEditor(kind, returnTab) {
        const activePage = document.querySelector('.tab-content.active');
        const inferredReturnTab = activePage && activePage.id === 'apps' ? 'apps' : 'toolbox';
        toolEditorReturnTab = returnTab === 'apps' || returnTab === 'toolbox' ? returnTab : inferredReturnTab;
        activeToolEditor = kind;
        toolPreviewRenderVersion++;
        if (kind === 'blend-match') blendMatchPreviewSources = null;
        if (scopeRefreshTimer) clearInterval(scopeRefreshTimer);
        scopeRefreshTimer = null;
        switchTab('toolEditor');
        if (kind === 'glow') renderGlowEditor();
        else if (kind === 'blend-match') renderBlendMatchEditor();
        else if (kind === 'scope') renderScopeEditor();
        else if (kind === 'light') renderLightEditor();
        else renderNewVfxEditor();

        // Photoshop UXP 不保证 innerHTML 插入的 select 会触发 MutationObserver。
        // 工具编辑器是动态生成的，渲染完成后必须显式包装，确保不会回退成灰色原生下拉。
        const editorContent = document.getElementById('toolEditorContent');
        if (editorContent) {
            initAllFakeSelects(editorContent);
            initToolRangeControls(editorContent);
        }
    }

    function openToolboxSpaceFx() {
        openToolEditor('vfx', 'toolbox');
    }

    function resizeChatPrompt() {
        const chatPrompt = document.getElementById('chatPrompt');
        if (!chatPrompt) return;
        chatPrompt.style.height = 'auto';
        chatPrompt.style.height = Math.min(chatPrompt.scrollHeight, 320) + 'px';
    }

    function updateChatHistory() {
        const chatHistoryDiv = document.getElementById('chatHistory');

        if (chatHistory.length === 0) {
            chatHistoryDiv.innerHTML = '<div class="info-text" style="text-align: center; padding: 20px;">暂无聊天记录</div>';
            return;
        }

        let html = '';
        chatHistory.forEach(function(message) {
            const isUser = message.role === 'user';
            html += '<div class="chat-message ' + (isUser ? 'user-message' : 'assistant-message') + '" style="margin-bottom: 10px; padding: 8px; border-radius: 4px; background: ' + (isUser ? '#2d2d2d' : '#1e3a1e') + ';">';
            html += '<div style="font-size: 10px; color: #6d6d6d; margin-bottom: 4px;">' + (isUser ? '我' : '助手') + ' - ' + escapeHTML(message.timestamp) + '</div>';
            html += '<div class="chat-message-content" style="word-break: break-word; white-space: pre-wrap;">' + escapeHTML(message.content) + '</div>';
            html += '</div>';
        });

        chatHistoryDiv.innerHTML = html;
        chatHistoryDiv.scrollTop = chatHistoryDiv.scrollHeight;
    }

    // UXP 对纵向 flex 子项的百分比宽度支持不稳定：内容较少的页面可能被压成 0 宽，
    // 百分比 min-width 又会触发布局循环。改为按面板可见宽度写入确定像素值。
    function syncActiveTabWidth(content) {
        const workspace = document.querySelector('.workspace');
        const activeContent = content || document.querySelector('.tab-content.active');
        if (!workspace || !activeContent) return;

        const workspaceRect = workspace.getBoundingClientRect();
        const workspaceWidth = Number(workspaceRect && workspaceRect.width) || Number(workspace.clientWidth) || 0;
        if (workspaceWidth <= 0) return;

        // Photoshop/UXP 的滚动槽不计入 clientWidth，视觉上固定占约 18px。
        const availableWidth = Math.max(1, Math.floor(workspaceWidth - 18));
        const widthValue = availableWidth + 'px';
        activeContent.style.setProperty('width', widthValue, 'important');
        activeContent.style.setProperty('min-width', widthValue, 'important');
        activeContent.style.setProperty('max-width', widthValue, 'important');
        // UXP 偶尔无视 flex 子项的显式 width，但会遵守确定的 flex-basis。
        activeContent.style.setProperty('flex', '0 0 ' + widthValue, 'important');
    }

    window.addEventListener('resize', function() {
        syncActiveTabWidth();
        // 预览区是正方形，卡片宽度变了要重新算边长
        squareGalleryThumbs();
    });

    // ---------- 供圆环助手调用的参数写入接口 ----------
    //
    // 为什么不直接把 DOM 的 value 交给外部改：面板的下拉是**自绘**的
    // （原生 <select> 被换成 .custom-select + 一个隐藏的原生 select）。
    // 外部直接设 .value 只会改到隐藏的那个，**可见的触发器文字纹丝不动** ——
    // 用户看到的就是「在圆环里改了参数，面板上没反应」。
    // 必须走面板自己的 refreshCustomSelectById，并顺带更新联动的文字。
    //
    // 返回 true 表示真的改成功了。值不在选项里就返回 false —— 不猜、不改，
    // 让调用方能如实报错，而不是静默什么都没发生。
    window.applyRingParam = function applyRingParam(key, value) {
        try {
            const text = String(value);

            if (key === 'model') {
                const select = document.getElementById('imgModel');
                if (!select) return false;
                const index = Array.from(select.options).findIndex(function (option) {
                    return option.value === text;
                });
                if (index < 0) return false;
                select.selectedIndex = index;
                refreshCustomSelectById('imgModel');
                // 模型换了，「平台与模型」卡片右上角那个渠道摘要也得跟着换
                updateImageProviderSummary(select.value);
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }

            if (key === 'resolution') {
                const select = document.getElementById('imgResolution');
                if (!select) return false;
                const normalized = normalizeImageResolution(text);
                const found = Array.from(select.options).some(function (option) {
                    return option.value === normalized;
                });
                if (!found) return false;
                select.value = normalized;
                refreshCustomSelectById('imgResolution');
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }

            if (key === 'count') {
                const select = document.getElementById('imageCount');
                if (!select) return false;
                const found = Array.from(select.options).some(function (option) {
                    return option.value === text;
                });
                if (!found) return false;
                select.value = text;
                refreshCustomSelectById('imageCount');
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
        } catch (error) {
            console.error('圆环参数写入失败:', key, error);
        }
        return false;
    };

    // ---------- 供圆环助手查询任务状态 ----------
    //
    // 圆环以前靠「画廊里出现新 ID」判断自己那次生成完成了。并发之后这会认错：
    // 两个任务同时跑，先回来的那个不是自己的也会被当成自己的 ——
    // 提示是错的，连缩略图都是别人的图。
    // 任务中心本来就有一份带 id 和 state 的记录，直接查它才分得清。
    window.HuanmengTaskCenter = {
        list: function () {
            return taskEntries.map(function (task) {
                return {
                    id: task.id,
                    state: task.state,
                    detail: task.detail || '',
                    prompt: task.prompt || '',
                    model: task.model || '',
                    completed: task.completed || 0,
                    total: task.total || 0
                };
            });
        }
    };

    // ---------- 供圆环助手调用的对话接口 ----------
    //
    // 圆环里的「对话」是个子菜单：模型 / 快捷提问 / 打字提问。
    // 这些都必须落到面板自己这条对话流程上，不能另起一套 ——
    // 否则圆环里问的、面板里问的会变成两份互不相干的聊天记录。
    //
    // 所以这里只做两件事：把文字塞进 #chatPrompt 并触发面板自己的发送按钮，
    // 然后盯着 chatHistory 等回复。请求、鉴权、失败提示全在 chat() 里，一行都不重复实现。

    window.applyRingChatModel = function applyRingChatModel(value) {
        try {
            const select = document.getElementById('chatModel');
            if (!select) return false;
            const text = String(value);
            const index = Array.from(select.options).findIndex(function (option) {
                return option.value === text;
            });
            if (index < 0) return false;
            select.selectedIndex = index;
            // 和图像参数那边同一个坑：对话模型下拉也是自绘的，
            // 只改隐藏的 <select> 的话可见文字不动 = 看起来没同步
            refreshCustomSelectById('chatModel');
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        } catch (error) {
            console.error('圆环写入对话模型失败:', error);
        }
        return false;
    };

    // 圆环要显示的那点对话状态。插件重启就没了 —— 聊天记录本来也不落盘，
    // 圆环上的「看回复」只在本次会话内有意义。
    const ringChatState = { busy: false, lastQuestion: '', lastReply: '', lastError: '' };

    function ringChatSleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    window.HuanmengChat = {
        state: function () {
            const select = document.getElementById('chatModel');
            const models = [];
            if (select && select.options) {
                for (let i = 0; i < select.options.length; i += 1) {
                    models.push({
                        value: String(select.options[i].value),
                        text: String(select.options[i].text || select.options[i].value)
                    });
                }
            }
            return {
                model: select ? String(select.value || '') : '',
                models: models,
                busy: ringChatState.busy,
                lastQuestion: ringChatState.lastQuestion,
                lastReply: ringChatState.lastReply,
                lastError: ringChatState.lastError,
                historyCount: chatHistory.length
            };
        },

        /**
         * 问一句，等回复。
         *
         * 为什么不直接调 API：对话要带上当前聊天记录和选区图片，
         * 那套上下文组装（buildChatContextMessages）只有 chat() 里那一份。
         * 从外面重放一遍迟早会走偏，所以这里老老实实驱动面板自己的按钮。
         *
         * 返回 { ok, reply } 或 { ok:false, error }。绝不抛异常 ——
         * 调用方是圆环桥接，它只需要一句能给用户看的话。
         */
        ask: async function (text) {
            const prompt = String(text == null ? '' : text).trim();
            if (!prompt) return { ok: false, error: '问题是空的' };
            if (ringChatState.busy) return { ok: false, error: '上一条还在等回复' };

            const button = document.getElementById('btnChat');
            const box = document.getElementById('chatPrompt');
            if (!button || typeof button.onclick !== 'function') {
                return { ok: false, error: '对话页还没初始化完，稍后再试' };
            }
            if (!box) return { ok: false, error: '找不到对话输入框' };

            const before = chatHistory.length;
            box.value = prompt;
            box.dispatchEvent(new Event('input', { bubbles: true }));

            ringChatState.busy = true;
            ringChatState.lastQuestion = prompt;
            ringChatState.lastError = '';

            try {
                button.onclick();

                // chat() 在真正发请求前会同步禁用按钮。没被禁用 = 它在校验阶段
                // 就 return 了（缺密钥、模型路由不对、没配 API…），
                // 原因写在底部状态栏里，直接拿来当错误信息 —— 不能干等三分钟。
                await ringChatSleep(500);
                if (!button.disabled) {
                    const status = document.getElementById('status');
                    const shown = status && status.classList.contains('show')
                        ? String(status.textContent || '').trim() : '';
                    const reason = shown || '面板拒绝了这次提问';
                    ringChatState.lastError = reason;
                    return { ok: false, error: reason };
                }

                const deadline = Date.now() + 180000;
                while (Date.now() < deadline && button.disabled) {
                    await ringChatSleep(400);
                }

                for (let i = before; i < chatHistory.length; i += 1) {
                    const message = chatHistory[i];
                    if (!message || message.role !== 'assistant') continue;
                    const content = String(message.content || '');
                    // 面板把失败也写成一条 assistant 消息，前缀是固定的
                    if (/^发送失败/.test(content)) {
                        const error = content.replace(/^发送失败：?/, '').trim() || '发送失败';
                        ringChatState.lastError = error;
                        return { ok: false, error: error };
                    }
                    ringChatState.lastReply = content;
                    ringChatState.lastError = '';
                    return { ok: true, reply: content };
                }

                if (Date.now() >= deadline) {
                    const timeout = '等待回复超时（3 分钟）';
                    ringChatState.lastError = timeout;
                    return { ok: false, error: timeout };
                }
                const empty = '没有拿到回复内容';
                ringChatState.lastError = empty;
                return { ok: false, error: empty };
            } catch (error) {
                const message = error && error.message ? error.message : '提问失败';
                ringChatState.lastError = message;
                return { ok: false, error: message };
            } finally {
                ringChatState.busy = false;
            }
        },

        /**
         * 聊天记录，给圆环显示用。
         * 只给显示要的字段 —— 圆环不需要知道时间戳那些。
         * limit 是「最近多少条」，默认全部。
         */
        history: function (limit) {
            const all = chatHistory.filter(function (message) {
                return message && (message.role === 'user' || message.role === 'assistant');
            });
            const start = typeof limit === 'number' && limit > 0
                ? Math.max(0, all.length - limit)
                : 0;
            return all.slice(start).map(function (message) {
                return { role: message.role, text: String(message.content || '') };
            });
        },

        newChat: function () {
            // 用 length = 0 而不是换一个新数组：chatHistory 是闭包共享的绑定，
            // 换数组会让别处已经拿到的引用指向旧的那个（面板上是清不掉的）。
            chatHistory.length = 0;
            ringChatState.lastQuestion = '';
            ringChatState.lastReply = '';
            ringChatState.lastError = '';
            updateChatHistory();
            return true;
        }
    };

    // 全局函数，供HTML直接调用
    window.switchTab = function switchTab(tabId) {
        debugLog('切换到标签页:', tabId);
        closeAllCustomSelects(null);

        if (tabId !== 'toolEditor' && scopeRefreshTimer) {
            clearInterval(scopeRefreshTimer);
            scopeRefreshTimer = null;
        }
        
        // 移除所有标签页的active类
        document.querySelectorAll('.tab').forEach(function(tab) {
            tab.classList.remove('active');
        });
        
        // 移除所有内容区域的active类
        document.querySelectorAll('.tab-content').forEach(function(content) {
            content.classList.remove('active');
        });
        
        // 添加当前标签页的active类
        const activeTab = document.querySelector('.tab[data-tab="' + tabId + '"]');
        if (activeTab) {
            activeTab.classList.add('active');
            debugLog('成功激活标签页:', tabId);
        } else if (tabId !== 'toolEditor') {
            console.error('未找到标签页:', tabId);
        }
        
        // 添加当前内容区域的active类
        const activeContent = document.getElementById(tabId);
        if (activeContent) {
            activeContent.classList.add('active');
            syncActiveTabWidth(activeContent);
            requestAnimationFrame(function() {
                syncActiveTabWidth(activeContent);
            });
            // UXP 在内容较多的标签切换后还会进行一次异步 flex 布局；
            // 再校准一次，避免偶发把设置/记录页压成 0 宽。
            setTimeout(function() {
                if (activeContent.classList.contains('active')) syncActiveTabWidth(activeContent);
            }, 80);
            debugLog('成功激活内容区域:', tabId);
        } else {
            console.error('未找到内容区域:', tabId);
        }

        if (tabId === 'home') {
            refreshAnnouncements();
            checkForUpdates(false);
        }

        if (tabId === 'gallery') {
            renderGallery().catch(function(error) {
                showStatus('读取画廊失败：' + error.message, 'error');
            });
        }

        if (!initCompatibility()) applyBrowserCaptureLabels();


        if (tabId === 'img2img') {
            ensureImg2ImgInlineControls();
            ensurePresetActionButtons();
            refreshPresetsForGenerationEntry().catch(function(error) {
                console.error('刷新预设失败:', error);
            });
            bindPseudoVfxControls();
            if (currentVfxConfig) {
                updateVfxUiFromConfig(currentVfxConfig);
            }
        }

        if (tabId === 'img2imgTutorial') {
            bindSettingsGroupTogglesByContainer('img2imgTutorial', false);
        }

        if (tabId === 'apps') {
            appsReturnTab = 'apps';
            ensurePresetsLoaded().catch(function(error) {
                console.error('加载预设失败:', error);
            });
            bindPseudoVfxControls();
            renderAppsHome();
            setAppsEditorVisible('home');
            updateVfxUiFromConfig(currentVfxConfig || DEFAULT_VFX_CONFIG);
        }

        if (tabId === 'runninghub') {
            appsReturnTab = 'runninghub';
            renderRunninghubHome();
            setAppsEditorVisible('home');
        }

        if (tabId === 'vfxTutorial') {
            bindSettingsGroupTogglesByContainer('vfxTutorial', false);
        }

        if (tabId === 'settings') {
            organizeSettingsPage();
            ensureSettingsUiCompatibility();
            bindSettingsGroupToggles();
            ensureSettingsModelActionsVisible();
            bindModelActionButtons();
            initAllFakeSelects(document.getElementById('settings'));
        }

        if (tabId === 'tasks' || tabId === 'generationCenter') {
            renderTaskCenter();
        }

        // 对话页与生成中心已拆开：切过来时重绘一次并滚到底，
        // 避免在别的标签页期间产生的对话看不到。
        if (tabId === 'chat') {
            updateChatHistory();
        }
        
        // 如果切换到logs标签，更新日志显示
        if (tabId === 'logs') {
            debugLog('更新日志显示');
            updateLogDisplay();
            syncActiveTabWidth(activeContent);
            setTimeout(function() { syncActiveTabWidth(activeContent); }, 80);
        }

        if (activeContent) initAllRenderedRanges(activeContent);
    }

    async function loadSettings() {
        const storedSettings = Config.getSettings() || {};

        currentSettings = Object.assign({
            chatApiKey: "",
            imgApiKey: "",
            chatApiUrl: OPENAI_OFFICIAL_BASE_URL,
            imgApiUrl: GRS_DEFAULT_BASE_URL,
            grsRegion: "overseas",
            volcengineApiUrl: VOLCENGINE_DEFAULT_BASE_URL,
            volcengineApiKey: "",
            volcengineImageModel: VOLCENGINE_DEFAULT_IMAGE_MODEL,
            volcengineChatModel: VOLCENGINE_DEFAULT_CHAT_MODEL,
            newApiUrl: NEWAPI_DEFAULT_BASE_URL,
            newApiKey: "",
            newApiImageModel: "",
            newApiImageMode: "auto",
            xaiApiUrl: XAI_DEFAULT_BASE_URL,
            xaiApiKey: "",
            grok2apiApiUrl: GROK2API_DEFAULT_BASE_URL,
            grok2apiApiKey: "",
            sub2apiApiUrl: SUB2API_DEFAULT_BASE_URL,
            sub2apiApiKey: "",
            fireflyApiUrl: FIREFLY_DEFAULT_BASE_URL,
            fireflyApiKey: "",
            googleApiKey: "",
            googleAiEnabled: true,
            chatModel: DEFAULT_GRS_CHAT_MODEL,
            imgModel: DEFAULT_IMAGE_MODEL,
            imgResolution: DEFAULT_IMAGE_RESOLUTION,
            textSystemPromptPositive: DEFAULT_TEXT_SYSTEM_PROMPT_POSITIVE,
            textSystemPromptNegative: DEFAULT_TEXT_SYSTEM_PROMPT_NEGATIVE,
            imageSystemPromptPositive: DEFAULT_IMAGE_SYSTEM_PROMPT_POSITIVE,
            imageSystemPromptNegative: DEFAULT_IMAGE_SYSTEM_PROMPT_NEGATIVE,
            model: "gemini-2.0-flash-exp",
            textSizeMultiplier: 1,
            alignmentMode: "fit-layer",
            runninghubApiKey: "",
            runninghubApps: [],
            advancedPollInterval: DEFAULT_RUNNINGHUB_POLL_INTERVAL,
            advancedTimeout: DEFAULT_RUNNINGHUB_TIMEOUT,
            advancedMaxConcurrent: DEFAULT_RUNNINGHUB_MAX_CONCURRENT,
            advancedAiOptimizeAppId: DEFAULT_AI_OPTIMIZE_APP_ID,
            autoColorMatchEnabled: false,
            autoColorMatchOptInVersion: 0,
            autoColorMatchMethod: 'wavelet',
            promptSyncBaseUrl: '',
            galleryRetentionMode: "count",
            galleryMaxCount: 30,
            galleryMaxDays: 30
        }, storedSettings);

        currentSettings.chatApiUrl = OPENAI_OFFICIAL_BASE_URL;
        if (!currentSettings.imgApiKey && currentSettings.chatApiKey) {
            currentSettings.imgApiKey = currentSettings.chatApiKey;
        }
        currentSettings.imgApiUrl = normalizeGrsBaseUrlStrict(currentSettings.imgApiUrl);
        currentSettings.grsRegion = currentSettings.grsRegion === 'domestic' ? 'domestic' : 'overseas';
        currentSettings.imgApiUrl = currentSettings.grsRegion === 'domestic' ? GRS_CHINA_BASE_URL : GRS_DEFAULT_BASE_URL;
        currentSettings.volcengineApiUrl = getVolcengineBaseUrlFromSettings(currentSettings);
        currentSettings.volcengineImageModel = String(currentSettings.volcengineImageModel || VOLCENGINE_DEFAULT_IMAGE_MODEL).trim();
        currentSettings.volcengineChatModel = String(currentSettings.volcengineChatModel || VOLCENGINE_DEFAULT_CHAT_MODEL).trim();
        currentSettings.galleryRetentionMode = ['count', 'days', 'both'].indexOf(currentSettings.galleryRetentionMode) > -1 ? currentSettings.galleryRetentionMode : 'count';
        currentSettings.galleryMaxCount = Math.max(1, Math.min(500, Number(currentSettings.galleryMaxCount) || 30));
        currentSettings.galleryMaxDays = Math.max(1, Math.min(3650, Number(currentSettings.galleryMaxDays) || 30));
        currentSettings.textSystemPromptPositive = String(currentSettings.textSystemPromptPositive == null ? DEFAULT_TEXT_SYSTEM_PROMPT_POSITIVE : currentSettings.textSystemPromptPositive);
        currentSettings.textSystemPromptNegative = String(currentSettings.textSystemPromptNegative == null ? DEFAULT_TEXT_SYSTEM_PROMPT_NEGATIVE : currentSettings.textSystemPromptNegative);
        currentSettings.imageSystemPromptPositive = String(currentSettings.imageSystemPromptPositive == null ? DEFAULT_IMAGE_SYSTEM_PROMPT_POSITIVE : currentSettings.imageSystemPromptPositive);
        currentSettings.imageSystemPromptNegative = String(currentSettings.imageSystemPromptNegative == null ? DEFAULT_IMAGE_SYSTEM_PROMPT_NEGATIVE : currentSettings.imageSystemPromptNegative);
        currentSettings.newApiUrl = normalizeBaseUrl(currentSettings.newApiUrl, NEWAPI_DEFAULT_BASE_URL);
        currentSettings.xaiApiUrl = normalizeBaseUrl(currentSettings.xaiApiUrl, XAI_DEFAULT_BASE_URL);
        currentSettings.grok2apiApiUrl = normalizeBaseUrl(currentSettings.grok2apiApiUrl, GROK2API_DEFAULT_BASE_URL);
        currentSettings.sub2apiApiUrl = normalizeBaseUrl(currentSettings.sub2apiApiUrl, SUB2API_DEFAULT_BASE_URL);
        currentSettings.fireflyApiUrl = normalizeBaseUrl(currentSettings.fireflyApiUrl, FIREFLY_DEFAULT_BASE_URL);
        const legacyXaiWasGrok2Api = /^g2a_/i.test(String(currentSettings.xaiApiKey || ''))
            || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::8000)?(?:\/|$)/i.test(String(currentSettings.xaiApiUrl || ''));
        if (legacyXaiWasGrok2Api) {
            if (!storedSettings.grok2apiApiKey) currentSettings.grok2apiApiKey = currentSettings.xaiApiKey || '';
            if (!storedSettings.grok2apiApiUrl) currentSettings.grok2apiApiUrl = currentSettings.xaiApiUrl || GROK2API_DEFAULT_BASE_URL;
            if (parseModelSelection(currentSettings.imgModel).provider === 'xai') {
                currentSettings.imgModel = buildModelValue('grok2api', getModelName(currentSettings.imgModel));
            }
            Config.saveSettings(Object.assign({}, storedSettings, currentSettings));
        }
        currentSettings.newApiImageMode = ['auto', 'images', 'chat'].indexOf(currentSettings.newApiImageMode) > -1 ? currentSettings.newApiImageMode : 'auto';
        currentSettings.advancedPollInterval = Math.min(60000, Math.max(500, Number(currentSettings.advancedPollInterval) || DEFAULT_RUNNINGHUB_POLL_INTERVAL));
        currentSettings.advancedTimeout = Math.min(120000, Math.max(5000, Number(currentSettings.advancedTimeout) || DEFAULT_RUNNINGHUB_TIMEOUT));
        currentSettings.advancedMaxConcurrent = Math.min(5, Math.max(1, Number(currentSettings.advancedMaxConcurrent) || DEFAULT_RUNNINGHUB_MAX_CONCURRENT));
        currentSettings.advancedAiOptimizeAppId = normalizeRunninghubAppId(currentSettings.advancedAiOptimizeAppId || '') || DEFAULT_AI_OPTIMIZE_APP_ID;
        // 2.1.1 起自动校色改为明确自愿开启。旧版本默认 true 会让回图长时间
        // 停在“校色并回写”，因此没有新 opt-in 标记时统一迁移为关闭。
        currentSettings.autoColorMatchEnabled = storedSettings.autoColorMatchOptInVersion === 2 && storedSettings.autoColorMatchEnabled === true;
        currentSettings.autoColorMatchOptInVersion = storedSettings.autoColorMatchOptInVersion === 2 ? 2 : 0;
        currentSettings.autoColorMatchMethod = currentSettings.autoColorMatchMethod === 'reinhard' ? 'reinhard' : 'wavelet';
        currentSettings.promptSyncBaseUrl = String(currentSettings.promptSyncBaseUrl || '').trim();
        currentSettings.runninghubApps = Array.isArray(currentSettings.runninghubApps) ? currentSettings.runninghubApps : [];
        loadRunninghubApps(currentSettings.runninghubApps);
        currentSettings.runninghubApps = runninghubApps.slice();
        currentSettings.chatModel = normalizeChatModelValue(currentSettings.chatModel || currentSettings.model || DEFAULT_GRS_CHAT_MODEL);

        // 兼容旧版本默认值：历史配置为 nano-banana-pro 时自动迁移到 PS 原生模型
        const storedImgModelKey = getModelKey(storedSettings.imgModel || '');
        if (!storedImgModelKey || storedImgModelKey === LEGACY_IMAGE_DEFAULT_MODEL) {
            currentSettings.imgModel = DEFAULT_IMAGE_MODEL;
            if (storedSettings.imgModel !== DEFAULT_IMAGE_MODEL) {
                Config.saveSettings(Object.assign({}, storedSettings, currentSettings));
            }
        }

        if (currentSettings) {
            const chatApiKeyEl = document.getElementById('chatApiKey');
            if (chatApiKeyEl) {
                chatApiKeyEl.value = currentSettings.chatApiKey || '';
            }
            
            const imgApiKeyEl = document.getElementById('imgApiKey');
            if (imgApiKeyEl) {
                imgApiKeyEl.value = currentSettings.imgApiKey || '';
            }
            
            const chatApiUrlEl = document.getElementById('chatApiUrl');
            if (chatApiUrlEl) {
                chatApiUrlEl.value = currentSettings.chatApiUrl || '';
            }
            
            const imgApiUrlEl = document.getElementById('imgApiUrl');
            const grsRegionEl = document.getElementById('grsRegion');
            const volcengineApiUrlEl = document.getElementById('volcengineApiUrl');
            const volcengineApiKeyEl = document.getElementById('volcengineApiKey');
            const volcengineImageModelEl = document.getElementById('volcengineImageModel');
            const volcengineChatModelEl = document.getElementById('volcengineChatModel');
            const galleryRetentionModeEl = document.getElementById('galleryRetentionMode');
            const galleryMaxCountEl = document.getElementById('galleryMaxCount');
            const galleryMaxDaysEl = document.getElementById('galleryMaxDays');
            if (imgApiUrlEl) {
                imgApiUrlEl.value = currentSettings.imgApiUrl || '';
            }

            if (grsRegionEl) grsRegionEl.value = currentSettings.grsRegion;
            if (volcengineApiUrlEl) volcengineApiUrlEl.value = currentSettings.volcengineApiUrl;
            if (volcengineApiKeyEl) volcengineApiKeyEl.value = currentSettings.volcengineApiKey || '';
            if (volcengineImageModelEl) volcengineImageModelEl.value = currentSettings.volcengineImageModel;
            if (volcengineChatModelEl) volcengineChatModelEl.value = currentSettings.volcengineChatModel;
            if (galleryRetentionModeEl) galleryRetentionModeEl.value = currentSettings.galleryRetentionMode;
            if (galleryMaxCountEl) galleryMaxCountEl.value = String(currentSettings.galleryMaxCount);
            if (galleryMaxDaysEl) galleryMaxDaysEl.value = String(currentSettings.galleryMaxDays);

            const newApiUrlEl = document.getElementById('newApiUrl');
            if (newApiUrlEl) {
                newApiUrlEl.value = currentSettings.newApiUrl || '';
            }

            const newApiKeyEl = document.getElementById('newApiKey');
            if (newApiKeyEl) {
                newApiKeyEl.value = currentSettings.newApiKey || '';
            }

            const newApiImageModeEl = document.getElementById('newApiImageMode');
            if (newApiImageModeEl) {
                newApiImageModeEl.value = currentSettings.newApiImageMode || 'auto';
            }
            const newApiImageModelEl = document.getElementById('newApiImageModel');
            if (newApiImageModelEl) newApiImageModelEl.value = currentSettings.newApiImageModel || '';

            const xaiApiUrlEl = document.getElementById('xaiApiUrl');
            if (xaiApiUrlEl) xaiApiUrlEl.value = currentSettings.xaiApiUrl || XAI_DEFAULT_BASE_URL;
            const xaiApiKeyEl = document.getElementById('xaiApiKey');
            if (xaiApiKeyEl) xaiApiKeyEl.value = currentSettings.xaiApiKey || '';
            const grok2apiApiUrlEl = document.getElementById('grok2apiApiUrl');
            if (grok2apiApiUrlEl) grok2apiApiUrlEl.value = currentSettings.grok2apiApiUrl || GROK2API_DEFAULT_BASE_URL;
            const grok2apiApiKeyEl = document.getElementById('grok2apiApiKey');
            if (grok2apiApiKeyEl) grok2apiApiKeyEl.value = currentSettings.grok2apiApiKey || '';
            const sub2apiApiUrlEl = document.getElementById('sub2apiApiUrl');
            if (sub2apiApiUrlEl) sub2apiApiUrlEl.value = currentSettings.sub2apiApiUrl || SUB2API_DEFAULT_BASE_URL;
            const sub2apiApiKeyEl = document.getElementById('sub2apiApiKey');
            if (sub2apiApiKeyEl) sub2apiApiKeyEl.value = currentSettings.sub2apiApiKey || '';
            const fireflyApiUrlEl = document.getElementById('fireflyApiUrl');
            if (fireflyApiUrlEl) fireflyApiUrlEl.value = currentSettings.fireflyApiUrl || FIREFLY_DEFAULT_BASE_URL;
            const fireflyApiKeyEl = document.getElementById('fireflyApiKey');
            if (fireflyApiKeyEl) fireflyApiKeyEl.value = currentSettings.fireflyApiKey || '';

            const googleApiKeyEl = document.getElementById('googleApiKey');
            if (googleApiKeyEl) {
                googleApiKeyEl.value = currentSettings.googleApiKey || '';
            }

            const googleAiEnabledEl = document.getElementById('googleAiEnabled');
            if (googleAiEnabledEl) {
                googleAiEnabledEl.checked = !!currentSettings.googleAiEnabled;
            }
            
            const chatModelSelect = document.getElementById('chatModel');
            const imgProviderSelect = document.getElementById('imgProvider');
            const imgModelSelect = document.getElementById('imgModel');
            const imgResolutionSelect = document.getElementById('imgResolution');
            const imageCountSelect = document.getElementById('imageCount');
            
            if (chatModelSelect) {
                fillChatModels([], currentSettings.googleApiKey || '', !!currentSettings.googleAiEnabled, currentSettings.newApiKey || '', currentSettings.newApiUrl || '', currentNewApiChatModels);
                const savedModel = normalizeChatModelValue(currentSettings.chatModel || currentSettings.model || '');
                const chatOptionIndex = Array.from(chatModelSelect.options).findIndex(function(option) {
                    return normalizeChatModelValue(option.value) === savedModel;
                });
                chatModelSelect.selectedIndex = chatOptionIndex > -1 ? chatOptionIndex : 0;
                refreshCustomSelectById('chatModel');
            }
            if (imgModelSelect) {
                // 初始化时直接填充本地默认生图模型（无需手动拉取）
                const savedModelValue = currentSettings.imgModel || currentSettings.model || '';
                if (imgProviderSelect) imgProviderSelect.value = getImageProviderChannel(savedModelValue);
                fillImageModels([]);
                const savedModel = getModelName(savedModelValue);
                const savedSelectionKey = getImageModelSelectionKey(savedModelValue);
                const normalizedSavedModel = normalizeGrsModelName(savedModel).toLowerCase();
                const optionIndex = Array.from(imgModelSelect.options).findIndex(function(option) {
                    const optionModel = getModelName(option.value).toLowerCase();
                    return getImageModelSelectionKey(option.value) === savedSelectionKey
                        || (!parseModelSelection(savedModelValue).provider && (optionModel === savedModel.toLowerCase() || optionModel === normalizedSavedModel));
                });
                imgModelSelect.selectedIndex = optionIndex > -1 ? optionIndex : 0;
                refreshCustomSelectById('imgModel');
                updateImageProviderSummary(imgModelSelect.value);
            }
            if (imgResolutionSelect) {
                imgResolutionSelect.value = normalizeImageResolution(currentSettings.imgResolution);
                refreshCustomSelectById('imgResolution');
            }
            if (imageCountSelect) {
                imageCountSelect.selectedIndex = 0;
                refreshCustomSelectById('imageCount');
            }
        } else {
            // 设置文字大小倍数默认值
            const textSizeMultiplierEl = document.getElementById('textSizeMultiplier');
            const textSizeValueEl = document.getElementById('textSizeValue');
            if (textSizeMultiplierEl) {
                textSizeMultiplierEl.value = 1;
            }
            if (textSizeValueEl) {
                textSizeValueEl.textContent = '当前倍数: 1.0x';
            }
            
            // 确保PS原生模型在没有设置的情况下也显示
            const imgModelSelect = document.getElementById('imgModel');
            if (imgModelSelect) {
                fillImageModels([]);
                imgModelSelect.selectedIndex = 0;
                refreshCustomSelectById('imgModel');
            }
            const imgResolutionSelect = document.getElementById('imgResolution');
            if (imgResolutionSelect) {
                imgResolutionSelect.value = DEFAULT_IMAGE_RESOLUTION;
                refreshCustomSelectById('imgResolution');
            }
        }
        
        // 加载文字大小倍数设置
        const textSizeMultiplierEl = document.getElementById('textSizeMultiplier');
        const textSizeValueEl = document.getElementById('textSizeValue');
        if (textSizeMultiplierEl) {
            textSizeMultiplierEl.value = currentSettings.textSizeMultiplier || 1;
        }
        if (textSizeValueEl) {
            textSizeValueEl.textContent = '当前倍数: ' + (currentSettings.textSizeMultiplier || 1).toFixed(1) + 'x';
        }
        
        // 加载图片对齐模式设置
        const alignmentModeEl = document.getElementById('alignmentMode');
        if (alignmentModeEl) {
            alignmentModeEl.value = currentSettings.alignmentMode || 'fit-layer';
        }
        document.querySelectorAll('[data-align-mode]').forEach(function(button) {
            button.classList.toggle('active', button.dataset.alignMode === (currentSettings.alignmentMode || 'fit-layer'));
        });

        const runninghubApiKeyEl = document.getElementById('runninghubApiKey');
        if (runninghubApiKeyEl) {
            runninghubApiKeyEl.value = currentSettings.runninghubApiKey || '';
        }

        const advancedPollIntervalEl = document.getElementById('advancedPollInterval');
        if (advancedPollIntervalEl) {
            advancedPollIntervalEl.value = currentSettings.advancedPollInterval || DEFAULT_RUNNINGHUB_POLL_INTERVAL;
        }

        const advancedTimeoutEl = document.getElementById('advancedTimeout');
        if (advancedTimeoutEl) {
            advancedTimeoutEl.value = currentSettings.advancedTimeout || DEFAULT_RUNNINGHUB_TIMEOUT;
        }

        const advancedMaxConcurrentEl = document.getElementById('advancedMaxConcurrent');
        if (advancedMaxConcurrentEl) {
            advancedMaxConcurrentEl.value = currentSettings.advancedMaxConcurrent || DEFAULT_RUNNINGHUB_MAX_CONCURRENT;
        }

        const advancedAiOptimizeAppIdEl = document.getElementById('advancedAiOptimizeAppId');
        if (advancedAiOptimizeAppIdEl) {
            advancedAiOptimizeAppIdEl.value = currentSettings.advancedAiOptimizeAppId || DEFAULT_AI_OPTIMIZE_APP_ID;
        }

        const autoColorMatchEnabledEl = document.getElementById('autoColorMatchEnabled');
        if (autoColorMatchEnabledEl) autoColorMatchEnabledEl.checked = currentSettings.autoColorMatchEnabled === true;
        const autoColorMatchMethodEl = document.getElementById('autoColorMatchMethod');
        if (autoColorMatchMethodEl) autoColorMatchMethodEl.value = currentSettings.autoColorMatchMethod || 'wavelet';
        const toolColorMatchMethodEl = document.getElementById('toolColorMatchMethod');
        if (toolColorMatchMethodEl) toolColorMatchMethodEl.value = currentSettings.autoColorMatchMethod || 'wavelet';
        const promptSyncBaseUrlEl = document.getElementById('promptSyncBaseUrl');
        if (promptSyncBaseUrlEl) promptSyncBaseUrlEl.value = currentSettings.promptSyncBaseUrl || '';
        [
            ['textSystemPromptPositive', 'textSystemPromptPositive'],
            ['textSystemPromptNegative', 'textSystemPromptNegative'],
            ['imageSystemPromptPositive', 'imageSystemPromptPositive'],
            ['imageSystemPromptNegative', 'imageSystemPromptNegative']
        ].forEach(function(binding) {
            const element = document.getElementById(binding[0]);
            if (element) element.value = currentSettings[binding[1]] || '';
        });

        const runninghubAppIdInputEl = document.getElementById('runninghubAppIdInput');
        if (runninghubAppIdInputEl) {
            runninghubAppIdInputEl.value = '';
        }
        pendingRunninghubParsedApp = null;
        updateRunninghubParsedAppInfo();
        renderRunninghubAppList();
        renderAppsHome();
        renderToolboxMobileRouteControls();
        refreshRunninghubAccountSummary();
        setAppsEditorVisible('home');
        
        // 应用文字大小设置
        applyTextSizeMultiplier(currentSettings.textSizeMultiplier || 1);

        loadPresetCategories([]);
        updatePresetSelect([]);

        // 初始化时更新预览比例
        const currentImgModelEl = document.getElementById('imgModel');
        updatePreviewAspectByModel(currentImgModelEl ? currentImgModelEl.value : '');
    }



    let presetsLoadPromise = null;
    let presetsLoaded = false;
    let generationPresetRefreshPromise = null;

    async function ensurePresetsLoaded() {
        if (presetsLoaded) return currentAllPresets;
        if (!presetsLoadPromise) {
            presetsLoadPromise = loadPresets().finally(function() {
                presetsLoadPromise = null;
            });
        }
        const loadState = await presetsLoadPromise;
        presetsLoaded = !loadState || loadState.ready !== false;
        return currentAllPresets;
    }

    function invalidatePresetCache() {
        presetsLoaded = false;
        presetsLoadPromise = null;
    }

    function refreshPresetsForGenerationEntry() {
        if (generationPresetRefreshPromise) return generationPresetRefreshPromise;
        // 本地预设必须先立即显示；云同步不可阻塞生成页，更不能让网络故障把
        // 分类/预设按钮长期留在空状态。云端完成后再无感刷新。
        generationPresetRefreshPromise = ensurePresetsLoaded().then(function(localPresets) {
            syncServerPresets({ silent: true }).catch(function(error) {
                console.warn('进入生成页时同步云预设失败，继续使用本地预设:', error && error.message);
            });
            return localPresets;
        }).finally(function() {
            generationPresetRefreshPromise = null;
        });
        return generationPresetRefreshPromise;
    }

    function scheduleDeferredStartupWork() {
        setTimeout(function() {
            initFakeSelects();
            FAKE_SELECT_IDS.forEach(refreshCustomSelectById);
            bindModelActionButtons();
        }, 800);

        setTimeout(function() {
            refreshAnnouncements();
            checkForUpdates(false);
        }, 1200);
    }

    // 使用异步函数来读取 yushe.json
    async function loadYushePresets() {
        try {
            if (!uxpFs) {
                const response = await fetch('assets/presets/yushe.json', { cache: 'no-store' });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return { presets: dedupePresetEntries(await response.json()), ready: true };
            }
            const pluginFolder = await uxpFs.getPluginFolder();
            const assetsFolder = await pluginFolder.getEntry("assets");
            const presetsFolder = await assetsFolder.getEntry("presets");
            const file = await presetsFolder.getEntry("yushe.json");
            const content = await file.read();
            const presets = dedupePresetEntries(JSON.parse(content));
            debugLog("成功加载本地预设:", presets);
            return { presets: presets, ready: true };
        } catch (e) {
            console.error("读取 yushe.json 失败:", e);
            return { presets: [], ready: true };
        }
    }



    async function loadUserPresets() {
        if (!uxpFs) return Config.getPresets() || [];
        try {
            const dataFolder = await uxpFs.getDataFolder();
            const file = await dataFolder.getEntry('huanmeng_user_presets.json');
            return dedupePresetEntries(JSON.parse(await file.read()));
        } catch (error) {
            return [];
        }
    }

    async function saveUserPresets(presets) {
        const normalized = dedupePresetEntries(presets || []);
        if (!uxpFs) {
            const config = Config.read();
            config.presets = normalized;
            return Config.write(config);
        }
        const dataFolder = await uxpFs.getDataFolder();
        const file = await dataFolder.createFile('huanmeng_user_presets.json', { overwrite: true });
        await file.write(JSON.stringify(normalized, null, 2));
        return true;
    }

    function extractPresetPromptText(content) {
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            return content.map(extractPresetPromptText).filter(Boolean).join('\n');
        }

        if (!content || typeof content !== 'object') {
            return '';
        }

        const preferredKeys = ['prompt', 'content', 'instruction', 'description', 'positive', 'negative', 'sccz', 'sccf'];
        const chunks = [];

        preferredKeys.forEach(function(key) {
            if (!(key in content)) return;
            const value = extractPresetPromptText(content[key]);
            if (!value) return;
            if (key === 'positive' || key === 'sccz') {
                chunks.push('正向提示词：' + value);
                return;
            }
            if (key === 'negative' || key === 'sccf') {
                chunks.push('反向提示词：' + value);
                return;
            }
            chunks.push(value);
        });

        Object.keys(content).forEach(function(key) {
            if (preferredKeys.indexOf(key) > -1) return;
            const value = extractPresetPromptText(content[key]);
            if (value) {
                chunks.push(value);
            }
        });

        return chunks.join('\n').trim();
    }

    function normalizePresetPromptText(prompt) {
        let text = String(prompt || '').replace(/\r/g, '\n').trim();
        if (!text) return '';

        if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
            try {
                text = extractPresetPromptText(JSON.parse(text));
            } catch (e) {
                // keep original text
            }
        }

        return text
            .replace(/^现在你是一个[^：:\n]+[：:]\s*/i, '')
            .replace(/^你是一个[^：:\n]+[：:]\s*/i, '')
            .replace(/^作为[^，。；：:\n]+[，：:]\s*/i, '')
            .replace(/^\s*prompt\s*[:：]\s*/i, '')
            .replace(/^\s*json\s*[:：]\s*/i, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function normalizePresetEntry(preset) {
        if (!preset) return null;

        const name = String(preset.name || preset.title || '').trim();
        const category = String(preset.category || '其他').trim() || '其他';
        const vfxConfig = normalizeVfxConfig(preset.vfxConfig);
        const hasVfxPreset = !!(preset.vfxConfig && typeof preset.vfxConfig === 'object' && vfxConfig.enabled);
        const promptSource = typeof preset.prompt !== 'undefined'
            ? preset.prompt
            : (typeof preset.content !== 'undefined' ? preset.content : (hasVfxPreset ? buildVfxPrompt(vfxConfig) : ''));
        const prompt = normalizePresetPromptText(
            extractPresetPromptText(promptSource)
        );

        if (!name || !prompt) return null;
        const refImages = normalizeReferenceImageList(preset.refImages || preset.referenceImages);
        return {
            name: name,
            prompt: prompt,
            category: category,
            refImages: refImages,
            vfxConfig: hasVfxPreset ? vfxConfig : null
        };
    }

    function dedupePresetEntries(presets) {
        const seenPromptKeys = new Set();
        const seenNameKeys = new Set();
        const result = [];

        (presets || []).forEach(function(preset) {
            const normalized = normalizePresetEntry(preset);
            if (!normalized) return;

            const nameKey = normalized.name.trim().toLowerCase();
            if (nameKey && seenNameKeys.has(nameKey)) return;

            const promptKey = normalized.prompt.replace(/\s+/g, ' ').trim().toLowerCase();
            if (promptKey && seenPromptKeys.has(promptKey) && !normalized.vfxConfig) return;

            if (nameKey) {
                seenNameKeys.add(nameKey);
            }
            if (promptKey) {
                seenPromptKeys.add(promptKey);
            }
            result.push(normalized);
        });

        return result;
    }

    // 算法一：1:1 强制无偏移模式
    // 1. 计算虚拟正方形边界
    function computeVirtualSquareBounds(originalBounds) {
        if (!originalBounds) return null;
        const w = Math.max(1, Math.round(originalBounds.right - originalBounds.left));
        const h = Math.max(1, Math.round(originalBounds.bottom - originalBounds.top));
        const size = Math.max(w, h);
        const dx = Math.floor((size - w) / 2);
        const dy = Math.floor((size - h) / 2);
        return {
            top: Math.round(originalBounds.top - dy),
            left: Math.round(originalBounds.left - dx),
            bottom: Math.round(originalBounds.top - dy + size),
            right: Math.round(originalBounds.left - dx + size)
        };
    }

    // 2. 扩展画布到正方形
    async function extendCanvasToSquare(size) {
        if (!psAPI.app || !psAPI.core) return;
        
        try {
            await psAPI.core.executeAsModal(async () => {
                const doc = psAPI.app.activeDocument;
                if (!doc) return;
                
                const currentWidth = doc.width;
                const currentHeight = doc.height;
                const newWidth = Math.max(currentWidth, size);
                const newHeight = Math.max(currentHeight, size);
                
                if (newWidth !== currentWidth || newHeight !== currentHeight) {
                    doc.resizeCanvas(newWidth, newHeight, psAPI.constants.AnchorPosition.MIDDLECENTER);
                    debugLog("画布已扩展到正方形:", newWidth, newHeight);
                }
            });
        } catch (error) {
            console.error("扩展画布失败:", error);
        }
    }

    // 3. 捕获过程中的防偏移处理
    async function captureWithNoOffset(originalBounds) {
        let exportBounds = { ...originalBounds };
        let w = Math.max(1, originalBounds.right - originalBounds.left);
        let h = Math.max(1, originalBounds.bottom - originalBounds.top);
        
        const virtualBounds = computeVirtualSquareBounds(originalBounds);
        const size = Math.max(w, h);
        if (size > w || size > h) {
            // 扩展画布到正方形
            await extendCanvasToSquare(size);
        }
        exportBounds = virtualBounds || originalBounds;
        w = size;
        h = size;
        
        return { exportBounds, width: w, height: h };
    }

    // 5. 缩放图层
    async function scaleLayer(layer, scaleX, scaleY) {
        if (!psAPI.app || !psAPI.core) return;
        
        try {
            await psAPI.core.executeAsModal(async () => {
                const scaleCommand = {
                    _obj: "transform",
                    _target: {
                        _ref: "layer",
                        _id: layer.id
                    },
                    freeTransformCenterState: {
                        _enum: "quadCenterState",
                        _value: "QCSCenter"
                    },
                    width: { _unit: "percentUnit", _value: scaleX },
                    height: { _unit: "percentUnit", _value: scaleY },
                    interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubicAutomatic" }
                };
                await psAPI.app.batchPlay([scaleCommand], { synchronousExecution: true });
                debugLog("图层已缩放:", scaleX, scaleY);
            });
        } catch (error) {
            console.error("缩放图层失败:", error);
        }
    }

    // 6. 移动图层
    async function moveLayer(layer, dx, dy) {
        if (!psAPI.app || !psAPI.core) return;
        
        try {
            await psAPI.core.executeAsModal(async () => {
                const moveCommand = {
                    _obj: "move",
                    _target: {
                        _ref: "layer",
                        _id: layer.id
                    },
                    to: {
                        _obj: "offset",
                        horizontal: { _unit: "pixelsUnit", _value: dx },
                        vertical: { _unit: "pixelsUnit", _value: dy }
                    }
                };
                await psAPI.app.batchPlay([moveCommand], { synchronousExecution: true });
                debugLog("图层已移动:", dx, dy);
            });
        } catch (error) {
            console.error("移动图层失败:", error);
        }
    }

    // 7. 导入时的精确还原
    async function restorePosition(layer, targetBounds) {
        if (!psAPI.app || !psAPI.core) return;
        
        try {
            await psAPI.core.executeAsModal(async () => {
                const lb = layer.bounds;
                const currentW = Math.max(1, lb.right - lb.left);
                const currentH = Math.max(1, lb.bottom - lb.top);
                const tW = Math.max(1, targetBounds.right - targetBounds.left);
                const tH = Math.max(1, targetBounds.bottom - targetBounds.top);
                
                // 计算缩放比例
                const scaleX = (tW / currentW) * 100;
                const scaleY = (tH / currentH) * 100;
                
                // 应用缩放
                await scaleLayer(layer, scaleX, scaleY);
                
                // 计算位移
                const newLb = layer.bounds;
                const dx = targetBounds.left - newLb.left;
                const dy = targetBounds.top - newLb.top;
                
                // 应用位移
                if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                    await moveLayer(layer, dx, dy);
                }
                
                debugLog("图层位置已还原");
            });
        } catch (error) {
            console.error("还原图层位置失败:", error);
        }
    }

    // 算法二：智能对齐系统 (Smart Alignment System)
    // 1. 智能对齐主函数
    async function smartAlignImage(task) {
        if (!task || task.ratio !== "auto") return;

        let rawW, rawH;
        if (task.bounds) {
            rawW = Math.round(task.bounds.right - task.bounds.left);
            rawH = Math.round(task.bounds.bottom - task.bounds.top);
        } else {
            rawW = task.baseImageWidth;
            rawH = task.baseImageHeight;
        }

        const allRatios = getSupportedRatioMap(task.platform);
        const currentRatio = rawW / rawH;

        let bestRatioStr = "1:1";
        let minDiff = Infinity;

        for (let k in allRatios) {
            const diff = Math.abs(currentRatio - allRatios[k]);
            if (diff < minDiff) {
                minDiff = diff;
                bestRatioStr = k;
            }
        }

        task.ratio = bestRatioStr;
    }

    // 2. 获取支持的比例映射
    function getSupportedRatioMap(platform) {
        // 根据平台返回支持的比例
        // 示例实现
        return {
            "1:1": 1.0,
            "3:4": 0.75,
            "4:3": 1.333,
            "9:16": 0.5625,
            "16:9": 1.777,
            "2:3": 0.666,
            "3:2": 1.5
        };
    }

    // 3. 调整图像大小
    async function resizeImage(image, width, height) {
        if (!psAPI.app || !psAPI.core) return;
        
        try {
            await psAPI.core.executeAsModal(async () => {
                const doc = psAPI.app.activeDocument;
                if (!doc) return;
                
                // 调整图像大小
                doc.resizeImage(width, height, doc.resolution, psAPI.constants.ResampleMethod.BICUBIC);
                debugLog("图像已调整大小:", width, height);
            });
        } catch (error) {
            console.error("调整图像大小失败:", error);
        }
    }

    async function loadPresets() {
        initCompatibility();
        const yusheResult = await loadYushePresets();
        const yushePresets = yusheResult && Array.isArray(yusheResult.presets) ? yusheResult.presets : [];
        const userPresets = await loadUserPresets();
        const sourceReady = !compatibility.isUXPAvailable || !!(yusheResult && yusheResult.ready);
        const browserFallbackPresets = sourceReady && uxpFs ? [] : (Config.getPresets() || []);
        const serverPresets = Config.getServerPresets() || [];
        currentAllPresets = dedupePresetEntries([].concat(
            VFX_BUILTIN_PRESETS,
            yushePresets || [],
            userPresets || [],
            browserFallbackPresets || [],
            serverPresets || []
        ));

        debugLog('加载预设中...');
        debugLog('yushe.json 预设数量:', yushePresets.length);
        if (userPresets.length) debugLog('用户预设数量:', userPresets.length);
        if (browserFallbackPresets.length) {
            debugLog('浏览器本地预设数量:', browserFallbackPresets.length);
        }
        if (serverPresets.length) debugLog('服务器预设数量:', serverPresets.length);
        debugLog('总预设数量:', currentAllPresets.length);

        loadPresetCategories(currentAllPresets, 'presetCategory');
        updatePresetSelect(currentAllPresets, 'promptPreset');
        loadPresetCategories(currentAllPresets, 'vfxPresetCategory');
        updatePresetSelect(currentAllPresets, 'vfxPromptPreset');
        return { ready: sourceReady };
    }

    async function syncServerPresets(options) {
        const silent = !!(options && options.silent);
        const baseInput = document.getElementById('promptSyncBaseUrl');
        const statusEl = document.getElementById('promptSyncStatus');
        const baseUrl = String((baseInput && baseInput.value) || (currentSettings && currentSettings.promptSyncBaseUrl) || '').trim().replace(/\/+$/, '');
        if (!baseUrl) throw new Error('请先填写提示词同步服务器地址');
        if (!/^https?:\/\//i.test(baseUrl)) throw new Error('服务器地址必须以 http:// 或 https:// 开头');
        if (statusEl && !silent) statusEl.textContent = '正在读取服务器预设目录…';

        let response = await fetch(baseUrl + '/api/presets/manifest', { headers: { Accept: 'application/json' } });
        if (response.status === 404) response = await fetch(baseUrl + '/api/presets', { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('读取预设目录失败：HTTP ' + response.status);
        const manifest = await response.json();
        const rawItems = Array.isArray(manifest) ? manifest : (manifest && (manifest.presets || manifest.items || manifest.files)) || [];
        if (!Array.isArray(rawItems)) throw new Error('服务器预设目录格式不正确');

        const normalizePreset = function(raw, fallback) {
            const item = raw && typeof raw === 'object' ? raw : {};
            const meta = fallback && typeof fallback === 'object' ? fallback : {};
            const file = item.file || item.filename || item.path || meta.file || meta.filename || meta.path || '';
            const rawContent = item.prompt || item.text || item.content || item.positivePrompt || item.positive_prompt || meta.prompt || meta.text || meta.content || '';
            const prompt = extractPresetPromptText(rawContent);
            if (!prompt) return null;
            return {
                name: item.name || item.title || meta.name || meta.title || String(file || '服务器预设').replace(/\.[^.]+$/, ''),
                category: item.category || meta.category || '服务器',
                prompt: String(prompt),
                subCategory: item.subCategory || item.subcategory || meta.subCategory || meta.subcategory || '',
                description: item.description || meta.description || '',
                refImages: item.refImages || item.referenceImages || meta.refImages || meta.referenceImages || [],
                source: 'server',
                _cloudFile: file
            };
        };

        const presets = [];
        for (let i = 0; i < rawItems.length; i++) {
            const item = rawItems[i];
            const direct = normalizePreset(item, item);
            if (direct) {
                presets.push(direct);
                continue;
            }
            const file = typeof item === 'string' ? item : (item && (item.file || item.filename || item.path));
            if (!file) continue;
            const detailResponse = await fetch(baseUrl + '/api/presets/' + encodeURIComponent(file), { headers: { Accept: 'application/json' } });
            if (!detailResponse.ok) continue;
            const detail = await detailResponse.json();
            const normalized = normalizePreset(detail, typeof item === 'object' ? item : { file: file });
            if (normalized) presets.push(normalized);
        }

        const deduped = dedupePresetEntries(presets);
        Config.saveServerPresets(deduped);
        if (currentSettings) {
            currentSettings.promptSyncBaseUrl = baseUrl;
            Config.saveSettings(currentSettings);
        }
        invalidatePresetCache();
        await ensurePresetsLoaded();
        if (statusEl && !silent) statusEl.textContent = '已同步 ' + deduped.length + ' 条服务器预设';
        if (!silent) showToast('服务器提示词已同步');
        return deduped;
    }
    
    function loadPresetCategories(presets, selectId) {
        const categorySelect = document.getElementById(selectId || 'presetCategory');
        if (!categorySelect) return;

        const categories = [...new Set(presets.map(preset => preset.category || '其他'))];

        categorySelect.innerHTML = '<option value="">-- 选择分类 --</option>';

        categories.forEach(category => {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category;
            categorySelect.appendChild(option);
        });

        categorySelect.onchange = function() {
            filterPresetsByCategory(selectId === 'vfxPresetCategory' ? 'vfx' : 'img2img');
        };

        refreshCustomSelectById(categorySelect.id);
    }

    function updatePresetSelect(presets, selectId) {
        const presetSelect = document.getElementById(selectId || 'promptPreset');
        if (!presetSelect) return;
        const previousValue = presetSelect.value;

        presetSelect.innerHTML = '<option value="">-- 选择预设 --</option>';

        presets.forEach(function(preset) {
            const option = document.createElement('option');
            option.value = preset.name;
            option.textContent = preset.name;
            presetSelect.appendChild(option);
        });

        if (previousValue && Array.from(presetSelect.options).some(function(option) { return option.value === previousValue; })) {
            presetSelect.value = previousValue;
        }

        refreshCustomSelectById(presetSelect.id);
    }

    function filterPresetsByCategory(scope) {
        const isVfx = scope === 'vfx';
        const categorySelect = document.getElementById(isVfx ? 'vfxPresetCategory' : 'presetCategory');
        const selectedCategory = categorySelect ? categorySelect.value : '';

        let filteredPresets = currentAllPresets;
        if (selectedCategory) {
            filteredPresets = currentAllPresets.filter(function(preset) {
                return preset.category === selectedCategory;
            });
        }

        updatePresetSelect(filteredPresets, isVfx ? 'vfxPromptPreset' : 'promptPreset');

        const presetSelect = document.getElementById(isVfx ? 'vfxPromptPreset' : 'promptPreset');
        if (presetSelect && !presetSelect.value && isVfx) {
            bindPseudoVfxControls();
            updateVfxUiFromConfig(DEFAULT_VFX_CONFIG);
        }
    }

    function collectVfxFormConfig() {
        const effectPresetEl = document.getElementById('vfxEffectPreset');
        const colorState = getVfxColorControlState();
        const effectCustomEl = document.getElementById('vfxEffectCustomName');
        const motionPathEl = document.getElementById('vfxMotionPathText');
        const materialPresetEl = document.getElementById('vfxMaterialPreset');
        const materialCustomEl = document.getElementById('vfxMaterialCustomName');
        const particleEl = document.getElementById('vfxParticleText');
        const smokeEnabledEl = document.getElementById('vfxSmokeEnabled');
        const smokeTextEl = document.getElementById('vfxSmokeText');
        return normalizeVfxConfig({
            enabled: true,
            color: colorState.color,
            saturation: colorState.saturation,
            brightness: colorState.brightness,
            effectPreset: effectPresetEl ? effectPresetEl.value : DEFAULT_VFX_CONFIG.effectPreset,
            effectCustomName: effectCustomEl ? effectCustomEl.value : '',
            motionPathText: motionPathEl ? motionPathEl.value : DEFAULT_VFX_CONFIG.motionPathText,
            trajectoryReferenceImage: currentVfxConfig && currentVfxConfig.trajectoryReferenceImage ? currentVfxConfig.trajectoryReferenceImage : null,
            materialPreset: materialPresetEl ? materialPresetEl.value : DEFAULT_VFX_CONFIG.materialPreset,
            materialCustomName: materialCustomEl ? materialCustomEl.value : '',
            particleText: particleEl ? particleEl.value : DEFAULT_VFX_CONFIG.particleText,
            smokeEnabled: !!(smokeEnabledEl && smokeEnabledEl.checked),
            smokeText: smokeTextEl ? smokeTextEl.value : ''
        });
    }

    function syncPseudoSliderUi(sliderId, value) {
        const slider = document.querySelector('.vfx-pseudo-slider[data-slider-for="' + sliderId + '"]');
        if (!slider) return;
        const normalized = clampVfxSliderValue(value, 0);
        const percent = normalized + '%';
        const fill = slider.querySelector('.vfx-pseudo-slider-fill');
        const thumb = slider.querySelector('.vfx-pseudo-slider-thumb');
        if (fill) fill.style.width = percent;
        if (thumb) thumb.style.left = 'calc(18px + (' + normalized + ' * (100% - 36px) / 100))';
        slider.setAttribute('aria-valuenow', String(normalized));
    }

    function setVfxColorValue(color, overrides) {
        const normalized = normalizeHexColor(color, DEFAULT_VFX_CONFIG.color);
        const nativeColor = document.getElementById('vfxColor');
        const textColor = document.getElementById('vfxColorHex');
        if (nativeColor) nativeColor.value = normalized;
        if (textColor) textColor.value = normalized;
        const hsv = hexColorToHsv(normalized);
        const sliderState = Object.assign({
            hue: hsv.h,
            saturation: Math.round(hsv.s * 100),
            brightness: Math.round(hsv.v * 100)
        }, overrides || {});
        const saturation = clampVfxSliderValue(sliderState.saturation, Math.round(hsv.s * 100));
        const brightness = clampVfxSliderValue(sliderState.brightness, Math.round(hsv.v * 100));
        const saturationInput = document.getElementById('vfxColorSaturation');
        const brightnessInput = document.getElementById('vfxColorBrightness');
        if (saturationInput) saturationInput.value = String(saturation);
        if (brightnessInput) brightnessInput.value = String(brightness);
        syncPseudoSliderUi('vfxColorSaturation', saturation);
        syncPseudoSliderUi('vfxColorBrightness', brightness);
        syncVfxSliderValueLabel('vfxColorSaturation', saturation);
        syncVfxSliderValueLabel('vfxColorBrightness', brightness);
        syncVfxHueRingUi(normalized, sliderState.hue);
        return normalized;
    }

    function drawVfxHueRing() {
        const strip = document.getElementById('vfxHueRing');
        if (!strip) return;
        strip.setAttribute('aria-valuemin', '0');
        strip.setAttribute('aria-valuemax', '360');
    }

    function syncVfxHueRingUi(color, hueOverride) {
        const ring = document.getElementById('vfxHueRing');
        const thumb = document.getElementById('vfxHueThumb');
        const preview = document.getElementById('vfxColorPreview');
        if (!ring || !thumb) return;
        const normalizedColor = normalizeHexColor(color, DEFAULT_VFX_CONFIG.color);
        if (preview) {
            preview.style.background = normalizedColor;
        }
        const hue = Number.isFinite(Number(hueOverride)) ? ((Math.round(Number(hueOverride)) % 360) + 360) % 360 : hexColorToHue(normalizedColor);
        ring.setAttribute('aria-valuenow', String(hue));
        const left = 6 + (hue / 360) * Math.max(0, ring.clientWidth - 12);
        thumb.style.left = left + 'px';
        thumb.style.top = '50%';
    }

    function updateVfxConditionalFields(config) {
        const normalized = normalizeVfxConfig(config || currentVfxConfig || DEFAULT_VFX_CONFIG);
        const effectCustomCell = document.getElementById('vfxEffectCustomCell');
        const materialCustomCell = document.getElementById('vfxMaterialCustomCell');
        const smokeTextCell = document.getElementById('vfxSmokeTextCell');
        if (effectCustomCell) effectCustomCell.style.display = normalized.effectPreset === 'custom' ? '' : 'none';
        if (materialCustomCell) materialCustomCell.style.display = normalized.materialPreset === 'custom' ? '' : 'none';
        if (smokeTextCell) smokeTextCell.style.display = normalized.smokeEnabled ? '' : 'none';
    }

    function renderVfxTrajectorySlot() {
        const slot = document.getElementById('vfxTrajectorySlot');
        if (!slot) return;
        const trajectory = currentVfxConfig && currentVfxConfig.trajectoryReferenceImage ? currentVfxConfig.trajectoryReferenceImage : null;
        slot.innerHTML = '';
        if (!trajectory) {
            const empty = document.createElement('div');
            empty.className = 'reference-slot empty';
            empty.textContent = '点击下方按钮抓取轨迹图';
            slot.appendChild(empty);
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'reference-slot';
        const img = document.createElement('img');
        img.src = trajectory.base64;
        img.alt = '轨迹图';
        img.title = '当前 VFX 轨迹参考图';
        wrapper.appendChild(img);
        const badge = document.createElement('div');
        badge.className = 'info-text';
        badge.textContent = 'VFX 轨迹图';
        wrapper.appendChild(badge);
        slot.appendChild(wrapper);
    }

    function updatePseudoSliderFromPointer(slider, clientX) {
        if (!slider) return;
        const targetId = slider.getAttribute('data-slider-for');
        const nativeInput = targetId ? document.getElementById(targetId) : null;
        if (!nativeInput) return;
        const rect = slider.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const nextValue = clampVfxSliderValue(Math.round(ratio * 100), Number(nativeInput.value) || 0);
        nativeInput.value = String(nextValue);
        nativeInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function updateHueRingFromPointer(clientX, clientY) {
        const ring = document.getElementById('vfxHueRing');
        if (!ring) return;
        const rect = ring.getBoundingClientRect();
        const ratio = rect.width ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
        const angle = Math.round(ratio * 360) % 360;
        updateVfxColorFromControls({ hue: angle });
    }

    function bindPseudoVfxControls() {
        const hueRing = document.getElementById('vfxHueRing');
        if (hueRing && hueRing.dataset.bound !== 'true') {
            hueRing.dataset.bound = 'true';
            drawVfxHueRing();
            hueRing.addEventListener('pointerdown', function(event) {
                event.preventDefault();
                hueRing.focus();
                updateHueRingFromPointer(event.clientX, event.clientY);
                const move = function(moveEvent) {
                    updateHueRingFromPointer(moveEvent.clientX, moveEvent.clientY);
                };
                const end = function() {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', end);
                    window.removeEventListener('pointercancel', end);
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', end);
                window.addEventListener('pointercancel', end);
            });
            hueRing.addEventListener('keydown', function(event) {
                const textColor = document.getElementById('vfxColorHex');
                const currentHue = hexColorToHue(textColor ? textColor.value : DEFAULT_VFX_CONFIG.color);
                let nextHue = currentHue;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextHue = currentHue - 5;
                if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextHue = currentHue + 5;
                if (nextHue === currentHue) return;
                event.preventDefault();
                updateVfxColorFromControls({ hue: nextHue });
            });
            drawVfxHueRing();
            syncVfxHueRingUi((document.getElementById('vfxColorHex') || {}).value || DEFAULT_VFX_CONFIG.color);
        }

        const colorText = document.getElementById('vfxColorHex');
        if (colorText && colorText.dataset.bound !== 'true') {
            colorText.dataset.bound = 'true';
            colorText.addEventListener('input', function() {
                const normalized = normalizeHexColor(colorText.value, currentVfxConfig && currentVfxConfig.color ? currentVfxConfig.color : DEFAULT_VFX_CONFIG.color);
                const hsv = hexColorToHsv(normalized);
                setVfxColorValue(normalized, {
                    hue: hsv.h,
                    saturation: Math.round(hsv.s * 100),
                    brightness: Math.round(hsv.v * 100)
                });
            });
            colorText.addEventListener('change', function() {
                const normalized = setVfxColorValue(colorText.value);
                const nativeColor = document.getElementById('vfxColor');
                if (nativeColor) nativeColor.dispatchEvent(new Event('input', { bubbles: true }));
                colorText.value = normalized;
            });
        }

        ['vfxColorSaturation', 'vfxColorBrightness'].forEach(function(sliderId) {
            const nativeInput = document.getElementById(sliderId);
            const pseudoSlider = document.querySelector('.vfx-pseudo-slider[data-slider-for="' + sliderId + '"]');
            if (!nativeInput || !pseudoSlider) return;
            if (nativeInput.dataset.bound !== 'true') {
                nativeInput.dataset.bound = 'true';
                nativeInput.addEventListener('input', function() {
                    const value = clampVfxSliderValue(nativeInput.value, 0);
                    nativeInput.value = String(value);
                    syncPseudoSliderUi(sliderId, value);
                    syncVfxSliderValueLabel(sliderId, value);
                    updateVfxColorFromControls();
                });
            }
            if (pseudoSlider.dataset.bound !== 'true') {
                pseudoSlider.dataset.bound = 'true';
                pseudoSlider.addEventListener('pointerdown', function(event) {
                    event.preventDefault();
                    pseudoSlider.focus();
                    updatePseudoSliderFromPointer(pseudoSlider, event.clientX);
                    const move = function(moveEvent) {
                        updatePseudoSliderFromPointer(pseudoSlider, moveEvent.clientX);
                    };
                    const end = function() {
                        window.removeEventListener('pointermove', move);
                        window.removeEventListener('pointerup', end);
                        window.removeEventListener('pointercancel', end);
                    };
                    window.addEventListener('pointermove', move);
                    window.addEventListener('pointerup', end);
                    window.addEventListener('pointercancel', end);
                });
                pseudoSlider.addEventListener('keydown', function(event) {
                    let delta = 0;
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') delta = -2;
                    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') delta = 2;
                    if (!delta) return;
                    event.preventDefault();
                    const nextValue = clampVfxSliderValue((Number(nativeInput.value) || 0) + delta, Number(nativeInput.value) || 0);
                    nativeInput.value = String(nextValue);
                    nativeInput.dispatchEvent(new Event('input', { bubbles: true }));
                });
            }
            syncPseudoSliderUi(sliderId, nativeInput.value);
            syncVfxSliderValueLabel(sliderId, nativeInput.value);
        });

        const smokeCheckbox = document.getElementById('vfxSmokeEnabled');
        if (smokeCheckbox && smokeCheckbox.dataset.bound !== 'true') {
            smokeCheckbox.dataset.bound = 'true';
            syncPseudoCheckboxUi(smokeCheckbox);
            smokeCheckbox.addEventListener('change', function() {
                syncPseudoCheckboxUi(smokeCheckbox);
                updateVfxConditionalFields(collectVfxFormConfig());
            });
        }
    }

    function syncPseudoCheckboxUi(checkbox) {
        if (!checkbox) return;
        const label = checkbox.closest('.checkbox-row');
        if (label) {
            label.classList.toggle('pseudo-checkbox-on', !!checkbox.checked);
        }
    }

    async function captureVfxTrajectoryReference() {
        try {
            const capture = await captureBlurredTrajectoryReferenceFromSelection();
            currentVfxConfig = normalizeVfxConfig(Object.assign({}, currentVfxConfig || DEFAULT_VFX_CONFIG, {
                enabled: true,
                trajectoryReferenceImage: {
                    base64: capture.base64,
                    bounds: capture.bounds,
                    label: '轨迹图',
                    role: 'vfx-trajectory'
                }
            }));
            renderVfxTrajectorySlot();
            applyVfxPromptToTextarea();
            showStatus('VFX 轨迹图已读取', 'success');
            showToast('轨迹图已更新');
        } catch (error) {
            showStatus('读取轨迹图失败：' + error.message, 'error');
        }
    }

    function clearVfxTrajectoryReference() {
        currentVfxConfig = normalizeVfxConfig(Object.assign({}, currentVfxConfig || DEFAULT_VFX_CONFIG, {
            enabled: true,
            trajectoryReferenceImage: null
        }));
        renderVfxTrajectorySlot();
        applyVfxPromptToTextarea();
        showToast('轨迹图已清除');
    }

    function getActiveReferenceImagesForRequest() {
        const items = referenceImages.slice(0, referenceInputMode === 'single' ? 1 : MAX_REFERENCE_IMAGES);
        const trajectory = currentVfxConfig && currentVfxConfig.trajectoryReferenceImage ? currentVfxConfig.trajectoryReferenceImage : null;
        if (trajectory && trajectory.base64) {
            items.unshift({
                base64: trajectory.base64,
                label: trajectory.label || '轨迹图',
                bounds: trajectory.bounds,
                role: 'vfx-trajectory'
            });
        }
        return items
            .map(function(item) { return normalizeReferenceImageData(item); })
            .filter(Boolean)
            .slice(0, MAX_REFERENCE_IMAGES);
    }

    function updateVfxUiFromConfig(config) {
        const normalized = normalizeVfxConfig(config || currentVfxConfig || DEFAULT_VFX_CONFIG);
        currentVfxConfig = normalized;
        drawVfxHueRing();
        const effectPresetEl = document.getElementById('vfxEffectPreset');
        const effectCustomEl = document.getElementById('vfxEffectCustomName');
        const motionPathEl = document.getElementById('vfxMotionPathText');
        const materialPresetEl = document.getElementById('vfxMaterialPreset');
        const materialCustomEl = document.getElementById('vfxMaterialCustomName');
        const particleEl = document.getElementById('vfxParticleText');
        const smokeEnabledEl = document.getElementById('vfxSmokeEnabled');
        const smokeTextEl = document.getElementById('vfxSmokeText');
        if (effectPresetEl) effectPresetEl.value = normalized.effectPreset;
        if (effectCustomEl) effectCustomEl.value = normalized.effectCustomName;
        if (motionPathEl) motionPathEl.value = normalized.motionPathText;
        if (materialPresetEl) materialPresetEl.value = normalized.materialPreset;
        if (materialCustomEl) materialCustomEl.value = normalized.materialCustomName;
        if (particleEl) particleEl.value = normalized.particleText;
        if (smokeEnabledEl) {
            smokeEnabledEl.checked = !!normalized.smokeEnabled;
            syncPseudoCheckboxUi(smokeEnabledEl);
        }
        if (smokeTextEl) smokeTextEl.value = normalized.smokeText;
        setVfxColorValue(normalized.color, {
            saturation: normalized.saturation,
            brightness: normalized.brightness
        });
        updateVfxConditionalFields(normalized);
        renderVfxTrajectorySlot();
        ['vfxEffectPreset', 'vfxMaterialPreset', 'vfxPresetCategory', 'vfxPromptPreset'].forEach(refreshCustomSelectById);
    }

    function applyVfxPromptToTextarea() {
        const config = collectVfxFormConfig();
        currentVfxConfig = config;
        const imgPrompt = document.getElementById('imgPrompt');
        if (imgPrompt) {
            imgPrompt.value = buildVfxPrompt(config);
        }
    }

    function showPresetSaveDialog(data) {
        const existing = document.querySelector('.preset-save-overlay');
        if (existing) existing.remove();
        const categories = Array.from(new Set((currentAllPresets || []).map(function(item) {
            return item && item.category;
        }).filter(Boolean)));
        if (data.category && categories.indexOf(data.category) < 0) categories.unshift(data.category);
        const overlay = document.createElement('div');
        overlay.className = 'preset-save-overlay';
        overlay.innerHTML = ''
            + '<div class="preset-save-dialog">'
            + '<div class="preset-save-title">保存预设</div>'
            + '<div class="preset-save-field"><label for="presetSaveName">预设名称</label><input id="presetSaveName" type="text" placeholder="输入预设名称…" value="' + escapeHTML(data.name || '') + '"></div>'
            + '<div class="preset-save-field"><label for="presetSaveCat">分类</label><select id="presetSaveCat">' + categories.map(function(category) { return '<option value="' + escapeHTML(category) + '"' + (category === data.category ? ' selected' : '') + '>' + escapeHTML(category) + '</option>'; }).join('') + '</select></div>'
            + '<div class="preset-save-field"><label for="presetSaveSubCat">子分类</label><input id="presetSaveSubCat" type="text" placeholder="子分类（可选）"></div>'
            + '<div class="preset-save-summary"><strong>提示词内容</strong><span>' + escapeHTML(data.prompt.substring(0, 160)) + (data.prompt.length > 160 ? '…' : '') + '</span></div>'
            + (data.refImages.length ? '<div class="preset-save-summary">包含 ' + data.refImages.length + ' 张参考图</div>' : '')
            + '<div class="preset-save-summary">同时保存：降噪强度' + (data.vfxConfig && data.vfxConfig.enabled ? '、空间特效参数' : '') + '</div>'
            + '<div class="preset-save-btns"><button class="btn btn-secondary" id="presetSaveCancel" type="button">取消</button><button class="btn btn-primary" id="presetSaveConfirm" type="button">保存</button></div>'
            + '</div>';
        document.body.appendChild(overlay);
        const nameInput = overlay.querySelector('#presetSaveName');
        if (nameInput) nameInput.focus();
        overlay.querySelector('#presetSaveCancel').onclick = function() { overlay.remove(); };
        overlay.onclick = function(event) { if (event.target === overlay) overlay.remove(); };
        overlay.querySelector('#presetSaveConfirm').onclick = async function() {
            const name = String(nameInput && nameInput.value || '').trim();
            if (!name) {
                showStatus('请输入预设名称', 'error');
                return;
            }
            const category = String((overlay.querySelector('#presetSaveCat') || {}).value || data.category || '其他').trim();
            const subCategory = String((overlay.querySelector('#presetSaveSubCat') || {}).value || '').trim();
            const confirm = overlay.querySelector('#presetSaveConfirm');
            confirm.disabled = true;
            try {
                await savePreset({ confirmed: true, name: name, category: category, subCategory: subCategory });
                overlay.remove();
            } finally {
                confirm.disabled = false;
            }
        };
    }

    async function savePreset(options) {
        options = options || {};
        const vfxConfig = collectVfxFormConfig();
        const prompt = vfxConfig.enabled
            ? buildVfxPrompt(vfxConfig)
            : normalizePresetPromptText(document.getElementById('imgPrompt').value.trim());
        const presetNameSource = document.getElementById('vfxPresetName') || document.getElementById('presetName');
        const presetName = options.name || (presetNameSource ? presetNameSource.value.trim() : '');
        const presetCategory = vfxConfig.enabled
            ? 'VFX特效'
            : (options.category || document.getElementById('presetCategory').value || '其他');

        if (!prompt) {
            showStatus('请先输入提示词', 'error');
            return;
        }

        if (!options.confirmed) {
            showPresetSaveDialog({
                name: presetName,
                prompt: prompt,
                category: presetCategory,
                refImages: referenceImages,
                vfxConfig: vfxConfig
            });
            return;
        }

        try {
            const userPresets = await loadUserPresets();
            const nextPresets = Array.isArray(userPresets) ? userPresets.slice() : [];
            const existingIndex = nextPresets.findIndex(function(p) { return p && p.name === presetName; });
            const nextEntry = {
                id: existingIndex >= 0 && nextPresets[existingIndex].id ? nextPresets[existingIndex].id : ('user-' + Date.now()),
                _isFactory: false,
                title: presetName,
                name: presetName,
                content: prompt,
                prompt: prompt,
                category: presetCategory,
                subCategory: options.subCategory || '',
                starred: existingIndex >= 0 ? !!nextPresets[existingIndex].starred : false,
                refImages: referenceImages.map(function(ref) { return { base64: ref.base64, label: ref.label }; })
            };
            if (vfxConfig.enabled) nextEntry.vfxConfig = vfxConfig;
            if (existingIndex >= 0) nextPresets[existingIndex] = nextEntry;
            else nextPresets.push(nextEntry);
            await saveUserPresets(nextPresets);
            invalidatePresetCache();
            await ensurePresetsLoaded();

        const presetSelect = document.getElementById(vfxConfig.enabled ? 'vfxPromptPreset' : 'promptPreset');
        if (presetSelect) {
            presetSelect.value = presetName;
            refreshCustomSelectById(presetSelect.id);
        }

            if (vfxConfig.enabled) {
                applyVfxPromptToTextarea();
            }

            showStatus('预设已保存: ' + presetName, 'success');
            showToast('预设已保存');
        } catch (e) {
            console.error('保存预设失败:', e);
            showStatus('保存预设失败: ' + e.message, 'error');
        }
    }
    
    async function deletePreset(scope) {
        const isVfx = scope === 'vfx';
        const presetSelect = document.getElementById(isVfx ? 'vfxPromptPreset' : 'promptPreset');
        const selectedName = presetSelect ? presetSelect.value : '';

        if (!selectedName) {
            showStatus('请先选择要删除的预设', 'error');
            return;
        }

        if (VFX_BUILTIN_PRESETS.some(function(preset) { return preset.name === selectedName; })) {
            showStatus('内置 VFX 预设不能直接删除，可另存为自己的版本', 'info');
            return;
        }

        try {
            const userPresets = await loadUserPresets();
            if (!userPresets.some(function(preset) { return preset && preset.name === selectedName; })) {
                showStatus('这是云端或内置预设，不能直接删除；可另存为自己的版本', 'info');
                return;
            }
            await saveUserPresets(userPresets.filter(function(preset) { return preset && preset.name !== selectedName; }));
            invalidatePresetCache();

            await ensurePresetsLoaded();
            if (isVfx) {
                const vfxPresetNameEl = document.getElementById('vfxPresetName');
                if (vfxPresetNameEl) vfxPresetNameEl.value = '';
            }
            showStatus('预设已删除', 'success');
            showToast('预设已删除');
        } catch (e) {
            console.error('删除预设失败:', e);
            showStatus('删除预设失败: ' + e.message, 'error');
        }
    }
    
    function applyPresetVfxState(preset) {
        const hasVfxConfig = !!(preset && preset.vfxConfig);
        const vfxState = hasVfxConfig
            ? Object.assign({}, preset.vfxConfig, { enabled: true })
            : DEFAULT_VFX_CONFIG;
        bindPseudoVfxControls();
        updateVfxUiFromConfig(vfxState);
        if (hasVfxConfig) {
            applyVfxPromptToTextarea();
        }
    }

    async function applyPreset(scope) {
        const isVfx = scope === 'vfx';
        const selectId = isVfx ? 'vfxPromptPreset' : 'promptPreset';
        const initialSelect = document.getElementById(selectId);
        // 先保存用户刚点击的值。ensurePresetsLoaded 可能重建 option；若等它结束后
        // 再读取，UXP 会拿到被重置的空项，表现为“点了预设但没有选中”。
        const requestedName = initialSelect ? initialSelect.value : '';
        await ensurePresetsLoaded();
        const presetSelect = document.getElementById(selectId);
        const selectedName = requestedName || (presetSelect ? presetSelect.value : '');

        if (!selectedName) {
            return;
        }

        if (presetSelect && presetSelect.value !== selectedName && Array.from(presetSelect.options || []).some(function(option) { return option.value === selectedName; })) {
            presetSelect.value = selectedName;
            refreshCustomSelectById(selectId);
        }

        const preset = currentAllPresets.find(p => p.name === selectedName);

        if (preset) {
            const promptField = document.getElementById('imgPrompt');
            if (promptField) {
                promptField.value = preset.prompt || '';
                promptField.dispatchEvent(new Event('input', { bubbles: true }));
            }
            document.getElementById('presetName').value = preset.name || '';
            const img2imgCategory = document.getElementById('presetCategory');
            if (img2imgCategory) img2imgCategory.value = preset.category || '';
            const vfxCategory = document.getElementById('vfxPresetCategory');
            if (vfxCategory) vfxCategory.value = preset.category || '';
            const vfxPresetNameEl = document.getElementById('vfxPresetName');
            if (vfxPresetNameEl) vfxPresetNameEl.value = preset.name || '';
            referenceImages = normalizeReferenceImageList(preset.refImages || preset.referenceImages);
            renderReferenceImages();
            applyPresetVfxState(preset);
            refreshCustomSelectById('presetCategory');
            refreshCustomSelectById('vfxPresetCategory');
            refreshCustomSelectById('promptPreset');
            refreshCustomSelectById('vfxPromptPreset');
            showToast('预设已应用');
        }
    }

    function renderAnnouncements(announcements) {
        const containers = ['serverAnnouncements', 'homeAnnouncements']
            .map(function(id) { return document.getElementById(id); })
            .filter(Boolean);
        if (!containers.length) return;
        const list = Array.isArray(announcements) ? announcements : [];
        const html = !list.length
            ? '<div class="info-text">暂无公告</div>'
            : list.slice(0, 5).map(function(item) {
                return '<div class="notice-section"><strong>' + escapeHTML(item.title || '公告') + '</strong>'
                    + escapeHTML(item.content || '')
                    + (item.publishAt ? '<div class="info-text">' + escapeHTML(item.publishAt) + '</div>' : '')
                    + '</div>';
            }).join('<div class="notice-divider"></div>');
        containers.forEach(function(container) {
            container.innerHTML = html;
        });
    }

    function renderUpdateInfo(updateData) {
        const containers = ['serverUpdateInfo', 'homeUpdateInfo']
            .map(function(id) { return document.getElementById(id); })
            .filter(Boolean);
        if (!containers.length) return;
        let html = '';
        if (!updateData) {
            html = '未检查更新';
        } else if (updateData.needsUpdate) {
            html = '发现新版本：' + escapeHTML(updateData.latestVersion || '')
                + '<br>' + escapeHTML((updateData.changelog || []).join(' / '));
        } else {
            html = '当前已是最新版本：' + (updateData.currentVersion || PLUGIN_VERSION);
        }
        containers.forEach(function(container) {
            container.innerHTML = html;
        });
    }

    async function refreshAnnouncements() {
        const baseUrl = getServerApiUrlFromSettings();
        const result = await API.getAnnouncements(baseUrl);
        if (result.success && result.data && result.data.success !== false) {
            renderAnnouncements(result.data.announcements || []);
            return true;
        }
        renderAnnouncements([]);
        return false;
    }

    async function checkForUpdates(showResult) {
        const baseUrl = getServerApiUrlFromSettings();
        const result = await API.checkUpdate(baseUrl, PLUGIN_VERSION);
        if (result.success && result.data && result.data.success !== false) {
            renderUpdateInfo(result.data);
            if (showResult) {
                showStatus(result.data.needsUpdate ? '发现新版本：' + result.data.latestVersion : '当前已是最新版本', result.data.needsUpdate ? 'info' : 'success');
            }
            return true;
        }
        if (showResult) showStatus('检查更新失败：' + (result.error || '服务器不可用'), 'error');
        return false;
    }

    async function refreshServerStatus() {
        const statusEl = document.getElementById('serverStatusInfo');
        const result = await API.getServerStatus(getServerApiUrlFromSettings());
        if (statusEl) {
            statusEl.textContent = result.success && result.data
                ? '服务器正常，版本：' + (result.data.version || 'unknown')
                : '服务器不可用';
        }
    }

    function getServerApiUrlFromSettings() {
        return normalizeBaseUrl(SERVER_API_URL, DEFAULT_SERVER_API_URL);
    }



    function extractNewApiCredits(data) {
        if (!data || typeof data !== 'object') return null;
        const candidates = [
            data.total_available,
            data.total_granted,
            data.credit,
            data.credits,
            data.quota,
            data.used_quota !== undefined && data.quota !== undefined ? data.quota - data.used_quota : null,
            data.data && data.data.total_available,
            data.data && data.data.total_granted,
            data.data && data.data.credit,
            data.data && data.data.credits,
            data.data && data.data.quota,
            data.data && data.data.used_quota !== undefined && data.data.quota !== undefined ? data.data.quota - data.data.used_quota : null,
            data.user && data.user.quota,
            data.user && data.user.credit,
            data.user && data.user.credits
        ];
        for (let i = 0; i < candidates.length; i++) {
            const value = candidates[i];
            if (value !== null && value !== undefined && value !== '' && !Number.isNaN(Number(value))) {
                return Number(value);
            }
        }
        return null;
    }

    async function checkNewApiCredits() {
        const infoEl = document.getElementById('newApiCreditsInfo');
        const keyEl = document.getElementById('newApiKey');
        const urlEl = document.getElementById('newApiUrl');
        const baseUrl = normalizeBaseUrl(urlEl ? urlEl.value : (currentSettings && currentSettings.newApiUrl), '');
        const apiKey = keyEl ? keyEl.value : (currentSettings && currentSettings.newApiKey);
        if (infoEl) infoEl.textContent = '正在查询...';
        const result = await API.checkNewApiCredits({ apiKey: apiKey, baseUrl: baseUrl });
        if (!result.success) {
            if (infoEl) infoEl.textContent = result.error || '查询失败';
            showStatus(result.error || '查询失败', 'error');
            return false;
        }
        const credits = extractNewApiCredits(result.data);
        const text = credits === null ? '查询成功，请在控制台查看返回数据' : '当前余额：' + credits;
        if (infoEl) infoEl.textContent = text;
        showStatus(text, credits === null ? 'info' : 'success');
        if (credits === null) {
            console.log('NewAPI 余额返回数据:', result.data);
        }
        return true;
    }

    async function checkGrsCredits() {
        const infoEl = document.getElementById('grsCreditsInfo');
        const keyEl = document.getElementById('imgApiKey');
        const urlEl = document.getElementById('imgApiUrl');
        if (infoEl) infoEl.textContent = '正在查询...';
        const result = await API.checkGrsCredits({
            apiKey: keyEl ? keyEl.value : (currentSettings && currentSettings.imgApiKey),
            imgApiUrl: urlEl ? urlEl.value : (currentSettings && currentSettings.imgApiUrl)
        });
        if (!result.success) {
            if (infoEl) infoEl.textContent = result.error || '查询失败';
            showStatus(result.error || '查询失败', 'error');
            return false;
        }
        const responseData = result.data || {};
        const hasError = responseData.code !== undefined && responseData.code !== 0;
        const hasErrorMessage = responseData.msg && typeof responseData.msg === 'string' && responseData.msg.trim() !== '' && responseData.msg.trim().toLowerCase() !== 'success';
        if (hasError || hasErrorMessage) {
            const message = responseData.msg || '查询失败';
            if (infoEl) infoEl.textContent = message;
            showStatus(message, 'error');
            return false;
        }
        const credits = responseData.data && responseData.data.credits !== undefined ? responseData.data.credits : 0;
        if (infoEl) infoEl.textContent = '当前积分余额：' + credits;
        showStatus('当前积分余额：' + credits, 'success');
        return true;
    }

    function bindModelActionButtons() {
        const btnAutoFetchNewApiModels = document.getElementById('btnAutoFetchNewApiModels');
        if (btnAutoFetchNewApiModels) {
            btnAutoFetchNewApiModels.onclick = function () {
                fetchNewApiModelsAndFillChat();
            };
        }

        const btnCheckNewApiCredits = document.getElementById('btnCheckNewApiCredits');
        if (btnCheckNewApiCredits) {
            btnCheckNewApiCredits.onclick = function() {
                checkNewApiCredits();
            };
        }

        const btnCheckGrsCredits = document.getElementById('btnCheckGrsCredits');
        if (btnCheckGrsCredits) {
            btnCheckGrsCredits.onclick = function() {
                checkGrsCredits();
            };
        }

        const btnRefreshAnnouncements = document.getElementById('btnRefreshAnnouncements');
        if (btnRefreshAnnouncements) {
            btnRefreshAnnouncements.onclick = function() {
                refreshAnnouncements();
                refreshServerStatus();
            };
        }

        const btnCheckUpdate = document.getElementById('btnCheckUpdate');
        if (btnCheckUpdate) {
            btnCheckUpdate.onclick = function() {
                checkForUpdates(true);
            };
        }

        const btnRefreshAccountSummary = document.getElementById('btnRefreshAccountSummary');
        if (btnRefreshAccountSummary) {
            btnRefreshAccountSummary.onclick = function() {
                refreshRunninghubAccountSummary();
                showStatus('账户状态已刷新', 'success');
            };
        }

        const btnResetAiOptimizeAppId = document.getElementById('btnResetAiOptimizeAppId');
        if (btnResetAiOptimizeAppId) {
            btnResetAiOptimizeAppId.onclick = function() {
                const input = document.getElementById('advancedAiOptimizeAppId');
                if (input) {
                    input.value = DEFAULT_AI_OPTIMIZE_APP_ID;
                }
                if (currentSettings) {
                    currentSettings.advancedAiOptimizeAppId = DEFAULT_AI_OPTIMIZE_APP_ID;
                }
                refreshRunninghubAccountSummary();
                showStatus('AI 优化应用 ID 已恢复默认值', 'success');
            };
        }
    }

    function ensureSettingsModelActionsVisible() {
        const settingsTab = document.getElementById('settings');
        if (!settingsTab) return;

        const actionCard = Array.from(settingsTab.querySelectorAll('.settings-card')).find(function(card) {
            const label = card.querySelector('label');
            return label && String(label.textContent || '').includes('模型列表');
        });
        if (!actionCard) return;

        let actionsWrap = actionCard.querySelector('.settings-actions');
        if (!actionsWrap) {
            actionsWrap = document.createElement('div');
            actionsWrap.className = 'settings-actions';
            actionCard.appendChild(actionsWrap);
        }
        actionsWrap.removeAttribute('style');

        const buttonDefs = [
            { id: 'btnAutoFetchNewApiModels', text: '抓取 NewAPI 模型' }
        ];

        buttonDefs.forEach(function(def) {
            let btn = document.getElementById(def.id);
            if (!btn) {
                btn = document.createElement('button');
                btn.id = def.id;
                btn.className = 'btn btn-secondary';
                btn.type = 'button';
                btn.textContent = def.text;
            }
            actionsWrap.appendChild(btn);
            btn.classList.add('btn');
            btn.classList.add('btn-secondary');
            btn.removeAttribute('style');
        });

        let tip = actionCard.querySelector('.settings-actions-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'settings-actions-tip';
            tip.textContent = '会使用当前 NewAPI 地址和密钥刷新聊天模型列表';
            actionCard.appendChild(tip);
        }
        tip.removeAttribute('style');

        bindModelActionButtons();
    }



    function bindSettingsGroupTogglesByContainer(containerId, collapseByDefault) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const toggles = container.querySelectorAll('.settings-group-toggle');
        toggles.forEach(function(toggle) {
            const section = toggle.closest('.settings-group');
            if (!toggle.dataset.title) {
                toggle.dataset.title = (toggle.textContent || '').trim();
            }
            if (section && !toggle.dataset.initialized) {
                if (collapseByDefault) {
                    section.classList.add('collapsed');
                    toggle.setAttribute('aria-expanded', 'false');
                } else {
                    section.classList.remove('collapsed');
                    toggle.setAttribute('aria-expanded', 'true');
                }
                toggle.dataset.initialized = '1';
            }
            if (!toggle || toggle.dataset.bound === '1') return;
            toggle.addEventListener('click', function() {
                const section = toggle.closest('.settings-group');
                if (!section) return;
                section.classList.toggle('collapsed');
                toggle.setAttribute('aria-expanded', section.classList.contains('collapsed') ? 'false' : 'true');
            });
            toggle.addEventListener('keydown', function(event) {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggle.click();
            });
            toggle.dataset.bound = '1';
        });
    }

    function bindSettingsGroupToggles() {
        bindSettingsGroupTogglesByContainer('settings', true);
    }


    function ensureSelectOptions(selectEl, options) {
        if (!selectEl || !Array.isArray(options)) return;
        const currentValue = selectEl.value;
        const existingValues = Array.from(selectEl.options || {}).map(function(option) {
            return option.value;
        });

        options.forEach(function(item) {
            if (existingValues.indexOf(item.value) > -1) return;
            const option = document.createElement('option');
            option.value = item.value;
            option.textContent = item.text;
            selectEl.appendChild(option);
        });

        if (currentValue) {
            selectEl.value = currentValue;
        }
    }



    function ensureImg2ImgInlineControls() {
        const controls = [
            {
                id: 'imgResolution',
                options: [
                    { value: 'auto', text: '自适应分辨率' },
                    { value: '1K', text: '1K' },
                    { value: '2K', text: '2K' },
                    { value: '4K', text: '4K' }
                ]
            },
            {
                id: 'imageCount',
                options: [
                    { value: '', text: '-- 选择数量 --' },
                    { value: '1', text: '1张' },
                    { value: '2', text: '2张' },
                    { value: '3', text: '3张' },
                    { value: '4', text: '4张' }
                ]
            },
            {
                id: 'presetCategory',
                options: [
                    { value: '', text: '-- 选择分类 --' }
                ]
            },
            {
                id: 'promptPreset',
                options: [
                    { value: '', text: '-- 选择预设 --' }
                ]
            }
        ];

        controls.forEach(function(item) {
            const selectEl = document.getElementById(item.id);
            if (!selectEl) return;
            ensureSelectOptions(selectEl, item.options);
        });

        const imgResolutionSelect = document.getElementById('imgResolution');
        if (imgResolutionSelect) {
            imgResolutionSelect.value = normalizeImageResolution(imgResolutionSelect.value || (currentSettings && currentSettings.imgResolution));
        }

        controls.forEach(function(item) {
            refreshCustomSelectById(item.id);
        });
    }

    function ensurePresetActionButtons() {
        const img2imgTab = document.getElementById('img2img');
        if (!img2imgTab) return;

        const createButton = function(id, text) {
            const button = document.createElement('button');
            button.id = id;
            button.type = 'button';
            button.className = 'btn btn-secondary';
            button.textContent = text;
            return button;
        };

        let saveButton = document.getElementById('btnSavePreset');
        let deleteButton = document.getElementById('btnDeletePreset');
        if (!saveButton) {
            saveButton = createButton('btnSavePreset', '保存预设');
        }
        if (!deleteButton) {
            deleteButton = createButton('btnDeletePreset', '删除预设');
        }

        const ttPresetRow = img2imgTab.querySelector('.tt-preset-save-row');
        if (ttPresetRow) {
            if (saveButton.parentNode !== ttPresetRow) ttPresetRow.appendChild(saveButton);
            if (deleteButton.parentNode !== ttPresetRow) ttPresetRow.appendChild(deleteButton);
            saveButton.textContent = '保存';
            deleteButton.textContent = '删除';
            saveButton.style.setProperty('display', 'flex', 'important');
            deleteButton.style.setProperty('display', 'flex', 'important');
            if (saveButton.dataset.presetActionBound !== '1') {
                saveButton.onclick = async function() { await savePreset(); };
                saveButton.dataset.presetActionBound = '1';
            }
            if (deleteButton.dataset.presetActionBound !== '1') {
                deleteButton.onclick = async function() { await deletePreset(); };
                deleteButton.dataset.presetActionBound = '1';
            }
            return;
        }

        let actions = img2imgTab.querySelector('.preset-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'preset-actions';
        }
        const oldActionsHost = actions.parentNode;

        let row = actions.closest('.preset-actions-row');
        if (!row || !img2imgTab.contains(row)) {
            row = document.createElement('div');
            row.className = 'form-group preset-actions-row';
        } else {
            row.classList.add('form-group', 'preset-actions-row');
        }

        if (actions.parentNode !== row) {
            row.appendChild(actions);
        }
        if (oldActionsHost && oldActionsHost !== row && oldActionsHost.classList && oldActionsHost.classList.contains('form-group') && oldActionsHost.children.length === 0) {
            oldActionsHost.remove();
        }
        if (saveButton.parentNode !== actions) {
            actions.appendChild(saveButton);
        }
        if (deleteButton.parentNode !== actions) {
            actions.appendChild(deleteButton);
        }

        const presetNameGroup = document.getElementById('presetName') ? document.getElementById('presetName').closest('.form-group') : null;
        if (presetNameGroup && presetNameGroup.parentNode === img2imgTab && row.parentNode !== img2imgTab) {
            img2imgTab.insertBefore(row, presetNameGroup.nextSibling);
        } else if (row.parentNode === img2imgTab && presetNameGroup && row.previousElementSibling !== presetNameGroup) {
            img2imgTab.insertBefore(row, presetNameGroup.nextSibling);
        }

        saveButton.style.setProperty('display', 'flex', 'important');
        deleteButton.style.setProperty('display', 'flex', 'important');

        if (saveButton.dataset.presetActionBound !== '1') {
            saveButton.onclick = async function() {
                await savePreset();
            };
            saveButton.dataset.presetActionBound = '1';
        }
        if (deleteButton.dataset.presetActionBound !== '1') {
            deleteButton.onclick = async function() {
                await deletePreset();
            };
            deleteButton.dataset.presetActionBound = '1';
        }
    }





    
    function setupEventListeners() {
        debugLog('开始设置事件监听器...');
        const galleryGrid = document.getElementById('galleryGrid');
        if (galleryGrid) {
            let gallerySingleClickTimer = null;
            galleryGrid.onclick = async function(event) {
                const action = event.target && event.target.closest && event.target.closest('[data-gallery-action]');
                const card = event.target && event.target.closest && event.target.closest('.gallery-card');
                if (!action || !card) return;
                const itemId = card.getAttribute('data-gallery-id');
                try {
                    if (action.dataset.galleryAction === 'delete') {
                        await window.HuanmengGalleryStore.remove(itemId);
                        await renderGallery();
                    } else if (isGalleryBrowserMode()) {
                        if (gallerySingleClickTimer) clearTimeout(gallerySingleClickTimer);
                        gallerySingleClickTimer = setTimeout(function() {
                            gallerySingleClickTimer = null;
                            openGalleryPreview(itemId).catch(function(error) {
                                showStatus('画廊预览失败：' + error.message, 'error');
                            });
                        }, 230);
                    } else {
                        // 预览区现在是 div，没有 disabled 属性，用 class 做重入保护
                        action.classList.add('is-busy');
                        await replayGalleryItem(itemId);
                    }
                } catch (error) {
                    showStatus('画廊操作失败：' + error.message, 'error');
                } finally {
                    action.classList.remove('is-busy');
                }
            };
            galleryGrid.ondblclick = function(event) {
                if (!isGalleryBrowserMode()) return;
                const action = event.target && event.target.closest && event.target.closest('[data-gallery-action="replay"]');
                const card = event.target && event.target.closest && event.target.closest('.gallery-card');
                if (!action || !card) return;
                event.preventDefault();
                if (gallerySingleClickTimer) {
                    clearTimeout(gallerySingleClickTimer);
                    gallerySingleClickTimer = null;
                }
                downloadGalleryItem(card.getAttribute('data-gallery-id')).catch(function(error) {
                    showStatus('下载失败：' + error.message, 'error');
                });
            };
        }
        const btnRefreshGallery = document.getElementById('btnRefreshGallery');
        if (btnRefreshGallery) btnRefreshGallery.onclick = function() { renderGallery(); };

        // 清空画廊。删除不可撤销，所以做两步确认：
        // 第一次点击只把按钮切成「确认清空？」并进入 is-armed 状态，4 秒内再点一次才真正执行。
        // 这里刻意不做弹窗/遮罩——该项目在这个 UXP 环境里反复验证过浮层不可靠
        // （下拉面板被同页卡片盖住的那一串问题），内联确认没有层叠风险。
        const btnClearGallery = document.getElementById('btnClearGallery');
        if (btnClearGallery) {
            let clearArmed = false;
            let clearTimer = null;
            const disarmClear = function() {
                clearArmed = false;
                if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
                btnClearGallery.textContent = '清空';
                btnClearGallery.classList.remove('is-armed');
            };
            btnClearGallery.onclick = async function() {
                if (!clearArmed) {
                    clearArmed = true;
                    btnClearGallery.textContent = '确认清空？';
                    btnClearGallery.classList.add('is-armed');
                    clearTimer = setTimeout(disarmClear, 4000);
                    return;
                }
                disarmClear();
                btnClearGallery.disabled = true;
                try {
                    const result = await window.HuanmengGalleryStore.clear();
                    showStatus('已清空画廊，共删除 ' + result.removed + ' 张', 'success');
                    showToast('画廊已清空');
                    await renderGallery();
                } catch (error) {
                    showStatus('清空画廊失败：' + error.message, 'error');
                } finally {
                    btnClearGallery.disabled = false;
                }
            };
        }
        const btnPruneGallery = document.getElementById('btnPruneGallery');
        if (btnPruneGallery) btnPruneGallery.onclick = async function() {
            try {
                const result = await window.HuanmengGalleryStore.prune(getGalleryPolicy());
                const status = document.getElementById('galleryPruneStatus');
                if (status) status.textContent = '已清理 ' + result.removed + ' 张，保留 ' + result.kept + ' 张';
                await renderGallery();
            } catch (error) {
                showStatus('清理画廊失败：' + error.message, 'error');
            }
        };
        const promptInputTt = document.getElementById('imgPrompt');
        const promptCountTt = document.getElementById('imgPromptCharCount');
        const updatePromptCountTt = function() {
            if (promptCountTt) promptCountTt.textContent = String((promptInputTt && promptInputTt.value || '').length) + ' / 5000 字';
        };
        if (promptInputTt) {
            promptInputTt.addEventListener('input', updatePromptCountTt);
            updatePromptCountTt();
        }
        const btnClearPromptTt = document.getElementById('btnClearPromptTt');
        if (btnClearPromptTt) {
            btnClearPromptTt.onclick = function() {
                if (!promptInputTt) return;
                promptInputTt.value = '';
                promptInputTt.dispatchEvent(new Event('input', { bubbles: true }));
                promptInputTt.focus();
            };
        }

        document.querySelectorAll('[data-align-mode]').forEach(function(button) {
            button.onclick = function() {
                const nextMode = button.dataset.alignMode || 'fit-layer';
                document.querySelectorAll('[data-align-mode]').forEach(function(item) {
                    item.classList.toggle('active', item === button);
                });
                const alignmentSelect = document.getElementById('alignmentMode');
                if (alignmentSelect) alignmentSelect.value = nextMode;
                if (currentSettings) currentSettings.alignmentMode = nextMode;
                showToast('对齐模式：' + button.textContent.trim());
            };
        });

        document.querySelectorAll('[data-ref-mode]').forEach(function(button) {
            button.onclick = function() {
                referenceInputMode = button.dataset.refMode === 'multi' ? 'multi' : 'single';
                document.querySelectorAll('[data-ref-mode]').forEach(function(item) {
                    item.classList.toggle('active', item === button);
                });
                const card = document.querySelector('.tt-image-input-card');
                if (card) card.dataset.refMode = referenceInputMode;
                renderReferenceImages();
                showToast(referenceInputMode === 'single' ? '已切换到单图模式' : '已切换到多图模式');
            };
        });

        const btnCheckGrok2Api = document.getElementById('btnCheckGrok2Api');
        if (btnCheckGrok2Api) {
            btnCheckGrok2Api.onclick = async function() {
                const urlEl = document.getElementById('grok2apiApiUrl');
                const keyEl = document.getElementById('grok2apiApiKey');
                const baseUrl = normalizeBaseUrl(urlEl && urlEl.value, GROK2API_DEFAULT_BASE_URL).replace(/\/v1$/i, '');
                const apiKey = normalizeApiKey(keyEl && keyEl.value);
                if (!apiKey) {
                    showStatus('请先填写 grok2api Client Key（g2a_...）', 'error');
                    return;
                }
                btnCheckGrok2Api.disabled = true;
                btnCheckGrok2Api.textContent = '检查中...';
                try {
                    const response = await fetch(joinApiUrl(baseUrl, '/v1/models'), {
                        headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + apiKey }
                    });
                    if (response.status === 401) {
                        throw new Error('Client Key 无效；请从 grok2api → Client Keys 复制 g2a_...');
                    }
                    if (!response.ok) throw new Error('HTTP ' + response.status + ' - ' + await response.text());
                    const data = await response.json();
                    const count = Array.isArray(data && data.data) ? data.data.length : 0;
                    showStatus('grok2api 连接成功，读取到 ' + count + ' 个模型', 'success');
                    showToast('grok2api 连接成功');
                } catch (error) {
                    showStatus('grok2api 连接失败：' + error.message, 'error');
                } finally {
                    btnCheckGrok2Api.disabled = false;
                    btnCheckGrok2Api.textContent = '检查连接 / 读取模型';
                }
            };
        }

        const btnCheckSub2Api = document.getElementById('btnCheckSub2Api');
        if (btnCheckSub2Api) {
            btnCheckSub2Api.onclick = async function() {
                const urlEl = document.getElementById('sub2apiApiUrl');
                const keyEl = document.getElementById('sub2apiApiKey');
                const statusEl = document.getElementById('sub2apiStatus');
                const baseUrl = normalizeBaseUrl(urlEl && urlEl.value, SUB2API_DEFAULT_BASE_URL).replace(/\/v1$/i, '');
                const apiKey = normalizeApiKey(keyEl && keyEl.value);
                if (!apiKey) {
                    const message = '请先填写 Sub2API 用户 API Key（sk-...）';
                    if (statusEl) statusEl.textContent = message;
                    showStatus(message, 'error');
                    return;
                }
                btnCheckSub2Api.disabled = true;
                btnCheckSub2Api.textContent = '检查中...';
                if (statusEl) statusEl.textContent = '正在连接 Sub2API 并读取模型...';
                try {
                    const response = await fetch(joinApiUrl(baseUrl, '/v1/models'), {
                        headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + apiKey }
                    });
                    if (response.status === 401) {
                        throw new Error('用户 API Key 无效；请从 Sub2API 用户后台复制 sk-... 密钥');
                    }
                    if (!response.ok) throw new Error('HTTP ' + response.status + ' - ' + await response.text());
                    const data = await response.json();
                    const models = Array.isArray(data && data.data) ? data.data : (Array.isArray(data && data.models) ? data.models : []);
                    const count = models.length;
                    const message = 'Sub2API 连接成功，读取到 ' + count + ' 个模型';
                    if (statusEl) statusEl.textContent = message + '；图片分组需启用生图权限。';
                    showStatus(message, 'success');
                    showToast('Sub2API 连接成功');
                } catch (error) {
                    const message = 'Sub2API 连接失败：' + error.message;
                    if (statusEl) statusEl.textContent = message;
                    showStatus(message, 'error');
                } finally {
                    btnCheckSub2Api.disabled = false;
                    btnCheckSub2Api.textContent = '检查连接 / 读取模型';
                }
            };
        }
        const btnRefreshUi = document.getElementById('btnRefreshUi');
        if (btnRefreshUi) {
            btnRefreshUi.onclick = function() {
                ensureImg2ImgInlineControls();
                ensurePresetActionButtons();
                ensureSettingsUiCompatibility();
                updateLogDisplay();
                showToast('界面已刷新');
            };
        }

        const btnCloseSplash = document.getElementById('btnCloseSplash');
        if (btnCloseSplash) {
            btnCloseSplash.onclick = function() {
                const shell = document.querySelector('.app-shell');
                if (shell) {
                    shell.classList.remove('splash-open');
                }
                switchTab('img2img');
            };
        }

        // 为标签页添加点击事件
        const tabs = document.querySelectorAll('.tab');
        debugLog('找到标签页数量:', tabs.length);
        
        if (tabs.length === 0) {
            console.error('没有找到标签页元素');
        } else {
            debugLog('找到的标签页:', Array.from(tabs).map(tab => tab.getAttribute('data-tab')));
        }
        
        for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i];
            const tabId = tab.getAttribute('data-tab');
            debugLog('绑定标签页点击事件:', tabId);
            
            tab.onclick = function() {
                const clickedTabId = this.getAttribute('data-tab');
                debugLog('标签页被点击:', clickedTabId);
                switchTab(clickedTabId);
            };
            
            // 测试点击事件是否绑定成功
            debugLog('标签页', tabId, '的onclick事件:', tab.onclick);
        }
        
        // 为按钮添加点击事件
        const btnSaveSettings = document.getElementById('btnSaveSettings');
        if (btnSaveSettings) {
            debugLog('绑定btnSaveSettings点击事件');
            btnSaveSettings.onclick = saveSettings;
        }

        const btnChat = document.getElementById('btnChat');
        if (btnChat) {
            debugLog('绑定btnChat点击事件');
            btnChat.onclick = chat;
        }
        
        const btnImg2Img = document.getElementById('btnImg2Img');
        if (btnImg2Img) {
            debugLog('绑定btnImg2Img点击事件');
            btnImg2Img.onclick = async function() {
                try {
                    debugLog('btnImg2Img被点击，开始执行img2Img函数');
                    await img2Img();
                } catch (error) {
                    console.error('执行img2Img函数出错:', error);
                    showStatus('执行出错: ' + error.message, 'error');
                }
            };
        }
        
        const btnAddToBatch = document.getElementById('btnAddToBatch');
        if (btnAddToBatch) {
            debugLog('绑定btnAddToBatch点击事件');
            btnAddToBatch.onclick = async function() {
                try {
                    await addToBatch();
                } catch (error) {
                    console.error('执行addToBatch函数出错:', error);
                    showStatus('执行出错: ' + error.message, 'error');
                }
            };
        }

        const btnAddReferenceImage = document.getElementById('btnAddReferenceImage');
        if (btnAddReferenceImage) {
            debugLog('绑定btnAddReferenceImage点击事件');
            btnAddReferenceImage.onclick = addReferenceImageFromSelection;
        }

        const btnAddReferenceImageVfx = document.getElementById('btnAddReferenceImageVfx');
        if (btnAddReferenceImageVfx) {
            btnAddReferenceImageVfx.onclick = addReferenceImageFromSelection;
        }

        const btnStartBatch = document.getElementById('btnStartBatch');
        if (btnStartBatch) {
            debugLog('绑定btnStartBatch点击事件');
            btnStartBatch.onclick = startBatch;
        }
        
        const btnClearBatch = document.getElementById('btnClearBatch');
        if (btnClearBatch) {
            debugLog('绑定btnClearBatch点击事件');
            btnClearBatch.onclick = clearBatch;
        }
        
        const btnExportLogs = document.getElementById('btnExportLogs');
        if (btnExportLogs) {
            debugLog('绑定btnExportLogs点击事件');
            btnExportLogs.onclick = exportLogs;
        }
        
        const btnClearLogs = document.getElementById('btnClearLogs');
        if (btnClearLogs) {
            debugLog('绑定btnClearLogs点击事件');
            btnClearLogs.onclick = clearLogs;
        }
        
        const logSearch = document.getElementById('logSearch');
        if (logSearch) {
            debugLog('绑定logSearch输入事件');
            logSearch.oninput = searchLogs;
        }
        
        const promptPreset = document.getElementById('promptPreset');
        if (promptPreset) {
            debugLog('绑定promptPreset change事件');
            promptPreset.onchange = function() {
                runGuardedUiAction(function() { return applyPreset('img2img'); }, '应用提示词预设');
            };
        }

        const vfxPromptPreset = document.getElementById('vfxPromptPreset');
        if (vfxPromptPreset) {
            vfxPromptPreset.onchange = function() {
                runGuardedUiAction(function() { return applyPreset('vfx'); }, '应用 VFX 预设');
            };
        }

        const btnBackToImg2ImgWorkspace = document.getElementById('btnBackToImg2ImgWorkspace');
        if (btnBackToImg2ImgWorkspace) {
            btnBackToImg2ImgWorkspace.onclick = function() {
                switchTab('img2img');
            };
        }


        const btnBackToAppsHome = document.getElementById('btnBackToAppsHome');
        if (btnBackToAppsHome) {
            btnBackToAppsHome.onclick = function() {
                closeAppCategory();
            };
        }

        const btnBackToGenericAppHome = document.getElementById('btnBackToGenericAppHome');
        if (btnBackToGenericAppHome) {
            btnBackToGenericAppHome.onclick = function() {
                closeAppCategory();
            };
        }

        const appsHome = document.getElementById('appsHome');
        if (appsHome) {
            appsHome.onclick = function(event) {
                const trigger = event.target.closest('[data-app-category]');
                if (!trigger) return;
                openAppsCard(trigger.getAttribute('data-app-category'));
            };
        }

        const runninghubHome = document.getElementById('runninghubHome');
        if (runninghubHome) {
            runninghubHome.onclick = function(event) {
                const trigger = event.target.closest('[data-app-category]');
                if (!trigger) return;
                openAppsCard(trigger.getAttribute('data-app-category'));
            };
        }

        document.querySelectorAll('[data-ps-tool]').forEach(function(button) {
            button.onclick = async function() {
                const toolName = button.getAttribute('data-ps-tool');
                button.disabled = true;
                const browserMode = isMobileWebEnvironment();
                showStatus(browserMode ? '正在上传并执行手机工具...' : '正在执行 Photoshop 工具...', 'info');
                try {
                    const message = browserMode
                        ? await runBrowserToolboxAction(toolName, button)
                        : await runPhotoshopToolboxAction(toolName);
                    showStatus(message, 'success');
                    showToast(message);
                    Config.addLog({
                        timestamp: new Date().toLocaleString('zh-CN'),
                        model: browserMode ? '手机工具箱' : 'Photoshop 工具箱',
                        prompt: toolName,
                        type: 'toolbox',
                        status: '成功',
                        message: message
                    });
                } catch (error) {
                    const message = error && error.message ? error.message : String(error);
                    showStatus('工具执行失败：' + message, 'error');
                    Config.addLog({
                        timestamp: new Date().toLocaleString('zh-CN'),
                        model: 'Photoshop 工具箱',
                        prompt: toolName,
                        type: 'toolbox',
                        status: '失败',
                        error: message
                    });
                } finally {
                    button.disabled = false;
                }
            };
        });

        const btnToolGlowEditor = document.getElementById('btnToolGlowEditor');
        if (btnToolGlowEditor) btnToolGlowEditor.onclick = function() { openToolEditor('glow', 'toolbox'); };

        const btnToolSpaceFx = document.getElementById('btnToolSpaceFx');
        if (btnToolSpaceFx) btnToolSpaceFx.onclick = openToolboxSpaceFx;

        const btnToolScope = document.getElementById('btnToolScope');
        if (btnToolScope) btnToolScope.onclick = function() { openToolEditor('scope', 'toolbox'); };

        const btnToolLight = document.getElementById('btnToolLight');
        if (btnToolLight) btnToolLight.onclick = function() { openToolEditor('light', 'toolbox'); };

        const btnToolColorMatch = document.getElementById('btnToolColorMatch');
        if (btnToolColorMatch) btnToolColorMatch.onclick = function() { openToolEditor('blend-match', 'toolbox'); };

        const autoColorMatchMethod = document.getElementById('autoColorMatchMethod');
        const toolColorMatchMethod = document.getElementById('toolColorMatchMethod');
        if (autoColorMatchMethod && toolColorMatchMethod) {
            autoColorMatchMethod.onchange = function() { toolColorMatchMethod.value = autoColorMatchMethod.value; };
            toolColorMatchMethod.onchange = function() { autoColorMatchMethod.value = toolColorMatchMethod.value; };
        }

        const btnSyncServerPresets = document.getElementById('btnSyncServerPresets');
        if (btnSyncServerPresets) {
            btnSyncServerPresets.onclick = async function() {
                btnSyncServerPresets.disabled = true;
                try {
                    await syncServerPresets();
                } catch (error) {
                    const statusEl = document.getElementById('promptSyncStatus');
                    if (statusEl) statusEl.textContent = '同步失败：' + (error && error.message ? error.message : error);
                    showStatus('服务器提示词同步失败：' + (error && error.message ? error.message : error), 'error');
                } finally {
                    btnSyncServerPresets.disabled = false;
                }
            };
        }

        const taskCenterList = document.getElementById('taskCenterList');
        if (taskCenterList) {
            taskCenterList.onclick = async function(event) {
                const actionButton = event.target.closest('[data-task-action]');
                if (!actionButton) return;
                const card = actionButton.closest('[data-task-id]');
                if (!card) return;
                const taskId = card.getAttribute('data-task-id');
                const action = actionButton.getAttribute('data-task-action');
                actionButton.disabled = true;
                try {
                    if (action === 'return') {
                        await retryTaskReturn(taskId);
                    } else if (action === 'cancel') {
                        // 按 taskId 取消对应的那一个。并发下不能「取消当前的」——
                        // 那会取消到别的任务上去。
                        abortGenerationTask(taskId);
                        updateTaskEntry(taskId, { state: 'cancelled', detail: '用户已取消', progress: 0 });
                    }
                } catch (error) {
                    updateTaskEntry(taskId, { state: 'failed', detail: error && error.message ? error.message : String(error) });
                    showStatus('任务操作失败：' + (error && error.message ? error.message : error), 'error');
                }
            };
        }

        const btnClearFinishedTasks = document.getElementById('btnClearFinishedTasks');
        if (btnClearFinishedTasks) {
            btnClearFinishedTasks.onclick = function() {
                taskEntries = taskEntries.filter(function(task) {
                    return ['completed', 'failed', 'cancelled'].indexOf(task.state) < 0;
                });
                Config.saveTasks(taskEntries);
                renderTaskCenter();
                showToast('已清理结束任务');
            };
        }

        const btnParseRunninghubApp = document.getElementById('btnParseRunninghubApp');
        if (btnParseRunninghubApp) {
            btnParseRunninghubApp.onclick = async function() {
                try {
                    await parseRunninghubApp();
                } catch (error) {
                    console.error('解析 RunningHub 应用失败:', error);
                    showStatus('解析应用失败：' + error.message, 'error');
                }
            };
        }

        const btnSaveRunninghubParsedApp = document.getElementById('btnSaveRunninghubParsedApp');
        if (btnSaveRunninghubParsedApp) {
            btnSaveRunninghubParsedApp.onclick = function() {
                try {
                    saveParsedRunninghubApp();
                } catch (error) {
                    console.error('保存 RunningHub 应用失败:', error);
                    showStatus('保存应用失败：' + error.message, 'error');
                }
            };
        }

        const runninghubAppList = document.getElementById('runninghubAppList');
        if (runninghubAppList) {
            runninghubAppList.oninput = function(event) {
                const searchInput = event.target && event.target.closest ? event.target.closest('#runninghubAppSearch') : null;
                if (!searchInput) return;
                runninghubAppSearchQuery = searchInput.value || '';
                renderRunninghubAppList();
            };
            runninghubAppList.onclick = function(event) {
                const removeTrigger = event.target.closest('[data-runninghub-remove]');
                if (removeTrigger) {
                    const appId = removeTrigger.getAttribute('data-runninghub-remove');
                    removeRunninghubApp(appId);
                    showStatus('RunningHub 应用已删除', 'success');
                    showToast('应用已删除');
                    return;
                }
                const toggleTrigger = event.target.closest('[data-runninghub-toggle]');
                if (toggleTrigger) {
                    const appId = toggleTrigger.getAttribute('data-runninghub-toggle');
                    const enabled = toggleTrigger.getAttribute('data-runninghub-enabled') !== '1';
                    toggleRunninghubAppEnabled(appId, enabled);
                }
            };
        }

        const btnBackToVfxWorkspace = document.getElementById('btnBackToVfxWorkspace');
        if (btnBackToVfxWorkspace) {
            btnBackToVfxWorkspace.onclick = function() {
                openToolEditor('vfx', 'apps');
            };
        }

        const appEditorBody = document.getElementById('appEditorBody');
        if (appEditorBody) {
            appEditorBody.oninput = function(event) {
                const target = event.target;
                if (!target || !target.getAttribute) return;
                const compositeField = target.getAttribute('data-composite-field');
                if (compositeField) {
                    const patch = {};
                    patch[compositeField] = target.type === 'checkbox' ? !!target.checked : target.value;
                    updateCompositeAssistantState(patch, false);
                    return;
                }
                const effectTransferField = target.getAttribute('data-effect-transfer-field');
                if (effectTransferField) {
                    const patch = {};
                    patch[effectTransferField] = target.type === 'checkbox' ? !!target.checked : target.value;
                    updateEffectTransferState(patch, false);
                    return;
                }
                const aiSuperresField = target.getAttribute('data-ai-superres-field');
                if (aiSuperresField) {
                    const patch = {};
                    patch[aiSuperresField] = aiSuperresField === 'upscaleFactor' || aiSuperresField === 'tileOverlap' ? Number(target.value) : target.value;
                    updateAiSuperResolutionState(patch, false);
                    return;
                }
                const fieldKey = target.getAttribute('data-runninghub-field');
                if (!fieldKey) return;
                if (target.type === 'checkbox') {
                    currentRunninghubFieldValues[fieldKey] = !!target.checked;
                    return;
                }
                currentRunninghubFieldValues[fieldKey] = target.value;
            };
            appEditorBody.onchange = function(event) {
                const target = event.target;
                if (!target || !target.getAttribute) return;
                const passTrigger = target.getAttribute('data-composite-pass');
                if (passTrigger) {
                    toggleCompositeAssistantPass(passTrigger, !!target.checked);
                    return;
                }
                const compositeField = target.getAttribute('data-composite-field');
                if (compositeField) {
                    const patch = {};
                    patch[compositeField] = target.type === 'checkbox' ? !!target.checked : target.value;
                    updateCompositeAssistantState(patch, true);
                    return;
                }
                const effectTransferField = target.getAttribute('data-effect-transfer-field');
                if (effectTransferField) {
                    const patch = {};
                    patch[effectTransferField] = target.type === 'checkbox' ? !!target.checked : target.value;
                    updateEffectTransferState(patch, true);
                    return;
                }
                const aiSuperresField = target.getAttribute('data-ai-superres-field');
                if (aiSuperresField) {
                    const patch = {};
                    patch[aiSuperresField] = aiSuperresField === 'upscaleFactor' || aiSuperresField === 'tileOverlap' ? Number(target.value) : target.value;
                    patch.tilePlan = null;
                    updateAiSuperResolutionState(patch, true);
                    return;
                }
                const fieldKey = target.getAttribute('data-runninghub-field');
                if (!fieldKey) return;
                if (target.type === 'checkbox') {
                    currentRunninghubFieldValues[fieldKey] = !!target.checked;
                } else {
                    currentRunninghubFieldValues[fieldKey] = target.value;
                }
            };
            appEditorBody.onclick = function(event) {
                const compositeCaptureTrigger = event.target.closest('[data-composite-capture-image]');
                if (compositeCaptureTrigger) {
                    captureCompositeAssistantImage();
                    return;
                }
                const compositeClearTrigger = event.target.closest('[data-composite-clear-image]');
                if (compositeClearTrigger) {
                    updateCompositeAssistantState({ image: null, imageUrl: '' }, true);
                    showToast('输入图片已清除');
                    return;
                }
                const compositeRunTrigger = event.target.closest('[data-composite-run]');
                if (compositeRunTrigger) {
                    runCompositeAssistant();
                    return;
                }
                const compositeResetTrigger = event.target.closest('[data-composite-reset]');
                if (compositeResetTrigger) {
                    resetCompositeAssistantState();
                    return;
                }
                if (event.target.closest('[data-effect-transfer-capture-source]')) {
                    captureEffectTransferImage('source');
                    return;
                }
                if (event.target.closest('[data-effect-transfer-capture-effect]')) {
                    captureEffectTransferImage('effect');
                    return;
                }
                if (event.target.closest('[data-effect-transfer-clear-source]')) {
                    updateEffectTransferState({ sourceImage: null }, true);
                    return;
                }
                if (event.target.closest('[data-effect-transfer-clear-effect]')) {
                    updateEffectTransferState({ effectImage: null }, true);
                    return;
                }
                if (event.target.closest('[data-effect-transfer-run]')) {
                    runEffectTransfer();
                    return;
                }
                if (event.target.closest('[data-effect-transfer-reset]')) {
                    resetEffectTransferState();
                    return;
                }
                if (event.target.closest('[data-ai-superres-capture-source]')) {
                    captureAiSuperResolutionSource();
                    return;
                }
                if (event.target.closest('[data-ai-superres-clear-source]')) {
                    updateAiSuperResolutionState({ sourceImage: null, tilePlan: null }, true);
                    return;
                }
                if (event.target.closest('[data-ai-superres-plan]')) {
                    planAiSuperResolutionTiles();
                    return;
                }
                if (event.target.closest('[data-ai-superres-run]')) {
                    runAiSuperResolution();
                    return;
                }
                if (event.target.closest('[data-ai-superres-reset]')) {
                    resetAiSuperResolutionState();
                    return;
                }
                const captureTrigger = event.target.closest('[data-runninghub-image-capture]');
                if (captureTrigger) {
                    assignRunninghubImageField(captureTrigger.getAttribute('data-runninghub-image-capture'));
                    return;
                }
                const clearTrigger = event.target.closest('[data-runninghub-image-clear]');
                if (clearTrigger) {
                    clearRunninghubImageField(clearTrigger.getAttribute('data-runninghub-image-clear'));
                    return;
                }
                const clearValuesTrigger = event.target.closest('[data-app-editor-clear-values]');
                if (clearValuesTrigger) {
                    currentRunninghubFieldValues = {};
                    if (appEditorMeta && Array.isArray(appEditorMeta.inputs)) {
                        appEditorMeta.inputs.forEach(function(field) {
                            if (field.defaultValue != null && field.type !== 'image') {
                                currentRunninghubFieldValues[field.key] = field.type === 'boolean' ? !!field.defaultValue : field.defaultValue;
                            }
                        });
                    }
                    renderGenericAppEditor(appEditorMeta || {});
                    showStatus('参数已清空', 'success');
                    return;
                }
                const saveIdTrigger = event.target.closest('[data-runninghub-save-app-id]');
                if (saveIdTrigger) {
                    saveCurrentRunninghubAppId();
                    return;
                }
                const runTrigger = event.target.closest('#btnRunCurrentApp');
                if (runTrigger) {
                    runCurrentRunninghubApp();
                }
            };
        }

        const btnGoToImg2Img = document.getElementById('btnGoToImg2Img');
        if (btnGoToImg2Img) {
            btnGoToImg2Img.onclick = function() {
                applyVfxPromptToTextarea();
                switchTab('img2img');
            };
        }

        const btnGenerateVfxApp = document.getElementById('btnGenerateVfxApp');
        if (btnGenerateVfxApp) {
            btnGenerateVfxApp.onclick = async function() {
                applyVfxPromptToTextarea();
                const route = readIndependentGenerationControls('tool:vfx', 'toolRoute');
                const prompt = (document.getElementById('imgPrompt') || {}).value || '';
                await img2Img({
                    prompt: prompt,
                    model: route.model,
                    imageResolution: route.imageResolution,
                    imageCount: route.imageCount,
                    type: 'vfx',
                    title: 'VFX 特效',
                    button: btnGenerateVfxApp,
                    idleButtonLabel: '直接生成 VFX'
                });
            };
        }

        const vfxEffectPreset = document.getElementById('vfxEffectPreset');
        if (vfxEffectPreset) {
            vfxEffectPreset.onchange = function() {
                const config = collectVfxFormConfig();
                currentVfxConfig = config;
                updateVfxConditionalFields(config);
                applyVfxPromptToTextarea();
            };
        }

        const vfxEffectCustomName = document.getElementById('vfxEffectCustomName');
        if (vfxEffectCustomName) {
            vfxEffectCustomName.oninput = function() {
                currentVfxConfig = collectVfxFormConfig();
                applyVfxPromptToTextarea();
            };
        }

        const vfxMotionPathText = document.getElementById('vfxMotionPathText');
        if (vfxMotionPathText) {
            vfxMotionPathText.oninput = function() {
                currentVfxConfig = collectVfxFormConfig();
                applyVfxPromptToTextarea();
            };
        }

        const vfxMaterialPreset = document.getElementById('vfxMaterialPreset');
        if (vfxMaterialPreset) {
            vfxMaterialPreset.onchange = function() {
                const config = collectVfxFormConfig();
                currentVfxConfig = config;
                updateVfxConditionalFields(config);
                applyVfxPromptToTextarea();
            };
        }

        const vfxMaterialCustomName = document.getElementById('vfxMaterialCustomName');
        if (vfxMaterialCustomName) {
            vfxMaterialCustomName.oninput = function() {
                currentVfxConfig = collectVfxFormConfig();
                applyVfxPromptToTextarea();
            };
        }

        const vfxParticleText = document.getElementById('vfxParticleText');
        if (vfxParticleText) {
            vfxParticleText.oninput = function() {
                currentVfxConfig = collectVfxFormConfig();
                applyVfxPromptToTextarea();
            };
        }

        const vfxSmokeEnabled = document.getElementById('vfxSmokeEnabled');
        if (vfxSmokeEnabled) {
            vfxSmokeEnabled.onchange = function() {
                const config = collectVfxFormConfig();
                currentVfxConfig = config;
                updateVfxConditionalFields(config);
                applyVfxPromptToTextarea();
            };
        }

        const vfxSmokeText = document.getElementById('vfxSmokeText');
        if (vfxSmokeText) {
            vfxSmokeText.oninput = function() {
                currentVfxConfig = collectVfxFormConfig();
                applyVfxPromptToTextarea();
            };
        }

        const vfxColor = document.getElementById('vfxColor');
        if (vfxColor) {
            vfxColor.oninput = function() {
                setVfxColorValue(vfxColor.value);
                const config = collectVfxFormConfig();
                currentVfxConfig = config;
                applyVfxPromptToTextarea();
            };
        }

        const btnCreateVfxLayer = document.getElementById('btnCreateVfxLayer');
        if (btnCreateVfxLayer) {
            btnCreateVfxLayer.onclick = createVfxDoodleLayer;
        }

        const btnCaptureTrajectory = document.getElementById('btnCaptureTrajectory');
        if (btnCaptureTrajectory) {
            btnCaptureTrajectory.onclick = captureVfxTrajectoryReference;
        }

        const btnClearTrajectory = document.getElementById('btnClearTrajectory');
        if (btnClearTrajectory) {
            btnClearTrajectory.onclick = clearVfxTrajectoryReference;
        }

        const btnPickPsForeground = document.getElementById('btnPickPsForeground');
        if (btnPickPsForeground) {
            btnPickPsForeground.onclick = syncVfxColorFromForeground;
        }

        const btnApplyVfxPrompt = document.getElementById('btnApplyVfxPrompt');
        if (btnApplyVfxPrompt) {
            btnApplyVfxPrompt.onclick = function() {
                const config = collectVfxFormConfig();
                currentVfxConfig = config;
                applyVfxPromptToTextarea();
                showToast('VFX 提示词已更新');
            };
        }

        const btnImg2ImgReadSelection = document.getElementById('btnImg2ImgReadSelection');
        if (btnImg2ImgReadSelection) {
            debugLog('绑定btnImg2ImgReadSelection点击事件');
            btnImg2ImgReadSelection.onclick = async function() {
                try {
                    await img2ImgReadSelection();
                } catch (error) {
                    console.error('执行img2ImgReadSelection函数出错:', error);
                    showStatus('读取选区失败：' + error.message, 'error');
                }
            };
        }

        try {
            bindPseudoVfxControls();
        } catch (error) {
            console.error('绑定VFX伪控件失败:', error);
            showStatus('VFX 控件初始化失败：' + error.message, 'error');
        }

        const btnSavePreset = document.getElementById('btnSavePreset');
        if (btnSavePreset) {
            debugLog('绑定btnSavePreset点击事件');
            btnSavePreset.onclick = async function() {
                await savePreset();
            };
        }

        const btnSaveVfxPreset = document.getElementById('btnSaveVfxPreset');
        if (btnSaveVfxPreset) {
            btnSaveVfxPreset.onclick = async function() {
                await savePreset();
            };
        }

        const btnDeletePreset = document.getElementById('btnDeletePreset');
        if (btnDeletePreset) {
            debugLog('绑定btnDeletePreset点击事件');
            btnDeletePreset.onclick = async function() {
                await deletePreset('img2img');
            };
        }

        const btnDeleteVfxPreset = document.getElementById('btnDeleteVfxPreset');
        if (btnDeleteVfxPreset) {
            btnDeleteVfxPreset.onclick = async function() {
                await deletePreset('vfx');
            };
        }
        
        const btnChatReadSelection = document.getElementById('btnChatReadSelection');
        if (btnChatReadSelection) {
            debugLog('绑定btnChatReadSelection点击事件');
            btnChatReadSelection.onclick = chatReadSelection;
        }
        
        const btnChatSendToImg2Img = document.getElementById('btnChatSendToImg2Img');
        if (btnChatSendToImg2Img) {
            debugLog('绑定btnChatSendToImg2Img点击事件');
            btnChatSendToImg2Img.onclick = chatSendToImg2Img;
        }
        const textSizeMultiplier = document.getElementById('textSizeMultiplier');
        const textSizeValue = document.getElementById('textSizeValue');
        if (textSizeMultiplier) {
            debugLog('绑定textSizeMultiplier input事件');
            textSizeMultiplier.addEventListener('input', function(event) {
                const value = parseFloat(event.target.value);
                if (textSizeValue) {
                    textSizeValue.textContent = '当前倍数: ' + value.toFixed(1) + 'x';
                }
                // 实时应用文字大小变化
                applyTextSizeMultiplier(value);
            });
        }
        
        // 为聊天输入框添加键盘事件：Enter发送、Shift+Enter换行、Tab调出上次输入
        const chatPrompt = document.getElementById('chatPrompt');
        if (chatPrompt) {
            debugLog('绑定chatPrompt keydown/input事件');
            chatPrompt.addEventListener('keydown', function(event) {
                if (event.key === 'Tab') {
                    event.preventDefault();
                    if (lastChatInput) {
                        chatPrompt.value = lastChatInput;
                        resizeChatPrompt();
                    }
                    return;
                }

                if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
                    const btnChat = document.getElementById('btnChat');
                    if (btnChat && btnChat.disabled) return;
                    event.preventDefault();
                    chat();
                }
            });
            chatPrompt.addEventListener('input', resizeChatPrompt);
            resizeChatPrompt();
        }
        
        // 为图片生成提示词输入框添加事件监听器
        const imgPrompt = document.getElementById('imgPrompt');
        if (imgPrompt) {
            // 仅添加必要的事件监听器
        }
        
        // 为图片模型下拉框添加change事件监听器，更新预览比例
        const imgProviderSelect = document.getElementById('imgProvider');
        if (imgProviderSelect) {
            imgProviderSelect.addEventListener('change', function() {
                renderImageModelsForProvider(this.value, '');
                refreshCustomSelectById('imgProvider');
            });
        }
        const imgModelSelect = document.getElementById('imgModel');
        if (imgModelSelect) {
            debugLog('绑定imgModelSelect change事件');
            imgModelSelect.addEventListener('change', function() {
                updatePreviewAspectByModel(this.value);
                updateImageProviderSummary(this.value);
            });
        }
        
        debugLog('事件监听器设置完成');
    }
    
    async function addToBatch() {
        const prompt = normalizePresetPromptText(document.getElementById('imgPrompt').value.trim());
        const model = document.getElementById('imgModel').value;
        const imageResolution = getSelectedImageResolution();
        const imageCount = parseInt(document.getElementById('imageCount').value) || 1;
        
        if (!prompt) {
            showStatus('请输入提示词', 'error');
            return;
        }
        
        if (!model) {
            showStatus('请选择模型', 'error');
            return;
        }
        
        // 自动获取当时的选区
        if (psAPI.app && psAPI.core && psAPI.imaging) {
            try {
                const bounds = await getSelectionBoundsInPixels();
                if (bounds) {
                    // 验证选区尺寸是否有效
                    if (bounds.width <= 0 || bounds.height <= 0) {
                        debugLog("选区尺寸无效: " + bounds.width + " x " + bounds.height);
                        showStatus('选区尺寸无效，请重新选择区域', 'error');
                        return;
                    }
                    
                    savedSelectionBounds = bounds;
                    savedDocumentId = psAPI.app.activeDocument ? psAPI.app.activeDocument.id : null;
                    debugLog("选区尺寸: " + bounds.width + " x " + bounds.height);
                    
                    const base64Data = await getImageDataToBase64(bounds);
                    
                    if (base64Data && base64Data.length > 0) {
                        selectedImageBase64 = 'data:image/png;base64,' + base64Data;
                        
                        const selectionInfo = document.getElementById('selectionInfo');
                        if (selectionInfo) {
                            selectionInfo.textContent = '选区尺寸: ' + Math.round(bounds.width) + ' x ' + Math.round(bounds.height) + ' 像素';
                        }
                        
                        const previewImage = document.getElementById('previewImage');
                        const previewPlaceholder = document.getElementById('previewPlaceholder');
                        if (previewImage) {
                            previewImage.src = selectedImageBase64;
                            previewImage.style.display = 'block';
                        }
                        if (previewPlaceholder) {
                            previewPlaceholder.style.display = 'none';
                        }
                    }
                } else {
                    debugLog("未能获取选区边界");
                }
            } catch (e) {
                debugLog("选区读取失败:", e);
                showStatus('读取选区失败: ' + e.message, 'error');
                return;
            }
        }
        
        if (!savedSelectionBounds) {
            showStatus('请先读取选区', 'error');
            return;
        }
        
        // 创建批处理任务
        const task = {
            id: Date.now() + Math.random().toString(36).substr(2, 9),
            prompt: prompt,
            model: model,
            imageResolution: imageResolution,
            imageCount: imageCount,
            selectionBounds: JSON.parse(JSON.stringify(savedSelectionBounds)),
            imageBase64: selectedImageBase64,
            referenceImages: getActiveReferenceImageData(),
            timestamp: new Date().toLocaleString('zh-CN')
        };
        
        batchTasks.push(task);
        updateBatchTaskList();
        
        // 显示批处理标签页
        const batchTab = document.querySelector('.tab[data-tab="batch"]');
        if (batchTab) {
            batchTab.style.display = 'block';
        }
        switchTab('batch');
        
        showStatus('任务已添加到批处理', 'success');
        showToast('任务已添加到批处理');
    }
    
    function updateBatchTaskList() {
        const taskList = document.getElementById('batchTaskList');
        if (!taskList) return;
        
        if (batchTasks.length === 0) {
            taskList.innerHTML = '<div class="info-text" style="text-align: center; padding: 20px;">暂无批处理任务</div>';
            return;
        }
        
        let html = '';
        batchTasks.forEach((task, index) => {
            html += '<div style="background: #2d2d2d; border: 1px solid #3d3d3d; border-radius: 4px; padding: 8px; margin-bottom: 8px;">';
            html += '<div style="font-size: 12px; font-weight: 500; margin-bottom: 4px;">任务 ' + (index + 1) + '</div>';
            html += '<div style="font-size: 10px; color: #9d9d9d; margin-bottom: 4px;">模型: ' + task.model + '</div>';
            html += '<div style="font-size: 10px; color: #9d9d9d; margin-bottom: 4px;">图片大小: ' + (normalizeImageResolution(task.imageResolution) === 'auto' ? '自适应' : normalizeImageResolution(task.imageResolution)) + '</div>';
            html += '<div style="font-size: 10px; color: #9d9d9d; margin-bottom: 4px;">生成数量: ' + task.imageCount + '张</div>';
            html += '<div style="font-size: 10px; color: #9d9d9d; margin-bottom: 4px;">选区尺寸: ' + Math.round(task.selectionBounds.width) + ' x ' + Math.round(task.selectionBounds.height) + ' 像素</div>';
            html += '<div style="font-size: 10px; color: #9d9d9d; margin-bottom: 4px;">参考图: ' + ((task.referenceImages || []).length) + ' 张</div>';
            html += '<div style="font-size: 10px; color: #9d9d9d;">提示词: ' + task.prompt + '</div>';
            html += '</div>';
        });
        
        taskList.innerHTML = html;
    }
    
    function clearBatch() {
        batchTasks = [];
        updateBatchTaskList();
        
        // 如果没有任务了，隐藏批处理标签页
        const batchTab = document.querySelector('.tab[data-tab="batch"]');
        if (batchTab) {
            batchTab.style.display = 'none';
        }
        
        showStatus('批处理任务已清空', 'success');
        showToast('批处理任务已清空');
    }
    
    async function startBatch() {
        if (batchTasks.length === 0) {
            showStatus('批处理任务列表为空', 'error');
            return;
        }
        
        const btn = document.getElementById('btnStartBatch');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="loading"></span>正在处理...';
        }
        
        showStatus('开始批处理，共 ' + batchTasks.length + ' 个任务', 'info');
        
        let completedCount = 0;
        let successCount = 0;
        
        // 并发生成所有任务
        const tasks = batchTasks.map(async (task, index) => {
            try {
                debugLog('开始处理任务 ' + (index + 1) + ':', task);
                
                // 保存当前的全局状态
                const originalSavedSelectionBounds = savedSelectionBounds;
                const originalSelectedImageBase64 = selectedImageBase64;
                
                // 设置当前任务的状态
                savedSelectionBounds = task.selectionBounds;
                selectedImageBase64 = task.imageBase64;
                
                // 计算图像尺寸
                const imageConfig = getModelImageConfig(task.model, task.selectionBounds, task.imageResolution);
                const width = imageConfig.width;
                const height = imageConfig.height;
                
                // 创建AbortController
                const abortController = new AbortController();
                
                // 根据模型选择使用哪个API
                let result;
                const routingValidation = validateImageApiRouting(task.model, currentSettings);
                if (!routingValidation.valid) {
                    Config.addLog({
                        timestamp: task.timestamp,
                        model: task.model,
                        prompt: task.prompt,
                        type: 'batch',
                        status: '失败',
                        error: routingValidation.message
                    });
                    return;
                }

                const route = routingValidation.route;
                const requestPrompt = getImageRequestPrompt(task.model, task.prompt, !!task.imageBase64);
                if (route.provider === 'google') {
                    // 使用Google AI Studio API
                    result = await API.generateImageGoogle({
                        apiKey: route.apiKey,
                        model: task.model,
                        prompt: requestPrompt,
                        imageBase64: task.imageBase64,
                        referenceImages: task.referenceImages || [],
                        abortSignal: abortController.signal
                    });
                } else {
                    result = await API.generateImage({
                        apiKey: route.apiKey,
                        provider: route.provider,
                        apiType: route.apiType,
                        baseUrl: route.baseUrl,
                        model: task.model,
                        prompt: requestPrompt,
                        imageBase64: task.imageBase64,
                        referenceImages: task.referenceImages || [],
                        sizeHint: task.selectionBounds,
                        imageResolution: task.imageResolution,
                        imageSize: imageConfig.imageSize,
                        aspectRatio: 'auto',
                        size: imageConfig.size,
                        abortSignal: abortController.signal
                    });
                }
                
                debugLog('任务 ' + (index + 1) + ' API响应:', result);
                
                if (result.success) {
                    const responseData = result.data;
                    debugLog('任务 ' + (index + 1) + ' 响应数据:', responseData);
                    
                    // 提取图像URL
                    const imageUrl = extractImageFromResponse(responseData);
                    debugLog('任务 ' + (index + 1) + ' 提取到的图像URL:', imageUrl);
                    
                    if (imageUrl) {
                        await downloadAndPlaceDocument(imageUrl, width, height, task.prompt, 'img2img', task.timestamp + ' (任务 ' + (index + 1) + ')', task.model);
                        successCount++;
                    } else {
                        const extractionError = result.error || '无法从响应中提取图像';
                        Config.addLog({
                            timestamp: task.timestamp,
                            model: task.model,
                            prompt: task.prompt,
                            type: 'batch',
                            status: '失败',
                            error: extractionError
                        });
                    }
                } else {
                    const errorMsg = result.error || '未知错误';
                    Config.addLog({
                        timestamp: task.timestamp,
                        model: task.model,
                        prompt: task.prompt,
                        type: 'batch',
                        status: '失败',
                        error: errorMsg
                    });
                }
                
                // 恢复原始状态
                savedSelectionBounds = originalSavedSelectionBounds;
                selectedImageBase64 = originalSelectedImageBase64;
                
            } catch (error) {
                console.error('任务 ' + (index + 1) + ' 出错:', error);
                Config.addLog({
                    timestamp: task.timestamp,
                    model: task.model,
                    prompt: task.prompt,
                    type: 'batch',
                    status: '失败',
                    error: error.message
                });
            } finally {
                completedCount++;
                if (btn) {
                    btn.innerHTML = '<span class="loading"></span>处理中 ' + completedCount + '/' + batchTasks.length + '...';
                }
            }
        });
        
        // 等待所有任务完成
        await Promise.all(tasks);
        
        // 清空批处理任务
        batchTasks = [];
        updateBatchTaskList();
        
        // 如果没有任务了，隐藏批处理标签页
        const batchTab = document.querySelector('.tab[data-tab="batch"]');
        if (batchTab) {
            batchTab.style.display = 'none';
        }
        
        // 恢复按钮状态
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '开始批处理';
        }
        
        showStatus('批处理完成，成功 ' + successCount + ' 个任务', 'success');
        showToast('批处理完成');
    }

    let chatSelectedImageBase64 = null;

    async function chatReadSelection() {
        const isUxp = initCompatibility();
        if (!isUxp) {
            try {
                const upload = await pickBrowserImage('上传对话图片');
                chatSelectedImageBase64 = upload.base64;
                const selectionInfo = document.getElementById('chatSelectionInfo');
                if (selectionInfo) selectionInfo.textContent = '已上传：' + upload.label + (upload.bounds ? ' · ' + upload.bounds.width + ' × ' + upload.bounds.height : '');
                const previewImage = document.getElementById('chatPreviewImage');
                const previewPlaceholder = document.getElementById('chatPreviewPlaceholder');
                if (previewImage) { previewImage.src = upload.base64; previewImage.style.display = 'block'; }
                if (previewPlaceholder) previewPlaceholder.style.display = 'none';
                showStatus('对话图片已上传', 'success');
            } catch (error) {
                if (error && error.message !== '未选择图片') showStatus('上传图片失败：' + error.message, 'error');
            }
            applyBrowserCaptureLabels();
            return;
        }
        if (!psAPI.app || !psAPI.core || !psAPI.imaging) {
            showStatus('UXP模块未加载', 'error');
            return;
        }

        const btn = document.getElementById('btnChatReadSelection');
        btn.disabled = true;
        btn.innerHTML = '<span class="loading"></span>读取中...';
        showStatus('正在读取选区...', 'info');

        try {
            const bounds = await getSelectionBoundsInPixels();
            if (bounds) {
                
                const base64Data = await getImageDataToBase64(bounds);
                
                if (base64Data && base64Data.length > 0) {
                    chatSelectedImageBase64 = 'data:image/png;base64,' + base64Data;
                    
                    const selectionInfo = document.getElementById('chatSelectionInfo');
                    if (selectionInfo) {
                        selectionInfo.textContent = '选区尺寸: ' + Math.round(bounds.width) + ' x ' + Math.round(bounds.height) + ' 像素';
                    }
                    
                    const previewImage = document.getElementById('chatPreviewImage');
                    const previewPlaceholder = document.getElementById('chatPreviewPlaceholder');
                    if (previewImage) {
                        previewImage.src = chatSelectedImageBase64;
                        previewImage.style.display = 'block';
                    }
                    if (previewPlaceholder) {
                        previewPlaceholder.style.display = 'none';
                    }
                    
                    showStatus('选区读取成功', 'success');
                    showToast('选区已读取');
                    await deselectAll();
                }
            } else {
                const selectionInfo = document.getElementById('chatSelectionInfo');
                if (selectionInfo) {
                    selectionInfo.textContent = '未检测到选区';
                }
                showStatus('未检测到选区', 'error');
            }
        } catch (e) {
            debugLog("选区读取失败:", e);
            chatSelectedImageBase64 = null;
            showStatus('选区读取失败：' + e.message, 'error');
        }

        btn.disabled = false;
        btn.innerHTML = '读取选区';
    }

    function chatSendToImg2Img() {
        // 查找最后一条API传回来的消息（role为'assistant'的消息）
        let lastAssistantMessage = '';
        for (let i = chatHistory.length - 1; i >= 0; i--) {
            if (chatHistory[i].role === 'assistant') {
                lastAssistantMessage = chatHistory[i].content;
                break;
            }
        }
        
        if (lastAssistantMessage) {
            document.getElementById('imgPrompt').value = lastAssistantMessage;
        }
        
        if (chatSelectedImageBase64) {
            updatePrimaryImagePreview(chatSelectedImageBase64, savedSelectionBounds, '已从聊天界面导入选区');
        }
        
        switchTab('img2img');
        showToast('已发送到图生图');
    }
    
    async function img2ImgReadSelection() {
        const isUxp = initCompatibility();
        if (!isUxp) {
            try {
                const upload = await pickBrowserImage('上传主图');
                savedSelectionBounds = upload.bounds;
                savedDocumentId = null;
                updatePrimaryImagePreview(upload.base64, upload.bounds, upload.label);
                showStatus('主图已上传', 'success');
            } catch (error) {
                if (error && error.message !== '未选择图片') showStatus('上传主图失败：' + error.message, 'error');
            }
            applyBrowserCaptureLabels();
            return;
        }
        if (!psAPI.app || !psAPI.core || !psAPI.imaging) {
            showStatus('UXP模块未加载', 'error');
            return;
        }

        const btn = document.getElementById('btnImg2ImgReadSelection');
        btn.disabled = true;
        btn.innerHTML = '<span class="loading"></span>读取中...';
        showStatus('正在读取选区...', 'info');

        try {
            const bounds = await getSelectionBoundsInPixels();
            if (bounds) {
                savedSelectionBounds = bounds;
                savedDocumentId = psAPI.app.activeDocument ? psAPI.app.activeDocument.id : null;

                const base64Data = await getImageDataToBase64(bounds);

                if (base64Data && base64Data.length > 0) {
                    updatePrimaryImagePreview('data:image/png;base64,' + base64Data, bounds);

                    showStatus('选区读取成功', 'success');
                    showToast('选区已读取');
                    await deselectAll();
                }
            } else {
                savedSelectionBounds = null;
                savedDocumentId = null;
                selectedImageBase64 = null;
                clearPrimaryImagePreview('未检测到选区 - 图像将创建为新文档');
                showStatus('未检测到选区', 'error');
            }
        } catch (e) {
            debugLog("选区读取失败:", e);
            savedSelectionBounds = null;
            selectedImageBase64 = null;
            clearPrimaryImagePreview('选区读取失败');
            showStatus('选区读取失败：' + e.message, 'error');
        }

        btn.disabled = false;
        btn.innerHTML = '读取选区';
    }

    function normalizeReferenceImageData(image) {
        if (!image) return '';
        let raw = image;
        if (typeof image === 'object') {
            raw = image.base64 || image.dataUrl || image.dataURL || image.url || image.image || image.base64Data || '';
        }
        const value = String(raw || '').trim().replace(/\s+/g, '');
        if (!value) return '';
        if (/^data:image\//i.test(value)) return value;
        // xAI / grok2api / Sub2API 的参考图字段都同时接受公网 URL 和 base64 data URI。
        // 这里原本会把 http(s) 地址当成裸 base64 包成 data:image/png;base64,https://...
        // 变成一段无效数据，所以直接原样透传。
        if (/^https?:\/\//i.test(value)) return value;
        const stripped = value.replace(/^data:[^,]+,/, '');
        return 'data:image/png;base64,' + stripped;
    }

    function normalizeReferenceImageList(images) {
        return (Array.isArray(images) ? images : [])
            .map(function(item, index) {
                const base64 = normalizeReferenceImageData(item);
                if (!base64) return null;
                const bounds = item && typeof item === 'object' && item.bounds ? item.bounds : null;
                return {
                    base64: base64,
                    label: '图' + (index + 2),
                    bounds: bounds
                };
            })
            .filter(Boolean)
            .slice(0, MAX_REFERENCE_IMAGES);
    }

    function getActiveReferenceImageData() {
        return getActiveReferenceImagesForRequest();
    }

    function renderReferenceImages() {
        const countEl = document.getElementById('referenceImageCount');
        const slotsEl = document.getElementById('referenceImageSlots');
        const mirrorCountEl = document.getElementById('vfxReferenceImageCount');
        const mirrorSlotsEl = document.getElementById('vfxReferenceImageSlots');
        const normalizedRefs = normalizeReferenceImageList(referenceImages);
        referenceImages = normalizedRefs;
        if (countEl) {
            countEl.textContent = String(referenceImages.length);
        }
        if (mirrorCountEl) {
            mirrorCountEl.textContent = String(referenceImages.length);
        }
        if (!slotsEl && !mirrorSlotsEl) return;

        [slotsEl, mirrorSlotsEl].filter(Boolean).forEach(function(container) {
            container.innerHTML = '';
            referenceImages.forEach(function(ref, index) {
                const slot = document.createElement('div');
                slot.className = 'reference-slot';

                const img = document.createElement('img');
                const src = normalizeReferenceImageData(ref);
                img.src = src;
                img.alt = ref.label || ('图' + (index + 2));
                img.title = '点击重新抓取当前选区';
                img.onerror = function() {
                    slot.className = 'reference-slot empty';
                    slot.textContent = '预览失败';
                };
                img.onclick = function(event) {
                    event.stopPropagation();
                    recaptureReferenceImage(index);
                };
                slot.appendChild(img);

                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'reference-slot-delete';
                del.textContent = '×';
                del.title = '删除参考图';
                del.onclick = function(event) {
                    event.stopPropagation();
                    removeReferenceImage(index);
                };
                slot.appendChild(del);

                container.appendChild(slot);
            });

            for (let i = referenceImages.length; i < MAX_REFERENCE_IMAGES; i++) {
                const placeholder = document.createElement('div');
                placeholder.className = 'reference-slot empty';
                placeholder.textContent = '图' + (i + 2);
                container.appendChild(placeholder);
            }
        });
    }

    function renderRunninghubAppList() {
        const list = document.getElementById('runninghubAppList');
        if (!list) return;
        const query = String(runninghubAppSearchQuery || '').trim().toLowerCase();
        const filteredApps = runninghubApps.filter(function(app) {
            if (!query) return true;
            return [app.name, app.description, app.appId, app.id].some(function(value) {
                return String(value || '').toLowerCase().indexOf(query) > -1;
            });
        });
        const toolbar = '<div class="settings-card field-stack">'
            + '<label for="runninghubAppSearch">搜索已导入应用</label>'
            + '<input type="text" id="runninghubAppSearch" placeholder="按应用名或 appId 搜索" value="' + escapeHTML(runninghubAppSearchQuery) + '">'
            + '<div class="info-text">共 ' + runninghubApps.length + ' 个应用，当前显示 ' + filteredApps.length + ' 个。</div>'
            + '</div>';
        if (!runninghubApps.length) {
            list.innerHTML = toolbar + '<div class="info-text">暂无导入应用</div>';
            return;
        }
        if (!filteredApps.length) {
            list.innerHTML = toolbar + '<div class="info-text">没有匹配的应用</div>';
            return;
        }
        list.innerHTML = toolbar + filteredApps.map(function(app) {
            const appIdValue = String(app.appId || app.id || '');
            const appId = escapeHTML(shortRunninghubId(appIdValue));
            const rawAppId = escapeHTML(appIdValue || '--');
            const statusText = app.enabled === false ? '已停用' : '已启用';
            const toggleText = app.enabled === false ? '启用' : '停用';
            const fieldCount = Array.isArray(app.inputs) ? app.inputs.length : 0;
            return ''
                + '<div class="settings-card field-stack">'
                + '<div class="btn-row">'
                + '<div><div class="card-title" style="margin:0 0 4px;">' + escapeHTML(app.name || 'RunningHub 应用') + '</div><div class="info-text">ID：' + appId + ' · ' + escapeHTML(statusText) + ' · 参数：' + fieldCount + ' 个</div><div class="info-text">原始 ID：' + rawAppId + '</div></div>'
                + '<div class="btn-row">'
                + '<button class="btn btn-secondary" type="button" data-runninghub-toggle="' + escapeHTML(appIdValue) + '" data-runninghub-enabled="' + (app.enabled === false ? '0' : '1') + '">' + toggleText + '</button>'
                + '<button class="btn btn-secondary" type="button" data-runninghub-remove="' + escapeHTML(appIdValue) + '">删除</button>'
                + '</div>'
                + '</div>'
                + (app.description ? '<div class="info-text">' + escapeHTML(app.description) + '</div>' : '')
                + '</div>';
        }).join('');
    }

    function getBuiltInAppCategories() {
        return [
            {
                id: 'kao-vfx',
                icon: 'VFX',
                title: 'VFX 特效（尻粒子）',
                desc: '粒子类型、11 项特效与物理光学参数的独立 VFX。',
                editorType: 'kao-vfx-ui'
            }
        ];
    }

    function getRunninghubAppCards() {
        return runninghubApps.filter(function(app) {
            return app && app.enabled !== false;
        }).map(function(app) {
            return {
                id: app.appId || app.webappId || app.webAppId || app.id,
                icon: 'RH',
                title: app.name || 'RunningHub 应用',
                desc: app.description || '导入的 RunningHub 应用',
                editorType: 'runninghub',
                source: 'runninghub',
                appId: app.appId || app.webappId || app.webAppId || app.id || '',
                webappId: app.webappId || app.webAppId || app.appId || app.id || '',
                inputs: Array.isArray(app.inputs) ? app.inputs.map(coerceRunninghubFieldForEditor) : []
            };
        });
    }

    // 界面图标统一用单色内联 SVG，不用 emoji。
    // emoji 是彩色字形，和侧边栏的单色图标体系不一致，且不同系统渲染差异大。
    // 一律 fill="currentColor"，颜色跟随按钮文字色。
    const UI_ICONS = {
        // 图像 / 加载图片
        image: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2zm7.2 2.6a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7zM3.3 12.2h9.4L9.5 7.3 7.2 10.1 5.7 8.3z"/></svg>',
        // 开始 / 生成
        play: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4.6 2.7 13 8l-8.4 5.3z"/></svg>',
        // 自动识别（闪电）
        bolt: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9.4 1.4 3 9.1h4.1L6.6 14.6 13 6.9H8.9z"/></svg>',
        // 随机（骰子）
        dice: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2zm1.8 2.1a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm5.4 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM8 6.9a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm-2.7 4.8a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm5.4 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z"/></svg>',
        // 特效（四角星）
        sparkle: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6.2 1.6 7.5 5.4l3.8 1.3-3.8 1.3-1.3 3.8-1.3-3.8L1.1 6.7l3.8-1.3zM11.9 9.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>',
        // 抓取 / 下载
        download: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7.1 1.6h1.8v5h2.3L8 10.3 4.8 6.6h2.3z"/><path fill="currentColor" d="M2.6 10.9h10.8a.9.9 0 0 1 .9.9v1.6a.9.9 0 0 1-.9.9H2.6a.9.9 0 0 1-.9-.9v-1.6a.9.9 0 0 1 .9-.9zm9 1.1a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z"/></svg>'
    };

    // 生成带图标的按钮内容。图标与文字之间用 margin 留白（UXP 对 flex gap 支持不稳）。
    function uiIconLabel(iconName, text) {
        const icon = UI_ICONS[iconName] || '';
        return '<span class="ui-icon-label">' + icon + '<span>' + escapeHTML(text) + '</span></span>';
    }

    function getReferenceUiAppCards() {
        return [
            {
                id: 'camera-ui',
                title: '3D 镜头控制',
                desc: '镜头角度、距离与 AI 重构界面。',
                editorType: 'camera-ui',
                source: 'reference-ui'
            },
            {
                id: 'hemisynth-ui',
                title: '半合成',
                desc: '现场布景化、手办地台、垂悬环绕物。',
                editorType: 'hemisynth-ui',
                source: 'reference-ui'
            }
        ];
    }



    function refreshRunninghubAccountSummary() {
        const info = document.getElementById('accountSummaryInfo');
        const appCount = Array.isArray(runninghubApps) ? runninghubApps.length : 0;
        const enabledCount = (Array.isArray(runninghubApps) ? runninghubApps : []).filter(function(app) {
            return app && app.enabled !== false;
        }).length;
        const apiConfigured = !!getRunninghubApiKey();
        if (!info) return;
        info.innerHTML = 'RunningHub API：' + (apiConfigured ? '已配置' : '未配置')
            + '<br>已导入应用：' + appCount + ' 个'
            + '<br>启用应用：' + enabledCount + ' 个'
            + '<br>AI 优化应用 ID：' + escapeHTML(String((currentSettings && currentSettings.advancedAiOptimizeAppId) || DEFAULT_AI_OPTIMIZE_APP_ID));
    }

    function openAppsCard(categoryId) {
        categoryId = String(categoryId || '').trim();
        if (!categoryId) return;
        if (categoryId === 'vfx') {
            openAppCategory('vfx');
            return;
        }
        const target = getBuiltInAppCategories().concat(getReferenceUiAppCards(), getRunninghubAppCards()).find(function(card) {
            return String(card.id || '') === categoryId;
        });
        if (target) {
            const runninghubTab = document.querySelector('.tab[data-tab="runninghub"]');
            appsReturnTab = target.source === 'runninghub' || (runninghubTab && runninghubTab.classList.contains('active')) ? 'runninghub' : 'apps';
            const genericEditor = document.getElementById('appEditor');
            const targetHost = document.getElementById(appsReturnTab);
            if (genericEditor && targetHost) targetHost.appendChild(genericEditor);
            const backButton = document.getElementById('btnBackToGenericAppHome');
            if (backButton) backButton.textContent = appsReturnTab === 'runninghub' ? '返回应用' : '返回快速';
            switchTab(appsReturnTab);
            openAppCategory(categoryId, target);
            return;
        }
        showStatus('未找到应用：' + categoryId, 'error');
    }

    function renderAppsHome() {
        const home = document.getElementById('appsHome');
        if (!home) return;
        const builtInCards = getBuiltInAppCategories();
        const referenceCards = getReferenceUiAppCards();
        const cards = builtInCards.concat(referenceCards);
        const appCountCard = '<div class="module-card field-stack">'
            + '<div class="card-title">快速功能</div>'
            + '<div class="info-text">内置功能：' + cards.length + ' 个。3D 镜头与半合成固定显示；RunningHub 已独立到“应用”页面。</div>'
            + '</div>';
        home.innerHTML = appCountCard + cards.map(function(card) {
            return '<div class="module-card field-stack app-launch-wrap" data-app-category="' + escapeHTML(card.id) + '"><button class="app-launch-card" type="button" data-app-category="' + escapeHTML(card.id) + '"><div class="app-launch-content"><div class="app-launch-title">' + escapeHTML(card.title) + '</div><div class="app-launch-desc">' + escapeHTML(card.desc || '进入参数页') + '</div></div></button></div>';
        }).join('');
        home.querySelectorAll('[data-app-category]').forEach(function(trigger) {
            trigger.onclick = function(event) {
                event.preventDefault();
                event.stopPropagation();
                openAppsCard(trigger.getAttribute('data-app-category'));
            };
        });
        renderRunninghubHome();
    }

    function renderRunninghubHome() {
        const home = document.getElementById('runninghubHome');
        if (!home) return;
        const referenceCards = getReferenceUiAppCards();
        const runninghubCards = getRunninghubAppCards();
        const cards = referenceCards.concat(runninghubCards);
        const summary = '<div class="module-card field-stack">'
            + '<div class="card-title">小应用</div>'
            + '<div class="info-text">内置界面：' + referenceCards.length + ' 个 · RunningHub 已启用：' + runninghubCards.length + ' 个</div>'
            + '<div class="info-text">新增、停用或删除应用请前往设置页的 RunningHub 分组。</div>'
            + '</div>';
        const empty = '<div class="module-card"><div class="info-text empty-state">暂无已启用的 RunningHub 应用</div></div>';
        home.innerHTML = summary + (cards.length ? cards.map(function(card) {
            return '<div class="module-card field-stack app-launch-wrap" data-app-category="' + escapeHTML(card.id) + '"><button class="app-launch-card" type="button" data-app-category="' + escapeHTML(card.id) + '"><div class="app-launch-content"><div class="app-launch-title">' + escapeHTML(card.title) + '</div><div class="app-launch-desc">' + escapeHTML(card.desc || '进入参数页') + '</div></div></button></div>';
        }).join('') : empty);
        home.querySelectorAll('[data-app-category]').forEach(function(trigger) {
            trigger.onclick = function(event) {
                event.preventDefault();
                event.stopPropagation();
                openAppsCard(trigger.getAttribute('data-app-category'));
            };
        });
    }

    function shortRunninghubId(id) {
        const value = String(id || '').trim();
        if (!value) return '--';
        if (value.length <= 10) return value;
        return value.slice(0, 4) + '...' + value.slice(-4);
    }

    function normalizeRunninghubAppId(rawValue) {
        const text = String(rawValue || '').trim();
        if (!text) return '';
        if (!/[/?#]/.test(text) && text.indexOf('runninghub.cn') === -1) return text;
        let decoded = text;
        try {
            decoded = decodeURIComponent(text);
        } catch (error) {}
        try {
            const url = new URL(decoded);
            const queryKeys = ['webappId', 'webappid', 'appId', 'appid', 'workflowId', 'workflowid', 'id', 'code'];
            for (let i = 0; i < queryKeys.length; i++) {
                const value = url.searchParams.get(queryKeys[i]);
                if (value && value.trim()) return value.trim();
            }
            const segments = url.pathname.split('/').filter(Boolean);
            if (segments.length > 0) {
                for (let index = 0; index < segments.length; index += 1) {
                    const segment = segments[index].toLowerCase();
                    if (['app', 'workflow', 'community', 'detail'].indexOf(segment) > -1 && segments[index + 1]) {
                        return segments[index + 1].trim();
                    }
                }
                return segments[segments.length - 1].trim();
            }
        } catch (error) {}
        const numeric = decoded.match(/\d{5,}/);
        return numeric ? numeric[0] : text;
    }

    function getRunninghubApiKey() {
        const input = document.getElementById('runninghubApiKey');
        return normalizeApiKey(input ? input.value : (currentSettings && currentSettings.runninghubApiKey) || '');
    }

    function updateRunninghubParsedAppInfo() {
        const info = document.getElementById('runninghubParsedAppInfo');
        const saveBtn = document.getElementById('btnSaveRunninghubParsedApp');
        if (saveBtn) {
            saveBtn.disabled = !pendingRunninghubParsedApp;
        }
        if (!info) return;
        if (!pendingRunninghubParsedApp) {
            const currentText = String(info.textContent || '').trim();
            if (!currentText || currentText === '正在解析应用...' || currentText === '未解析应用') {
                info.textContent = '未解析应用';
            }
            return;
        }
        const fieldCount = Array.isArray(pendingRunninghubParsedApp.inputs) ? pendingRunninghubParsedApp.inputs.length : 0;
        info.innerHTML = '<strong>' + escapeHTML(pendingRunninghubParsedApp.name || 'RunningHub 应用') + '</strong>'
            + '<br>ID：' + escapeHTML(shortRunninghubId(pendingRunninghubParsedApp.appId))
            + ' · 参数：' + fieldCount + ' 个';
    }

    function normalizeRunninghubFieldType(type) {
        const value = String(type || 'text').trim().toLowerCase();
        if (['text', 'textarea', 'number', 'select', 'boolean', 'image'].indexOf(value) > -1) {
            return value;
        }
        return 'text';
    }

    function normalizeRunninghubField(field) {
        const key = String(field && (field.key || field.id || field.fieldName || field.name) || '').trim();
        if (!key) {
            throw new Error('存在缺少 key 的 inputs 项');
        }
        const type = normalizeRunninghubFieldType(field.type || field.fieldType || field.componentType);
        const normalized = {
            key: key,
            label: String(field.label || field.title || field.name || key).trim(),
            type: type,
            required: !!field.required,
            placeholder: String(field.placeholder || field.defaultPlaceholder || '').trim(),
            description: String(field.description || field.desc || field.helpText || '').trim(),
            nodeId: field.nodeId != null ? String(field.nodeId) : '',
            fieldName: String(field.fieldName || field.name || key).trim(),
            fieldType: String(field.fieldType || field.type || '').trim(),
            fieldData: field.fieldData != null ? field.fieldData : null,
            defaultValue: field.defaultValue != null ? field.defaultValue : (field.value != null ? field.value : '')
        };
        if (type === 'select') {
            const rawOptions = Array.isArray(field.options) ? field.options : (Array.isArray(field.enumOptions) ? field.enumOptions : []);
            normalized.options = rawOptions.map(function(option) {
                if (typeof option === 'string' || typeof option === 'number') {
                    return { value: String(option), label: String(option) };
                }
                const value = String(option && (option.value != null ? option.value : option.label) || '').trim();
                const label = String(option && (option.label || option.name || option.value) || '').trim();
                return value ? { value: value, label: label || value } : null;
            }).filter(Boolean);
            if (!normalized.options.length) {
                throw new Error('select 类型参数缺少 options');
            }
        }
        return normalized;
    }

    function validateRunninghubAppConfig(config) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            throw new Error('RunningHub 应用配置必须是 JSON 对象');
        }
        const name = String(config.name || '').trim();
        if (!name) {
            throw new Error('应用名称不能为空');
        }
        const appId = String(config.appId || config.webappId || '').trim();
        if (!appId) {
            throw new Error('appId 或 webappId 不能为空');
        }
        if (!Array.isArray(config.inputs) || !config.inputs.length) {
            throw new Error('inputs 不能为空');
        }
    }

    function normalizeRunninghubAppConfig(config) {
        validateRunninghubAppConfig(config);
        const appId = normalizeRunninghubAppId(config.appId || config.webappId || config.webAppId || config.workflowId || config.id || '');
        if (!appId) {
            throw new Error('appId 或 webappId 不能为空');
        }
        return {
            id: appId,
            appId: appId,
            webappId: appId,
            name: String(config.name || '').trim(),
            description: String(config.description || '').trim(),
            enabled: config.enabled !== false,
            source: 'runninghub',
            createdAt: config.createdAt || Date.now(),
            updatedAt: Date.now(),
            inputs: config.inputs.map(normalizeRunninghubField)
        };
    }

    function coerceRunninghubFieldForEditor(field) {
        if (!field || typeof field !== 'object') return field;
        const hint = [field.key, field.paramKey, field.fieldName, field.field, field.name, field.label, field.title, field.description, field.placeholder]
            .map(function(item) { return String(item || '').trim().toLowerCase(); })
            .filter(Boolean)
            .join(' ');
        if (field.type !== 'image' && /image|img|file|upload|图像|图片|照片|参考图|选区/.test(hint)) {
            return Object.assign({}, field, { type: 'image', required: !!field.required });
        }
        return field;
    }

    function normalizeRunninghubAppMetaForRuntime(meta) {
        meta = meta || {};
        const appId = extractRunninghubWebappId(meta);
        const normalized = Object.assign({}, meta);
        if (appId) {
            normalized.id = appId;
            normalized.appId = appId;
            normalized.webappId = appId;
        }
        normalized.inputs = (Array.isArray(meta.inputs) ? meta.inputs : []).map(coerceRunninghubFieldForEditor);
        return normalized;
    }

    function extractRunninghubValue(value, depth) {
        if (depth > 6 || value == null) return null;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                const found = extractRunninghubValue(value[i], depth + 1);
                if (found != null) return found;
            }
            return null;
        }
        if (typeof value === 'object') {
            const keys = ['value', 'defaultValue', 'default', 'content', 'text', 'label'];
            for (let i = 0; i < keys.length; i++) {
                if (value[keys[i]] != null && typeof value[keys[i]] !== 'object') {
                    return value[keys[i]];
                }
            }
        }
        return null;
    }

    function isPromptLikeRunninghubText(text) {
        return /prompt|提示词|negative|正向|负向/i.test(String(text || ''));
    }

    function isWeakRunninghubLabel(label) {
        var text = String(label || '').trim().toLowerCase();
        if (!text) return true;
        return ['value', 'text', 'string', 'number', 'int', 'float', 'double', 'bool', 'boolean'].indexOf(text) > -1;
    }

    function parseRunninghubExplicitRequired(value) {
        if (value === undefined) return null;
        if (value === null) return false;
        if (value === true || value === false) return value;
        if (typeof value === 'number') return value !== 0;
        var marker = String(value || '').trim().toLowerCase();
        if (!marker) return false;
        if (['true', '1', 'yes', 'y', 'on', 'required', '是'].indexOf(marker) > -1) return true;
        if (['false', '0', 'no', 'n', 'off', 'optional', '否'].indexOf(marker) > -1) return false;
        return !!marker;
    }

    function resolveRunninghubRequiredSpec(raw, type) {
        var keys = ['required', 'isRequired', 'must', 'need', 'needRequired', 'mandatory'];
        for (var i = 0; i < keys.length; i++) {
            if (!Object.prototype.hasOwnProperty.call(raw || {}, keys[i])) continue;
            var parsed = parseRunninghubExplicitRequired(raw[keys[i]]);
            if (parsed !== null) return { required: parsed, explicit: true };
        }
        if (type === 'image') return { required: false, explicit: false };
        return { required: true, explicit: false };
    }

    function normalizeRunninghubFieldToken(value) {
        return String(value || '').trim().toLowerCase().replace(/[^a-z0-9一-龥]+/g, '');
    }

    function normalizeRunninghubOptionText(value) {
        if (value === undefined || value === null) return '';
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return String(value).trim();
        }
        if (typeof value !== 'object' || Array.isArray(value)) return '';
        var keys = ['value', 'optionValue', 'enumValue', 'id', 'key', 'code', 'index', 'fastIndex', 'name', 'label', 'text', 'title'];
        for (var i = 0; i < keys.length; i++) {
            if (value[keys[i]] != null) {
                var text = String(value[keys[i]]).trim();
                if (text) return text;
            }
        }
        return '';
    }

    function isRunninghubTypeMarkerOption(value) {
        var text = String(value || '').trim().toLowerCase();
        return ['string', 'text', 'number', 'int', 'float', 'double', 'boolean', 'bool', 'image', 'file'].indexOf(text) > -1;
    }

    function extractRunninghubOptionEntries(raw, depth) {
        depth = depth || 0;
        if (depth > 8 || raw === undefined || raw === null) return [];
        if (typeof raw === 'string') {
            var text = raw.trim();
            if (!text) return [];
            var parsed = parseJsonFromEscapedText(text);
            if (parsed !== null && parsed !== undefined) {
                return extractRunninghubOptionEntries(parsed, depth + 1);
            }
            if (text.indexOf('|') > -1 || text.indexOf(',') > -1 || text.indexOf('\n') > -1) {
                return text.split(/[|,\r\n]+/).map(function(item) {
                    var value = item.trim();
                    return value ? { value: value, label: value } : null;
                }).filter(Boolean);
            }
            return [{ value: text, label: text }];
        }
        if (typeof raw === 'number' || typeof raw === 'boolean') {
            return [{ value: raw, label: String(raw) }];
        }
        if (Array.isArray(raw)) {
            return raw.reduce(function(bucket, item) {
                return bucket.concat(extractRunninghubOptionEntries(item, depth + 1));
            }, []);
        }
        if (typeof raw !== 'object') return [];
        var containerKeys = ['options', 'enums', 'values', 'items', 'list', 'data', 'children', 'selectOptions', 'optionList', 'fieldOptions'];
        var valueKeys = ['value', 'optionValue', 'enumValue', 'id', 'key', 'code', 'index', 'fastIndex', 'name', 'label', 'title', 'text'];
        var labelKeys = ['label', 'title', 'text', 'description', 'descriptionCn', 'descriptionEn', 'name', 'value', 'index', 'id', 'key'];
        var collected = [];
        var hasContainer = false;
        containerKeys.forEach(function(key) {
            if (raw[key] === undefined) return;
            hasContainer = true;
            collected = collected.concat(extractRunninghubOptionEntries(raw[key], depth + 1));
        });
        var nextValue = valueKeys.map(function(key) { return raw[key]; }).find(function(item) {
            return item !== undefined && item !== null && String(item).trim() !== '';
        });
        var nextLabel = labelKeys.map(function(key) { return raw[key]; }).find(function(item) {
            return item !== undefined && item !== null && String(item).trim() !== '';
        });
        if (nextValue !== undefined || nextLabel !== undefined) {
            collected.push({
                value: nextValue !== undefined ? nextValue : nextLabel,
                label: String(nextLabel !== undefined ? nextLabel : nextValue)
            });
        }
        if (!hasContainer) {
            Object.keys(raw).forEach(function(key) {
                var value = raw[key];
                if (!value || typeof value !== 'object') return;
                collected = collected.concat(extractRunninghubOptionEntries(value, depth + 1));
            });
        }
        var seen = new Set();
        return collected.filter(function(item) {
            var value = normalizeRunninghubOptionText(item && item.value);
            if (!value) return false;
            var marker = value.toLowerCase();
            if (seen.has(marker)) return false;
            seen.add(marker);
            item.value = value;
            item.label = normalizeRunninghubOptionText(item.label) || value;
            return true;
        });
    }

    function parseRunninghubBooleanLike(value) {
        if (value === true || value === false) return value;
        var marker = String(value == null ? '' : value).trim().toLowerCase();
        if (!marker) return null;
        if (['true', '1', 'yes', 'y', 'on', '是'].indexOf(marker) > -1) return true;
        if (['false', '0', 'no', 'n', 'off', '否'].indexOf(marker) > -1) return false;
        return null;
    }

    function inferRunninghubFieldType(rawType) {
        var marker = String(rawType || '').toLowerCase();
        if (marker.indexOf('image') > -1 || marker.indexOf('file') > -1 || marker.indexOf('img') > -1) return 'image';
        if (marker.indexOf('number') > -1 || marker.indexOf('int') > -1 || marker.indexOf('float') > -1 || marker.indexOf('slider') > -1) return 'number';
        if (marker === 'list') return 'select';
        if (marker.indexOf('select') > -1 || marker.indexOf('enum') > -1 || marker.indexOf('option') > -1) return 'select';
        if (marker.indexOf('bool') > -1 || marker.indexOf('checkbox') > -1 || marker.indexOf('toggle') > -1) return 'boolean';
        if (marker.indexOf('switch') > -1) return 'select';
        return 'text';
    }

    function resolveRunninghubInputType(input) {
        var rawType = inferRunninghubFieldType(input && (input.type || input.fieldType));
        var keyText = [input && input.key, input && input.paramKey, input && input.fieldName, input && input.field, input && input.name, input && input.label, input && input.title, input && input.description]
            .map(function(item) { return String(item || '').trim().toLowerCase(); })
            .filter(Boolean)
            .join(' ');
        if (/image|img|file|upload|图像|图片|照片|参考图|选区/.test(keyText)) return 'image';
        var entries = extractRunninghubOptionEntries(input && input.options);
        var optionValues = entries.map(function(entry) { return entry.value; });
        var optionBooleans = optionValues.length > 0 && optionValues.every(function(item) { return parseRunninghubBooleanLike(item) !== null; });
        var optionNumbers = optionValues.length > 0 && optionValues.every(function(item) { return /^-?\d+(?:\.\d+)?$/.test(String(item)); });
        var defaultValue = input && input.default;
        var defaultBoolean = parseRunninghubBooleanLike(defaultValue) !== null;
        var defaultNumber = defaultValue !== undefined && defaultValue !== null && /^-?\d+(?:\.\d+)?$/.test(String(defaultValue).trim());
        var fieldType = String(input && input.fieldType || '');
        var numericHint = /(?:^|[^a-z])(int|integer|float|double|decimal|number)(?:[^a-z]|$)/i.test(fieldType);
        var booleanHint = /(?:^|[^a-z])(bool|boolean|checkbox|toggle|switch)(?:[^a-z]|$)/i.test(fieldType);
        if (rawType === 'image' || rawType === 'number') return rawType;
        if (rawType === 'select') {
            if (optionBooleans) return 'boolean';
            if (entries.length > 0) return 'select';
            if (defaultBoolean && booleanHint) return 'boolean';
            if (defaultNumber && numericHint) return 'number';
            return 'text';
        }
        if (rawType === 'boolean') {
            if (optionNumbers) return 'number';
            if (optionBooleans || defaultBoolean || booleanHint) return 'boolean';
            return 'boolean';
        }
        if (rawType === 'text' && entries.length > 1) {
            if (optionBooleans) return 'boolean';
            return 'select';
        }
        if (rawType === 'text' && numericHint) return 'number';
        if (rawType === 'text' && (optionBooleans || (booleanHint && defaultBoolean))) return 'boolean';
        return rawType;
    }

    function resolveRunninghubDisplayLabel(args) {
        args = args || {};
        var key = args.key;
        var fieldName = args.fieldName;
        var rawLabel = args.rawLabel;
        var rawName = args.rawName;
        var preferred = String(rawLabel || rawName || '').trim();
        if (preferred && !isWeakRunninghubLabel(preferred)) {
            return { label: preferred, source: 'raw', confidence: 1 };
        }
        var labelMap = {
            aspectratio: '比例',
            resolution: '分辨率',
            channel: '通道',
            prompt: '提示词',
            negativeprompt: '反向提示词',
            seed: '随机种子',
            steps: '步数',
            cfg: 'CFG',
            cfgscale: 'CFG 强度',
            sampler: '采样器',
            scheduler: '调度器',
            width: '宽度',
            height: '高度',
            model: '模型',
            style: '风格',
            strength: '强度',
            denoise: '降噪强度'
        };
        var candidates = [fieldName, key, key && String(key).indexOf(':') > -1 ? String(key).split(':').pop() : ''];
        for (var i = 0; i < candidates.length; i++) {
            var mapped = labelMap[normalizeRunninghubFieldToken(candidates[i])];
            if (mapped) return { label: mapped, source: 'map', confidence: 0.6 };
        }
        var fallback = preferred || String(fieldName || key || '').trim();
        return { label: fallback, source: 'fallback', confidence: 0.4 };
    }

    function resolveRunninghubFieldDataLabel(fieldData) {
        if (!fieldData) return '';
        var parsed = fieldData;
        if (typeof fieldData === 'string') parsed = parseJsonFromEscapedText(fieldData);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
        if (Array.isArray(parsed.options) || Array.isArray(parsed.items) || Array.isArray(parsed.values)) return '';
        return String(parsed.label || parsed.name || parsed.title || parsed.description || '').trim();
    }

    function isLikelyRunninghubInputRecord(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        var key = String(item.key || item.paramKey || item.fieldName || item.name || '').trim();
        if (key) return true;
        if ((item.nodeId != null || item.nodeID != null) && String(item.fieldName || item.field || '').trim()) return true;
        if (item.fieldData != null && String(item.fieldName || item.key || item.paramKey || '').trim()) return true;
        if (item.default != null || item.fieldValue != null) {
            if (String(item.name || item.label || item.fieldName || item.key || '').trim()) return true;
        }
        return !!String(item.type || item.fieldType || item.inputType || item.widget || item.valueType || '').trim();
    }

    function parseJsonFromEscapedText(text) {
        var raw = String(text || '').trim();
        if (!raw) return null;
        var attempts = [raw];
        if ((raw[0] === '"' && raw[raw.length - 1] === '"') || (raw[0] === "'" && raw[raw.length - 1] === "'")) {
            attempts.push(raw.slice(1, -1));
        }
        attempts.push(raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
        for (var i = 0; i < attempts.length; i++) {
            var candidate = String(attempts[i] || '').trim();
            if (!candidate) continue;
            try {
                return JSON.parse(candidate);
            } catch (error) {}
            try {
                var start = candidate.search(/[\[{]/);
                var end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
                if (start >= 0 && end > start) {
                    return JSON.parse(candidate.slice(start, end + 1));
                }
            } catch (error) {}
        }
        return null;
    }

    function collectRunninghubSourceCandidates(value, depth, seen) {
        depth = depth || 0;
        seen = seen || new Set();
        if (depth > 6 || value == null) return [];
        var out = [];
        function walk(current, currentDepth) {
            if (currentDepth > 6 || current == null) return;
            if (typeof current === 'string') {
                var parsed = parseJsonFromEscapedText(current);
                if (parsed && parsed !== current) {
                    walk(parsed, currentDepth + 1);
                }
                return;
            }
            if (typeof current !== 'object') return;
            var marker = '';
            if (Array.isArray(current)) {
                marker = 'arr:' + current.length + ':' + (current[0] && typeof current[0] === 'object' ? Object.keys(current[0]).sort().slice(0, 6).join('|') : typeof current[0]);
            } else {
                marker = 'obj:' + Object.keys(current).sort().slice(0, 12).join('|');
            }
            if (seen.has(marker)) return;
            seen.add(marker);
            out.push(current);
            var likelyKeys = ['data', 'result', 'payload', 'content', 'body', 'value', 'appInfo', 'webappInfo', 'workflow', 'nodeInfoList', 'inputs', 'params'];
            if (Array.isArray(current)) {
                current.slice(0, 20).forEach(function(item) {
                    walk(item, currentDepth + 1);
                });
                return;
            }
            likelyKeys.forEach(function(key) {
                if (current[key] != null) {
                    walk(current[key], currentDepth + 1);
                }
            });
        }
        walk(value, depth);
        return out;
    }

    function toRunninghubInputListFromUnknown(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        var list = Object.keys(value).map(function(key) { return value[key]; }).filter(isLikelyRunninghubInputRecord);
        return list.length ? list : [];
    }

    function getRunninghubNodeBindingCount(list) {
        return (Array.isArray(list) ? list : []).filter(function(item) {
            return item && (item.nodeId != null || item.nodeID != null) && String(item.fieldName || item.field || '').trim();
        }).length;
    }

    function collectRunninghubInputCandidates(source, depth, path, out) {
        depth = depth || 0;
        path = path || 'root';
        out = out || [];
        if (depth > 8 || source == null) return out;
        if (typeof source === 'string') {
            var parsed = parseJsonFromEscapedText(source);
            if (parsed && parsed !== source) {
                collectRunninghubInputCandidates(parsed, depth + 1, path + '.json', out);
            }
            return out;
        }
        if (Array.isArray(source)) {
            var inputLikeCount = source.filter(isLikelyRunninghubInputRecord).length;
            if (source.length && inputLikeCount) {
                out.push({
                    path: path,
                    list: source,
                    inputLikeCount: inputLikeCount,
                    nodeBindingCount: getRunninghubNodeBindingCount(source)
                });
            }
            source.forEach(function(item, index) {
                collectRunninghubInputCandidates(item, depth + 1, path + '[' + index + ']', out);
            });
            return out;
        }
        if (typeof source !== 'object') return out;
        var mappedList = toRunninghubInputListFromUnknown(source);
        if (mappedList.length) {
            out.push({
                path: path + '.$values',
                list: mappedList,
                inputLikeCount: mappedList.length,
                nodeBindingCount: getRunninghubNodeBindingCount(mappedList)
            });
        }
        Object.keys(source).forEach(function(key) {
            collectRunninghubInputCandidates(source[key], depth + 1, path + '.' + key, out);
        });
        return out;
    }

    function dedupeRunninghubInputCandidates(candidates) {
        var seen = new Set();
        return (Array.isArray(candidates) ? candidates : []).filter(function(candidate) {
            if (!candidate || !Array.isArray(candidate.list) || !candidate.list.length) return false;
            var key = candidate.path + '|' + candidate.list.length + '|' + (candidate.inputLikeCount || 0);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).sort(function(a, b) {
            if ((b.nodeBindingCount || 0) !== (a.nodeBindingCount || 0)) {
                return (b.nodeBindingCount || 0) - (a.nodeBindingCount || 0);
            }
            if ((b.inputLikeCount || 0) !== (a.inputLikeCount || 0)) {
                return (b.inputLikeCount || 0) - (a.inputLikeCount || 0);
            }
            return (b.list.length || 0) - (a.list.length || 0);
        });
    }

    function collectRunninghubAppNameCandidates(value, depth, bucket, seen, parentKey) {
        depth = depth || 0;
        bucket = bucket || [];
        seen = seen || new Set();
        parentKey = String(parentKey || '').toLowerCase();
        if (depth > 8 || value == null) return bucket;
        var scoreMap = {
            webappname: 50,
            appname: 46,
            workflowname: 44,
            displayname: 42,
            title: 38,
            name: 34
        };
        if (typeof value === 'string') {
            var text = value.trim();
            if (text && scoreMap[parentKey]) {
                var dedupeKey = text.toLowerCase();
                if (!seen.has(dedupeKey)) {
                    seen.add(dedupeKey);
                    bucket.push({ text: text, score: scoreMap[parentKey] + Math.min(12, text.length) - depth, depth: depth });
                }
            }
            var parsed = parseJsonFromEscapedText(value);
            if (parsed && parsed !== value) {
                collectRunninghubAppNameCandidates(parsed, depth + 1, bucket, seen, parentKey);
            }
            return bucket;
        }
        if (Array.isArray(value)) {
            value.slice(0, 30).forEach(function(item) {
                collectRunninghubAppNameCandidates(item, depth + 1, bucket, seen, parentKey);
            });
            return bucket;
        }
        if (typeof value !== 'object') return bucket;
        Object.keys(value).forEach(function(key) {
            collectRunninghubAppNameCandidates(value[key], depth + 1, bucket, seen, key);
        });
        return bucket;
    }

    function resolveRunninghubAppName(data) {
        var candidates = collectRunninghubAppNameCandidates(data, 0, [], new Set(), '');
        if (!candidates.length) return '';
        candidates.sort(function(a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return a.depth - b.depth;
        });
        return candidates[0].text || '';
    }

    function extractNodeInfoListFromText(rawText) {
        var text = String(rawText || '').trim();
        if (!text) return [];
        var parsed = parseJsonFromEscapedText(text);
        if (parsed && Array.isArray(parsed.nodeInfoList)) {
            return parsed.nodeInfoList;
        }
        var match = text.match(/"nodeInfoList"\s*:\s*(\[[\s\S]*?\])/);
        if (match && match[1]) {
            try {
                var list = JSON.parse(match[1]);
                return Array.isArray(list) ? list : [];
            } catch (error) {}
        }
        return [];
    }

    function findCurlDemoText(data, depth) {
        depth = depth || 0;
        if (depth > 8 || data == null) return '';
        var keys = ['curl', 'curlCmd', 'curlCommand', 'apiCallDemo', 'requestDemo', 'requestExample', 'demo', 'example', 'doc', 'docs', 'apiDoc', 'apiDocs'];
        if (typeof data === 'string') return data.trim();
        if (Array.isArray(data)) {
            for (var i = 0; i < data.length; i++) {
                var fromArray = findCurlDemoText(data[i], depth + 1);
                if (fromArray) return fromArray;
            }
            return '';
        }
        if (typeof data !== 'object') return '';
        for (var j = 0; j < keys.length; j++) {
            var value = data[keys[j]];
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }
        var objectKeys = Object.keys(data);
        for (var k = 0; k < objectKeys.length; k++) {
            var nested = findCurlDemoText(data[objectKeys[k]], depth + 1);
            if (nested) return nested;
        }
        return '';
    }



    function shouldUseRunninghubTextarea(source, provisionalType, looksPromptLike) {
        if (!source || provisionalType === 'image' || provisionalType === 'select' || provisionalType === 'boolean' || provisionalType === 'number') {
            return false;
        }
        var rawType = String(source.type || source.fieldType || source.inputType || source.widget || source.valueType || '').trim().toLowerCase();
        if (/textarea|multiline|paragraph|text-area|longtext/.test(rawType)) return true;
        if (!looksPromptLike) return false;
        var keyText = [source.key, source.paramKey, source.fieldName, source.field, source.name, source.label, source.title]
            .map(function(item) { return String(item || '').trim().toLowerCase(); })
            .filter(Boolean)
            .join(' ');
        var hasBinding = !!(String(source.nodeId || source.nodeID || source.node || source.node_id || '').trim() && String(source.fieldName || source.field || source.name || '').trim());
        if (/negative\s*prompt|negativeprompt|^prompt$| prompt|提示词|反向提示词/.test(keyText)) return true;
        if (hasBinding && /prompt|instruction|caption|description|text/.test(keyText)) return true;
        return false;
    }

    function normalizeRunninghubInputField(item, index) {
        if (!item || typeof item !== 'object') return null;
        var source = item;
        var nodeId = String(source.nodeId || source.nodeID || source.node || source.node_id || '').trim();
        var fieldName = String(source.fieldName || source.field || source.name || '').trim();
        var derivedKey = nodeId && fieldName ? (nodeId + ':' + fieldName) : '';
        var key = String(source.key || source.paramKey || derivedKey || source.fieldName || ('param_' + (index + 1))).trim();
        if (!key) return null;
        var fieldDataLabel = resolveRunninghubFieldDataLabel(source.fieldData);
        var hintText = key + ' ' + String(source.fieldName || '') + ' ' + String(source.label || '') + ' ' + String(source.name || '') + ' ' + String(source.description || '') + ' ' + fieldDataLabel;
        var looksPromptLike = isPromptLikeRunninghubText(hintText);
        var options = []
            .concat(extractRunninghubOptionEntries(source.options))
            .concat(extractRunninghubOptionEntries(source.enums))
            .concat(extractRunninghubOptionEntries(source.values))
            .concat(extractRunninghubOptionEntries(source.selectOptions))
            .concat(extractRunninghubOptionEntries(source.optionList))
            .concat(extractRunninghubOptionEntries(source.fieldOptions));
        if (!options.length) {
            options = extractRunninghubOptionEntries(source.fieldData);
        }
        var normalizedOptions = [];
        var seenOptions = new Set();
        options.forEach(function(option) {
            var value = normalizeRunninghubOptionText(option && option.value != null ? option.value : option);
            if (!value || isRunninghubTypeMarkerOption(value)) return;
            var marker = value.toLowerCase();
            if (seenOptions.has(marker)) return;
            seenOptions.add(marker);
            normalizedOptions.push({
                value: value,
                label: normalizeRunninghubOptionText(option && option.label != null ? option.label : option) || value
            });
        });
        var provisionalType = resolveRunninghubInputType({
            type: source.type || source.valueType || source.widget || source.inputType || source.fieldType,
            fieldType: source.fieldType,
            options: normalizedOptions,
            default: source.default != null ? source.default : source.fieldValue,
            key: key,
            paramKey: source.paramKey,
            fieldName: fieldName,
            field: source.field,
            name: source.name,
            label: source.label,
            title: source.title,
            description: source.description || source.desc || fieldDataLabel
        });
        var normalizedType = shouldUseRunninghubTextarea(source, provisionalType, looksPromptLike) ? 'textarea' : provisionalType;
        var baseName = String(source.name || source.label || source.title || fieldDataLabel || source.description || fieldName || key).trim();
        var baseLabel = String(source.label || source.name || source.title || fieldDataLabel || source.description || fieldName || key).trim();
        var labelMeta = resolveRunninghubDisplayLabel({
            key: key,
            fieldName: fieldName,
            rawLabel: baseLabel,
            rawName: baseName
        });
        var requiredSpec = resolveRunninghubRequiredSpec(source, normalizedType);
        var normalized = {
            key: key,
            label: labelMeta.label || baseLabel || baseName || key,
            labelSource: labelMeta.source,
            labelConfidence: labelMeta.confidence,
            type: normalizedType,
            required: requiredSpec.required,
            requiredExplicit: requiredSpec.explicit,
            placeholder: String(source.placeholder || source.tips || source.helpText || '').trim(),
            description: String(source.description || source.desc || source.summary || '').trim(),
            nodeId: nodeId,
            fieldName: fieldName || key,
            fieldType: String(source.fieldType || source.type || source.inputType || '').trim(),
            fieldData: source.fieldData != null ? source.fieldData : (source.data != null ? source.data : null),
            defaultValue: source.defaultValue != null ? source.defaultValue : (source.default != null ? source.default : (source.fieldValue != null ? source.fieldValue : extractRunninghubValue(source.value, 0)))
        };
        if (normalizedType === 'select' && normalizedOptions.length) {
            normalized.options = normalizedOptions;
        }
        return normalized;
    }

    function isGhostSchemaInput(source, normalized) {
        var raw = source || normalized;
        var field = normalized || source;
        if (!raw && !field) return true;
        var hint = [
            raw && raw.key,
            raw && raw.fieldName,
            raw && raw.name,
            raw && raw.label,
            raw && raw.description,
            field && field.key,
            field && field.fieldName,
            field && field.label
        ].map(function(item) {
            return String(item || '').trim();
        }).filter(Boolean).join(' ');
        if (!hint) return true;
        var rawType = String(raw && (raw.fieldType || raw.type || raw.inputType || raw.widget || raw.valueType) || '').trim().toLowerCase();
        var normalizedType = String(field && field.type || '').trim().toLowerCase();
        var defaultMarker = String(
            raw && (raw.defaultValue != null ? raw.defaultValue : (raw.default != null ? raw.default : raw.fieldValue))
            || field && field.defaultValue
            || ''
        ).trim().toLowerCase();
        var hasBinding = !!(
            String(raw && (raw.nodeId || raw.nodeID || raw.node || raw.node_id) || field && field.nodeId || '').trim()
            && String(raw && (raw.fieldName || raw.field || raw.name) || field && field.fieldName || '').trim()
        );
        if (hasBinding && normalizedType === 'image') return false;
        if (hasBinding && normalizedType === 'select' && Array.isArray(field && field.options) && field.options.length > 1) return false;
        if (hasBinding && (normalizedType === 'textarea' || normalizedType === 'text') && /prompt|negativeprompt|提示词|反向提示词/.test(hint.toLowerCase())) return false;
        var weakHint = isWeakRunninghubLabel(String(field && field.label || raw && raw.label || '').trim())
            && isWeakRunninghubLabel(String(field && field.fieldName || raw && raw.fieldName || raw && raw.name || '').trim())
            && isWeakRunninghubLabel(String(field && field.key || raw && raw.key || '').trim());
        var schemaLike = /schema|jsonschema|workflowjson|nodeinfolist|fielddata|inputtype/.test(hint.toLowerCase());
        var plainStringLike = /string|text|schema/.test(rawType || normalizedType || defaultMarker);
        var hasUsefulOptions = Array.isArray(field && field.options) && field.options.length > 1;
        if (!hasBinding && hasUsefulOptions && (normalizedType === 'select' || normalizedType === 'boolean')) return false;
        if (schemaLike) return true;
        if (!hasBinding && weakHint && !hasUsefulOptions) return true;
        if (!hasBinding && isPromptLikeRunninghubText(hint) && plainStringLike && !hasUsefulOptions) return true;
        if (/^param_\d+$/.test(String(field && field.key || raw && raw.key || '').trim()) && weakHint && !hasUsefulOptions) return true;
        return false;
    }

    function buildRunninghubInputMergeKey(input) {
        if (!input || typeof input !== 'object') return '';
        var nodeId = String(input.nodeId || '').trim();
        var fieldName = String(input.fieldName || '').trim();
        if (nodeId && fieldName) return (nodeId + ':' + fieldName).toLowerCase();
        var key = String(input.key || '').trim();
        if (key) return key.toLowerCase();
        if (fieldName) return fieldName.toLowerCase();
        return '';
    }

    function mergeRunninghubInputs(primaryInputs, fallbackInputs) {
        var primary = Array.isArray(primaryInputs) ? primaryInputs : [];
        var fallback = Array.isArray(fallbackInputs) ? fallbackInputs : [];
        if (!primary.length) return fallback;
        if (!fallback.length) return primary;
        var fallbackMap = new Map();
        fallback.forEach(function(item) {
            var marker = buildRunninghubInputMergeKey(item);
            if (!marker || fallbackMap.has(marker)) return;
            fallbackMap.set(marker, item);
        });
        return primary.map(function(input) {
            var marker = buildRunninghubInputMergeKey(input);
            var alt = marker ? fallbackMap.get(marker) : null;
            if (!alt) return input;
            var needsOptions = input.type === 'select'
                && (!Array.isArray(input.options) || input.options.length <= 1)
                && Array.isArray(alt.options)
                && alt.options.length > 1;
            var betterLabel = typeof alt.labelConfidence === 'number'
                && (!input.labelConfidence || alt.labelConfidence > input.labelConfidence + 0.2)
                && !isWeakRunninghubLabel(alt.label);
            if (!needsOptions && !betterLabel) return input;
            return Object.assign({}, input, {
                options: needsOptions ? alt.options : input.options,
                label: betterLabel ? alt.label : input.label,
                labelSource: betterLabel ? alt.labelSource : input.labelSource,
                labelConfidence: betterLabel ? alt.labelConfidence : input.labelConfidence
            });
        });
    }



    function extractRunninghubAppPayload(data) {
        if (typeof data === 'string') {
            var parsed = parseJsonFromEscapedText(data);
            if (parsed && parsed !== data) {
                return extractRunninghubAppPayload(parsed);
            }
        }
        if (!data || typeof data !== 'object') {
            return { name: '未命名应用', description: '', inputs: [], debug: { selectedRawCount: 0 } };
        }
        var legacySources = [
            data.nodeInfoList,
            data.inputs,
            data.params,
            data.inputParams,
            data.nodeList,
            data.workflow && data.workflow.inputs,
            data.workflow && data.workflow.nodeInfoList,
            data.appInfo && data.appInfo.nodeInfoList,
            data.webappInfo && data.webappInfo.nodeInfoList,
            data.webappInfo && data.webappInfo.nodeList,
            data.workflow && data.workflow.nodeList,
            data.workflow && data.workflow.nodes,
            data.nodeInfo,
            data.nodeInfos,
            data.data && data.data.nodeInfo,
            data.data && data.data.nodeInfos,
            data.data && data.data.nodeInfoList,
            data.data && data.data.inputs,
            data.result && data.result.nodeInfoList,
            data.result && data.result.inputs
        ];
        var legacyCandidates = legacySources.map(function(value, index) {
            var list = toRunninghubInputListFromUnknown(value);
            return {
                path: 'legacyCandidate[' + index + ']',
                list: list,
                inputLikeCount: list.filter(isLikelyRunninghubInputRecord).length,
                nodeBindingCount: getRunninghubNodeBindingCount(list)
            };
        }).filter(function(item) {
            return Array.isArray(item.list) && item.list.length > 0;
        });
        var candidateList = dedupeRunninghubInputCandidates(legacyCandidates.concat(collectRunninghubInputCandidates(data, 0, 'root', [])));
        var selected = candidateList[0] || { path: '', list: [] };
        var rawInputs = Array.isArray(selected.list) ? selected.list : [];
        var primaryInputs = rawInputs.map(function(item, index) {
            return { raw: item, input: normalizeRunninghubInputField(item, index) };
        }).filter(function(item) {
            return item && item.input && item.input.key;
        }).filter(function(item) {
            return !isGhostSchemaInput(item.raw, item.input);
        }).map(function(item) {
            return item.input;
        });
        var altInputs = candidateList.filter(function(item) {
            return item && item.path && item.path !== selected.path;
        }).slice(0, 3).reduce(function(all, candidate) {
            return all.concat((candidate.list || []).map(function(item, index) {
                return { raw: item, input: normalizeRunninghubInputField(item, index) };
            }).filter(function(item) {
                return item && item.input && item.input.key;
            }).filter(function(item) {
                return !isGhostSchemaInput(item.raw, item.input);
            }).map(function(item) {
                return item.input;
            }));
        }, []);
        var curlDemoText = findCurlDemoText(data, 0);
        var curlNodeInfoList = extractNodeInfoListFromText(curlDemoText);
        var curlInputs = curlNodeInfoList.map(function(item, index) {
            return normalizeRunninghubInputField(item, index);
        }).filter(function(item) {
            return item && item.key;
        });
        var inputs = mergeRunninghubInputs(primaryInputs, altInputs.concat(curlInputs));
        return {
            name: resolveRunninghubAppName(data) || '未命名应用',
            description: String(data.description || data.desc || data.summary || '').trim(),
            inputs: inputs,
            debug: {
                selectedPath: selected.path || '',
                selectedRawCount: rawInputs.length,
                candidateCount: candidateList.length,
                primaryInputsFound: primaryInputs.length,
                curlNodeInfoCount: curlNodeInfoList.length
            }
        };
    }

    function pickRunninghubBestPayload(candidates) {
        var best = null;
        (Array.isArray(candidates) ? candidates : []).forEach(function(source) {
            var payload = extractRunninghubAppPayload(source);
            var inputCount = Array.isArray(payload.inputs) ? payload.inputs.length : 0;
            var hasNamedPayload = payload.name && payload.name !== '未命名应用';
            var rawCount = payload.debug && payload.debug.selectedRawCount ? payload.debug.selectedRawCount : 0;
            var score = inputCount * 1000 + (hasNamedPayload ? 100 : 0) + rawCount;
            if (!best || score > best.score) {
                best = {
                    source: source,
                    parsed: payload,
                    payload: payload,
                    score: score,
                    rawCount: rawCount,
                    nameScore: hasNamedPayload ? 1 : 0
                };
            }
        });
        return best;
    }





    async function fetchRunninghubJson(url, options) {
        let response;
        try {
            response = await fetch(url, options);
        } catch (error) {
            throw new Error('网络请求失败：' + error.message);
        }
        const text = await response.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch (error) {
            data = { rawText: text };
        }
        if (!response.ok) {
            const errorMessage = data && (data.message || data.msg || data.error || data.detail) || ('HTTP ' + response.status);
            throw new Error(String(errorMessage));
        }
        return data;
    }

    function buildRunninghubParseUrl(pathname, queryParams) {
        var base = 'https://www.runninghub.cn';
        var url = new URL(pathname, base);
        Object.keys(queryParams || {}).forEach(function(key) {
            if (queryParams[key] === undefined || queryParams[key] === null || queryParams[key] === '') return;
            url.searchParams.set(key, String(queryParams[key]));
        });
        return url.toString();
    }

    function buildRunninghubFallbackUrls(endpoint, normalizedId) {
        var urls = [];
        var seen = new Set();
        function push(url) {
            if (!url || seen.has(url)) return;
            seen.add(url);
            urls.push(url);
        }
        push('https://www.runninghub.cn' + endpoint + '/' + encodeURIComponent(normalizedId));
        push(buildRunninghubParseUrl(endpoint, { webappId: normalizedId }));
        push(buildRunninghubParseUrl(endpoint, { webAppId: normalizedId }));
        push(buildRunninghubParseUrl(endpoint, { appId: normalizedId }));
        push(buildRunninghubParseUrl(endpoint, { id: normalizedId }));
        return urls;
    }

    async function fetchRunninghubAppMeta() {
        const apiKey = getRunninghubApiKey();
        if (!apiKey) {
            throw new Error('请先填写 RunningHub API Key');
        }
        const inputEl = document.getElementById('runninghubAppIdInput');
        const rawValue = inputEl ? inputEl.value.trim() : '';
        const appId = normalizeRunninghubAppId(rawValue);
        if (!appId) {
            throw new Error('请输入 RunningHub 应用 ID 或链接');
        }
        if (inputEl) {
            inputEl.value = appId;
        }
        const headers = {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
        };
        const reasons = [];
        const fallbackEndpoints = [
            '/uc/openapi/app',
            '/uc/openapi/community/app',
            '/uc/openapi/workflow'
        ];
        function tryHandleResult(endpoint, result) {
            var sourceCandidates = collectRunninghubSourceCandidates(result, 0, new Set());
            var best = pickRunninghubBestPayload(sourceCandidates);
            if (!best || !best.payload) return null;
            var nextPayload = Object.assign({}, best.payload, {
                appId: appId,
                name: best.payload.name || ('RunningHub 应用 ' + appId)
            });
            if (Array.isArray(nextPayload.inputs) && nextPayload.inputs.length > 0) {
                return {
                    id: appId,
                    appId: appId,
                    name: nextPayload.name,
                    description: nextPayload.description || '',
                    enabled: true,
                    source: 'runninghub',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    inputs: nextPayload.inputs
                };
            }
            return null;
        }

        const getVariants = [
            { apiKey: apiKey, webappId: appId },
            { apiKey: apiKey, webAppId: appId },
            { apiKey: apiKey, appId: appId },
            { apikey: apiKey, webappId: appId }
        ];
        for (let i = 0; i < getVariants.length; i++) {
            try {
                const payload = await fetchRunninghubJson(buildRunninghubParseUrl('/api/webapp/apiCallDemo', getVariants[i]), { method: 'GET', headers: headers });
                const parsed = tryHandleResult('/api/webapp/apiCallDemo', payload);
                if (parsed) return parsed;
                reasons.push('apiCallDemo(GET): ' + String(payload && (payload.message || payload.msg || payload.error) || '未识别到可用输入参数'));
            } catch (error) {
                reasons.push('apiCallDemo(GET): ' + error.message);
            }
        }

        const postVariants = [
            { apiKey: apiKey, webappId: appId },
            { apiKey: apiKey, webAppId: appId },
            { apiKey: apiKey, appId: appId }
        ];
        for (let i = 0; i < postVariants.length; i++) {
            try {
                const payload = await fetchRunninghubJson('https://www.runninghub.cn/api/webapp/apiCallDemo', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(postVariants[i])
                });
                const parsed = tryHandleResult('/api/webapp/apiCallDemo', payload);
                if (parsed) return parsed;
                reasons.push('apiCallDemo(POST): ' + String(payload && (payload.message || payload.msg || payload.error) || '未识别到可用输入参数'));
            } catch (error) {
                reasons.push('apiCallDemo(POST): ' + error.message);
            }
        }

        for (let i = 0; i < fallbackEndpoints.length; i++) {
            const endpoint = fallbackEndpoints[i];
            const urls = buildRunninghubFallbackUrls(endpoint, appId);
            for (let j = 0; j < urls.length; j++) {
                try {
                    const payload = await fetchRunninghubJson(urls[j], { method: 'GET', headers: headers });
                    const parsed = tryHandleResult(endpoint, payload);
                    if (parsed) return parsed;
                    reasons.push(endpoint + ': ' + String(payload && (payload.message || payload.msg || payload.error) || '未识别到可用输入参数'));
                } catch (error) {
                    reasons.push(endpoint + ': ' + error.message);
                }
            }
        }

        throw new Error(reasons[0] || '接口已返回，但没有解析到可用参数（可能参数藏在 apiCallDemo/curl/nodeInfoList 里）');
    }

    async function parseRunninghubApp() {
        const btn = document.getElementById('btnParseRunninghubApp');
        const info = document.getElementById('runninghubParsedAppInfo');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="loading"></span>解析中...';
        }
        if (info) {
            info.textContent = '正在解析应用...';
        }
        showStatus('正在解析 RunningHub 应用...', 'info');
        try {
            const parsed = await fetchRunninghubAppMeta();
            pendingRunninghubParsedApp = parsed;
            updateRunninghubParsedAppInfo();
            showStatus('RunningHub 应用解析成功', 'success');
            showToast('应用已解析');
        } catch (error) {
            pendingRunninghubParsedApp = null;
            if (info) {
                info.textContent = '解析失败：' + error.message;
            }
            updateRunninghubParsedAppInfo();
            showStatus('解析应用失败：' + error.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '解析应用';
            }
        }
    }

    function saveParsedRunninghubApp() {
        if (!pendingRunninghubParsedApp) {
            showStatus('请先解析 RunningHub 应用', 'error');
            return;
        }
        const appId = String(pendingRunninghubParsedApp.appId || pendingRunninghubParsedApp.id || '').trim();
        const exists = runninghubApps.some(function(app) {
            return String(app.appId || app.id || '') === appId;
        });
        if (exists) {
            showStatus('该 RunningHub 应用已保存', 'error');
            return;
        }
        runninghubApps.push(normalizeRunninghubAppConfig(pendingRunninghubParsedApp));
        pendingRunninghubParsedApp = null;
        renderRunninghubAppList();
        renderAppsHome();
        updateRunninghubParsedAppInfo();
        persistRunninghubApps();
        showStatus('RunningHub 应用已保存', 'success');
        showToast('应用已保存');
    }

    function persistRunninghubApps() {
        saveSettings();
    }

    function loadRunninghubApps(items) {
        runninghubApps = Array.isArray(items) ? items.map(function(app) {
            try {
                return normalizeRunninghubAppConfig(app);
            } catch (error) {
                return null;
            }
        }).filter(Boolean) : [];
    }

    function getRunninghubImageValue(key) {
        const value = currentRunninghubFieldValues[key];
        if (!value || !value.base64) return null;
        return value;
    }

    async function assignRunninghubImageField(fieldKey) {
        if (!fieldKey) return;
        showStatus('正在读取选区...', 'info');
        try {
            const capture = await captureReferenceImageFromSelection();
            currentRunninghubFieldValues[fieldKey] = {
                base64: capture.base64,
                bounds: capture.bounds,
                label: RUNNINGHUB_IMAGE_VALUE_SOURCE_LABEL
            };
            renderGenericAppEditor(appEditorMeta || {});
            showStatus('图片参数已读取', 'success');
            showToast('图片已读取');
        } catch (error) {
            showStatus('读取图片参数失败：' + error.message, 'error');
        }
    }

    function clearRunninghubImageField(fieldKey) {
        if (!fieldKey) return;
        delete currentRunninghubFieldValues[fieldKey];
        renderGenericAppEditor(appEditorMeta || {});
        showToast('图片已清除');
    }

    function renderRunninghubField(field) {
        const fieldId = 'runninghubField_' + String(field.key || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const label = escapeHTML(field.label || field.key || '参数');
        const requiredMark = field.required ? ' <span class="info-text">*</span>' : '';
        const description = field.description ? '<div class="info-text">' + escapeHTML(field.description) + '</div>' : '';
        const placeholder = escapeHTML(field.placeholder || '');
        if (field.type === 'textarea') {
            return '<div class="form-group settings-card"><label for="' + fieldId + '">' + label + requiredMark + '</label><textarea id="' + fieldId + '" class="prompt-textarea" data-runninghub-field="' + escapeHTML(field.key) + '" placeholder="' + placeholder + '">' + escapeHTML(currentRunninghubFieldValues[field.key] || '') + '</textarea>' + description + '</div>';
        }
        if (field.type === 'number') {
            return '<div class="form-group settings-card"><label for="' + fieldId + '">' + label + requiredMark + '</label><input type="number" id="' + fieldId + '" data-runninghub-field="' + escapeHTML(field.key) + '" placeholder="' + placeholder + '" value="' + escapeHTML(currentRunninghubFieldValues[field.key] || '') + '">' + description + '</div>';
        }
        if (field.type === 'select') {
            return '<div class="form-group settings-card"><label for="' + fieldId + '">' + label + requiredMark + '</label><select id="' + fieldId + '" data-runninghub-field="' + escapeHTML(field.key) + '">' + (field.options || []).map(function(option) {
                const selected = String(currentRunninghubFieldValues[field.key] || '') === String(option.value) ? ' selected' : '';
                return '<option value="' + escapeHTML(option.value) + '"' + selected + '>' + escapeHTML(option.label) + '</option>';
            }).join('') + '</select>' + description + '</div>';
        }
        if (field.type === 'boolean') {
            return '<div class="form-group settings-card"><label class="checkbox-row"><input type="checkbox" id="' + fieldId + '" data-runninghub-field="' + escapeHTML(field.key) + '"' + (currentRunninghubFieldValues[field.key] ? ' checked' : '') + '> ' + label + requiredMark + '</label>' + description + '</div>';
        }
        if (field.type === 'image') {
            const imageValue = getRunninghubImageValue(field.key);
            return ''
                + '<div class="form-group settings-card">'
                + '<label>' + label + requiredMark + '</label>'
                + '<div class="reference-panel">'
                + '<div class="reference-panel-head"><div class="card-title" style="margin:0;">图片参数</div><div class="reference-count">' + (imageValue ? (imageValue.uploadToken ? '已上传' : '已读取') : '未读取') + '</div></div>'
                + '<div class="reference-image-slots">'
                + (imageValue && imageValue.base64 ? '<div class="reference-slot"><img src="' + escapeHTML(imageValue.base64) + '" alt="' + label + '"></div>' : '<div class="reference-slot empty">读取文档</div>')
                + '</div>'
                + (imageValue && imageValue.uploadToken ? '<div class="info-text">token：' + escapeHTML(shortRunninghubId(imageValue.uploadToken)) + '</div>' : '')
                + '<div class="btn-row">'
                + '<button class="btn btn-secondary" type="button" data-runninghub-image-capture="' + escapeHTML(field.key) + '">' + (imageValue ? '重新读取文档' : '读取当前文档') + '</button>'
                + '<button class="btn btn-secondary" type="button" data-runninghub-image-clear="' + escapeHTML(field.key) + '"' + (imageValue ? '' : ' disabled') + '>清除</button>'
                + '</div>'
                + '</div>'
                + description
                + '</div>';
        }
        return '<div class="form-group settings-card"><label for="' + fieldId + '">' + label + requiredMark + '</label><input type="text" id="' + fieldId + '" data-runninghub-field="' + escapeHTML(field.key) + '" placeholder="' + placeholder + '" value="' + escapeHTML(currentRunninghubFieldValues[field.key] || '') + '">' + description + '</div>';
    }

    function getLatestRunninghubLog(appId) {
        const logs = getRunninghubLogsByAppId(appId);
        return logs.length ? logs[0] : null;
    }

    function formatLogTimestamp(value) {
        if (value == null || value === '') return '--';
        return String(value);
    }

    function getCompositeAssistantImagePreview() {
        if (compositeAssistantState.image && compositeAssistantState.image.base64) return compositeAssistantState.image.base64;
        if (compositeAssistantState.imageUrl) return compositeAssistantState.imageUrl;
        return '';
    }

    function getCompositeAssistantImageLabel() {
        if (compositeAssistantState.image && compositeAssistantState.image.label) return compositeAssistantState.image.label;
        if (compositeAssistantState.imageUrl) return '图片 URL';
        return '未添加';
    }

    function renderCompositeAssistantPassOptions() {
        return COMPOSITE_ASSISTANT_PASS_TYPES.map(function(pass) {
            const checked = compositeAssistantState.selectedPasses.indexOf(pass.id) > -1;
            return '<label class="settings-card field-stack" style="cursor:pointer;">'
                + '<div class="checkbox-row"><input type="checkbox" data-composite-pass="' + escapeHTML(pass.id) + '"' + (checked ? ' checked' : '') + '> <strong>' + escapeHTML(pass.title) + '</strong></div>'
                + '<div class="info-text">' + escapeHTML(pass.desc) + '</div>'
                + '</label>';
        }).join('');
    }

    function buildModelOptionsHtml(options, selectedValue) {
        return (options || []).map(function(option) {
            const value = option && option.value != null ? String(option.value) : '';
            const text = option && option.text != null ? String(option.text) : value;
            return '<option value="' + escapeHTML(value) + '"' + (String(selectedValue || '') === value ? ' selected' : '') + '>' + escapeHTML(text) + '</option>';
        }).join('');
    }

    function getCompositeChatModelOptions() {
        const options = [];
        GRS_CHAT_MODEL_DEFAULT_OPTIONS.forEach(function(model) {
            options.push({ value: buildModelValue('grs', model.value), text: model.text });
        });
        (currentNewApiChatModels || []).forEach(function(model) {
            const value = buildModelValue(model.provider || 'newapi', model.value || model.name || model.id || model);
            options.push({ value: value, text: model.text || ((model.value || model.name || model.id || model) + ' (NewAPI)') });
        });
        return options;
    }

    function getCompositeImageModelOptions() {
        const options = [];
        DEFAULT_IMAGE_MODELS.forEach(function(model) {
            options.push({ value: model.value, text: getImageModelDisplayName(model.value, model.text) });
        });
        GRS_IMAGE_MODEL_DEFAULT_OPTIONS.forEach(function(model) {
            options.push({ value: model.value, text: getImageModelDisplayName(model.value, model.text) });
        });
        XAI_IMAGE_MODEL_DEFAULT_OPTIONS.forEach(function(model) {
            options.push({ value: model.value, text: model.text });
        });
        FIREFLY_IMAGE_MODEL_DEFAULT_OPTIONS.forEach(function(model) {
            options.push({ value: model.value, text: model.text });
        });
        return options;
    }

    function ensureCompositeAssistantModelDefaults() {
        if (!compositeAssistantState.chatModel) {
            compositeAssistantState.chatModel = currentSettings && currentSettings.chatModel ? currentSettings.chatModel : buildModelValue('grs', DEFAULT_GRS_CHAT_MODEL);
        }
        if (!compositeAssistantState.imageModel) {
            compositeAssistantState.imageModel = currentSettings && currentSettings.imgModel ? currentSettings.imgModel : DEFAULT_IMAGE_MODEL;
        }
    }

    function renderCompositeAssistantEditor() {
        const title = document.getElementById('appEditorTitle');
        const desc = document.getElementById('appEditorDesc');
        const body = document.getElementById('appEditorBody');
        if (title) title.textContent = '合成辅助器';
        if (desc) desc.textContent = '用提示词和原图直接生成深度、法线、分割、雾效等合成辅助图';
        if (!body) return;
        const preview = getCompositeAssistantImagePreview();
        const imageLabel = getCompositeAssistantImageLabel();
        ensureCompositeAssistantModelDefaults();
        const chatModelOptions = getCompositeChatModelOptions();
        const imageModelOptions = getCompositeImageModelOptions();
        body.innerHTML = ''
            + '<div class="module-card field-stack">'
            + '<div class="card-title">输入图片</div>'
            + '<div class="reference-panel">'
            + '<div class="reference-panel-head"><div class="card-title" style="margin:0;">图片来源</div><div class="reference-count">' + escapeHTML(imageLabel) + '</div></div>'
            + '<div class="reference-image-slots">'
            + (preview ? '<div class="reference-slot"><img src="' + escapeHTML(preview) + '" alt="合成辅助器输入图"></div>' : '<div class="reference-slot empty">当前画布 / 本地图片 / URL</div>')
            + '</div>'
            + '<div class="btn-row">'
            + '<button class="btn btn-secondary" type="button" data-composite-capture-image="1">读取当前选区</button>'
            + '<button class="btn btn-secondary" type="button" data-composite-clear-image="1"' + (preview ? '' : ' disabled') + '>清除</button>'
            + '</div>'
            + '</div>'
            + '<div class="form-group"><label for="compositeImageSource">默认来源</label><select id="compositeImageSource" data-composite-field="imageSource">'
            + '<option value="canvas"' + (compositeAssistantState.imageSource === 'canvas' ? ' selected' : '') + '>当前画布</option>'
            + '<option value="local"' + (compositeAssistantState.imageSource === 'local' ? ' selected' : '') + '>选择本地图片</option>'
            + '<option value="url"' + (compositeAssistantState.imageSource === 'url' ? ' selected' : '') + '>粘贴图片 URL</option>'
            + '</select></div>'
            + '<div class="form-group"><label for="compositeImageUrl">图片 URL</label><input id="compositeImageUrl" type="text" data-composite-field="imageUrl" placeholder="https://..." value="' + escapeHTML(compositeAssistantState.imageUrl || '') + '"></div>'
            + '</div>'
            + '<div class="module-card field-stack">'
            + '<div class="card-title">输出类型</div>'
            + '<div class="info-text">默认选择深度图、法线图、分割图，可多选。</div>'
            + renderCompositeAssistantPassOptions()
            + '</div>'
            + '<div class="module-card field-stack">'
            + '<div class="card-title">幻梦AI 模型</div>'
            + '<div class="form-group"><label for="compositeChatModel">文字/分析模型</label><select id="compositeChatModel" data-composite-field="chatModel">' + buildModelOptionsHtml(chatModelOptions, compositeAssistantState.chatModel) + '</select></div>'
            + '<div class="form-group"><label for="compositeImageModel">生图模型</label><select id="compositeImageModel" data-composite-field="imageModel">' + buildModelOptionsHtml(imageModelOptions, compositeAssistantState.imageModel) + '</select></div>'
            + '<label class="checkbox-row"><input type="checkbox" data-composite-field="analysisEnabled"' + (compositeAssistantState.analysisEnabled ? ' checked' : '') + '> 先用文字模型分析图片再生成</label>'
            + '</div>'
            + '<div class="module-card field-stack">'
            + '<div class="card-title">生成设置</div>'
            + '<div class="form-group"><label for="compositeOutputSize">输出尺寸</label><select id="compositeOutputSize" data-composite-field="outputSize">'
            + '<option value="source"' + (compositeAssistantState.outputSize === 'source' ? ' selected' : '') + '>跟随原图</option>'
            + '<option value="1024"' + (compositeAssistantState.outputSize === '1024' ? ' selected' : '') + '>1024</option>'
            + '<option value="1536"' + (compositeAssistantState.outputSize === '1536' ? ' selected' : '') + '>1536</option>'
            + '<option value="2048"' + (compositeAssistantState.outputSize === '2048' ? ' selected' : '') + '>2048</option>'
            + '</select></div>'
            + '<div class="form-group"><label for="compositeQuality">精度</label><select id="compositeQuality" data-composite-field="quality">'
            + '<option value="fast"' + (compositeAssistantState.quality === 'fast' ? ' selected' : '') + '>快速</option>'
            + '<option value="standard"' + (compositeAssistantState.quality === 'standard' ? ' selected' : '') + '>标准</option>'
            + '<option value="fine"' + (compositeAssistantState.quality === 'fine' ? ' selected' : '') + '>精细</option>'
            + '</select></div>'
            + '<div class="form-group"><label for="compositeImageResolution">生图清晰度</label><select id="compositeImageResolution" data-composite-field="imageResolution">'
            + '<option value="1K"' + (compositeAssistantState.imageResolution === '1K' ? ' selected' : '') + '>1K</option>'
            + '<option value="2K"' + (compositeAssistantState.imageResolution === '2K' ? ' selected' : '') + '>2K</option>'
            + '<option value="4K"' + (compositeAssistantState.imageResolution === '4K' ? ' selected' : '') + '>4K</option>'
            + '</select></div>'
            + '<div class="form-grid">'
            + '<div class="form-group"><label for="compositeImageCount">生成数量</label><input id="compositeImageCount" type="text" inputmode="numeric" data-composite-field="imageCount" value="' + escapeHTML(compositeAssistantState.imageCount || 1) + '"></div>'
            + '<div class="form-group"><label for="compositePromptStrength">提示词强度</label><input id="compositePromptStrength" type="text" inputmode="decimal" data-composite-field="promptStrength" value="' + escapeHTML(compositeAssistantState.promptStrength || 0.75) + '"></div>'
            + '<div class="form-group"><label for="compositeTemperature">分析温度</label><input id="compositeTemperature" type="text" inputmode="decimal" data-composite-field="temperature" value="' + escapeHTML(compositeAssistantState.temperature || 0.4) + '"></div>'
            + '</div>'
            + '<div class="form-group"><label for="compositeCustomPromptPrefix">自定义提示词前缀</label><textarea id="compositeCustomPromptPrefix" data-composite-field="customPromptPrefix" placeholder="可选：加入统一风格或项目约束">' + escapeHTML(compositeAssistantState.customPromptPrefix || '') + '</textarea></div>'
            + '<div class="form-group"><label for="compositeNegativePrompt">负面提示词</label><textarea id="compositeNegativePrompt" data-composite-field="negativePrompt">' + escapeHTML(compositeAssistantState.negativePrompt || COMPOSITE_ASSISTANT_PASS_PROMPTS.negative) + '</textarea></div>'
            + '<label class="checkbox-row"><input type="checkbox" data-composite-field="preserveEdges"' + (compositeAssistantState.preserveEdges ? ' checked' : '') + '> 边缘保留</label>'
            + '<div class="form-group"><label for="compositeOutputTarget">输出方式</label><select id="compositeOutputTarget" data-composite-field="outputTarget">'
            + '<option value="photoshop"' + (compositeAssistantState.outputTarget === 'photoshop' ? ' selected' : '') + '>插入 Photoshop</option>'
            + '<option value="result"' + (compositeAssistantState.outputTarget === 'result' ? ' selected' : '') + '>保存到任务结果</option>'
            + '<option value="both"' + (compositeAssistantState.outputTarget === 'both' ? ' selected' : '') + '>两者都要</option>'
            + '</select></div>'
            + '</div>'
            + '<div class="module-card field-stack">'
            + '<div class="card-title">操作</div>'
            + '<div class="btn-row">'
            + '<button class="btn btn-primary" type="button" data-composite-run="1">生成辅助图</button>'
            + '<button class="btn btn-secondary" type="button" data-composite-reset="1">重置参数</button>'
            + '</div>'
            + '<div class="info-text">会直接调用当前 幻梦AI 模型配置生成并回写 Photoshop。</div>'
            + '</div>';
        ['compositeChatModel', 'compositeImageModel', 'compositeImageSource', 'compositeOutputSize', 'compositeQuality', 'compositeImageResolution', 'compositeOutputTarget'].forEach(function(selectId) {
            refreshCustomSelectById(selectId);
        });
    }

    function updateCompositeAssistantState(patch, rerender) {
        patch = patch || {};
        if (Object.prototype.hasOwnProperty.call(patch, 'imageUrl')) {
            patch.imageUrl = String(patch.imageUrl || '').trim();
            if (patch.imageUrl) {
                patch.image = null;
                patch.imageSource = 'url';
            }
        }
        compositeAssistantState = Object.assign({}, compositeAssistantState, patch);
        if (rerender !== false) renderCompositeAssistantEditor();
    }

    function toggleCompositeAssistantPass(passId, checked) {
        passId = String(passId || '').trim();
        if (!passId) return;
        const selected = compositeAssistantState.selectedPasses.slice();
        const index = selected.indexOf(passId);
        if (checked && index === -1) selected.push(passId);
        if (!checked && index > -1) selected.splice(index, 1);
        updateCompositeAssistantState({ selectedPasses: selected }, false);
    }

    function resetCompositeAssistantState() {
        compositeAssistantState = Object.assign({}, DEFAULT_COMPOSITE_ASSISTANT_STATE, {
            selectedPasses: DEFAULT_COMPOSITE_ASSISTANT_STATE.selectedPasses.slice()
        });
        renderCompositeAssistantEditor();
        showStatus('合成辅助器参数已重置', 'success');
    }

    async function captureCompositeAssistantImage() {
        try {
            const capture = await captureReferenceImageFromSelection();
            if (!capture || !capture.base64) {
                showStatus('未读取到当前选区图片', 'error');
                return;
            }
            updateCompositeAssistantState({
                image: {
                    base64: capture.base64,
                    bounds: capture.bounds,
                    label: '当前 Photoshop 选区'
                },
                imageSource: 'canvas',
                imageUrl: ''
            }, true);
            showStatus('合成辅助器输入图片已读取', 'success');
        } catch (error) {
            showStatus('读取输入图片失败：' + error.message, 'error');
        }
    }

    function resolveCompositeImageSizeConfig(outputSize) {
        switch (String(outputSize || 'source')) {
            case '1024': return { imageSize: '1K', aspectRatio: 'auto' };
            case '1536': return { imageSize: '2K', aspectRatio: 'auto' };
            case '2048': return { imageSize: '2K', aspectRatio: 'auto' };
            case '2K': return { imageSize: '2K', aspectRatio: 'auto' };
            case '4K': return { imageSize: '4K', aspectRatio: 'auto' };
            default: return { imageSize: '1K', aspectRatio: 'auto' };
        }
    }

    async function callChatModelForAnalysis(chatModel, imageBase64, prompt, temperature, abortSignal) {
        const route = resolveChatApiRouting(chatModel, currentSettings);
        const chatApiKey = normalizeApiKey(route.apiKey);
        const baseUrl = normalizeBaseUrl(route.baseUrl, '');
        if (!chatApiKey) return { error: '缺少 API 密钥，请在设置中配置' };
        const messages = [];
        if (imageBase64) {
            const dataUrl = makeImageDataUrl(imageBase64);
            const mimeMatch = dataUrl.match(/^data:(image\/\w+);base64,/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
            const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
            messages.push({
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64Data } }
                ]
            });
        } else {
            messages.push({ role: 'user', content: prompt });
        }
        const chatOptions = {
            apiKey: chatApiKey,
            baseUrl: baseUrl,
            model: route.model,
            messages: messages,
            abortSignal: abortSignal
        };
        const result = route.provider === 'grs'
            ? await API.generateImage(Object.assign({}, chatOptions, { provider: 'grs', prompt: prompt, imageBase64: imageBase64 }))
            : await API.chatNewApi(chatOptions);
        if (!result.success) return { error: result.error || '文字模型分析失败' };
        const text = extractChatResponseText(result.data);
        return { success: true, text: text };
    }

    async function callImageModelForPass(passId, imageBase64, imageModel, imageResolution, promptStrength, customPromptPrefix, negativePrompt, abortSignal, analysisPrompt) {
        const imageConfig = resolveCompositeImageSizeConfig(imageResolution);
        const imgRoute = resolveImageApiRouting(imageModel, currentSettings);
        const validation = validateImageApiRouting(imageModel, currentSettings);
        if (!validation.valid) return { error: validation.message || '生图模型配置不完整' };
        const passPrompt = COMPOSITE_ASSISTANT_PASS_PROMPTS[passId] || '';
        const prefix = customPromptPrefix ? (customPromptPrefix + ' ' + passPrompt) : passPrompt;
        const strengthLine = promptStrength ? (' Prompt adherence strength: ' + promptStrength + '.') : '';
        const combinedPrompt = [analysisPrompt || prefix, strengthLine, negativePrompt || ''].filter(Boolean).join('\n');
        const genResult = await API.generateImage({
            apiKey: normalizeApiKey(imgRoute.apiKey),
            provider: imgRoute.provider,
            baseUrl: imgRoute.baseUrl,
            model: imgRoute.model,
            prompt: combinedPrompt,
            imageBase64: imageBase64,
            imageSize: imageConfig.imageSize,
            aspectRatio: 'auto',
            abortSignal: abortSignal
        });
        if (!genResult.success) return { error: genResult.error || '生成辅助图失败' };
        const imageUrl = extractImageFromResponse(genResult.data);
        return { success: true, imageUrl: imageUrl, prompt: combinedPrompt };
    }

    async function runCompositeAssistantAsync() {
        const hasImage = !!(compositeAssistantState.image && compositeAssistantState.image.base64) || !!compositeAssistantState.imageUrl;
        if (!hasImage) {
            showStatus('请先添加输入图片', 'error');
            return;
        }
        if (!compositeAssistantState.selectedPasses.length) {
            showStatus('请至少选择一种输出类型', 'error');
            return;
        }
        const imgModel = compositeAssistantState.imageModel || DEFAULT_IMAGE_MODEL;
        const validation = validateImageApiRouting(imgModel, currentSettings);
        if (!validation.valid) {
            showStatus('生图模型未配置：' + validation.message, 'error');
            return;
        }
        const abortController = new AbortController();
        let generatedCount = 0;
        try {
            const imageBase64 = compositeAssistantState.image && compositeAssistantState.image.base64
                ? compositeAssistantState.image.base64
                : '';
            const selectedPasses = compositeAssistantState.selectedPasses.slice();
            const totalPasses = selectedPasses.length;
            showStatus('开始合成辅助器生成...', 'info');
            for (let i = 0; i < selectedPasses.length; i++) {
                const passId = selectedPasses[i];
                showStatus('正在生成 ' + (i + 1) + '/' + totalPasses + '：' + passId + '...', 'info');
                const passPrompt = COMPOSITE_ASSISTANT_PASS_PROMPTS[passId] || '';
                const prefix = compositeAssistantState.customPromptPrefix
                    ? (compositeAssistantState.customPromptPrefix + ' ' + passPrompt)
                    : passPrompt;
                const strengthLine = (compositeAssistantState.promptStrength && Math.abs(Number(compositeAssistantState.promptStrength) - 0.75) > 0.01)
                    ? (' Prompt adherence strength: ' + compositeAssistantState.promptStrength + '.')
                    : '';
                const combinedPrompt = [prefix, strengthLine, compositeAssistantState.negativePrompt || COMPOSITE_ASSISTANT_PASS_PROMPTS.negative].filter(Boolean).join('\n');
                const genResult = await callImageModelForPass(
                    passId, imageBase64, imgModel, compositeAssistantState.imageResolution || '1K',
                    0.75,
                    '',
                    compositeAssistantState.negativePrompt || COMPOSITE_ASSISTANT_PASS_PROMPTS.negative,
                    abortController.signal,
                    combinedPrompt
                );
                if (!genResult.success) {
                    showStatus('生成 ' + passId + ' 失败：' + genResult.error, 'error');
                    Config.addLog({ timestamp: new Date().toLocaleString('zh-CN'), model: imgModel, prompt: combinedPrompt, type: 'composite-assistant', status: '失败', error: genResult.error });
                    continue;
                }
                showStatus('正在将 ' + passId + ' 放回 Photoshop...', 'info');
                await downloadAndPlaceDocument(genResult.imageUrl, 0, 0, passId, 'composite-assistant', new Date().toLocaleString('zh-CN'), imgModel);
                await applyVfxBlendModeToActiveLayer();
                generatedCount++;
                Config.addLog({ timestamp: new Date().toLocaleString('zh-CN'), model: imgModel, prompt: genResult.prompt || combinedPrompt, type: 'composite-assistant', status: '成功' });
            }
            showStatus('合成辅助器完成，生成 ' + generatedCount + ' 张辅助图。', 'success');
        } catch (error) {
            showStatus('合成辅助器出错：' + (error && error.message ? error.message : error), 'error');
        }
    }

    function runCompositeAssistant() {
        return runCompositeAssistantAsync();
    }

    function getAppImagePreview(image) {
        return image && image.base64 ? image.base64 : '';
    }

    function getAppImageLabel(image, fallback) {
        return image && image.label ? image.label : (fallback || '未读取');
    }

    function renderAppImageCaptureCard(titleText, image, captureAttr, clearAttr, emptyText) {
        const preview = getAppImagePreview(image);
        return '<div class="reference-panel">'
            + '<div class="reference-panel-head"><div class="card-title" style="margin:0;">' + escapeHTML(titleText) + '</div><div class="reference-count">' + escapeHTML(getAppImageLabel(image, '未读取')) + '</div></div>'
            + '<div class="reference-image-slots">'
            + (preview ? '<div class="reference-slot"><img src="' + escapeHTML(preview) + '" alt="' + escapeHTML(titleText) + '"></div>' : '<div class="reference-slot empty">' + escapeHTML(emptyText || '读取当前 Photoshop 选区') + '</div>')
            + '</div>'
            + '<div class="btn-row">'
            + '<button class="btn btn-secondary" type="button" ' + captureAttr + '="1">读取当前选区</button>'
            + '<button class="btn btn-secondary" type="button" ' + clearAttr + '="1"' + (preview ? '' : ' disabled') + '>清除</button>'
            + '</div>'
            + '</div>';
    }

    function ensureEffectTransferModelDefaults() {
        if (!effectTransferState.chatModel) effectTransferState.chatModel = currentSettings && currentSettings.chatModel ? currentSettings.chatModel : buildModelValue('grs', DEFAULT_GRS_CHAT_MODEL);
        if (!effectTransferState.imageModel) effectTransferState.imageModel = currentSettings && currentSettings.imgModel ? currentSettings.imgModel : DEFAULT_IMAGE_MODEL;
    }

    function updateEffectTransferState(patch, rerender) {
        effectTransferState = Object.assign({}, effectTransferState, patch || {});
        if (rerender !== false) renderEffectTransferEditor();
    }

    function renderEffectTransferEditor() {
        const title = document.getElementById('appEditorTitle');
        const desc = document.getElementById('appEditorDesc');
        const body = document.getElementById('appEditorBody');
        if (title) title.textContent = '特效迁移';
        if (desc) desc.textContent = '两种方案：先分析特效图写提示词，或原图 + 特效图直接参考迁移';
        if (!body) return;
        ensureEffectTransferModelDefaults();
        body.innerHTML = ''
            + '<div class="module-card field-stack">'
            + '<div class="card-title">迁移方案</div>'
            + '<label class="checkbox-row"><input type="radio" name="effectTransferMode" data-effect-transfer-field="mode" value="analyze-then-generate"' + (effectTransferState.mode === 'analyze-then-generate' ? ' checked' : '') + '> 方案一：先分析特效图生成提示词，再迁移</label>'
            + '<label class="checkbox-row"><input type="radio" name="effectTransferMode" data-effect-transfer-field="mode" value="direct-reference"' + (effectTransferState.mode === 'direct-reference' ? ' checked' : '') + '> 方案二：原图 + 特效图直接作为参考图迁移</label>'
            + '</div>'
            + '<div class="module-card field-stack">'
            + '<div class="card-title">图片</div>'
            + renderAppImageCaptureCard('原图 / 当前主体', effectTransferState.sourceImage, 'data-effect-transfer-capture-source', 'data-effect-transfer-clear-source', '读取要保留主体和构图的原图选区')
            + renderAppImageCaptureCard('特效源图 / 参考图', effectTransferState.effectImage, 'data-effect-transfer-capture-effect', 'data-effect-transfer-clear-effect', '读取提供特效、材质和光影的参考选区')
            + '</div>'
            + '<div class="module-card field-stack">'
            + '<div class="card-title">幻梦AI 模型</div>'
            + '<div class="form-group"><label for="effectTransferChatModel">文字/分析模型</label><select id="effectTransferChatModel" data-effect-transfer-field="chatModel">' + buildModelOptionsHtml(getCompositeChatModelOptions(), effectTransferState.chatModel) + '</select></div>'
            + '<div class="form-group"><label for="effectTransferImageModel">生图模型</label><select id="effectTransferImageModel" data-effect-transfer-field="imageModel">' + buildModelOptionsHtml(getCompositeImageModelOptions(), effectTransferState.imageModel) + '</select></div>'
            + '<div class="form-grid">'
            + '<div class="form-group"><label for="effectTransferResolution">输出清晰度</label><select id="effectTransferResolution" data-effect-transfer-field="imageResolution"><option value="1K"' + (effectTransferState.imageResolution === '1K' ? ' selected' : '') + '>1K</option><option value="2K"' + (effectTransferState.imageResolution === '2K' ? ' selected' : '') + '>2K</option><option value="4K"' + (effectTransferState.imageResolution === '4K' ? ' selected' : '') + '>4K</option></select></div>'
            + '<div class="form-group"><label for="effectTransferStrength">迁移强度</label><select id="effectTransferStrength" data-effect-transfer-field="strength"><option value="subtle"' + (effectTransferState.strength === 'subtle' ? ' selected' : '') + '>轻微</option><option value="balanced"' + (effectTransferState.strength === 'balanced' ? ' selected' : '') + '>平衡</option><option value="strong"' + (effectTransferState.strength === 'strong' ? ' selected' : '') + '>强烈</option></select></div>'
            + '</div>'
            + '<div class="form-group"><label for="effectTransferGeneratedPrompt">生成/编辑后的迁移提示词</label><textarea id="effectTransferGeneratedPrompt" data-effect-transfer-field="generatedPrompt" placeholder="方案一会自动写入，也可以手动补充">' + escapeHTML(effectTransferState.generatedPrompt || '') + '</textarea></div>'
            + '</div>'
            + '<div class="module-card field-stack"><div class="card-title">操作</div><div class="btn-row"><button class="btn btn-primary" type="button" data-effect-transfer-run="1">开始特效迁移</button><button class="btn btn-secondary" type="button" data-effect-transfer-reset="1">重置</button></div></div>';
        ['effectTransferChatModel', 'effectTransferImageModel', 'effectTransferResolution', 'effectTransferStrength'].forEach(function(selectId) {
            refreshCustomSelectById(selectId);
        });
    }

    async function captureEffectTransferImage(kind) {
        try {
            const capture = await captureReferenceImageFromSelection();
            const image = { base64: capture.base64, bounds: capture.bounds, label: kind === 'effect' ? '特效源图选区' : '原图选区' };
            const patch = kind === 'effect' ? { effectImage: image } : { sourceImage: image };
            updateEffectTransferState(patch, true);
            showStatus((kind === 'effect' ? '特效源图' : '原图') + '已读取', 'success');
        } catch (error) {
            showStatus('读取图片失败：' + error.message, 'error');
        }
    }

    async function runEffectTransfer() {
        if (!effectTransferState.sourceImage || !effectTransferState.sourceImage.base64) {
            showStatus('请先读取原图选区', 'error');
            return;
        }
        if (!effectTransferState.effectImage || !effectTransferState.effectImage.base64) {
            showStatus('请先读取特效源图选区', 'error');
            return;
        }
        ensureEffectTransferModelDefaults();
        const imageValidation = validateImageApiRouting(effectTransferState.imageModel, currentSettings);
        if (!imageValidation.valid) {
            showStatus('生图模型未配置：' + imageValidation.message, 'error');
            return;
        }
        const abortController = new AbortController();
        try {
            let prompt = effectTransferState.generatedPrompt || '';
            if (effectTransferState.mode === 'analyze-then-generate') {
                const chatValidation = validateChatApiRouting(effectTransferState.chatModel, currentSettings);
                if (!chatValidation.valid) {
                    showStatus('文字模型未配置：' + chatValidation.message, 'error');
                    return;
                }
                showStatus('正在分析特效源图...', 'info');
                const analysis = await callChatModelForAnalysis(effectTransferState.chatModel, effectTransferState.effectImage.base64, EFFECT_TRANSFER_ANALYZE_PROMPT, 0.35, abortController.signal);
                if (!analysis.success) {
                    showStatus('特效分析失败：' + analysis.error, 'error');
                    return;
                }
                prompt = analysis.text || prompt;
                effectTransferState.generatedPrompt = prompt;
                renderEffectTransferEditor();
            }
            const strengthText = effectTransferState.strength === 'strong' ? 'strong visible transfer' : (effectTransferState.strength === 'subtle' ? 'subtle controlled transfer' : 'balanced natural transfer');
            const finalPrompt = [effectTransferState.mode === 'direct-reference' ? EFFECT_TRANSFER_DIRECT_PROMPT : prompt, 'Transfer strength: ' + strengthText + '.', 'Preserve the original image identity, composition, pose, camera, layout, and structure.'].filter(Boolean).join('\n');
            const route = resolveImageApiRouting(effectTransferState.imageModel, currentSettings);
            const imageConfig = resolveCompositeImageSizeConfig(effectTransferState.imageResolution || '1K');
            showStatus('正在生成特效迁移结果...', 'info');
            const genResult = await API.generateImage({
                apiKey: normalizeApiKey(route.apiKey),
                provider: route.provider,
                baseUrl: route.baseUrl,
                model: route.model,
                prompt: finalPrompt,
                imageBase64: effectTransferState.sourceImage.base64,
                referenceImages: [effectTransferState.effectImage.base64],
                imageSize: imageConfig.imageSize,
                aspectRatio: 'auto',
                abortSignal: abortController.signal
            });
            if (!genResult.success) {
                showStatus('特效迁移失败：' + (genResult.error || '生成失败'), 'error');
                return;
            }
            const imageUrl = extractImageFromResponse(genResult.data);
            const previousBounds = savedSelectionBounds;
            savedSelectionBounds = effectTransferState.sourceImage.bounds;
            await downloadAndPlaceDocument(imageUrl, 0, 0, finalPrompt, 'effect-transfer', new Date().toLocaleString('zh-CN'), effectTransferState.imageModel);
            savedSelectionBounds = previousBounds;
            await applyVfxBlendModeToActiveLayer();
            Config.addLog({ timestamp: new Date().toLocaleString('zh-CN'), model: effectTransferState.imageModel, prompt: finalPrompt, type: 'effect-transfer', status: '成功' });
            showStatus('特效迁移完成', 'success');
        } catch (error) {
            showStatus('特效迁移出错：' + (error && error.message ? error.message : error), 'error');
        }
    }

    function resetEffectTransferState() {
        effectTransferState = Object.assign({}, DEFAULT_EFFECT_TRANSFER_STATE);
        renderEffectTransferEditor();
        showStatus('特效迁移参数已重置', 'success');
    }

    function ensureAiSuperResolutionDefaults() {
        if (!aiSuperResolutionState.model) aiSuperResolutionState.model = 'nano-banana-2-4k-cl';
        if (!aiSuperResolutionState.upscaleFactor) aiSuperResolutionState.upscaleFactor = 2;
        if (!aiSuperResolutionState.tileOverlap) aiSuperResolutionState.tileOverlap = 128;
    }

    function updateAiSuperResolutionState(patch, rerender) {
        aiSuperResolutionState = Object.assign({}, aiSuperResolutionState, patch || {});
        if (rerender !== false) renderAiSuperResolutionEditor();
    }

    function calculateAiSuperResolutionTiles(bounds, factor, overlap) {
        const safeFactor = Math.max(2, Math.min(4, Number(factor) || 2));
        const safeOverlap = Math.max(0, Math.min(512, Number(overlap) || 128));
        const maxOutputTile = 4096;
        const preferredInputTile = 3000;
        const tileInputMax = Math.min(preferredInputTile, Math.floor(maxOutputTile / safeFactor));
        const step = Math.max(256, tileInputMax - safeOverlap);
        const tiles = [];
        const sourceWidth = Math.round(bounds.width || (bounds.right - bounds.left));
        const sourceHeight = Math.round(bounds.height || (bounds.bottom - bounds.top));
        for (let y = 0; y < sourceHeight; y += step) {
            const top = Math.max(0, Math.min(y, Math.max(0, sourceHeight - tileInputMax)));
            const bottom = Math.min(sourceHeight, top + tileInputMax);
            for (let x = 0; x < sourceWidth; x += step) {
                const left = Math.max(0, Math.min(x, Math.max(0, sourceWidth - tileInputMax)));
                const right = Math.min(sourceWidth, left + tileInputMax);
                const sourceBounds = {
                    left: bounds.left + left,
                    top: bounds.top + top,
                    right: bounds.left + right,
                    bottom: bounds.top + bottom,
                    width: right - left,
                    height: bottom - top
                };
                tiles.push({
                    index: tiles.length + 1,
                    sourceBounds: sourceBounds,
                    targetBounds: {
                        left: Math.round(bounds.left + left * safeFactor),
                        top: Math.round(bounds.top + top * safeFactor),
                        right: Math.round(bounds.left + right * safeFactor),
                        bottom: Math.round(bounds.top + bottom * safeFactor),
                        width: Math.round((right - left) * safeFactor),
                        height: Math.round((bottom - top) * safeFactor)
                    }
                });
                if (right >= sourceWidth) break;
            }
            if (bottom >= sourceHeight) break;
        }
        return {
            factor: safeFactor,
            overlap: safeOverlap,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            targetWidth: Math.round(sourceWidth * safeFactor),
            targetHeight: Math.round(sourceHeight * safeFactor),
            tileInputMax: tileInputMax,
            maxOutputTile: maxOutputTile,
            tiles: tiles
        };
    }

    function renderAiSuperResolutionEditor() {
        const title = document.getElementById('appEditorTitle');
        const desc = document.getElementById('appEditorDesc');
        const body = document.getElementById('appEditorBody');
        if (title) title.textContent = 'AI超清';
        if (desc) desc.textContent = '自动切片，使用 Nano Banana 2 单张 4K 进行局部超清放大并拼回';
        if (!body) return;
        ensureAiSuperResolutionDefaults();
        const plan = aiSuperResolutionState.tilePlan;
        body.innerHTML = ''
            + '<div class="module-card field-stack">'
            + '<div class="card-title">原图</div>'
            + renderAppImageCaptureCard('超清源图', aiSuperResolutionState.sourceImage, 'data-ai-superres-capture-source', 'data-ai-superres-clear-source', '读取要超清放大的 Photoshop 选区')
            + '</div>'
            + '<div class="module-card field-stack">'
            + '<div class="card-title">放大设置</div>'
            + '<div class="form-grid">'
            + '<div class="form-group"><label for="aiSuperresFactor">放大倍数</label><select id="aiSuperresFactor" data-ai-superres-field="upscaleFactor"><option value="2"' + (Number(aiSuperResolutionState.upscaleFactor) === 2 ? ' selected' : '') + '>2x</option><option value="3"' + (Number(aiSuperResolutionState.upscaleFactor) === 3 ? ' selected' : '') + '>3x</option><option value="4"' + (Number(aiSuperResolutionState.upscaleFactor) === 4 ? ' selected' : '') + '>4x</option></select></div>'
            + '<div class="form-group"><label for="aiSuperresOverlap">切片重叠像素</label><input id="aiSuperresOverlap" type="text" inputmode="numeric" data-ai-superres-field="tileOverlap" value="' + escapeHTML(aiSuperResolutionState.tileOverlap || 128) + '"></div>'
            + '</div>'
            + '<div class="info-text">固定模型：Nano Banana 2 4K（nano-banana-2-4k-cl）</div>'
            + '</div>'
            + '<div class="module-card field-stack">'
            + '<div class="card-title">切片计划</div>'
            + (plan ? '<div class="info-text">原图：' + plan.sourceWidth + '×' + plan.sourceHeight + '，目标：' + plan.targetWidth + '×' + plan.targetHeight + '</div><div class="info-text">Tile：' + plan.tiles.length + ' 张，单块输入上限：' + plan.tileInputMax + 'px，单块输出上限：' + plan.maxOutputTile + 'px</div>' : '<div class="info-text">读取原图后点击“计算切片”。</div>')
            + '</div>'
            + '<div class="module-card field-stack"><div class="card-title">操作</div><div class="btn-row"><button class="btn btn-secondary" type="button" data-ai-superres-plan="1">计算切片</button><button class="btn btn-primary" type="button" data-ai-superres-run="1">开始 AI超清</button><button class="btn btn-secondary" type="button" data-ai-superres-reset="1">重置</button></div></div>';
        refreshCustomSelectById('aiSuperresFactor');
    }

    async function captureAiSuperResolutionSource() {
        try {
            const capture = await captureReferenceImageFromSelection();
            updateAiSuperResolutionState({
                sourceImage: { base64: capture.base64, bounds: capture.bounds, label: '超清源图选区' },
                tilePlan: calculateAiSuperResolutionTiles(capture.bounds, aiSuperResolutionState.upscaleFactor, aiSuperResolutionState.tileOverlap)
            }, true);
            showStatus('AI超清源图已读取并计算切片', 'success');
        } catch (error) {
            showStatus('读取 AI超清源图失败：' + error.message, 'error');
        }
    }

    function planAiSuperResolutionTiles() {
        if (!aiSuperResolutionState.sourceImage || !aiSuperResolutionState.sourceImage.bounds) {
            showStatus('请先读取要超清的原图选区', 'error');
            return;
        }
        updateAiSuperResolutionState({
            tilePlan: calculateAiSuperResolutionTiles(aiSuperResolutionState.sourceImage.bounds, aiSuperResolutionState.upscaleFactor, aiSuperResolutionState.tileOverlap)
        }, true);
        showStatus('AI超清切片已计算', 'success');
    }

    async function runAiSuperResolution() {
        if (!aiSuperResolutionState.sourceImage || !aiSuperResolutionState.sourceImage.bounds) {
            showStatus('请先读取要超清的原图选区', 'error');
            return;
        }
        if (!aiSuperResolutionState.tilePlan) planAiSuperResolutionTiles();
        const plan = aiSuperResolutionState.tilePlan;
        if (!plan || !plan.tiles || !plan.tiles.length) {
            showStatus('切片计划无效', 'error');
            return;
        }
        const validation = validateImageApiRouting(aiSuperResolutionState.model, currentSettings);
        if (!validation.valid) {
            showStatus('Nano Banana 2 4K 未配置：' + validation.message, 'error');
            return;
        }
        const route = resolveImageApiRouting(aiSuperResolutionState.model, currentSettings);
        const previousBounds = savedSelectionBounds;
        const abortController = new AbortController();
        const groupName = 'AI超清 ' + plan.factor + 'x ' + new Date().toLocaleString('zh-CN');
        try {
            for (let i = 0; i < plan.tiles.length; i++) {
                const tile = plan.tiles[i];
                showStatus('AI超清处理中 ' + (i + 1) + '/' + plan.tiles.length + '...', 'info');
                const tileBase64 = await getImageDataToBase64(tile.sourceBounds);
                if (!tileBase64) throw new Error('第 ' + (i + 1) + ' 个切片读取失败');
                const genResult = await API.generateImage({
                    apiKey: normalizeApiKey(route.apiKey),
                    provider: route.provider,
                    baseUrl: route.baseUrl,
                    model: route.model,
                    prompt: AI_SUPER_RES_TILE_PROMPT,
                    imageBase64: normalizeReferenceImageData(tileBase64),
                    imageResolution: '4K',
                    imageSize: '4K',
                    aspectRatio: 'auto',
                    abortSignal: abortController.signal
                });
                if (!genResult.success) throw new Error('第 ' + (i + 1) + ' 个切片生成失败：' + (genResult.error || '未知错误'));
                const imageUrl = extractImageFromResponse(genResult.data);
                savedSelectionBounds = tile.targetBounds;
                await downloadAndPlaceDocument(imageUrl, 0, 0, AI_SUPER_RES_TILE_PROMPT, 'ai-super-resolution', new Date().toLocaleString('zh-CN'), aiSuperResolutionState.model);
                await applyVfxBlendModeToActiveLayer();
                try {
                    const doc = psAPI.app && psAPI.app.activeDocument;
                    const layer = doc && doc.activeLayers && doc.activeLayers[0];
                    if (layer) layer.name = groupName + ' tile ' + (i + 1);
                } catch (nameError) {}
            }
            aiSuperResolutionState.outputGroupName = groupName;
            Config.addLog({ timestamp: new Date().toLocaleString('zh-CN'), model: aiSuperResolutionState.model, prompt: AI_SUPER_RES_TILE_PROMPT, type: 'ai-super-resolution', status: '成功', tileCount: plan.tiles.length });
            showStatus('AI超清完成，共生成 ' + plan.tiles.length + ' 个切片。', 'success');
        } catch (error) {
            showStatus('AI超清失败：' + (error && error.message ? error.message : error), 'error');
        } finally {
            savedSelectionBounds = previousBounds;
        }
    }

    function resetAiSuperResolutionState() {
        aiSuperResolutionState = Object.assign({}, DEFAULT_AI_SUPER_RESOLUTION_STATE);
        renderAiSuperResolutionEditor();
        showStatus('AI超清参数已重置', 'success');
    }

    function renderRunninghubCurrentStatus(appId) {
        const latest = getLatestRunninghubLog(appId);
        if (!latest) {
            return '<div class="module-card field-stack"><div class="card-title">当前状态</div><div class="info-text">还没有运行记录。</div></div>';
        }
        const taskId = latest.runninghubTaskId || latest.taskId || '';
        return '<div class="module-card field-stack">'
            + '<div class="card-title">当前状态</div>'
            + '<div class="info-text">状态：' + escapeHTML(latest.status || '未知') + '</div>'
            + '<div class="info-text">时间：' + escapeHTML(formatLogTimestamp(latest.timestamp)) + '</div>'
            + (taskId ? '<div class="info-text">任务：' + escapeHTML(shortRunninghubId(taskId)) + '</div>' : '')
            + (latest.error ? '<div class="info-text">错误：' + escapeHTML(latest.error) + '</div>' : '')
            + (latest.prompt ? '<div class="info-text">提示词：' + escapeHTML(String(latest.prompt).slice(0, 120)) + '</div>' : '')
            + '</div>';
    }

    function groupRunninghubEditorInputs(inputs) {
        const groups = [
            { title: '图片参数', items: [] },
            { title: '提示词参数', items: [] },
            { title: '常规参数', items: [] }
        ];
        inputs.forEach(function(field) {
            if (field.type === 'image') {
                groups[0].items.push(field);
                return;
            }
            if (field.type === 'textarea' || isPromptLikeRunninghubText([field.key, field.fieldName, field.label, field.description].join(' '))) {
                groups[1].items.push(field);
                return;
            }
            groups[2].items.push(field);
        });
        return groups.filter(function(group) { return group.items.length; });
    }

    function saveCurrentRunninghubAppId() {
        if (!appEditorMeta || appEditorMeta.source !== 'runninghub') return;
        const input = document.getElementById('runninghubEditorAppId');
        const nextId = normalizeRunninghubAppId(input ? input.value : '');
        if (!/^\d+$/.test(nextId)) {
            showStatus('请输入完整的 RunningHub webappId 数字', 'error');
            return;
        }
        const previousId = extractRunninghubWebappId(appEditorMeta) || appEditorMeta.id || appEditorMeta.appId || '';
        appEditorMeta = Object.assign({}, appEditorMeta, { id: nextId, appId: nextId, webappId: nextId });
        runninghubApps = runninghubApps.map(function(app) {
            const identity = getRunninghubAppIdentity(app);
            if (identity !== normalizeRunninghubAppId(previousId) && identity !== nextId) return app;
            return Object.assign({}, app, { id: nextId, appId: nextId, webappId: nextId, updatedAt: Date.now() });
        });
        currentAppCategory = nextId;
        persistRunninghubApps();
        renderRunninghubAppList();
        renderAppsHome();
        renderGenericAppEditor(appEditorMeta);
        showStatus('RunningHub webappId 已保存：' + nextId, 'success');
    }

    function renderGenericAppEditor(meta) {
        const title = document.getElementById('appEditorTitle');
        const desc = document.getElementById('appEditorDesc');
        const body = document.getElementById('appEditorBody');
        meta = meta || {};
        appEditorMeta = meta || null;
        if (title) title.textContent = meta.title || '应用';
        if (desc) desc.textContent = meta.desc || '';
        if (!body) return;
        body.className = 'app-editor-body';

        const inputs = (Array.isArray(meta.inputs) ? meta.inputs : []).filter(function(field) {
            return !isUselessRunninghubField(field);
        });
        const appId = extractRunninghubWebappId(meta) || meta.appId || meta.id || '';
        const summaryCard = '<div class="module-card field-stack">'
            + '<div class="card-title">应用概览</div>'
            + '<div class="info-text">来源：' + escapeHTML(meta.source === 'runninghub' ? 'RunningHub' : '内置小应用') + '</div>'
            + (appId ? '<div class="info-text">应用 ID：' + escapeHTML(appId) + '</div>' : '<div class="info-text">应用 ID：未识别，请重新解析 RunningHub 链接</div>')
            + (meta.source === 'runninghub' ? '<div class="form-group"><label for="runninghubEditorAppId">完整 webappId</label><input id="runninghubEditorAppId" type="text" value="' + escapeHTML(appId || '') + '" placeholder="粘贴 RunningHub 应用完整数字 ID"><div class="btn-row"><button class="btn btn-secondary" type="button" data-runninghub-save-app-id="1">保存 webappId</button></div></div>' : '')
            + '<div class="info-text">参数：' + inputs.length + ' 个</div>'
            + '</div>';
        const actionCard = '<div class="module-card field-stack">'
            + '<div class="card-title">快捷操作</div>'
            + '<div class="btn-row">'
            + '<button class="btn btn-primary" type="button" id="btnRunCurrentApp">运行应用</button>'
            + '<button class="btn btn-secondary" type="button" data-app-editor-clear-values="1">清空参数</button>'
            + '</div>'
            + '</div>';

        if (!inputs.length) {
            body.innerHTML = summaryCard + actionCard + '<div class="module-card"><div class="card-title">参数配置</div><div class="info-text">当前应用暂未配置参数。</div></div>';
            return;
        }

        const groupedInputs = groupRunninghubEditorInputs(inputs).map(function(group) {
            return '<div class="module-card field-stack">'
                + '<div class="card-title">' + escapeHTML(group.title) + '</div>'
                + group.items.map(renderRunninghubField).join('')
                + '</div>';
        }).join('');
        const statusAndLogs = meta && meta.source === 'runninghub'
            ? renderRunninghubCurrentStatus(appId) + renderRunninghubAppLogs(appId)
            : '';

        body.innerHTML = summaryCard + actionCard + groupedInputs + statusAndLogs;

        inputs.forEach(function(field) {
            if (field.type === 'select') {
                refreshCustomSelectById('runninghubField_' + String(field.key || '').replace(/[^a-zA-Z0-9_-]/g, '_'));
            }
        });
    }



    function nearestReferenceMap(map, value) {
        let best = map[0];
        let distance = Math.abs(Number(value) - Number(map[0][0]));
        for (let i = 1; i < map.length; i++) {
            const nextDistance = Math.abs(Number(value) - Number(map[i][0]));
            if (nextDistance < distance) {
                best = map[i];
                distance = nextDistance;
            }
        }
        return best[1];
    }

    function renderReferenceCameraEditor() {
        const title = document.getElementById('appEditorTitle');
        const desc = document.getElementById('appEditorDesc');
        const body = document.getElementById('appEditorBody');
        if (title) title.textContent = '3D 镜头控制';
        if (desc) desc.textContent = '镜头角度 + AI 重构';
        if (!body) return;
        body.className = 'app-editor-body reference-ui-root';

        const cameraRouteControls = buildIndependentGenerationControls('app:camera', 'cameraRoute', '3D 镜头独立生成参数');
        body.innerHTML = ''
            + '<div class="module-card w10-panel cam3d-panel">'
            + '  <div class="cam3d-canvas-wrap">'
            + '    <canvas id="camCanvas" class="cam3d-canvas" width="400" height="300"></canvas>'
            + '    <input type="range" id="camZoomSlider" class="cam3d-zoom-slider" min="0.5" max="2.0" step="0.05" value="1.0" title="缩放">'
            + '    <div id="btnCamCapture" class="cam3d-capture-btn" title="从 PS 选区截取图像">' + uiIconLabel('image', '加载图像') + '</div>'
            + '  </div>'
            + '  <div class="cam3d-controls">'
            + '    <div class="cam3d-row"><span class="cam3d-dot cam3d-dot-az"></span><label class="cam3d-label">方位</label><input type="range" id="camAzimuth" class="cam3d-slider cam3d-slider-az" min="0" max="315" step="1" value="0"><span id="camAzVal" class="cam3d-val cam3d-val-az">0°</span><span id="camAzReset" class="cam3d-reset" title="重置">↺</span></div>'
            + '    <div class="cam3d-row"><span class="cam3d-dot cam3d-dot-el"></span><label class="cam3d-label">仰角</label><input type="range" id="camElevation" class="cam3d-slider cam3d-slider-el" min="-90" max="90" step="1" value="0"><span id="camElVal" class="cam3d-val cam3d-val-el">0°</span><span id="camElReset" class="cam3d-reset" title="重置">↺</span></div>'
            + '    <div class="cam3d-row"><span class="cam3d-dot cam3d-dot-ds"></span><label class="cam3d-label">距离</label><input type="range" id="camDistance" class="cam3d-slider cam3d-slider-ds" min="0.6" max="4.0" step="0.1" value="1.0"><span id="camDsVal" class="cam3d-val cam3d-val-ds">1.0</span><span id="camDsReset" class="cam3d-reset" title="重置">↺</span></div>'
            + '  </div>'
            + '  <div id="camPromptPreview" class="cam3d-preview">&lt;sks&gt; front view eye-level shot medium close-up shot</div>'
            + cameraRouteControls
            + '  <div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">宽高比</div></div><div class="w10-row-right"><select class="w10-select" id="camAspectRatioInput"><option value="1:1" selected>1:1</option><option value="Auto">Auto</option><option value="9:16">9:16</option><option value="16:9">16:9</option><option value="2:3">2:3</option><option value="3:2">3:2</option></select></div></div>'
            + '  <button class="w10-btn w10-btn-accent cam3d-btn-go" id="btnCamGenerate">' + uiIconLabel('play', '开始生成') + '</button>'
            + '</div>';

        initAllFakeSelects(body);
        initAllRenderedRanges(body);
        bindIndependentGenerationControls('app:camera', 'cameraRoute', body);

        const canvas = document.getElementById('camCanvas');
        const azimuth = document.getElementById('camAzimuth');
        const elevation = document.getElementById('camElevation');
        const distance = document.getElementById('camDistance');
        const zoom = document.getElementById('camZoomSlider');
        const preview = document.getElementById('camPromptPreview');
        const azMap = [[0,'front view'],[45,'three-quarter front-right view'],[90,'right-side view'],[135,'three-quarter back-right view'],[180,'back view'],[225,'three-quarter back-left view'],[270,'left-side view'],[315,'three-quarter front-left view']];
        const elMap = [[-90,"worm's-eye view"],[-60,'extreme low-angle shot'],[-30,'low-angle shot'],[0,'eye-level shot'],[30,'slightly high-angle shot'],[60,'high-angle shot'],[90,'top-down view']];
        const dsMap = [[0.6,'extreme close-up'],[0.8,'close-up'],[1.0,'medium close-up'],[1.4,'medium shot'],[2.0,'full shot'],[3.0,'wide shot'],[4.0,'extreme wide shot']];
        const preserve = '. Strictly preserve the subject\'s pose, gesture, facial expression and body posture. Keep the background, environment, lighting, color grading and shadows completely unchanged. Only reconstruct the camera angle of the main subject, do not alter any other element in the scene.';

        function buildCameraPrompt() {
            return '<sks> ' + nearestReferenceMap(azMap, azimuth.value) + ' ' + nearestReferenceMap(elMap, elevation.value) + ' ' + nearestReferenceMap(dsMap, distance.value) + ' shot' + preserve;
        }

        function drawCameraStage(image) {
            if (!canvas) return;
            const context = canvas.getContext('2d');
            if (!context) return;
            const width = canvas.width;
            const height = canvas.height;
            context.fillStyle = '#242424';
            context.fillRect(0, 0, width, height);
            context.strokeStyle = 'rgba(255,255,255,.08)';
            context.lineWidth = 1;
            for (let x = 0; x <= width; x += 32) { context.beginPath(); context.moveTo(x, height * .55); context.lineTo(width / 2 + (x - width / 2) * .35, height); context.stroke(); }
            for (let y = height * .55; y <= height; y += 24) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
            if (image) {
                const maxW = width * .34;
                const maxH = height * .5;
                const ratio = Math.min(maxW / image.naturalWidth, maxH / image.naturalHeight);
                const drawW = image.naturalWidth * ratio;
                const drawH = image.naturalHeight * ratio;
                context.drawImage(image, width / 2 - drawW / 2, height * .52 - drawH / 2, drawW, drawH);
            }
            const angle = Number(azimuth.value) * Math.PI / 180;
            const radius = 88 / Math.max(.6, Number(distance.value));
            const cameraX = width / 2 + Math.sin(angle) * radius;
            const cameraY = height * .55 - Math.cos(angle) * radius * .42 - Number(elevation.value) * .35;
            context.strokeStyle = '#54c2ff'; context.beginPath(); context.arc(width / 2, height * .55, Math.max(34, radius), 0, Math.PI * 2); context.stroke();
            context.fillStyle = '#ff9438'; context.beginPath(); context.arc(cameraX, cameraY, 8, 0, Math.PI * 2); context.fill();
        }

        function updateCameraUi() {
            document.getElementById('camAzVal').textContent = azimuth.value + '°';
            document.getElementById('camElVal').textContent = elevation.value + '°';
            document.getElementById('camDsVal').textContent = Number(distance.value).toFixed(1);
            preview.textContent = buildCameraPrompt();
            drawCameraStage();
        }

        [azimuth, elevation, distance, zoom].forEach(function(control) { if (control) control.addEventListener('input', updateCameraUi); });
        document.getElementById('camAzReset').onclick = function() { azimuth.value = 0; updateCameraUi(); };
        document.getElementById('camElReset').onclick = function() { elevation.value = 0; updateCameraUi(); };
        document.getElementById('camDsReset').onclick = function() { distance.value = 1; updateCameraUi(); };
        document.getElementById('btnCamCapture').onclick = async function() {
            await img2ImgReadSelection();
            if (!selectedImageBase64) return;
            const image = new Image();
            image.onload = function() { drawCameraStage(image); };
            image.src = makeImageDataUrl(selectedImageBase64);
        };
        document.getElementById('btnCamGenerate').onclick = async function() {
            const route = readIndependentGenerationControls('app:camera', 'cameraRoute');
            await img2Img({ prompt: buildCameraPrompt(), model: route.model, imageResolution: route.imageResolution, imageCount: route.imageCount, type: 'camera-3d', title: '3D 镜头控制', button: this, idleButtonLabel: uiIconLabel('play', '开始生成') });
        };
        updateCameraUi();
    }

    const referenceHemisynthState = {
        tab: 'semi',
        bustMode: false,
        hangOn: false,
        richness: 3,
        charHint: '',
        values: {},
        useRefs: false
    };

    function getReferenceHemisynthTemplateKey() {
        if (referenceHemisynthState.tab === 'semi') {
            if (referenceHemisynthState.bustMode) return 'semiBust';
            return referenceHemisynthState.hangOn ? 'semiHang' : 'semiPlain';
        }
        return referenceHemisynthState.tab === 'diorama' ? 'diorama' : 'hangonly';
    }

    function getReferenceHemisynthFields(templateText) {
        const fields = [];
        const seen = {};
        const matcher = /【填空:([^=】]+?)(?:=([^】]*))?】/g;
        let match;
        while ((match = matcher.exec(templateText || '')) !== null) {
            if (seen[match[1]]) continue;
            seen[match[1]] = true;
            fields.push({ name: match[1], defaultValue: match[2] || '' });
        }
        return fields;
    }

    function renderReferenceHemisynthEditor() {
        const title = document.getElementById('appEditorTitle');
        const desc = document.getElementById('appEditorDesc');
        const body = document.getElementById('appEditorBody');
        if (title) title.textContent = '半合成';
        if (desc) desc.textContent = '现场布景化 / 手办地台 / 垂悬环绕物';
        if (!body) return;
        body.className = 'app-editor-body reference-ui-root';

        const templateKey = getReferenceHemisynthTemplateKey();
        const templates = window._hemisynthPrompts || {};
        const template = templates[templateKey] || { label: templateKey, text: '' };
        const fields = getReferenceHemisynthFields(template.text);
        if (!referenceHemisynthState.values[templateKey]) referenceHemisynthState.values[templateKey] = {};
        const values = referenceHemisynthState.values[templateKey];
        const richnessLabels = { 1: '极简', 2: '简洁', 3: '适中', 4: '丰富', 5: '极繁' };
        const densityOptions = ['', '极简', '简洁', '适中', '丰富', '极繁'];
        const heightOptions = ['', '头顶', '肩部', '胸部', '腰部'];
        const hemisynthRouteControls = buildIndependentGenerationControls('app:hemisynth', 'hemisynthRoute', '半合成独立生成参数');

        function fieldHtml(field) {
            const value = values[field.name] != null ? values[field.name] : '';
            if (field.name === '道具密度' || field.name === '物体高度') {
                const options = field.name === '道具密度' ? densityOptions : heightOptions;
                return '<div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">' + escapeHTML(field.name) + '</div></div><div class="w10-row-right"><select class="w10-select hs-field" data-field="' + escapeHTML(field.name) + '">' + options.map(function(option) {
                    const label = option || (field.name === '道具密度' ? '自动（默认适中）' : '自动（默认头顶齐平）');
                    return '<option value="' + escapeHTML(option) + '"' + (option === value ? ' selected' : '') + '>' + escapeHTML(label) + '</option>';
                }).join('') + '</select></div></div>';
            }
            return '<div class="w10-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:6px 0"><div class="w10-row-label">' + escapeHTML(field.name) + '</div><textarea class="w10-input hs-field" data-field="' + escapeHTML(field.name) + '" rows="1" placeholder="留空 = AI 按角色属性/看图自动判定">' + escapeHTML(value) + '</textarea></div>';
        }

        body.innerHTML = ''
            + '<div class="module-card w10-panel hemisynth-panel">'
            + '  <div class="sf-pill" id="hsTabs"><div class="sf-pill-opt' + (referenceHemisynthState.tab === 'semi' ? ' active' : '') + '" data-tab="semi">半合成</div><div class="sf-pill-opt' + (referenceHemisynthState.tab === 'diorama' ? ' active' : '') + '" data-tab="diorama">手办地台</div><div class="sf-pill-opt' + (referenceHemisynthState.tab === 'hangonly' ? ' active' : '') + '" data-tab="hangonly">垂悬环绕物</div></div>'
            + (referenceHemisynthState.tab === 'semi' ? '<div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">半身像兼容模式</div><div class="w10-row-desc">' + (referenceHemisynthState.bustMode ? '开启：不做地面，用四类悬浮/前景元素' : '关闭：标准全身布景（地面+道具）') + '</div></div><div class="w10-row-right"><div class="w10-toggle' + (referenceHemisynthState.bustMode ? ' on' : '') + '" id="hsBustTog"></div></div></div><div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">垂悬环绕物' + (referenceHemisynthState.bustMode ? '（半身模式下不可用）' : '') + '</div><div class="w10-row-desc">' + (referenceHemisynthState.hangOn ? '开启：布景含带状环绕悬空系统' : '关闭：只做地面布景+少量浮空点缀') + '</div></div><div class="w10-row-right"><div class="w10-toggle' + (referenceHemisynthState.hangOn ? ' on' : '') + (referenceHemisynthState.bustMode ? ' disabled' : '') + '" id="hsHangTog"></div></div></div>' : '')
            + '  <div class="w10-section-title" style="display:flex;align-items:center;justify-content:space-between"><span>参数（留空则 AI 自动判定）</span><button class="w10-btn" id="hsAutoBtn" type="button">' + uiIconLabel('bolt', '自动识别') + '</button></div>'
            + '  <div class="w10-row" style="flex-direction:column;align-items:stretch"><div style="display:flex;justify-content:space-between"><div class="w10-row-label">自动识别丰富度</div><span id="hsRichVal">' + referenceHemisynthState.richness + ' · ' + richnessLabels[referenceHemisynthState.richness] + '</span></div><input type="range" id="hsRich" min="1" max="5" step="1" value="' + referenceHemisynthState.richness + '"><div class="w10-row-desc">越往右，AI 自动识别时给出的道具/悬空元素越多、场景越饱满</div></div>'
            + '  <div class="w10-row" style="flex-direction:column;align-items:stretch"><div class="w10-row-label">角色补充信息（辅助识别 · 选填）</div><textarea class="w10-input" id="hsCharHint" rows="1" placeholder="角色名 / 出处 / 其它提示">' + escapeHTML(referenceHemisynthState.charHint) + '</textarea></div>'
            + '  <div class="hemisynth-fields">' + fields.map(fieldHtml).join('') + '</div>'
            + '  <div class="w10-section-title">生成</div>'
            + '  <div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">参考图</div><div class="w10-row-desc">沿用主生成页现有参考图</div></div><div class="w10-row-right"><div class="w10-toggle' + (referenceHemisynthState.useRefs ? ' on' : '') + '" id="hsRefTog"></div></div></div>'
            + hemisynthRouteControls
            + '  <div class="w10-row"><div class="w10-row-left"><div class="w10-row-label">宽高比</div></div><div class="w10-row-right"><select class="w10-select" id="hsAspect"><option>Auto</option><option>1:1</option><option>3:2</option><option>2:3</option><option>16:9</option><option>9:16</option><option>4:3</option><option>3:4</option></select></div></div>'
            + '  <div class="w10-row" style="border-bottom:none;flex-direction:column;align-items:stretch"><button class="w10-btn w10-btn-accent" id="hsStartBtn" type="button">' + uiIconLabel('sparkle', '生成（框选人物区域后点这里）') + '</button><div class="w10-row-desc" id="hsStatus" style="text-align:center">先在 PS 里框选人物画面，无选区则使用整张画布</div></div>'
            + '</div>';

        initAllFakeSelects(body);
        initAllRenderedRanges(body);
        bindIndependentGenerationControls('app:hemisynth', 'hemisynthRoute', body);
        body.querySelectorAll('#hsTabs [data-tab]').forEach(function(tabButton) {
            tabButton.onclick = function() { referenceHemisynthState.tab = tabButton.getAttribute('data-tab'); renderReferenceHemisynthEditor(); };
        });
        const bustToggle = document.getElementById('hsBustTog');
        if (bustToggle) bustToggle.onclick = function() { referenceHemisynthState.bustMode = !referenceHemisynthState.bustMode; renderReferenceHemisynthEditor(); };
        const hangToggle = document.getElementById('hsHangTog');
        if (hangToggle) hangToggle.onclick = function() { referenceHemisynthState.hangOn = !referenceHemisynthState.hangOn; renderReferenceHemisynthEditor(); };
        const refToggle = document.getElementById('hsRefTog');
        if (refToggle) refToggle.onclick = function() { referenceHemisynthState.useRefs = !referenceHemisynthState.useRefs; refToggle.classList.toggle('on', referenceHemisynthState.useRefs); };
        const richness = document.getElementById('hsRich');
        if (richness) richness.oninput = function() { referenceHemisynthState.richness = Number(richness.value); document.getElementById('hsRichVal').textContent = richness.value + ' · ' + richnessLabels[richness.value]; };
        const charHint = document.getElementById('hsCharHint');
        if (charHint) charHint.oninput = function() { referenceHemisynthState.charHint = charHint.value; };
        body.querySelectorAll('.hs-field').forEach(function(field) {
            field.oninput = field.onchange = function() { values[field.getAttribute('data-field')] = field.value; };
        });
        document.getElementById('hsAutoBtn').onclick = function() {
            fields.forEach(function(field) { if (!values[field.name]) values[field.name] = field.defaultValue; });
            renderReferenceHemisynthEditor();
        };
        document.getElementById('hsStartBtn').onclick = async function() {
            fields.forEach(function(field) {
                const control = body.querySelector('[data-field="' + field.name + '"]');
                if (control) values[field.name] = control.value;
            });
            const prompt = String(template.text || '').replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, function(_all, name, defaultValue) {
                return values[name] || defaultValue || '';
            });
            const route = readIndependentGenerationControls('app:hemisynth', 'hemisynthRoute');
            await img2Img({ prompt: prompt, model: route.model, imageResolution: route.imageResolution, imageCount: route.imageCount, type: 'hemisynth', title: '半合成', button: this, idleButtonLabel: uiIconLabel('sparkle', '生成（框选人物区域后点这里）') });
        };
    }

    const referenceKaoEffects = [
        ['particleDensity', '细沙状粒子逸散', 0.70],
        ['distortion', '接触面扭曲解离', 0.60],
        ['heatHaze', '粒子周围热空气折射', 0.60],
        ['chromatic', '粒子边缘色散', 0.40],
        ['flocculent', '细小组絮状粒子', 0.50],
        ['fadeSpeed', '主粒子褪散至无色', 0.60],
        ['hideLines', '隐藏原始线条痕迹', 0.70],
        ['fresnel', '菲涅尔能量（按明暗）', 0.70],
        ['edgeWarp', '图形边缘光线扭曲', 0.50],
        ['selfGlowLuma', '自发光范围（明度联动）', 0.60],
        ['densityByTransparency', '粒子密度（基于线条透明度）', 0.60]
    ];

    const referenceKaoState = {
        mainType: 'original',
        secondaryType: 'none',
        mix: 0.30,
        effects: {},
        ior: 1.33,
        iorOn: true,
        noiseRange: 0.50,
        noiseAmp: 0.50,
        noiseOn: true,
        blur: 0.50,
        blurOn: true,
        fresnelSpread: 0.50,
        fresnelOn: true,
        gravity: 0.50,
        gravityOn: true
    };
    referenceKaoEffects.forEach(function(effect) {
        referenceKaoState.effects[effect[0]] = { weight: effect[2], enabled: true };
    });

    function renderReferenceKaoEditor() {
        const title = document.getElementById('appEditorTitle');
        const desc = document.getElementById('appEditorDesc');
        const body = document.getElementById('appEditorBody');
        if (title) title.textContent = 'VFX 特效（尻粒子）';
        if (desc) desc.textContent = '粒子类型 / 11 项特效 / 物理光学 / 图生图生成';
        if (!body) return;
        body.className = 'app-editor-body reference-ui-root';

        const typeOptions = [
            ['none', '无'], ['original', '影视级流体'], ['energy', '能量自发光'],
            ['volumetric', '体积云'], ['smoke', '烟雾'], ['hair', '毛发'], ['burn', '燃烧']
        ];
        const renderOptions = function(selected) {
            return typeOptions.map(function(option) {
                return '<option value="' + option[0] + '"' + (selected === option[0] ? ' selected' : '') + '>' + option[1] + '</option>';
            }).join('');
        };
        const rangeRow = function(label, id, value, min, max, step, valueText, toggleKey, enabled) {
            return '<div class="kao-control-card">'
                + '<div class="kao-control-head"><span class="w10-row-label">' + escapeHTML(label) + '</span><span class="w10-ps-val" id="' + id + 'Val">' + escapeHTML(valueText) + '</span></div>'
                + '<div class="kao-control-track"><input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '"' + (enabled === false ? ' disabled' : '') + '>'
                + (toggleKey ? '<div class="w10-toggle' + (enabled === false ? '' : ' on') + '" data-kao-toggle="' + toggleKey + '"></div>' : '') + '</div>'
                + '</div>';
        };

        const effectsHtml = referenceKaoEffects.map(function(effect) {
            const current = referenceKaoState.effects[effect[0]];
            return rangeRow(effect[1], 'kaoFx_' + effect[0], current.weight, 0, 1, 0.01, current.weight.toFixed(2), 'effect:' + effect[0], current.enabled);
        }).join('');
        const kaoRouteControls = buildIndependentGenerationControls('app:kao-vfx', 'kaoRoute', '尻粒子独立生成参数');

        body.innerHTML = ''
            + '<div class="module-card w10-panel kao-panel">'
            + '  <div class="w10-section-title">粒子类型</div>'
            + '  <div class="kao-two-column">'
            + '    <div class="kao-select-card"><label>主粒子</label><select class="w10-select" id="kaoMainType">' + renderOptions(referenceKaoState.mainType) + '</select></div>'
            + '    <div class="kao-select-card"><label>辅粒子</label><select class="w10-select" id="kaoSecondaryType">' + renderOptions(referenceKaoState.secondaryType) + '</select></div>'
            + '  </div>'
            + rangeRow('辅助混合占比', 'kaoMix', referenceKaoState.mix, 0, 1, 0.01, Math.round(referenceKaoState.mix * 100) + '%', '', true)
            + '  <div class="w10-section-title">粒子特效（11 项）</div>'
            + '  <div class="kao-effects-grid">' + effectsHtml + '</div>'
            + '  <div class="w10-section-title">物理 / 光学</div>'
            + '  <div class="kao-effects-grid">'
            + rangeRow('折射率 IOR', 'kaoIor', referenceKaoState.ior, 1, 2, 0.01, referenceKaoState.ior.toFixed(2), 'iorOn', referenceKaoState.iorOn)
            + rangeRow('噪波影响范围', 'kaoNoiseRange', referenceKaoState.noiseRange, 0, 1, 0.01, referenceKaoState.noiseRange.toFixed(2), 'noiseOn', referenceKaoState.noiseOn)
            + rangeRow('噪波幅度（细密度）', 'kaoNoiseAmp', referenceKaoState.noiseAmp, 0, 1, 0.01, referenceKaoState.noiseAmp.toFixed(2), '', referenceKaoState.noiseOn)
            + rangeRow('动态模糊（运动拖尾）', 'kaoBlur', referenceKaoState.blur, 0, 1, 0.01, referenceKaoState.blur.toFixed(2), 'blurOn', referenceKaoState.blurOn)
            + rangeRow('菲涅尔边缘 / 表面蔓延', 'kaoFresnelSpread', referenceKaoState.fresnelSpread, 0, 1, 0.01, referenceKaoState.fresnelSpread.toFixed(2), 'fresnelOn', referenceKaoState.fresnelOn)
            + rangeRow('重力强度', 'kaoGravity', referenceKaoState.gravity, 0, 1, 0.01, referenceKaoState.gravity.toFixed(2), 'gravityOn', referenceKaoState.gravityOn)
            + '  </div>'
            + '  <div class="w10-section-title">生成</div>'
            + kaoRouteControls
            + '  <div class="kao-generation-grid">'
            + '    <div class="kao-select-card"><label>宽高比</label><select class="w10-select" id="kaoAspect"><option>Auto</option><option>1:1</option><option>3:2</option><option>2:3</option><option>16:9</option><option>9:16</option><option>4:3</option><option>3:4</option></select></div>'
            + '  </div>'
            + '  <div class="kao-actions"><button class="w10-btn" id="kaoRandomBtn" type="button">' + uiIconLabel('dice', '尻子大爆炸（随机所有参数）') + '</button><div class="btn-row"><button class="w10-btn" id="kaoDisableBtn" type="button">关闭所有粒子</button><button class="w10-btn w10-btn-accent" id="kaoStartBtn" type="button">' + uiIconLabel('sparkle', '生成特效') + '</button></div><div class="w10-row-desc" id="kaoStatus">先在 Photoshop 中框选需要生成特效的区域</div></div>'
            + '</div>';

        initAllFakeSelects(body);
        initAllRenderedRanges(body);
        bindIndependentGenerationControls('app:kao-vfx', 'kaoRoute', body);

        const bindRange = function(id, target, key, formatter) {
            const control = document.getElementById(id);
            if (!control) return;
            control.oninput = function() {
                target[key] = Number(control.value);
                const value = document.getElementById(id + 'Val');
                if (value) value.textContent = formatter(target[key]);
            };
        };
        bindRange('kaoMix', referenceKaoState, 'mix', function(value) { return Math.round(value * 100) + '%'; });
        referenceKaoEffects.forEach(function(effect) {
            bindRange('kaoFx_' + effect[0], referenceKaoState.effects[effect[0]], 'weight', function(value) { return value.toFixed(2); });
        });
        bindRange('kaoIor', referenceKaoState, 'ior', function(value) { return value.toFixed(2); });
        bindRange('kaoNoiseRange', referenceKaoState, 'noiseRange', function(value) { return value.toFixed(2); });
        bindRange('kaoNoiseAmp', referenceKaoState, 'noiseAmp', function(value) { return value.toFixed(2); });
        bindRange('kaoBlur', referenceKaoState, 'blur', function(value) { return value.toFixed(2); });
        bindRange('kaoFresnelSpread', referenceKaoState, 'fresnelSpread', function(value) { return value.toFixed(2); });
        bindRange('kaoGravity', referenceKaoState, 'gravity', function(value) { return value.toFixed(2); });
        document.getElementById('kaoMainType').onchange = function(event) { referenceKaoState.mainType = event.target.value; };
        document.getElementById('kaoSecondaryType').onchange = function(event) { referenceKaoState.secondaryType = event.target.value; };
        body.querySelectorAll('[data-kao-toggle]').forEach(function(toggle) {
            toggle.onclick = function() {
                const key = toggle.getAttribute('data-kao-toggle');
                if (key.indexOf('effect:') === 0) {
                    const effectId = key.slice(7);
                    const state = referenceKaoState.effects[effectId];
                    state.enabled = !state.enabled;
                    const control = document.getElementById('kaoFx_' + effectId);
                    if (control) control.disabled = !state.enabled;
                    toggle.classList.toggle('on', state.enabled);
                    return;
                }
                referenceKaoState[key] = !referenceKaoState[key];
                toggle.classList.toggle('on', referenceKaoState[key]);
                const slaves = {
                    iorOn: ['kaoIor'], noiseOn: ['kaoNoiseRange', 'kaoNoiseAmp'],
                    blurOn: ['kaoBlur'], fresnelOn: ['kaoFresnelSpread'], gravityOn: ['kaoGravity']
                }[key] || [];
                slaves.forEach(function(id) { const control = document.getElementById(id); if (control) control.disabled = !referenceKaoState[key]; });
            };
        });
        document.getElementById('kaoRandomBtn').onclick = function() {
            referenceKaoState.mix = Math.random();
            referenceKaoEffects.forEach(function(effect) {
                referenceKaoState.effects[effect[0]].weight = Math.random();
                referenceKaoState.effects[effect[0]].enabled = Math.random() > 0.15;
            });
            referenceKaoState.ior = 1 + Math.random();
            referenceKaoState.noiseRange = Math.random();
            referenceKaoState.noiseAmp = Math.random();
            referenceKaoState.blur = Math.random();
            referenceKaoState.fresnelSpread = Math.random();
            referenceKaoState.gravity = Math.random();
            renderReferenceKaoEditor();
        };
        document.getElementById('kaoDisableBtn').onclick = function() {
            referenceKaoEffects.forEach(function(effect) { referenceKaoState.effects[effect[0]].enabled = false; });
            renderReferenceKaoEditor();
        };
        document.getElementById('kaoStartBtn').onclick = async function() {
            const enabledEffects = referenceKaoEffects.filter(function(effect) { return referenceKaoState.effects[effect[0]].enabled; }).map(function(effect) {
                return effect[1] + '（强度 ' + referenceKaoState.effects[effect[0]].weight.toFixed(2) + '）';
            });
            const prompt = '8K/4K 超高清细节，照片级真实渲染，Houdini 粒子系统。基于参考图绘制线条区域生成影视级 VFX；主粒子：' + document.getElementById('kaoMainType').options[document.getElementById('kaoMainType').selectedIndex].textContent + '；辅粒子：' + document.getElementById('kaoSecondaryType').options[document.getElementById('kaoSecondaryType').selectedIndex].textContent + '，混合占比 ' + Math.round(referenceKaoState.mix * 100) + '%。启用效果：' + (enabledEffects.join('、') || '关闭粒子，仅保留原图') + '。折射率 ' + referenceKaoState.ior.toFixed(2) + '，噪波范围 ' + referenceKaoState.noiseRange.toFixed(2) + '，噪波幅度 ' + referenceKaoState.noiseAmp.toFixed(2) + '，动态模糊 ' + referenceKaoState.blur.toFixed(2) + '，菲涅尔蔓延 ' + referenceKaoState.fresnelSpread.toFixed(2) + '，重力 ' + referenceKaoState.gravity.toFixed(2) + '。严格保留人物身份、姿态、面部和背景，仅在线条指示区域生成特效。';
            const route = readIndependentGenerationControls('app:kao-vfx', 'kaoRoute');
            await img2Img({ prompt: prompt, model: route.model, imageResolution: route.imageResolution, imageCount: route.imageCount, type: 'kao-vfx', title: 'VFX 特效（尻粒子）', button: this, idleButtonLabel: uiIconLabel('sparkle', '生成特效') });
        };
    }

    function setAppsEditorVisible(mode) {
        const vfxEditor = document.getElementById('vfxAppEditor');
        const genericEditor = document.getElementById('appEditor');
        const home = document.getElementById('appsHome');
        const runninghubHome = document.getElementById('runninghubHome');
        appsViewMode = mode || 'home';
        if (home) home.style.display = appsViewMode === 'home' && appsReturnTab !== 'runninghub' ? '' : 'none';
        if (runninghubHome) runninghubHome.style.display = appsViewMode === 'home' && appsReturnTab === 'runninghub' ? '' : 'none';
        if (vfxEditor) vfxEditor.style.display = appsViewMode === 'vfx' ? '' : 'none';
        const appsContent = document.getElementById('apps');
        const runninghubContent = document.getElementById('runninghub');
        const managesCurrentPage = !!(
            (appsContent && appsContent.classList.contains('active')) ||
            (runninghubContent && runninghubContent.classList.contains('active'))
        );
        if (managesCurrentPage) {
            if (appsContent) appsContent.classList.toggle('active', appsReturnTab !== 'runninghub');
            if (runninghubContent) runninghubContent.classList.toggle('active', appsReturnTab === 'runninghub');
        }
        if (genericEditor) genericEditor.style.display = (appsViewMode !== 'home' && appsViewMode !== 'vfx') ? '' : 'none';
    }

    function openAppCategory(categoryId, meta) {
        currentAppCategory = categoryId || '';
        const editorBody = document.getElementById('appEditorBody');
        if (editorBody) editorBody.className = 'app-editor-body';
        if (categoryId === 'vfx') {
            openToolEditor('vfx', 'apps');
            return;
        }
        if (categoryId === 'kao-vfx' || (meta && meta.editorType === 'kao-vfx-placeholder')) {
            appEditorMeta = meta || { id: 'kao-vfx', title: 'VFX 特效（尻粒子）', desc: '快速界面独立 VFX' };
            const title = document.getElementById('appEditorTitle');
            const desc = document.getElementById('appEditorDesc');
            const body = document.getElementById('appEditorBody');
            if (title) title.textContent = appEditorMeta.title;
            if (desc) desc.textContent = appEditorMeta.desc;
            renderReferenceKaoEditor();
            setAppsEditorVisible('kao-vfx');
            return;
        }
        if (categoryId === 'camera-ui' || (meta && meta.editorType === 'camera-ui')) {
            appEditorMeta = meta || { id: 'camera-ui', title: '3D 镜头控制', desc: '镜头角度 + AI 重构' };
            renderReferenceCameraEditor();
            setAppsEditorVisible('camera-ui');
            return;
        }
        if (categoryId === 'hemisynth-ui' || (meta && meta.editorType === 'hemisynth-ui')) {
            appEditorMeta = meta || { id: 'hemisynth-ui', title: '半合成', desc: '现场布景化 / 手办地台 / 垂悬环绕物' };
            renderReferenceHemisynthEditor();
            setAppsEditorVisible('hemisynth-ui');
            return;
        }
        if (categoryId === 'composite-assistant') {
            appEditorMeta = meta || { id: 'composite-assistant', title: '合成辅助器', desc: '图片转深度、法线、分割、雾效等合成辅助图' };
            renderCompositeAssistantEditor();
            setAppsEditorVisible('composite-assistant');
            return;
        }
        if (categoryId === 'effect-transfer' || (meta && meta.editorType === 'effect-transfer')) {
            appEditorMeta = meta || { id: 'effect-transfer', title: '特效迁移', desc: '两种方案迁移特效、材质与光影。' };
            renderEffectTransferEditor();
            setAppsEditorVisible('effect-transfer');
            return;
        }
        if (categoryId === 'upscale' || (meta && meta.editorType === 'ai-super-resolution')) {
            appEditorMeta = meta || { id: 'upscale', title: 'AI超清', desc: '自动切片 Nano Banana 2 4K 超清放大。' };
            renderAiSuperResolutionEditor();
            setAppsEditorVisible('ai-super-resolution');
            return;
        }
        currentRunninghubFieldValues = {};
        const normalizedMeta = normalizeRunninghubAppMetaForRuntime(meta ? Object.assign({}, meta) : {});
        const normalizedInputs = Array.isArray(normalizedMeta.inputs) ? normalizedMeta.inputs : [];
        normalizedInputs.forEach(function(field) {
            if (field.defaultValue != null && currentRunninghubFieldValues[field.key] == null && field.type !== 'image') {
                currentRunninghubFieldValues[field.key] = field.type === 'boolean' ? !!field.defaultValue : field.defaultValue;
            }
        });
        renderGenericAppEditor(normalizedMeta);
        setAppsEditorVisible(categoryId || 'generic');
    }

    function closeAppCategory() {
        const returnTab = appsReturnTab;
        currentAppCategory = '';
        appEditorMeta = null;
        setAppsEditorVisible('home');
        if (returnTab === 'runninghub') {
            switchTab('runninghub');
        } else {
            switchTab('apps');
        }
        appsReturnTab = 'apps';
    }

    function getRunninghubAppIdentity(app) {
        return normalizeRunninghubAppId(app && (app.appId || app.webappId || app.webAppId || app.workflowId || app.id || ''));
    }

    function removeRunninghubApp(appId) {
        const id = normalizeRunninghubAppId(appId);
        if (!id) return;
        runninghubApps = runninghubApps.filter(function(app) {
            return getRunninghubAppIdentity(app) !== id;
        });
        if (normalizeRunninghubAppId(currentAppCategory) === id) {
            closeAppCategory();
        }
        renderRunninghubAppList();
        renderAppsHome();
        persistRunninghubApps();
    }

    function toggleRunninghubAppEnabled(appId, enabled) {
        const id = normalizeRunninghubAppId(appId);
        runninghubApps = runninghubApps.map(function(app) {
            if (getRunninghubAppIdentity(app) !== id) {
                return app;
            }
            return Object.assign({}, app, { enabled: !!enabled });
        });
        if (normalizeRunninghubAppId(currentAppCategory) === id && enabled === false) {
            closeAppCategory();
        }
        renderRunninghubAppList();
        renderAppsHome();
        persistRunninghubApps();
    }

    function isUselessRunninghubField(field) {
        if (!field || typeof field !== 'object') return true;
        if (field.type === 'image') return false;
        var key = String(field.key || '').trim().toLowerCase();
        var fieldName = String(field.fieldName || '').trim().toLowerCase();
        var label = String(field.label || '').trim().toLowerCase();
        var joined = [key, fieldName, label].filter(Boolean).join(' ');
        if (!joined) return true;
        if (isWeakRunninghubLabel(label) && isWeakRunninghubLabel(fieldName) && isWeakRunninghubLabel(key)) return true;
        if (/^param_\d+$/.test(key) && !label) return true;
        if (/schema|jsonschema|workflowjson|nodeinfolist|fielddata|inputtype/.test(joined)) return true;
        return false;
    }

    function getRunninghubLogsByAppId(appId) {
        var target = String(appId || '').trim();
        if (!target) return [];
        return (Config.getLogs() || []).filter(function(log) {
            return String(log && log.runninghubAppId || '').trim() === target;
        }).slice(0, 12);
    }

    function renderRunninghubAppLogs(appId) {
        var logs = getRunninghubLogsByAppId(appId);
        if (!logs.length) {
            return '<div class="module-card"><div class="card-title">运行日志</div><div class="info-text">当前应用还没有运行日志</div></div>';
        }
        return '<div class="module-card"><div class="card-title">运行日志</div><div class="field-stack">' + logs.map(function(log) {
            var status = escapeHTML(log.status || '记录');
            var time = escapeHTML(log.timestamp || '');
            var detail = escapeHTML(log.error || log.message || log.prompt || '');
            var taskId = escapeHTML(log.runninghubTaskId || '');
            return ''
                + '<div class="settings-card field-stack">'
                + '<div class="btn-row"><div class="card-title" style="margin:0;">' + status + '</div><div class="info-text">' + time + '</div></div>'
                + (taskId ? '<div class="info-text">taskId：' + taskId + '</div>' : '')
                + (detail ? '<div class="info-text">' + detail + '</div>' : '')
                + '</div>';
        }).join('') + '</div></div>';
    }

    function getRunninghubFieldValue(field) {
        const rawValue = currentRunninghubFieldValues[field.key];
        if (field.type === 'boolean') {
            return !!rawValue;
        }
        if (field.type === 'number') {
            if (rawValue === '' || rawValue == null) return '';
            const parsed = Number(rawValue);
            return Number.isFinite(parsed) ? parsed : rawValue;
        }
        if (field.type === 'image') {
            if (rawValue && rawValue.uploadToken) return rawValue.uploadToken;
            if (rawValue && rawValue.value) return rawValue.value;
            if (rawValue && rawValue.url) return rawValue.url;
            return '';
        }
        return rawValue == null ? '' : rawValue;
    }

    function dataUrlToBlob(dataUrl) {
        const value = String(dataUrl || '');
        const match = value.match(/^data:([^;,]+);base64,(.+)$/i);
        const mimeType = match ? match[1] : 'image/png';
        const base64 = match ? match[2] : value;
        const bytes = new Uint8Array(base64ToArrayBuffer(base64.replace(/\s+/g, '')));
        return new Blob([bytes], { type: mimeType });
    }

    function pickRunninghubUploadedValue(data) {
        const source = data && typeof data === 'object' ? data : {};
        const token = String(source.fileName || source.filename || source.fileKey || source.key || '').trim();
        const url = String(source.url || source.fileUrl || source.download_url || source.downloadUrl || '').trim();
        return token || url;
    }

    async function uploadRunninghubImageValue(apiKey, imageValue) {
        if (!imageValue) return '';
        if (typeof imageValue === 'string' && /^https?:\/\//i.test(imageValue.trim())) return imageValue.trim();
        if (imageValue.value && typeof imageValue.value === 'string') return imageValue.value.trim();
        if (imageValue.url && typeof imageValue.url === 'string') return imageValue.url.trim();
        const dataUrl = imageValue.dataUrl || imageValue.base64 || imageValue;
        const blob = dataUrlToBlob(makeImageDataUrl(String(dataUrl || '')));
        const mimeType = blob.type || 'image/jpeg';
        const fileName = mimeType === 'image/png' ? 'image.png' : (mimeType === 'image/webp' ? 'image.webp' : 'image.jpg');
        const endpoints = [
            'https://www.runninghub.cn/openapi/v2/media/upload/binary',
            'https://www.runninghub.cn/uc/openapi/upload'
        ];
        let lastError = null;
        for (let i = 0; i < endpoints.length; i++) {
            try {
                const formData = new FormData();
                formData.append('file', blob, fileName);
                const payload = await fetchRunninghubJson(endpoints[i], {
                    method: 'POST',
                    headers: { Authorization: 'Bearer ' + apiKey },
                    body: formData
                });
                const picked = pickRunninghubUploadedValue(payload && (payload.data || payload.result) || payload);
                if (picked) return picked;
                lastError = new Error((payload && (payload.message || payload.msg)) || '图片上传后未返回 token');
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error('图片上传失败');
    }

    async function ensureRunninghubUploadedImages(appMeta, apiKey) {
        const inputs = Array.isArray(appMeta && appMeta.inputs) ? appMeta.inputs : [];
        for (let i = 0; i < inputs.length; i++) {
            const field = inputs[i];
            if (!field || field.type !== 'image') continue;
            const rawValue = currentRunninghubFieldValues[field.key];
            if (!rawValue) {
                if (!field.required) {
                    const token = await uploadRunninghubImageValue(apiKey, BLANK_RUNNINGHUB_IMAGE_BASE64);
                    currentRunninghubFieldValues[field.key] = { uploadToken: token, value: token };
                }
                continue;
            }
            if (rawValue.uploadToken) continue;
            if (rawValue.value && !rawValue.base64 && !rawValue.dataUrl) continue;
            if (!rawValue.base64 && !rawValue.dataUrl) {
                if (!field.required) {
                    const token = await uploadRunninghubImageValue(apiKey, BLANK_RUNNINGHUB_IMAGE_BASE64);
                    currentRunninghubFieldValues[field.key] = Object.assign({}, rawValue, { uploadToken: token, value: token });
                }
                continue;
            }
            const token = await uploadRunninghubImageValue(apiKey, rawValue);
            currentRunninghubFieldValues[field.key] = Object.assign({}, rawValue, {
                uploadToken: token,
                value: token
            });
        }
    }

    function validateRunninghubRequiredFields(appMeta) {
        const inputs = Array.isArray(appMeta && appMeta.inputs) ? appMeta.inputs : [];
        const missing = inputs.filter(function(field) {
            if (!field.required) return false;
            const value = currentRunninghubFieldValues[field.key];
            if (field.type === 'boolean') return false;
            if (field.type === 'image') return !(value && value.base64);
            return value == null || String(value).trim() === '';
        });
        if (missing.length) {
            throw new Error('请先填写必填项：' + missing.map(function(field) {
                return field.label || field.key;
            }).join('、'));
        }
    }

    function buildRunninghubNodeInfoList(appMeta) {
        const inputs = Array.isArray(appMeta && appMeta.inputs) ? appMeta.inputs : [];
        return inputs.map(function(field, index) {
            const fieldValue = getRunninghubFieldValue(field);
            const payload = {
                nodeId: field.nodeId || field.key || String(index + 1),
                fieldName: field.fieldName || field.key,
                fieldValue: fieldValue
            };
            if (field.fieldType) payload.fieldType = field.fieldType;
            if (field.fieldData != null && field.type !== 'image') payload.fieldData = field.fieldData;
            return payload;
        });
    }

    function buildRunninghubLegacyNodeParams(appMeta) {
        const params = {};
        const inputs = Array.isArray(appMeta && appMeta.inputs) ? appMeta.inputs : [];
        inputs.forEach(function(field) {
            const value = getRunninghubFieldValue(field);
            params[field.key] = value;
            if (field.fieldName) params[field.fieldName] = value;
            if (field.name) params[field.name] = value;
        });
        return params;
    }

    function extractRunninghubTaskId(payload) {
        if (!payload) return '';
        if (typeof payload === 'string') {
            const text = payload.trim();
            return /^\d{6,}$/.test(text) ? text : '';
        }
        if (Array.isArray(payload)) {
            for (let i = 0; i < payload.length; i++) {
                const found = extractRunninghubTaskId(payload[i]);
                if (found) return found;
            }
            return '';
        }
        if (typeof payload !== 'object') return '';
        const directKeys = ['taskId', 'taskID', 'task_id', 'taskid', 'webappTaskId', 'webAppTaskId', 'webappTaskID', 'id', 'jobId', 'job_id', 'runId', 'run_id'];
        for (let i = 0; i < directKeys.length; i++) {
            const direct = payload[directKeys[i]];
            if (direct != null && String(direct).trim()) {
                return String(direct).trim();
            }
        }
        const nestedKeys = ['data', 'result', 'payload', 'output', 'outputs', 'task', 'taskInfo', 'webappTask', 'webAppTask'];
        for (let j = 0; j < nestedKeys.length; j++) {
            const nested = payload[nestedKeys[j]];
            const found = extractRunninghubTaskId(nested);
            if (found) return found;
        }
        return '';
    }

    function getRunninghubPayloadErrorMessage(payload) {
        if (!payload || typeof payload !== 'object') return '';
        const message = payload.message || payload.msg || payload.error || payload.errMsg || payload.detail;
        if (message) return String(message);
        if (payload.data && typeof payload.data === 'object') {
            return getRunninghubPayloadErrorMessage(payload.data);
        }
        if (payload.result && typeof payload.result === 'object') {
            return getRunninghubPayloadErrorMessage(payload.result);
        }
        return '';
    }

    function isRunninghubTaskFinished(payload) {
        const statusText = String(
            (payload && (payload.status || payload.taskStatus || payload.state || payload.phase))
            || (payload && payload.data && (payload.data.status || payload.data.taskStatus || payload.data.state))
            || ''
        ).toLowerCase();
        if (!statusText) {
            const imageUrl = extractImageFromResponse(payload);
            return !!imageUrl;
        }
        if (['success', 'succeed', 'succeeded', 'done', 'completed', 'finish', 'finished'].indexOf(statusText) > -1) {
            return true;
        }
        if (['failed', 'error', 'cancelled', 'canceled', 'timeout', 'rejected'].indexOf(statusText) > -1) {
            throw new Error((payload && (payload.message || payload.msg || payload.error)) || 'RunningHub 任务失败');
        }
        return false;
    }

    function extractRunninghubWebappId(appMeta) {
        var candidates = [
            appMeta && appMeta.appId,
            appMeta && appMeta.webappId,
            appMeta && appMeta.webAppId,
            appMeta && appMeta.webappID,
            appMeta && appMeta.webAppID,
            appMeta && appMeta.workflowId,
            appMeta && appMeta.id
        ];
        for (var i = 0; i < candidates.length; i++) {
            var value = normalizeRunninghubAppId(candidates[i]);
            if (/^\d+$/.test(value)) return value;
        }
        return '';
    }

    function isRunninghubParameterShapeError(message) {
        const marker = String(message || '').toLowerCase();
        return marker.indexOf('webappid cannot be null') > -1
            || marker.indexOf('param apikey is required') > -1
            || marker.indexOf('param api key is required') > -1;
    }

    async function submitRunninghubTask(appMeta) {
        const apiKey = getRunninghubApiKey();
        if (!apiKey) {
            throw new Error('请先在设置中填写 RunningHub API Key');
        }
        const appId = extractRunninghubWebappId(appMeta);
        if (!appId) {
            throw new Error('RunningHub 应用 ID 为空，请在应用概览里填写完整 webappId 后保存');
        }
        const nodeInfoList = buildRunninghubNodeInfoList(appMeta);
        const headers = {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
        };
        const bodies = [
            { apiKey: apiKey, webappId: appId, nodeInfoList: nodeInfoList },
            { apiKey: apiKey, webAppId: appId, nodeInfoList: nodeInfoList },
            { apiKey: apiKey, appId: appId, nodeInfoList: nodeInfoList }
        ];
        let lastError = null;
        for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i];
            try {
                const payload = await fetchRunninghubJson('https://www.runninghub.cn/task/openapi/ai-app/run', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(body)
                });
                const taskId = extractRunninghubTaskId(payload);
                if (taskId) {
                    return { taskId: taskId, payload: payload };
                }
                const payloadMessage = getRunninghubPayloadErrorMessage(payload);
                throw new Error(payloadMessage || '未返回 taskId');
            } catch (error) {
                lastError = error;
                if (body.webappId && error && error.message && !isRunninghubParameterShapeError(error.message)) {
                    throw new Error('RunningHub 提交失败，webappId=' + appId + '：' + error.message);
                }
            }
        }
        const legacyPayload = await fetchRunninghubJson('https://www.runninghub.cn/task/openapi/create', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                apiKey: apiKey,
                workflowId: appId,
                nodeParams: buildRunninghubLegacyNodeParams(appMeta)
            })
        });
        const legacyTaskId = extractRunninghubTaskId(legacyPayload);
        if (!legacyTaskId) {
            throw new Error(lastError ? ('RunningHub 提交失败，webappId=' + appId + '：' + lastError.message) : '提交任务失败');
        }
        return { taskId: legacyTaskId, payload: legacyPayload };
    }

    async function pollRunninghubTask(taskId) {
        const apiKey = getRunninghubApiKey();
        if (!apiKey) {
            throw new Error('请先在设置中填写 RunningHub API Key');
        }
        const headers = {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
        };
        const startedAt = Date.now();
        while (Date.now() - startedAt < 180000) {
            const payload = await fetchRunninghubJson('https://www.runninghub.cn/task/openapi/outputs', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ apiKey: apiKey, taskId: taskId })
            });
            if (isRunninghubTaskFinished(payload)) {
                return payload;
            }
            await new Promise(function(resolve) { setTimeout(resolve, 2500); });
        }
        throw new Error('任务轮询超时，请稍后去日志中查看结果');
    }

    function extractRunninghubOutputUrl(payload) {
        if (!payload) return '';
        if (typeof payload === 'string') {
            const trimmed = payload.trim().replace(/\\\//g, '/');
            if (/^(https?:\/\/|data:image\/)/i.test(trimmed) || isLikelyBase64ImageData(trimmed)) {
                return isLikelyBase64ImageData(trimmed) ? makeImageDataUrl(trimmed) : trimmed;
            }
            return '';
        }
        if (Array.isArray(payload)) {
            for (let i = 0; i < payload.length; i++) {
                const found = extractRunninghubOutputUrl(payload[i]);
                if (found) return found;
            }
            return '';
        }
        if (typeof payload !== 'object') return '';
        const preferredKeys = ['outputUrl', 'output_url', 'fileUrl', 'file_url', 'downloadUrl', 'download_url', 'url', 'imageUrl', 'image_url', 'resultUrl', 'result_url', 'uri', 'src'];
        for (let i = 0; i < preferredKeys.length; i++) {
            const value = payload[preferredKeys[i]];
            if (typeof value === 'string') {
                const normalized = value.trim().replace(/\\\//g, '/');
                if (/^(https?:\/\/|data:image\/)/i.test(normalized) || isLikelyBase64ImageData(normalized)) {
                    return isLikelyBase64ImageData(normalized) ? makeImageDataUrl(normalized) : normalized;
                }
            }
        }
        const nestedKeys = ['data', 'result', 'results', 'output', 'outputs', 'files', 'fileList', 'file_url_list', 'fileUrlList', 'images', 'imageList', 'dataList', 'payload'];
        for (let j = 0; j < nestedKeys.length; j++) {
            const found = extractRunninghubOutputUrl(payload[nestedKeys[j]]);
            if (found) return found;
        }
        return '';
    }

    async function runCurrentRunninghubApp() {
        if (!appEditorMeta || appEditorMeta.source !== 'runninghub') {
            showStatus('当前不是 RunningHub 应用', 'error');
            return;
        }
        const runBtn = document.getElementById('btnRunCurrentApp');
        const logBase = {
            timestamp: new Date().toLocaleString('zh-CN'),
            type: 'runninghub',
            model: appEditorMeta.name || 'RunningHub 应用',
            prompt: (appEditorMeta.inputs || []).map(function(field) {
                if (!field || field.type !== 'textarea') return '';
                const value = currentRunninghubFieldValues[field.key];
                return value ? String(value) : '';
            }).filter(Boolean).join(' | '),
            runninghubAppId: appEditorMeta.appId || appEditorMeta.id || ''
        };
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerHTML = '<span class="loading"></span>运行中...';
        }
        try {
            validateRunninghubRequiredFields(appEditorMeta);
            showStatus('正在上传图片并提交 RunningHub 任务...', 'info');
            await ensureRunninghubUploadedImages(appEditorMeta, getRunninghubApiKey());
            const submitResult = await submitRunninghubTask(appEditorMeta);
            Config.addLog(Object.assign({}, logBase, {
                status: '已提交',
                message: '任务已提交，正在轮询结果',
                runninghubTaskId: submitResult.taskId || ''
            }));
            renderGenericAppEditor(appEditorMeta);
            showStatus('任务已提交，正在轮询结果...', 'info');
            const result = await pollRunninghubTask(submitResult.taskId);
            const outputUrl = extractRunninghubOutputUrl(result) || extractImageFromResponse(result);
            if (outputUrl) {
                let firstImageField = null;
                (appEditorMeta.inputs || []).some(function(field) {
                    if (field && field.type === 'image') {
                        firstImageField = field;
                        return true;
                    }
                    return false;
                });
                const imageValue = firstImageField ? getRunninghubImageValue(firstImageField.key) : null;
                if (imageValue && imageValue.bounds) {
                    savedSelectionBounds = imageValue && imageValue.bounds ? imageValue.bounds : null;
                }
                const bounds = savedSelectionBounds || (imageValue && imageValue.bounds ? imageValue.bounds : null);
                const width = bounds && bounds.width ? bounds.width : 1024;
                const height = bounds && bounds.height ? bounds.height : 1024;
                await downloadAndPlaceDocument(outputUrl, width, height, appEditorMeta.name || 'RunningHub 应用', 'runninghub', new Date().toLocaleString('zh-CN'), appEditorMeta.appId || 'runninghub');
                Config.addLog(Object.assign({}, logBase, {
                    status: '成功',
                    message: '任务执行成功，结果已回写 Photoshop',
                    runninghubTaskId: submitResult.taskId || ''
                }));
                renderGenericAppEditor(appEditorMeta);
                showStatus('RunningHub 应用执行成功', 'success');
                showToast('结果已回写 Photoshop');
                return;
            }
            Config.addLog(Object.assign({}, logBase, {
                status: '完成',
                message: '任务完成，但未返回可识别图像结果',
                runninghubTaskId: submitResult.taskId || ''
            }));
            renderGenericAppEditor(appEditorMeta);
            showStatus('任务完成，但未返回可识别图像结果', 'success');
            showToast('任务已完成');
        } catch (error) {
            Config.addLog(Object.assign({}, logBase, {
                status: '失败',
                error: error.message,
                runninghubTaskId: error && error.runninghubTaskId ? error.runninghubTaskId : ''
            }));
            renderGenericAppEditor(appEditorMeta);
            showStatus('运行应用失败：' + error.message, 'error');
        } finally {
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.innerHTML = '运行应用';
            }
        }
    }



    async function captureReferenceImageFromSelection() {
        const isUxp = initCompatibility();
        if (!isUxp) {
            const upload = await pickBrowserImage('上传图片');
            return { base64: upload.base64, bounds: upload.bounds, documentId: null, label: upload.label };
        }
        if (!psAPI.app || !psAPI.core || !psAPI.imaging) {
            throw new Error('UXP模块未加载');
        }

        const bounds = await getSelectionBoundsInPixels();
        if (!bounds) {
            throw new Error('未检测到选区');
        }
        if (bounds.width <= 0 || bounds.height <= 0) {
            throw new Error('选区尺寸无效，请重新选择区域');
        }

        const base64Data = await getImageDataToBase64(bounds);
        if (!base64Data || base64Data.length <= 0) {
            throw new Error('选区图像读取失败');
        }
        await deselectAll();

        return {
            base64: normalizeReferenceImageData(base64Data),
            bounds: JSON.parse(JSON.stringify(bounds))
        };
    }

    async function duplicateSelectionToTemporaryLayer(layerName) {
        initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.action) {
            throw new Error('Photoshop API 不可用');
        }

        const tempName = String(layerName || 'VFX-Trajectory-Blur-Temp');
        const previousLayer = psAPI.app.activeDocument && psAPI.app.activeDocument.activeLayers && psAPI.app.activeDocument.activeLayers[0]
            ? psAPI.app.activeDocument.activeLayers[0]
            : null;

        await psAPI.core.executeAsModal(async function() {
            await psAPI.action.batchPlay([
                {
                    _obj: 'copyToLayer'
                },
                {
                    _obj: 'set',
                    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                    to: {
                        _obj: 'layer',
                        name: tempName
                    }
                }
            ], {
                synchronousExecution: true,
                modalBehavior: 'execute'
            });
        }, { commandName: '复制轨迹图层' });

        const duplicatedLayer = psAPI.app.activeDocument && psAPI.app.activeDocument.activeLayers && psAPI.app.activeDocument.activeLayers[0]
            ? psAPI.app.activeDocument.activeLayers[0]
            : null;

        return {
            layer: duplicatedLayer,
            previousLayer: previousLayer
        };
    }

    async function applyGaussianBlurToActiveLayer(radius) {
        initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.action) {
            throw new Error('Photoshop API 不可用');
        }

        const blurRadius = Math.max(0.1, Number(radius) || 18);
        await psAPI.core.executeAsModal(async function() {
            await psAPI.action.batchPlay([
                {
                    _obj: 'gaussianBlur',
                    radius: {
                        _unit: 'pixelsUnit',
                        _value: blurRadius
                    }
                }
            ], {
                synchronousExecution: true,
                modalBehavior: 'execute'
            });
        }, { commandName: '模糊轨迹图层' });
    }

    async function deleteLayerById(layerId) {
        initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.action || !layerId) {
            return;
        }

        await psAPI.core.executeAsModal(async function() {
            await psAPI.action.batchPlay([
                {
                    _obj: 'delete',
                    _target: [{ _ref: 'layer', _id: layerId }]
                }
            ], {
                synchronousExecution: true,
                modalBehavior: 'execute'
            });
        }, { commandName: '删除临时轨迹图层' });
    }

    async function restoreActiveLayerById(layerId) {
        initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.action || !layerId) {
            return;
        }

        await psAPI.core.executeAsModal(async function() {
            await psAPI.action.batchPlay([
                {
                    _obj: 'select',
                    _target: [{ _ref: 'layer', _id: layerId }],
                    makeVisible: false
                }
            ], {
                synchronousExecution: true,
                modalBehavior: 'execute'
            });
        }, { commandName: '恢复原始图层选择' });
    }

    async function captureBlurredTrajectoryReferenceFromSelection() {
        if (!initCompatibility()) {
            return captureReferenceImageFromSelection();
        }
        const tempLayerName = 'VFX-Trajectory-Blur-Temp';
        let duplicateInfo = null;
        let capture = null;

        try {
            duplicateInfo = await duplicateSelectionToTemporaryLayer(tempLayerName);
            await applyGaussianBlurToActiveLayer(18);
            capture = await captureReferenceImageFromSelection();
        } finally {
            if (duplicateInfo && duplicateInfo.layer && duplicateInfo.layer.id) {
                try {
                    await deleteLayerById(duplicateInfo.layer.id);
                } catch (cleanupError) {
                    console.error('删除临时轨迹图层失败:', cleanupError);
                }
            }
            if (duplicateInfo && duplicateInfo.previousLayer && duplicateInfo.previousLayer.id) {
                try {
                    await restoreActiveLayerById(duplicateInfo.previousLayer.id);
                } catch (restoreError) {
                    console.error('恢复原始图层选择失败:', restoreError);
                }
            }
        }

        if (!capture) {
            throw new Error('轨迹图读取失败');
        }

        return capture;
    }

    async function addReferenceImageFromSelection() {
        if (referenceInputMode !== 'single' && referenceImages.length >= MAX_REFERENCE_IMAGES) {
            showStatus('最多添加 ' + MAX_REFERENCE_IMAGES + ' 张参考图', 'error');
            return;
        }

        const buttons = [document.getElementById('btnAddReferenceImage'), document.getElementById('btnAddReferenceImageVfx')].filter(Boolean);
        buttons.forEach(function(btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="loading"></span>添加中...';
        });
        showStatus('正在添加参考图...', 'info');

        try {
            const capture = await captureReferenceImageFromSelection();
            const nextReference = {
                base64: normalizeReferenceImageData(capture),
                label: '图' + (referenceImages.length + 2),
                bounds: capture.bounds
            };
            referenceImages.push(nextReference);
            referenceImages = normalizeReferenceImageList(referenceImages);
            renderReferenceImages();
            showStatus('参考图已添加', 'success');
            showToast('参考图已添加');
        } catch (e) {
            showStatus('添加参考图失败：' + e.message, 'error');
        } finally {
            buttons.forEach(function(btn) {
                btn.disabled = false;
                btn.innerHTML = '添加当前选区为参考图';
            });
        }
    }

    async function recaptureReferenceImage(index) {
        if (index < 0 || index >= referenceImages.length) return;
        showStatus('正在重新抓取' + (referenceImages[index].label || ('图' + (index + 2))) + '...', 'info');

        try {
            const capture = await captureReferenceImageFromSelection();
            referenceImages[index] = {
                base64: capture.base64,
                label: '图' + (index + 2),
                bounds: capture.bounds
            };
            renderReferenceImages();
            showStatus('参考图已更新', 'success');
            showToast('参考图已更新');
        } catch (e) {
            showStatus('更新参考图失败：' + e.message, 'error');
        }
    }

    function removeReferenceImage(index) {
        if (index < 0 || index >= referenceImages.length) return;
        referenceImages.splice(index, 1);
        referenceImages = normalizeReferenceImageList(referenceImages);
        renderReferenceImages();
        showToast('参考图已删除');
    }



    function setModelButtonsState(loading) {
        const btnAutoFetchNewApi = document.getElementById('btnAutoFetchNewApiModels');

        if (btnAutoFetchNewApi) {
            btnAutoFetchNewApi.disabled = loading;
            btnAutoFetchNewApi.innerHTML = loading
                ? '<span class="loading"></span>读取中...'
                : uiIconLabel('download', '抓取 NewAPI 模型');
        }
    }

    function resetModelSelects() {
        const chatModelSelect = document.getElementById('chatModel');
        const imgModelSelect = document.getElementById('imgModel');

        if (chatModelSelect) {
            chatModelSelect.innerHTML = '<option value="">-- 点击获取模型列表 --</option>';
        }

        if (imgModelSelect) {
            fillImageModels([]);
        }

        refreshCustomSelectById('chatModel');
        refreshCustomSelectById('imgModel');
    }

    function getImageProviderChannel(modelValue) {
        // 显式渠道前缀必须最先判。
        // 曾经的写法是先做 GRS 名字判定，而 getModelKey 会把 'firefly/' 前缀剥掉，
        // 于是 firefly/gpt-image-2 被拿去跑 isGrsGptImageModel('gpt-image-2') 命中，
        // 整个 Firefly 模型被并进了 GRS 渠道的模型列表里。
        const parsed = parseModelSelection(modelValue);
        if (parsed.provider) return parsed.provider;
        if (getModelKey(modelValue) === 'ps_native_nano_banana') return 'photoshop';
        return 'photoshop';
    }

    function getImageProviderChannelLabel(provider) {
        return ({
            photoshop: 'Photoshop 原生',
            grs: 'GRS 云端',
            grok2api: 'grok2api',
            sub2api: 'Sub2API',
            xai: 'xAI 官方',
            firefly: 'Firefly',
            volcengine: '火山方舟',
            google: 'Google AI Studio',
            'newapi-openai': 'NewAPI · OpenAI',
            'newapi-gemini': 'NewAPI · Gemini',
            newapi: 'NewAPI'
        })[provider] || provider;
    }

    const WORKSPACE_GENERATION_ROUTES_KEY = 'huanmeng_workspace_generation_routes_v1';
    let workspaceGenerationRoutes = (function() {
        try {
            const parsed = JSON.parse(localStorage.getItem(WORKSPACE_GENERATION_ROUTES_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            return {};
        }
    })();

    function getWorkspaceGenerationRoute(scope) {
        const stored = workspaceGenerationRoutes[String(scope || 'default')] || {};
        const fallbackModel = (currentSettings && currentSettings.imgModel) || (document.getElementById('imgModel') || {}).value || DEFAULT_IMAGE_MODEL;
        const model = stored.model || fallbackModel;
        return {
            provider: stored.provider || getImageProviderChannel(model),
            model: model,
            imageResolution: normalizeImageResolution(stored.imageResolution || (currentSettings && currentSettings.imgResolution) || '2K'),
            imageCount: Math.max(1, Math.min(8, Number(stored.imageCount) || 1)),
            aspectRatio: stored.aspectRatio || 'auto'
        };
    }

    function saveWorkspaceGenerationRoute(scope, patch) {
        const key = String(scope || 'default');
        workspaceGenerationRoutes[key] = Object.assign({}, getWorkspaceGenerationRoute(key), patch || {});
        try { localStorage.setItem(WORKSPACE_GENERATION_ROUTES_KEY, JSON.stringify(workspaceGenerationRoutes)); } catch (error) {}
        return workspaceGenerationRoutes[key];
    }

    function getImageCatalogForProvider(provider) {
        const requested = String(provider || '');
        return imageModelOptionCatalog.filter(function(item) {
            return getImageProviderChannel(item.value) === requested;
        });
    }

    function getAvailableImageProviders() {
        const providers = [];
        const allowPhotoshop = initCompatibility();
        imageModelOptionCatalog.forEach(function(item) {
            const provider = getImageProviderChannel(item.value);
            if (provider === 'photoshop' && !allowPhotoshop) return;
            if (providers.indexOf(provider) < 0) providers.push(provider);
        });
        if (!providers.length) providers.push(allowPhotoshop ? 'photoshop' : 'grs');
        return providers;
    }

    function buildIndependentGenerationControls(scope, prefix, title) {
        const route = getWorkspaceGenerationRoute(scope);
        const providers = getAvailableImageProviders();
        if (providers.indexOf(route.provider) < 0) route.provider = providers[0];
        let models = getImageCatalogForProvider(route.provider);
        if (!models.length) models = imageModelOptionCatalog.slice();
        if (models.length && !models.some(function(item) { return item.value === route.model; })) route.model = models[0].value;
        saveWorkspaceGenerationRoute(scope, route);
        return '<div class="module-card independent-generation-controls" data-generation-scope="' + escapeHTML(scope) + '">'
            + '<div class="card-title">' + escapeHTML(title || '本界面生成参数') + '</div>'
            + '<div class="independent-generation-grid">'
            + '<div class="form-group independent-generation-cell"><label for="' + prefix + 'Provider">平台 / 渠道</label><select id="' + prefix + 'Provider">'
            + providers.map(function(provider) { return '<option value="' + escapeHTML(provider) + '"' + (provider === route.provider ? ' selected' : '') + '>' + escapeHTML(getImageProviderChannelLabel(provider)) + '</option>'; }).join('')
            + '</select></div>'
            + '<div class="form-group independent-generation-cell"><label for="' + prefix + 'Model">模型</label><select id="' + prefix + 'Model">'
            + models.map(function(item) { return '<option value="' + escapeHTML(item.value) + '"' + (item.value === route.model ? ' selected' : '') + '>' + escapeHTML(item.text) + '</option>'; }).join('')
            + '</select></div>'
            + '<div class="form-group independent-generation-cell"><label for="' + prefix + 'Resolution">分辨率</label><select id="' + prefix + 'Resolution">'
            + ['auto', '1K', '2K', '4K'].map(function(value) { return '<option value="' + value + '"' + (value === route.imageResolution ? ' selected' : '') + '>' + (value === 'auto' ? '自适应' : value) + '</option>'; }).join('')
            + '</select></div>'
            + '<div class="form-group independent-generation-cell"><label for="' + prefix + 'Count">数量</label><select id="' + prefix + 'Count">'
            + [1, 2, 3, 4].map(function(value) { return '<option value="' + value + '"' + (value === route.imageCount ? ' selected' : '') + '>' + value + '</option>'; }).join('')
            + '</select></div>'
            + '</div></div>';
    }

    function bindIndependentGenerationControls(scope, prefix, root) {
        const host = root || document;
        const provider = host.querySelector ? host.querySelector('#' + prefix + 'Provider') : document.getElementById(prefix + 'Provider');
        const model = host.querySelector ? host.querySelector('#' + prefix + 'Model') : document.getElementById(prefix + 'Model');
        const resolution = host.querySelector ? host.querySelector('#' + prefix + 'Resolution') : document.getElementById(prefix + 'Resolution');
        const count = host.querySelector ? host.querySelector('#' + prefix + 'Count') : document.getElementById(prefix + 'Count');
        if (!provider || !model) return;
        const refillModels = function(preferred) {
            let models = getImageCatalogForProvider(provider.value);
            if (!models.length) models = imageModelOptionCatalog.slice();
            model.innerHTML = models.map(function(item) {
                return '<option value="' + escapeHTML(item.value) + '"' + (item.value === preferred ? ' selected' : '') + '>' + escapeHTML(item.text) + '</option>';
            }).join('');
            if (model.selectedIndex < 0 && model.options.length) model.selectedIndex = 0;
            saveWorkspaceGenerationRoute(scope, { provider: provider.value, model: model.value });
            refreshCustomSelectById(model.id);
        };
        provider.onchange = function() { refillModels(''); };
        model.onchange = function() { saveWorkspaceGenerationRoute(scope, { provider: provider.value, model: model.value }); };
        if (resolution) resolution.onchange = function() { saveWorkspaceGenerationRoute(scope, { imageResolution: resolution.value }); };
        if (count) count.onchange = function() { saveWorkspaceGenerationRoute(scope, { imageCount: Number(count.value) || 1 }); };
        initAllFakeSelects(host);
    }

    function readIndependentGenerationControls(scope, prefix) {
        const route = getWorkspaceGenerationRoute(scope);
        const provider = document.getElementById(prefix + 'Provider');
        const model = document.getElementById(prefix + 'Model');
        const resolution = document.getElementById(prefix + 'Resolution');
        const count = document.getElementById(prefix + 'Count');
        return saveWorkspaceGenerationRoute(scope, {
            provider: provider ? provider.value : route.provider,
            model: model ? model.value : route.model,
            imageResolution: resolution ? resolution.value : route.imageResolution,
            imageCount: count ? Number(count.value) || 1 : route.imageCount
        });
    }

    const BROWSER_TOOLBOX_PROMPTS = {
        observer: '将输入图像转换为专业黑白明暗观察图。严格保持构图、人物、形状与细节位置不变，只去除颜色并优化灰阶层次，方便检查明暗与反差。',
        'neutral-gray': '基于输入图像生成可用于中性灰修图的光影辅助结果。严格保持主体、构图、颜色设计和几何结构不变，只整理局部光影与明暗关系。',
        frequency: '对输入图像执行专业高低频质感整理：清理低频色块与光影，同时保留真实皮肤、布料、毛发和材质的高频纹理。不得改变人物身份、姿态、构图或设计。',
        stamp: '生成与输入图像视觉内容完全一致的合并可见副本，不添加、不删除、不改变任何主体、构图、颜色或细节。',
        gaussian: '对输入图像应用克制、均匀的高斯柔化效果，保持构图与颜色不变，不新增内容。',
        sharpen: '对输入图像进行专业智能锐化，增强真实边缘和材质细节，抑制光晕、噪点和过度锐化，保持构图与颜色不变。',
        'high-pass': '生成输入图像的高反差细节增强结果，突出纹理与边缘，保持主体、构图、比例和颜色设计不变。',
        'content-aware': '智能修复输入图像中需要清理的瑕疵或突兀区域，用周围合理内容自然补全，严格保持主体身份、构图、光照和整体风格。',
        'select-mask': '从输入图像中精确识别并保留主要主体，生成边缘干净、头发和半透明细节自然的主体分离结果，不改变主体外观。'
    };

    function isMobileWebEnvironment() {
        return !initCompatibility();
    }

    function renderToolboxMobileRouteControls() {
        const host = document.getElementById('toolboxMobileRouteControls');
        if (!host) return;
        if (!isMobileWebEnvironment()) {
            host.innerHTML = '';
            host.style.display = 'none';
            return;
        }
        host.style.display = 'block';
        host.innerHTML = '<div class="module-card browser-toolbox-notice">'
            + '<div class="card-title">手机 / 浏览器工具模式</div>'
            + '<div class="info-text">点击下方 Photoshop 工具时会先上传图片，再使用这里单独选择的平台与模型处理；结果统一保存到画廊。</div>'
            + '</div>'
            + buildIndependentGenerationControls('mobile:toolbox', 'mobileToolRoute', '手机工具生成参数');
        bindIndependentGenerationControls('mobile:toolbox', 'mobileToolRoute', host);
        document.querySelectorAll('[data-ps-tool]').forEach(function(button) {
            const small = button.querySelector('small');
            if (small) small.textContent = '手机上传 · 云端处理';
        });
    }

    async function runBrowserToolboxAction(actionName, button) {
        const action = String(actionName || '');
        const prompt = BROWSER_TOOLBOX_PROMPTS[action];
        if (!prompt) throw new Error('当前工具尚未提供手机版路径');
        if (!selectedImageBase64) await captureToolSourceImage();
        if (!selectedImageBase64) throw new Error('请先上传需要处理的图片');
        const route = readIndependentGenerationControls('mobile:toolbox', 'mobileToolRoute');
        if (!route.model || getImageProviderChannel(route.model) === 'photoshop') {
            throw new Error('手机版不能使用 Photoshop 原生模型，请选择云端平台');
        }
        const label = (button && button.querySelector('strong') && button.querySelector('strong').textContent) || action;
        const generated = await img2Img({
            prompt: prompt,
            model: route.model,
            imageResolution: route.imageResolution,
            imageCount: route.imageCount,
            type: 'mobile-tool-' + action,
            title: '手机工具 · ' + label,
            button: button,
            idleButtonLabel: label
        });
        if (!generated) throw new Error(label + '未生成有效结果，请检查接口设置或生成记录');
        return label + '处理完成，结果已进入画廊';
    }

    function renderImageModelsForProvider(provider, preferredModelValue) {
        const imgModelSelect = document.getElementById('imgModel');
        if (!imgModelSelect) return;
        const selectedProvider = String(provider || 'photoshop');
        const preferredKey = getImageModelSelectionKey(preferredModelValue || '');
        const available = imageModelOptionCatalog.filter(function(item) {
            return getImageProviderChannel(item.value) === selectedProvider;
        });

        imgModelSelect.innerHTML = '';
        available.forEach(function(item) {
            const option = document.createElement('option');
            option.value = item.value;
            option.textContent = item.text;
            imgModelSelect.appendChild(option);
        });
        if (!available.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '当前渠道暂无模型';
            imgModelSelect.appendChild(option);
        }
        const preferredIndex = Array.from(imgModelSelect.options).findIndex(function(option) {
            return getImageModelSelectionKey(option.value) === preferredKey;
        });
        imgModelSelect.selectedIndex = preferredIndex > -1 ? preferredIndex : 0;
        refreshCustomSelectById('imgModel');
        updateImageProviderSummary(imgModelSelect.value);
    }

    function fillImageModels(models) {
        const imgModelSelect = document.getElementById('imgModel');
        const imgProviderSelect = document.getElementById('imgProvider');
        if (!imgModelSelect) return;
        const previousModel = imgModelSelect.value || (currentSettings && currentSettings.imgModel) || DEFAULT_IMAGE_MODEL;
        const catalog = [];
        const added = new Set();
        const addOption = function(value, text) {
            const cleanName = getModelName(value);
            const key = getImageModelSelectionKey(value);
            if (!cleanName || !key || added.has(key)) return;
            catalog.push({ value: String(value || cleanName), text: text || cleanName });
            added.add(key);
        };

        addOption('PS_NATIVE_NANO_BANANA', 'PS 原生 Banana Pro (Photoshop 官方)');

        (models || []).forEach(function(model) {
            const rawName = model.name || model.id || model.value || model;
            const cleanName = normalizeGrsModelName(rawName);
            const lowerName = String(cleanName).toLowerCase();
            const shouldInclude = isGrsNanoBananaModel(lowerName) || isGrsGptImageModel(lowerName);

            if (!shouldInclude) return;
            addOption(cleanName, getImageModelDisplayName(cleanName, model.displayName || model.text || cleanName));
        });

        DEFAULT_IMAGE_MODELS.forEach(function(model) {
            addOption(model.value, getImageModelDisplayName(model.value, model.text));
        });

        GRS_IMAGE_MODEL_DEFAULT_OPTIONS.forEach(function(model) {
            addOption(model.value, getImageModelDisplayName(model.value, model.text));
        });

        XAI_IMAGE_MODEL_DEFAULT_OPTIONS.forEach(function(model) {
            addOption(model.value, model.text);
        });

        GROK2API_IMAGE_MODEL_DEFAULT_OPTIONS.forEach(function(model) {
            addOption(model.value, model.text);
        });

        SUB2API_IMAGE_MODEL_DEFAULT_OPTIONS.forEach(function(model) {
            addOption(model.value, model.text);
        });

        FIREFLY_IMAGE_MODEL_DEFAULT_OPTIONS.forEach(function(model) {
            addOption(model.value, model.text);
        });

        const volcImageModel = currentSettings && String(currentSettings.volcengineImageModel || '').trim() || VOLCENGINE_DEFAULT_IMAGE_MODEL;
        addOption('volcengine/' + volcImageModel, volcImageModel + ' (火山方舟图像)');

        const configuredNewApiImageModel = currentSettings && String(currentSettings.newApiImageModel || '').trim();
        if (configuredNewApiImageModel) {
            addOption('newapi-openai/' + configuredNewApiImageModel, configuredNewApiImageModel + ' (New API)');
        }

        imageModelOptionCatalog = catalog;
        const channels = [];
        catalog.forEach(function(item) {
            const channel = getImageProviderChannel(item.value);
            if (channels.indexOf(channel) === -1) channels.push(channel);
        });
        if (imgProviderSelect) {
            const requestedChannel = imgProviderSelect.value || getImageProviderChannel(previousModel);
            imgProviderSelect.innerHTML = '';
            channels.forEach(function(channel) {
                const option = document.createElement('option');
                option.value = channel;
                option.textContent = getImageProviderChannelLabel(channel);
                imgProviderSelect.appendChild(option);
            });
            imgProviderSelect.value = channels.indexOf(requestedChannel) > -1 ? requestedChannel : getImageProviderChannel(previousModel);
            if (imgProviderSelect.selectedIndex < 0) imgProviderSelect.selectedIndex = 0;
            refreshCustomSelectById('imgProvider');
        }
        renderImageModelsForProvider(imgProviderSelect ? imgProviderSelect.value : getImageProviderChannel(previousModel), previousModel);
    }

    function getNewApiChatProviderByModelName(modelName) {
        const cleanName = String(getModelName(modelName) || '').trim();
        if (!cleanName) return '';
        return 'newapi';
    }

    function extractNewApiChatModels(rawData) {
        const modelItems = []
            .concat((rawData && rawData.data) || [])
            .concat((rawData && rawData.models) || [])
            .concat((rawData && rawData.result && rawData.result.data) || []);

        const mapped = [];
        const added = new Set();

        modelItems.forEach(function(item) {
            const rawName = item && (item.id || item.name || item.model || item.value);
            const cleanName = String(getModelName(rawName) || '').trim();
            const provider = getNewApiChatProviderByModelName(cleanName);
            if (!cleanName || !provider) return;

            const key = provider + '::' + cleanName.toLowerCase();
            if (added.has(key)) return;
            added.add(key);

            mapped.push({
                provider: provider,
                value: cleanName,
                text: cleanName + ' (NewAPI)'
            });
        });

        return mapped;
    }

    function fillChatModels(models, googleApiKey, googleAiEnabled, newApiKey, newApiUrl, newApiModels) {
        const chatModelSelect = document.getElementById('chatModel');
        if (!chatModelSelect) return;

        chatModelSelect.innerHTML = '';

        let hasValidModels = false;
        const added = new Set();

        const addChatOption = function(provider, value, text) {
            const cleanName = getModelName(value);
            const key = getChatOptionKey(provider, cleanName);
            if (!cleanName || added.has(key)) return;
            const option = document.createElement('option');
            option.value = buildModelValue(provider, cleanName);
            option.textContent = text || cleanName;
            chatModelSelect.appendChild(option);
            added.add(key);
            hasValidModels = true;
        };

        GRS_CHAT_MODEL_DEFAULT_OPTIONS.forEach(function(model) {
            addChatOption('grs', model.value, model.text);
        });

        const volcChatModel = currentSettings && String(currentSettings.volcengineChatModel || '').trim() || VOLCENGINE_DEFAULT_CHAT_MODEL;
        addChatOption('volcengine', volcChatModel, volcChatModel + ' (火山方舟文字)');

        (models || []).forEach(function(model) {
            const rawName = model.name || model.id || model.value || model;
            const cleanName = getModelName(rawName);
            const lowerName = String(cleanName).toLowerCase();

            if (isGrsChatModel(lowerName)) {
                addChatOption('grs', cleanName, (model.displayName || model.text || cleanName) + ' (GRS)');
            }
        });

        (newApiModels || []).forEach(function(model) {
            const provider = model.provider || 'newapi';
            addChatOption(provider, model.value || model.name || model.id || model, model.text || ((model.value || model.name || model.id || model) + ' (NewAPI)'));
        });

        if (!hasValidModels) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '-- 未获取到聊天模型 --';
            chatModelSelect.appendChild(option);
        }

        if (chatModelSelect.options.length > 0 && chatModelSelect.selectedIndex < 0) {
            chatModelSelect.selectedIndex = 0;
        }

        refreshCustomSelectById('chatModel');
    }

    async function refreshModels(forceReload = false) {
    const chatApiKeyEl = document.getElementById('chatApiKey');
    const googleApiKeyEl = document.getElementById('googleApiKey');
    const newApiKeyEl = document.getElementById('newApiKey');
    const newApiUrlEl = document.getElementById('newApiUrl');
    const googleAiEnabledEl = document.getElementById('googleAiEnabled');

    const chatApiKey = normalizeApiKey(chatApiKeyEl ? chatApiKeyEl.value : '');
    const googleApiKey = normalizeApiKey(googleApiKeyEl ? googleApiKeyEl.value : '');
    const newApiKey = normalizeApiKey(newApiKeyEl ? newApiKeyEl.value : '');
    const newApiUrl = normalizeBaseUrl(newApiUrlEl ? newApiUrlEl.value : '', '');
    const googleAiEnabled = googleAiEnabledEl ? googleAiEnabledEl.checked : true;

    if (currentRefreshAbortController) {
        currentRefreshAbortController.abort();
        currentRefreshAbortController = null;
        setModelButtonsState(false);
        showStatus('模型获取已取消', 'info');
        return;
    }

    if (!chatApiKey && !googleApiKey && !newApiKey) {
        fillImageModels([]);
        fillChatModels([], googleApiKey, googleAiEnabled, newApiKey, newApiUrl, currentNewApiChatModels);
        showStatus('图生图模型使用本地内置列表', 'info');
        return;
    }

    if (forceReload) {
        resetModelSelects();
    }

    const refreshController = new AbortController();
    currentRefreshAbortController = refreshController;
    setModelButtonsState(true);
    showStatus(forceReload ? '正在重新拉取模型...' : '正在获取模型列表...', 'info');

    try {
        let chatModels = [];
        let chatFailed = false;
        let newApiFailed = false;

        fillImageModels([]);

        // OpenAI 官方接口不走当前的 models 拉取逻辑，这里使用内置白名单模型

        if (newApiKey && newApiUrl) {
            const newApiResult = await API.listNewApiModels(newApiKey, newApiUrl, refreshController.signal);
            if (refreshController.signal.aborted) return;

            if (newApiResult.success) {
                currentNewApiChatModels = extractNewApiChatModels(newApiResult.data || {});
            } else {
                newApiFailed = true;
                chatFailed = true;
                console.error('自动读取NewAPI模型失败:', newApiResult.error);
            }
        } else if (forceReload) {
            currentNewApiChatModels = [];
        }

        // 聊天模型按内置 GRS 列表填充，图生图模型不进行远程获取
        fillImageModels([]);
        fillChatModels(chatModels, googleApiKey, googleAiEnabled, newApiKey, newApiUrl, currentNewApiChatModels);

        // 尝试恢复已保存模型
        const chatModelSelect = document.getElementById('chatModel');
        const imgModelSelect = document.getElementById('imgModel');

        if (currentSettings) {
            const savedChatModel = normalizeChatModelValue(currentSettings.chatModel || currentSettings.model || '');
            const savedImgModel = currentSettings.imgModel || currentSettings.model || '';

            if (chatModelSelect) {
                for (let i = 0; i < chatModelSelect.options.length; i++) {
                    if (normalizeChatModelValue(chatModelSelect.options[i].value) === savedChatModel) {
                        chatModelSelect.selectedIndex = i;
                        break;
                    }
                }
                refreshCustomSelectById('chatModel');
            }

            if (imgModelSelect) {
                for (let i = 0; i < imgModelSelect.options.length; i++) {
                    if (getImageModelSelectionKey(imgModelSelect.options[i].value) === getImageModelSelectionKey(savedImgModel)) {
                        imgModelSelect.selectedIndex = i;
                        break;
                    }
                }
                refreshCustomSelectById('imgModel');
                updateImageProviderSummary(imgModelSelect.value);
            }
        }

        // 刷新模型后更新预览比例
        const currentImgModelEl2 = document.getElementById('imgModel');
        updatePreviewAspectByModel(currentImgModelEl2 ? currentImgModelEl2.value : '');
        
        if (newApiFailed) {
            showStatus('NewAPI 模型自动读取失败，图生图模型使用内置列表', 'error');
            showToast('NewAPI 模型读取失败');
        } else if (chatFailed) {
            showStatus('聊天模型远程获取失败，图生图模型使用内置列表', 'error');
            showToast('聊天模型获取失败');
        } else {
            showStatus('模型列表已更新，图生图模型使用内置列表', 'success');
            showToast('模型列表已更新');
        }
    } catch (e) {
        console.error('refreshModels 出错:', e);
        fillImageModels([]);
        fillChatModels([], googleApiKey, googleAiEnabled, newApiKey, newApiUrl, currentNewApiChatModels);
        showStatus('模型列表刷新异常，图生图模型已保留内置列表', 'error');
    } finally {
        if (currentRefreshAbortController === refreshController) {
            currentRefreshAbortController = null;
        }
        setModelButtonsState(false);
    }
}

    async function fetchNewApiModelsAndFillChat() {
    const newApiKeyEl = document.getElementById('newApiKey');
    const newApiUrlEl = document.getElementById('newApiUrl');
    const googleApiKeyEl = document.getElementById('googleApiKey');
    const googleAiEnabledEl = document.getElementById('googleAiEnabled');
    const chatModelSelect = document.getElementById('chatModel');

    const newApiKey = normalizeApiKey(newApiKeyEl ? newApiKeyEl.value : '');
    const newApiUrl = normalizeBaseUrl(newApiUrlEl ? newApiUrlEl.value : '', '');
    const googleApiKey = normalizeApiKey(googleApiKeyEl ? googleApiKeyEl.value : '');
    const googleAiEnabled = googleAiEnabledEl ? googleAiEnabledEl.checked : true;
    const savedChatModel = chatModelSelect ? normalizeChatModelValue(chatModelSelect.value) : '';

    if (!newApiUrl) {
        showStatus('请先在设置中填写 NewAPI 地址', 'error');
        return;
    }

    if (!newApiKey) {
        showStatus('请先在设置中填写 NewAPI 密钥', 'error');
        return;
    }

    if (currentRefreshAbortController) {
        currentRefreshAbortController.abort();
        currentRefreshAbortController = null;
        setModelButtonsState(false);
        showStatus('模型抓取已取消', 'info');
        return;
    }

    const refreshController = new AbortController();
    currentRefreshAbortController = refreshController;
    setModelButtonsState(true);
    showStatus('正在抓取 NewAPI 模型列表...', 'info');

    try {
        const modelResult = await API.listNewApiModels(newApiKey, newApiUrl, refreshController.signal);
        if (refreshController.signal.aborted) return;

        if (!modelResult.success) {
            throw new Error(modelResult.error || '抓取NewAPI模型失败');
        }

        currentNewApiChatModels = extractNewApiChatModels(modelResult.data || {});
        fillChatModels([], googleApiKey, googleAiEnabled, newApiKey, newApiUrl, currentNewApiChatModels);

        if (chatModelSelect && savedChatModel) {
            const savedIndex = Array.from(chatModelSelect.options).findIndex(function(option) {
                return normalizeChatModelValue(option.value) === savedChatModel;
            });
            if (savedIndex > -1) {
                chatModelSelect.selectedIndex = savedIndex;
                refreshCustomSelectById('chatModel');
            }
        }

        if (currentNewApiChatModels.length > 0) {
            showStatus('NewAPI 模型抓取成功，共 ' + currentNewApiChatModels.length + ' 个', 'success');
            showToast('NewAPI 模型已更新');
        } else {
            showStatus('NewAPI 返回成功，但未识别到可用 GPT/Gemini 聊天模型', 'error');
        }
    } catch (e) {
        console.error('fetchNewApiModelsAndFillChat 出错:', e);
        showStatus('抓取 NewAPI 模型失败: ' + e.message, 'error');
    } finally {
        if (currentRefreshAbortController === refreshController) {
            currentRefreshAbortController = null;
        }
        setModelButtonsState(false);
    }
}

    function saveSettings() {
        debugLog('saveSettings函数被调用');
        try {
            function normalizeApiKey(v) {
                return String(v || '')
                    .trim()
                    .replace(/^["']+|["']+$/g, '') // 去掉首尾引号
                    .replace(/\r?\n/g, '');        // 去掉换行
            }
            
            const chatApiKeyEl = document.getElementById('chatApiKey');
            const imgApiKeyEl = document.getElementById('imgApiKey');
            const chatApiUrlEl = document.getElementById('chatApiUrl');
            const imgApiUrlEl = document.getElementById('imgApiUrl');
            const grsRegionEl = document.getElementById('grsRegion');
            const volcengineApiUrlEl = document.getElementById('volcengineApiUrl');
            const volcengineApiKeyEl = document.getElementById('volcengineApiKey');
            const volcengineImageModelEl = document.getElementById('volcengineImageModel');
            const volcengineChatModelEl = document.getElementById('volcengineChatModel');
            const galleryRetentionModeEl = document.getElementById('galleryRetentionMode');
            const galleryMaxCountEl = document.getElementById('galleryMaxCount');
            const galleryMaxDaysEl = document.getElementById('galleryMaxDays');
            const newApiUrlEl = document.getElementById('newApiUrl');
            const newApiKeyEl = document.getElementById('newApiKey');
            const newApiImageModeEl = document.getElementById('newApiImageMode');
            const newApiImageModelEl = document.getElementById('newApiImageModel');
            const xaiApiUrlEl = document.getElementById('xaiApiUrl');
            const xaiApiKeyEl = document.getElementById('xaiApiKey');
            const grok2apiApiUrlEl = document.getElementById('grok2apiApiUrl');
            const grok2apiApiKeyEl = document.getElementById('grok2apiApiKey');
            const sub2apiApiUrlEl = document.getElementById('sub2apiApiUrl');
            const sub2apiApiKeyEl = document.getElementById('sub2apiApiKey');
            const fireflyApiUrlEl = document.getElementById('fireflyApiUrl');
            const fireflyApiKeyEl = document.getElementById('fireflyApiKey');
            const googleApiKeyEl = document.getElementById('googleApiKey');
            const googleAiEnabledEl = document.getElementById('googleAiEnabled');
            const chatModelEl = document.getElementById('chatModel');
            const imgModelEl = document.getElementById('imgModel');
            const imgResolutionEl = document.getElementById('imgResolution');
            const textSystemPromptPositiveEl = document.getElementById('textSystemPromptPositive');
            const textSystemPromptNegativeEl = document.getElementById('textSystemPromptNegative');
            const imageSystemPromptPositiveEl = document.getElementById('imageSystemPromptPositive');
            const imageSystemPromptNegativeEl = document.getElementById('imageSystemPromptNegative');
            
            debugLog('获取DOM元素:', {
                chatApiKeyEl: !!chatApiKeyEl,
                imgApiKeyEl: !!imgApiKeyEl,
                chatApiUrlEl: !!chatApiUrlEl,
                imgApiUrlEl: !!imgApiUrlEl,
                newApiUrlEl: !!newApiUrlEl,
                newApiKeyEl: !!newApiKeyEl,
                xaiApiKeyEl: !!xaiApiKeyEl,
                fireflyApiUrlEl: !!fireflyApiUrlEl,
                googleApiKeyEl: !!googleApiKeyEl,
                googleAiEnabledEl: !!googleAiEnabledEl,
                chatModelEl: !!chatModelEl,
                imgModelEl: !!imgModelEl,
                imgResolutionEl: !!imgResolutionEl
            });
            
            const chatApiKey = chatApiKeyEl ? chatApiKeyEl.value.trim() : '';
            const imgApiKey = imgApiKeyEl ? imgApiKeyEl.value.trim() : '';
            const chatApiUrl = chatApiUrlEl ? chatApiUrlEl.value.trim() : '';
            const imgApiUrl = imgApiUrlEl ? imgApiUrlEl.value.trim() : '';
            const grsRegion = grsRegionEl && grsRegionEl.value === 'domestic' ? 'domestic' : 'overseas';
            const volcengineApiUrl = normalizeBaseUrl(volcengineApiUrlEl && volcengineApiUrlEl.value, VOLCENGINE_DEFAULT_BASE_URL);
            const volcengineApiKey = volcengineApiKeyEl ? normalizeApiKey(volcengineApiKeyEl.value) : '';
            const volcengineImageModel = String(volcengineImageModelEl && volcengineImageModelEl.value || VOLCENGINE_DEFAULT_IMAGE_MODEL).trim();
            const volcengineChatModel = String(volcengineChatModelEl && volcengineChatModelEl.value || VOLCENGINE_DEFAULT_CHAT_MODEL).trim();
            const galleryRetentionMode = galleryRetentionModeEl && ['count', 'days', 'both'].indexOf(galleryRetentionModeEl.value) > -1 ? galleryRetentionModeEl.value : 'count';
            const galleryMaxCount = Math.max(1, Math.min(500, Number(galleryMaxCountEl && galleryMaxCountEl.value) || 30));
            const galleryMaxDays = Math.max(1, Math.min(3650, Number(galleryMaxDaysEl && galleryMaxDaysEl.value) || 30));
            const newApiUrl = newApiUrlEl ? normalizeBaseUrl(newApiUrlEl.value.trim(), NEWAPI_DEFAULT_BASE_URL) : NEWAPI_DEFAULT_BASE_URL;
            const newApiKey = newApiKeyEl ? newApiKeyEl.value.trim() : '';
            const newApiImageMode = newApiImageModeEl ? newApiImageModeEl.value : 'auto';
            const newApiImageModel = newApiImageModelEl ? newApiImageModelEl.value.trim() : '';
            const xaiApiUrl = normalizeBaseUrl(xaiApiUrlEl ? xaiApiUrlEl.value.trim() : '', XAI_DEFAULT_BASE_URL);
            const xaiApiKey = xaiApiKeyEl ? normalizeApiKey(xaiApiKeyEl.value) : '';
            const grok2apiApiUrl = normalizeBaseUrl(grok2apiApiUrlEl ? grok2apiApiUrlEl.value.trim() : '', GROK2API_DEFAULT_BASE_URL);
            const grok2apiApiKey = grok2apiApiKeyEl ? normalizeApiKey(grok2apiApiKeyEl.value) : '';
            const sub2apiApiUrl = normalizeBaseUrl(sub2apiApiUrlEl ? sub2apiApiUrlEl.value.trim() : '', SUB2API_DEFAULT_BASE_URL);
            const sub2apiApiKey = sub2apiApiKeyEl ? normalizeApiKey(sub2apiApiKeyEl.value) : '';
            const fireflyApiUrl = normalizeBaseUrl(fireflyApiUrlEl ? fireflyApiUrlEl.value.trim() : '', FIREFLY_DEFAULT_BASE_URL);
            const fireflyApiKey = fireflyApiKeyEl ? normalizeApiKey(fireflyApiKeyEl.value) : '';
            const googleApiKey = googleApiKeyEl ? googleApiKeyEl.value.trim() : '';
            const googleAiEnabled = googleAiEnabledEl ? !!googleAiEnabledEl.checked : true;
            const runninghubApiKeyEl = document.getElementById('runninghubApiKey');
            const runninghubApiKey = runninghubApiKeyEl ? normalizeApiKey(runninghubApiKeyEl.value) : '';
            const advancedPollIntervalEl = document.getElementById('advancedPollInterval');
            const advancedTimeoutEl = document.getElementById('advancedTimeout');
            const advancedMaxConcurrentEl = document.getElementById('advancedMaxConcurrent');
            const advancedAiOptimizeAppIdEl = document.getElementById('advancedAiOptimizeAppId');
            const advancedPollInterval = Math.min(60000, Math.max(500, Number(advancedPollIntervalEl ? advancedPollIntervalEl.value : currentSettings && currentSettings.advancedPollInterval) || DEFAULT_RUNNINGHUB_POLL_INTERVAL));
            const advancedTimeout = Math.min(120000, Math.max(5000, Number(advancedTimeoutEl ? advancedTimeoutEl.value : currentSettings && currentSettings.advancedTimeout) || DEFAULT_RUNNINGHUB_TIMEOUT));
            const advancedMaxConcurrent = Math.min(5, Math.max(1, Number(advancedMaxConcurrentEl ? advancedMaxConcurrentEl.value : currentSettings && currentSettings.advancedMaxConcurrent) || DEFAULT_RUNNINGHUB_MAX_CONCURRENT));
            const advancedAiOptimizeAppId = normalizeRunninghubAppId(advancedAiOptimizeAppIdEl ? advancedAiOptimizeAppIdEl.value : (currentSettings && currentSettings.advancedAiOptimizeAppId) || '') || DEFAULT_AI_OPTIMIZE_APP_ID;
            const alignmentModeEl = document.getElementById('alignmentMode');
            const alignmentMode = alignmentModeEl ? alignmentModeEl.value : 'fit-layer';
            const lockedGrsApiUrl = grsRegion === 'domestic' ? GRS_CHINA_BASE_URL : GRS_DEFAULT_BASE_URL;
            const lockedChatApiUrl = OPENAI_OFFICIAL_BASE_URL;
            const chatModel = chatModelEl ? chatModelEl.value : '';
            const imgModel = imgModelEl ? imgModelEl.value : '';
            const imgResolution = normalizeImageResolution(imgResolutionEl ? imgResolutionEl.value : DEFAULT_IMAGE_RESOLUTION);
            const model = imgModel || chatModel || "gemini-2.0-flash-exp";
            const textSystemPromptPositive = textSystemPromptPositiveEl ? textSystemPromptPositiveEl.value.trim() : DEFAULT_TEXT_SYSTEM_PROMPT_POSITIVE;
            const textSystemPromptNegative = textSystemPromptNegativeEl ? textSystemPromptNegativeEl.value.trim() : DEFAULT_TEXT_SYSTEM_PROMPT_NEGATIVE;
            const imageSystemPromptPositive = imageSystemPromptPositiveEl ? imageSystemPromptPositiveEl.value.trim() : DEFAULT_IMAGE_SYSTEM_PROMPT_POSITIVE;
            const imageSystemPromptNegative = imageSystemPromptNegativeEl ? imageSystemPromptNegativeEl.value.trim() : DEFAULT_IMAGE_SYSTEM_PROMPT_NEGATIVE;
            const textSizeMultiplierEl = document.getElementById('textSizeMultiplier');
            const textSizeMultiplier = textSizeMultiplierEl ? parseFloat(textSizeMultiplierEl.value) : 1;
            const autoColorMatchEnabledEl = document.getElementById('autoColorMatchEnabled');
            const autoColorMatchMethodEl = document.getElementById('autoColorMatchMethod');
            const autoColorMatchEnabled = autoColorMatchEnabledEl ? !!autoColorMatchEnabledEl.checked : false;
            const autoColorMatchMethod = autoColorMatchMethodEl && autoColorMatchMethodEl.value === 'reinhard' ? 'reinhard' : 'wavelet';
            const promptSyncBaseUrlEl = document.getElementById('promptSyncBaseUrl');
            const promptSyncBaseUrl = String(promptSyncBaseUrlEl ? promptSyncBaseUrlEl.value.trim() : '').replace(/\/+$/, '');
            
            debugLog('获取设置值:', {
                chatApiKey: chatApiKey ? '***' : '',
                imgApiKey: imgApiKey ? '***' : '',
                newApiKey: newApiKey ? '***' : '',
                newApiUrl: newApiUrl || '',
                newApiImageMode: newApiImageMode,
                xaiApiKey: xaiApiKey ? '***' : '',
                xaiApiUrl: xaiApiUrl,
                grok2apiApiKey: grok2apiApiKey ? '***' : '',
                grok2apiApiUrl: grok2apiApiUrl,
                sub2apiApiKey: sub2apiApiKey ? '***' : '',
                sub2apiApiUrl: sub2apiApiUrl,
                fireflyApiKey: fireflyApiKey ? '***' : '',
                fireflyApiUrl: fireflyApiUrl,
                googleApiKey: googleApiKey ? '***' : '',
                googleAiEnabled: googleAiEnabled,
                chatApiUrl: lockedChatApiUrl,
                imgApiUrl: lockedGrsApiUrl,
                chatModel: chatModel,
                imgModel: imgModel,
                imgResolution: imgResolution,
                model: model
            });
            
            // 移除API密钥检查，允许保存空设置
            
            currentSettings = Object.assign({
                chatApiKey: chatApiKey,
                imgApiKey: imgApiKey,
                grsRegion: grsRegion,
                volcengineApiUrl: volcengineApiUrl,
                volcengineApiKey: volcengineApiKey,
                volcengineImageModel: volcengineImageModel,
                volcengineChatModel: volcengineChatModel,
                newApiUrl: newApiUrl,
                newApiKey: newApiKey,
                newApiImageMode: newApiImageMode,
                newApiImageModel: newApiImageModel,
                xaiApiUrl: xaiApiUrl,
                xaiApiKey: xaiApiKey,
                grok2apiApiUrl: grok2apiApiUrl,
                grok2apiApiKey: grok2apiApiKey,
                sub2apiApiUrl: sub2apiApiUrl,
                sub2apiApiKey: sub2apiApiKey,
                fireflyApiUrl: fireflyApiUrl,
                fireflyApiKey: fireflyApiKey,
                googleApiKey: googleApiKey,
                googleAiEnabled: googleAiEnabled,
                chatApiUrl: lockedChatApiUrl,
                imgApiUrl: lockedGrsApiUrl,
                chatModel: normalizeChatModelValue(chatModel || DEFAULT_GRS_CHAT_MODEL),
                imgModel: imgModel || DEFAULT_IMAGE_MODEL,
                imgResolution: imgResolution,
                textSystemPromptPositive: textSystemPromptPositive,
                textSystemPromptNegative: textSystemPromptNegative,
                imageSystemPromptPositive: imageSystemPromptPositive,
                imageSystemPromptNegative: imageSystemPromptNegative,
                model: model,
                imageWidth: 1024,
                imageHeight: 1024,
                widthUnit: 'pixel',
                heightUnit: 'pixel',
                textSizeMultiplier: textSizeMultiplier,
                alignmentMode: alignmentMode,
                runninghubApiKey: runninghubApiKey,
                runninghubApps: runninghubApps,
                advancedPollInterval: advancedPollInterval,
                advancedTimeout: advancedTimeout,
                advancedMaxConcurrent: advancedMaxConcurrent,
                advancedAiOptimizeAppId: advancedAiOptimizeAppId,
                autoColorMatchEnabled: autoColorMatchEnabled,
                autoColorMatchOptInVersion: 2,
                autoColorMatchMethod: autoColorMatchMethod,
                promptSyncBaseUrl: promptSyncBaseUrl,
                galleryRetentionMode: galleryRetentionMode,
                galleryMaxCount: galleryMaxCount,
                galleryMaxDays: galleryMaxDays
            });

            debugLog('保存设置:', currentSettings);
            Config.saveSettings(currentSettings);
            fillImageModels([]);
            updateImageProviderSummary(document.getElementById('imgModel') ? document.getElementById('imgModel').value : imgModel);

            if (imgApiUrlEl) {
                imgApiUrlEl.value = lockedGrsApiUrl;
            }
            if (chatApiUrlEl) {
                chatApiUrlEl.value = lockedChatApiUrl;
            }
            if (newApiImageModeEl) {
                newApiImageModeEl.value = newApiImageMode;
            }
            if (xaiApiUrlEl) xaiApiUrlEl.value = xaiApiUrl;
            if (grok2apiApiUrlEl) grok2apiApiUrlEl.value = grok2apiApiUrl;
            if (sub2apiApiUrlEl) sub2apiApiUrlEl.value = sub2apiApiUrl;
            if (fireflyApiUrlEl) fireflyApiUrlEl.value = fireflyApiUrl;

            debugLog('设置保存成功');
            showStatus('设置已保存', 'success');
            showToast('设置已保存');
        } catch (error) {
            console.error('保存设置失败:', error);
            showStatus('保存设置失败: ' + error.message, 'error');
        }
    }

    function extractTextFromContentParts(content) {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.map(function(part) {
            if (!part) return '';
            if (typeof part === 'string') return part;
            if (typeof part.text === 'string') return part.text;
            if (part.content && typeof part.content.text === 'string') return part.content.text;
            if (typeof part.content === 'string') return part.content;
            return '';
        }).filter(Boolean).join('\n').trim();
    }

    function extractChatResponseText(responseData) {
        if (!responseData) return '';
        if (responseData.choices && responseData.choices[0]) {
            const choice = responseData.choices[0];
            if (choice.message) {
                const messageContent = extractTextFromContentParts(choice.message.content);
                if (messageContent) return messageContent;
            }
            if (choice.delta) {
                const deltaContent = extractTextFromContentParts(choice.delta.content);
                if (deltaContent) return deltaContent;
            }
            const choiceText = extractTextFromContentParts(choice.text || choice.content);
            if (choiceText) return choiceText;
        }
        if (responseData.candidates && responseData.candidates[0] && responseData.candidates[0].content && responseData.candidates[0].content.parts) {
            const parts = responseData.candidates[0].content.parts;
            let text = '';
            for (let i = 0; i < parts.length; i++) {
                if (parts[i].text) {
                    text += parts[i].text + '\n';
                }
            }
            if (text.trim()) return text.trim();
        }
        if (responseData.message) {
            const messageText = extractTextFromContentParts(responseData.message.content || responseData.message.text);
            if (messageText) return messageText;
        }
        if (responseData.data) {
            const dataText = extractTextFromContentParts(responseData.data.text || responseData.data.content || (responseData.data.message && responseData.data.message.content));
            if (dataText) return dataText;
        }
        const directText = extractTextFromContentParts(responseData.content || responseData.text || responseData.output_text);
        if (directText) return directText;
        return '';
    }

    function buildChatContextMessages(prompt, imageBase64) {
        const text = prompt || '请描述这张图片';
        const recentHistory = chatHistory
            .filter(function(message) {
                return message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string' && message.content.trim();
            })
            .slice(-(CHAT_MEMORY_ROUNDS * 2))
            .map(function(message) {
                return {
                    role: message.role,
                    content: message.content.replace(/\n\n\[已添加选区图片\]$/, '').trim()
                };
            })
            .filter(function(message) {
                return message.content;
            });

        const currentMessage = {
            role: 'user',
            content: text
        };

        if (imageBase64) {
            currentMessage.content = [
                { type: 'text', text: text },
                { type: 'image_url', image_url: { url: imageBase64 } }
            ];
        }

        return prependTextSystemMessage(recentHistory.concat(currentMessage));
    }

    async function chat() {
        const chatPromptEl = document.getElementById('chatPrompt');
        const chatModelEl = document.getElementById('chatModel');
        const prompt = chatPromptEl ? chatPromptEl.value.trim() : '';
        const chatModelValue = (chatModelEl && chatModelEl.value) || (currentSettings && currentSettings.chatModel) || DEFAULT_GRS_CHAT_MODEL;

        if (!prompt && !chatSelectedImageBase64) {
            showStatus('请输入消息或读取选区', 'error');
            return;
        }

        if (prompt) {
            lastChatInput = prompt;
        }

        if (!currentSettings) {
            showStatus('请先在设置中配置API密钥', 'error');
            switchTab('settings');
            return;
        }

        const chatRouteValidation = validateChatApiRouting(chatModelValue, currentSettings);
        if (!chatRouteValidation.valid) {
            showStatus(chatRouteValidation.message, 'error');
            switchTab('settings');
            return;
        }
        const chatRoute = chatRouteValidation.route;
        const btn = document.getElementById('btnChat');
        if (btn) {
            btn.disabled = true;
        }

        const startTime = Date.now();
        let timerInterval;

        if (btn) {
            timerInterval = setInterval(() => {
                const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
                btn.innerHTML = '<span class="loading"></span>发送中... ' + elapsedTime + 's';
            }, 1000);
        }

        showStatus('正在发送消息，请稍候...', 'info');
        await new Promise(resolve => requestAnimationFrame(resolve));

        try {
            const timestamp = new Date().toLocaleString('zh-CN');
            const messages = buildChatContextMessages(prompt, chatSelectedImageBase64);
            let displayContent = prompt || '';
            if (chatSelectedImageBase64) {
                displayContent = (displayContent ? displayContent + '\n\n' : '') + '[已添加选区图片]';
            }
            chatHistory.push({
                role: 'user',
                content: displayContent,
                timestamp: timestamp
            });
            updateChatHistory();

            if (chatPromptEl) {
                chatPromptEl.value = '';
                resizeChatPrompt();
            }

            const result = isNewApiProvider(chatRoute.provider)
                ? await API.chatNewApi({
                    apiKey: chatRoute.apiKey,
                    baseUrl: chatRoute.baseUrl,
                    model: chatRoute.model,
                    prompt: prompt || '请描述这张图片',
                    messages: messages
                })
                : chatRoute.provider === 'volcengine'
                ? await API.chatOpenAICompatible({
                    apiKey: chatRoute.apiKey,
                    baseUrl: chatRoute.baseUrl,
                    model: chatRoute.model,
                    prompt: prompt || '请描述这张图片',
                    messages: messages
                })
                : await API.generateImage({
                    apiKey: chatRoute.apiKey,
                    provider: chatRoute.provider,
                    baseUrl: chatRoute.baseUrl,
                    model: chatRoute.model,
                    prompt: prompt || '请描述这张图片',
                    imageBase64: chatSelectedImageBase64,
                    messages: messages
                });

            if (result.success) {
                const responseData = result.data;
                const responseText = extractChatResponseText(responseData);

                if (responseText) {
                    chatHistory.push({
                        role: 'assistant',
                        content: responseText,
                        timestamp: new Date().toLocaleString('zh-CN')
                    });
                    updateChatHistory();

                    showStatus('消息发送成功', 'success');
                    showToast('收到回复');

                    Config.addLog({
                        timestamp: timestamp,
                        model: chatModelValue,
                        prompt: prompt,
                        type: 'chat',
                        status: '成功',
                        response: responseText
                    });
                } else {
                    const errorText = '发送失败：无法从响应中提取文本';
                    chatHistory.push({
                        role: 'assistant',
                        content: errorText,
                        timestamp: new Date().toLocaleString('zh-CN')
                    });
                    updateChatHistory();
                    showStatus(errorText, 'error');
                    Config.addLog({
                        timestamp: timestamp,
                        model: chatModelValue,
                        prompt: prompt,
                        type: 'chat',
                        status: '失败',
                        error: '无法从响应中提取文本'
                    });
                }
            } else {
                const errorMsg = result.error || '未知错误';
                const errorText = '发送失败：' + errorMsg;
                chatHistory.push({
                    role: 'assistant',
                    content: errorText,
                    timestamp: new Date().toLocaleString('zh-CN')
                });
                updateChatHistory();
                showStatus(errorText, 'error');

                Config.addLog({
                    timestamp: new Date().toLocaleString('zh-CN'),
                    model: chatModelValue,
                    prompt: prompt,
                    type: 'chat',
                    status: '失败',
                    error: errorMsg
                });
            }
        } catch (e) {
            const errorMsg = e && e.message ? e.message : '未知错误';
            const errorText = '发送失败：' + errorMsg;
            chatHistory.push({
                role: 'assistant',
                content: errorText,
                timestamp: new Date().toLocaleString('zh-CN')
            });
            updateChatHistory();
            showStatus(errorText, 'error');
            Config.addLog({
                timestamp: new Date().toLocaleString('zh-CN'),
                model: chatModelValue,
                prompt: prompt,
                type: 'chat',
                status: '失败',
                error: errorMsg
            });
        } finally {
            if (timerInterval) {
                clearInterval(timerInterval);
            }

            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '发送消息';
            }
        }
    }

    async function img2Img(runOptions) {
        initCompatibility();
        const overrides = runOptions && typeof runOptions === 'object' ? runOptions : {};
        const btn = overrides.button || document.getElementById('btnImg2Img');
        if (!btn) return;
        const idleButtonLabel = overrides.idleButtonLabel || btn.textContent || '生成图像';
        
        // 这里原本是「有任务在跑就取消它，然后 return」—— 也就是再点一次渲染
        // 等于取消，同时只能跑一个任务。改成并发后直接开新任务。
        // 取消能力没丢，挪到了任务中心每条任务的「取消任务」按钮上
        // （那儿本来就有界面，而且并发下它才分得清该取消哪一个）。
        debugLog('开始执行img2Img函数...');
        
        const promptInput = document.getElementById('imgPrompt');
        const modelInput = document.getElementById('imgModel');
        const imageCountInput = document.getElementById('imageCount');
        const prompt = normalizePresetPromptText(overrides.prompt != null ? overrides.prompt : (promptInput ? promptInput.value.trim() : ''));
        const model = overrides.model || (modelInput ? modelInput.value : DEFAULT_IMAGE_MODEL);
        const imageResolution = normalizeImageResolution(overrides.imageResolution || getSelectedImageResolution());
        const imageCount = Math.max(1, Math.min(8, parseInt(overrides.imageCount != null ? overrides.imageCount : (imageCountInput && imageCountInput.value), 10) || 1));
        const generationType = overrides.type || 'img2img';
        const generationTitle = overrides.title || '图像生成';

        if (!prompt) {
            debugLog('没有输入提示词');
            showStatus('请输入提示词', 'error');
            return;
        }
        
        // 检查是否选择了PS原生模型
        if (model === 'PS_NATIVE_NANO_BANANA') {
            debugLog('使用PS原生Nano Banana Pro模型');
            await executeNativeAIPreset(composeConfiguredSystemPrompt('image', prompt));
            return;
        }
        
        debugLog('提示词:', prompt);
        debugLog('模型:', model);
        debugLog('生成数量:', imageCount);
        debugLog('当前设置:', currentSettings);
        
        if (!currentSettings) {
            debugLog('没有配置API密钥');
            showStatus('请先在设置中配置API密钥', 'error');
            switchTab('settings');
            return;
        }
        
        const routingValidation = validateImageApiRouting(model, currentSettings);
        if (!routingValidation.valid) {
            showStatus(routingValidation.message, 'error');
            switchTab('settings');
            return;
        }

        const route = routingValidation.route;
        let imageConfig = getModelImageConfig(model, savedSelectionBounds, imageResolution);
        
        // 每次生成时都重新读取当前的选区
        if (psAPI.app && psAPI.core && psAPI.imaging) {
            btn.disabled = true;
            btn.innerHTML = '<span class="loading"></span>正在读取选区...';
            showStatus('正在读取选区...', 'info');
            
            try {
                const bounds = await getSelectionBoundsInPixels();
                if (bounds) {
                    // 验证选区尺寸是否有效
                    if (bounds.width <= 0 || bounds.height <= 0) {
                        debugLog("选区尺寸无效: " + bounds.width + " x " + bounds.height);
                        btn.disabled = false;
                        btn.innerHTML = idleButtonLabel;
                        showStatus('选区尺寸无效，请重新选择区域', 'error');
                        return;
                    }
                    
                    savedSelectionBounds = bounds;
                    savedDocumentId = psAPI.app.activeDocument ? psAPI.app.activeDocument.id : null;
                    debugLog("选区尺寸: " + bounds.width + " x " + bounds.height);
                    
                    const base64Data = await getImageDataToBase64(bounds);
                    
                    if (base64Data && base64Data.length > 0) {
                        updatePrimaryImagePreview('data:image/png;base64,' + base64Data, bounds);
                        
                        debugLog("选区图片已读取，base64长度:", selectedImageBase64.length);
                    }
                } else {
                    savedSelectionBounds = null;
                    savedDocumentId = null;
                    selectedImageBase64 = null;
                    clearPrimaryImagePreview('未检测到选区 - 图像将创建为新文档');
                    debugLog("未检测到选区，将创建新文档");
                }
            } catch (e) {
                debugLog("选区读取失败:", e);
                savedSelectionBounds = null;
                selectedImageBase64 = null;
                clearPrimaryImagePreview('读取选区失败');
                btn.disabled = false;
                btn.innerHTML = idleButtonLabel;
                showStatus('读取选区失败: ' + e.message, 'error');
                return;
            }
        } else {
            // 如果UXP模块未加载，使用已有的selectedImageBase64
            if (selectedImageBase64) {
                showStatus('使用已上传的图片进行生成...', 'info');
            }
        }

        imageConfig = getModelImageConfig(model, savedSelectionBounds, imageResolution);
        debugLog("图像配置: ", JSON.stringify(imageConfig));
        const width = imageConfig.width;
        const height = imageConfig.height;
        const activeReferenceImages = getActiveReferenceImagesForRequest();
        const requestPrompt = getImageRequestPrompt(model, prompt, !!selectedImageBase64);
        
        btn.disabled = false;
        
        const timestamp = new Date().toLocaleString('zh-CN');
        const generationPlacementContext = {
            bounds: savedSelectionBounds && Object.assign({}, savedSelectionBounds),
            documentId: savedDocumentId,
            documentName: psAPI.app && psAPI.app.activeDocument ? psAPI.app.activeDocument.name : ''
        };
        let successCount = 0;
        let completedCount = 0;
        const taskId = createTaskEntry({
            title: generationTitle,
            state: 'running',
            progress: 5,
            total: imageCount,
            model: model,
            provider: route.provider,
            prompt: prompt,
            detail: '已提交 ' + imageCount + ' 张图像'
        });
        // 本次任务的上下文：取消信号 + 落点快照，一个任务一份。
        // 这是并发能成立的前提 —— 共用一份的话，第二个任务会覆盖
        // 第一个的选区，结果就贴到错误的位置去了。
        const generationContext = createGenerationContext(taskId);
        // 取消信号挂进落点上下文一起往下传。回写那一步也要能感知取消，
        // 但它拿不到这里的局部变量，只能走参数传进去。
        generationPlacementContext.abortSignal = generationContext.abortController.signal;

        // 按钮不再变成「取消生成」：并发下再点一次是**开新任务**，不是取消。
        // 取消移到任务中心每条任务的按钮上 —— 那儿才分得清取消哪一个。
        // 按钮也不能 disable，否则第二个任务就开不出来了。
        btn.disabled = false;
        showStatus('正在生成 ' + imageCount + ' 张图像...', 'info');
        
        // 让界面先刷新
        await new Promise(resolve => requestAnimationFrame(resolve));
        
        let timerInterval = null;
        try {
            // 开始总计时器
            //
            // 按钮不再被这个计时器改写文案。并发下这个按钮的作用是「再开一个任务」，
            // 把它改成「取消生成 / 正在取消」会让用户以为点了会取消 —— 那是旧行为。
            // 进度看任务中心、状态栏和圆环，不看按钮。
            const startTime = Date.now();
            timerInterval = setInterval(() => {
                if (generationContext.abortController.signal.aborted) {
                    return;
                }
                // 只更新任务面板里的进度，不动按钮
                updateTaskEntry(taskId, {
                    detail: '生成中 ' + completedCount + '/' + imageCount
                        + ' · ' + Math.floor((Date.now() - startTime) / 1000) + 's'
                });
            }, 1000);

            // 创建并发生成图像的函数
            async function generateSingleImage(index) {
                try {
                    // 检查是否已被取消
                    if (generationContext.abortController.signal.aborted) {
                        debugLog('任务已被取消');
                        return false;
                    }
                    
                    // 根据模型选择使用哪个API
                    let result;
                    if (route.provider === 'google') {
                        result = await API.generateImageGoogle({
                            apiKey: route.apiKey,
                            model: model,
                            prompt: requestPrompt,
                            imageBase64: selectedImageBase64,
                            referenceImages: activeReferenceImages,
                            abortSignal: generationContext.abortController.signal
                        });
                    } else {
                        result = await API.generateImage({
                            apiKey: route.apiKey,
                            provider: route.provider,
                            apiType: route.apiType,
                            baseUrl: route.baseUrl,
                            model: model,
                            prompt: requestPrompt,
                            imageBase64: selectedImageBase64,
                            referenceImages: activeReferenceImages,
                            // 用本次任务的落点快照，不是全局的「当前选区」——
                            // 并发时后者可能已经被另一个任务改掉了，
                            // 那算出来的比例就是别人那个区域的
                            sizeHint: generationPlacementContext.bounds,
                            imageResolution: imageResolution,
                            imageSize: imageConfig.imageSize,
                            aspectRatio: 'auto',
                            size: imageConfig.size,
                            abortSignal: generationContext.abortController.signal
                        });
                    }
                    
                    debugLog('API响应 ' + (index + 1) + ':', result);
                    
                    if (result.success) {
                        const responseData = result.data;
                        debugLog('响应数据 ' + (index + 1) + ':', responseData);
                        
                        // 提取图像URL
                        const imageUrl = extractImageFromResponse(responseData);
                        debugLog('提取到的图像URL ' + (index + 1) + ':', imageUrl);
                        
                        if (imageUrl) {
                            const returnItem = Object.assign({ imageUrl: imageUrl, width: width, height: height, prompt: prompt, type: generationType, timestamp: timestamp + ' (' + (index + 1) + ')', model: model }, generationPlacementContext);
                            const autoReturnEl = document.getElementById('taskAutoReturn');
                            const autoReturn = !autoReturnEl || autoReturnEl.checked;
                            if (!autoReturn) {
                                if (!pendingReturnCache[taskId]) pendingReturnCache[taskId] = { items: [] };
                                pendingReturnCache[taskId].items.push(returnItem);
                                return true;
                            }
                            return await downloadAndPlaceDocument(imageUrl, width, height, prompt, generationType, returnItem.timestamp, model, returnItem);
                        } else {
                            const extractionError = result.error || '无法从响应中提取图像';
                            Config.addLog({
                                timestamp: timestamp,
                                model: model,
                                prompt: prompt,
                                type: generationType,
                                status: '失败',
                                error: extractionError
                            });
                            return false;
                        }
                    } else {
                        const errorMsg = result.error || '未知错误';
                        Config.addLog({
                            timestamp: timestamp,
                            model: model,
                            prompt: prompt,
                            type: generationType,
                            status: '失败',
                            error: errorMsg
                        });
                        return false;
                    }
                } catch (error) {
                    console.error('生成图像 ' + (index + 1) + ' 出错:', error);
                    Config.addLog({
                        timestamp: timestamp,
                        model: model,
                        prompt: prompt,
                        type: generationType,
                        status: '失败',
                        error: error.message
                    });
                    return false;
                } finally {
                    completedCount++;
                    updateTaskEntry(taskId, {
                        state: 'running',
                        progress: Math.min(88, 8 + Math.round(completedCount / imageCount * 80)),
                        completed: completedCount,
                        detail: '已完成接口请求 ' + completedCount + '/' + imageCount
                    });
                }
            }
            
            // 创建并执行并发任务
            const tasks = [];
            for (let i = 0; i < imageCount; i++) {
                tasks.push(generateSingleImage(i));
            }
            
            // 本次任务的所有单图 Promise（局部变量，不是全局 ——
            // 并发时两个任务共用一个全局 Promise 会互相等对方）
            const generationPromise = Promise.all(tasks);
            
            // 等待本次任务的所有单图完成
            const results = await generationPromise;

            // 计算成功数量
            successCount = results.filter(result => result).length;

            // 清除计时器
            clearInterval(timerInterval);
            timerInterval = null;

            if (generationContext.abortController.signal.aborted) {
                updateTaskEntry(taskId, { state: 'cancelled', detail: '任务已取消', progress: 0 });
            } else if (pendingReturnCache[taskId] && pendingReturnCache[taskId].items && pendingReturnCache[taskId].items.length) {
                updateTaskEntry(taskId, { state: 'waiting_return', progress: 90, completed: successCount, detail: '生成完成，等待回传 ' + pendingReturnCache[taskId].items.length + ' 张图片' });
                switchTab('generationCenter');
            } else if (successCount > 0) {
                updateTaskEntry(taskId, { state: 'completed', progress: 100, completed: successCount, detail: '已生成并回传 ' + successCount + ' 张图片' });
                showStatus('成功生成 ' + successCount + ' 张图像', 'success');
                showToast('成功生成 ' + successCount + ' 张图像');
            } else {
                updateTaskEntry(taskId, { state: 'failed', completed: 0, detail: '生成失败，请查看生成记录' });
            }
        } finally {
            if (timerInterval) {
                clearInterval(timerInterval);
            }
            // 注销本次任务的上下文。并发下不能「重置全局状态」——
            // 那会把别的还在跑的任务的上下文一起清掉。
            releaseGenerationContext(generationContext);

            // 按钮恢复原样。这里不能 disable，否则后续任务开不出来。
            btn.disabled = false;
            btn.innerHTML = idleButtonLabel;
        }
        return successCount > 0;
    }

    function isLikelyBase64ImageData(value) {
        if (typeof value !== 'string') return false;
        const trimmed = value.trim();
        if (!trimmed || trimmed.length < 128) return false;
        if (/^data:image\//i.test(trimmed)) return true;
        return /^[A-Za-z0-9+/=\s]+$/.test(trimmed) && (trimmed.indexOf('/') > -1 || trimmed.indexOf('+') > -1 || trimmed.indexOf('=') > -1);
    }

    function makeImageDataUrl(value) {
        if (!value) return '';
        if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) return value;
        const normalized = String(value).replace(/\s+/g, '');
        const mimeMatch = normalized.match(/^([A-Za-z]+\/[A-Za-z0-9.+-]+);base64,(.+)$/i);
        if (mimeMatch) {
            return 'data:' + mimeMatch[1] + ';base64,' + mimeMatch[2];
        }
        return 'data:image/png;base64,' + normalized;
    }

    function collectImageCandidates(value, results) {
        if (!value) return results;

        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (/^(https?:\/\/|data:image\/)/i.test(trimmed)) {
                results.push(trimmed);
            } else if (isLikelyBase64ImageData(trimmed)) {
                results.push(makeImageDataUrl(trimmed));
            }
            return results;
        }

        if (Array.isArray(value)) {
            value.forEach(function(item) {
                collectImageCandidates(item, results);
            });
            return results;
        }

        if (typeof value !== 'object') {
            return results;
        }

        ['url', 'image', 'image_url', 'output', 'b64_json', 'response_url', 'download_url', 'uri', 'src', 'base64', 'base64Data', 'imageBase64', 'image_data', 'imageData', 'result_image', 'original_url', 'originalUrl', 'file_url', 'fileUrl', 'result_url', 'resultUrl', 'thumbnail', 'thumbnail_url', 'thumbnailUrl'].forEach(function(key) {
            if (typeof value[key] === 'string') {
                const fieldValue = value[key];
                results.push(key === 'b64_json' || key.toLowerCase().includes('base64') || key.toLowerCase().includes('image_data')
                    ? makeImageDataUrl(fieldValue)
                    : fieldValue);
            }
        });

        Object.keys(value).forEach(function(key) {
            const fieldValue = value[key];
            if (typeof fieldValue === 'string') {
                const lowerKey = key.toLowerCase();
                if (lowerKey.includes('image') || lowerKey.includes('img') || lowerKey.includes('url') || lowerKey.includes('base64') || lowerKey.includes('b64')) {
                    if (/^(https?:\/\/|data:image\/)/i.test(fieldValue.trim()) || isLikelyBase64ImageData(fieldValue)) {
                        results.push(isLikelyBase64ImageData(fieldValue) ? makeImageDataUrl(fieldValue) : fieldValue.trim());
                    }
                }
            } else if (fieldValue && typeof fieldValue === 'object') {
                // 键名像图片字段、但值是对象时要继续下钻。
                // 覆盖 { outputs: [{ image: { url } }] } 这类结构（Adobe Firefly 的官方
                // 响应格式，也是不少网关的常见形状）—— 此前只处理字符串值，
                // 而下面的递归键列表又不含单数 image，导致这类响应一个候选都收不到。
                const lowerKey = key.toLowerCase();
                if (lowerKey.includes('image') || lowerKey.includes('img') || lowerKey.includes('url')
                    || lowerKey.includes('thumb') || lowerKey.includes('file') || lowerKey.includes('asset')
                    || lowerKey === 'output' || lowerKey === 'original' || lowerKey === 'source') {
                    collectImageCandidates(fieldValue, results);
                }
            }
        });

        // Google Gemini 的图像走 inlineData / inline_data：{ mimeType: 'image/png', data: '<裸base64>' }。
        // 这里的 data 没有 data: 前缀，通用启发式（isLikelyBase64ImageData 的长度+字符集判断）
        // 不一定认得出；而且外层键名 candidates / parts / inlineData 原本都不在下面的递归列表里，
        // 导致 Gemini 的官方图像响应一个候选都收不到。这里按 mimeType 显式认下来。
        ['inlineData', 'inline_data'].forEach(function(key) {
            const inline = value[key];
            if (!inline || typeof inline !== 'object') return;
            const mimeType = inline.mimeType || inline.mime_type || '';
            const data = inline.data;
            if (typeof data === 'string' && data.trim() && /^image\//i.test(mimeType)) {
                results.push('data:' + mimeType + ';base64,' + data.trim());
            }
        });

        // candidates/parts 是 Gemini 的容器键，content 已在上面，这里补齐剩下的层级。
        ['data', 'results', 'images', 'result', 'output', 'outputs', 'items', 'attachments', 'choices', 'content', 'message', 'payload', 'response', 'data_list', 'dataList', 'image_list', 'imageList', 'artifacts', 'files', 'candidates', 'parts'].forEach(function(key) {
            collectImageCandidates(value[key], results);
        });

        return results;
    }

    function isLikelyImageResult(value) {
        if (!value) return false;
        if (/^data:image\//i.test(value)) return true;

        try {
            const parsed = new URL(value.replace(/\\\//g, '/'));
            return /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(parsed.pathname)
                || /(?:^|\.)(oaidalleapiprodscus|blob|grs|claude|image|img|cdn|adobe|firefly|storage|xai-imgen)\./i.test(parsed.hostname)
                // 对象存储 / CDN 的预签名直链通常没有扩展名，主机名也不含 image/firefly 等字样
                // （例如 Adobe Firefly 的 pre-signed-firefly-prod.s3-accelerate.amazonaws.com、
                //   火山方舟的 ark-content.volces.com）。
                // 注意：这是硬编码域名表，无法穷举；新渠道返回新域名时需要在
                // isLikelyImageResult 里补一条，否则会报「无法从响应中提取图像」。
                || /(?:^|\.)(amazonaws|cloudfront|aliyuncs|myqcloud|googleusercontent|digitaloceanspaces|backblazeb2|b-cdn|volces|volccdn|byteimg|ibyteimg)\./i.test(parsed.hostname);
        } catch (error) {
            return /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(value);
        }
    }

    function sanitizeImageCandidate(value) {
        if (typeof value !== 'string') return value;
        // data URL 直接返回：base64 里的 = 填充和 + / 不能被当成标点削掉
        if (/^data:image\//i.test(value)) return value.trim();

        let result = value.trim();
        // 从 JSON 字符串里正则扫出来的 URL 常常带着被包裹的标点：
        // markdown 的 ![img](https://x/y.png) 会连右括号一起吃进来，
        // 中文全角括号、列表逗号、句末句号同理。这些脏字符会让下载 404，
        // 所以按尾部逐个剥掉（= 不在集合里，不会破坏 query 参数）。
        const trailing = /[)\]}>"'`,;:，。；：）】》、»”’]+$/;
        let previous;
        do {
            previous = result;
            result = result.replace(trailing, '');
            // markdown 的 <https://x/y.png> 形式：尾部 > 已剥掉，再剥一次配对的
        } while (result !== previous);
        return result;
    }

    function extractImageFromResponse(response) {
        try {
            debugLog('开始提取图像URL...');
            debugLog('响应类型:', typeof response);
            debugLog('响应结构:', JSON.stringify(response, null, 2));

            if (!response) {
                debugLog('响应为空');
                return null;
            }

            const candidates = collectImageCandidates(response, []);
            const serialized = JSON.stringify(response);
            const escapedUrlMatches = serialized.match(/https?:\\?\/\\?\/[^"'\\\s]+/g) || [];
            const dataMatches = serialized.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) || [];
            const allMatches = candidates
                .concat(escapedUrlMatches.map(function(url) { return url.replace(/\\\//g, '/'); }))
                .concat(dataMatches);

            for (let i = 0; i < allMatches.length; i++) {
                const candidate = sanitizeImageCandidate(allMatches[i]);
                if (isLikelyImageResult(candidate)) {
                    debugLog('找到图像结果:', candidate);
                    return candidate;
                }
            }

            debugLog('未找到图像URL');
        } catch (e) {
            console.error('提取图像失败:', e);
        }

        return null;
    }

    
    function base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    function detectImageMimeType(buffer, headerValue) {
        const header = String(headerValue || '').split(';')[0].trim().toLowerCase();
        if (/^image\/(?:png|jpe?g|webp|gif)$/i.test(header)) return header === 'image/jpg' ? 'image/jpeg' : header;
        const bytes = new Uint8Array(buffer || 0);
        if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
        if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
        if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
        return 'image/png';
    }

    async function fetchImageAsDataUrl(imageUrl) {
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error('下载失败: ' + response.status);
        }
        const arrayBuffer = await response.arrayBuffer();
        const mimeType = detectImageMimeType(arrayBuffer, response.headers && response.headers.get && response.headers.get('content-type'));
        return 'data:' + mimeType + ';base64,' + arrayBufferToBase64(arrayBuffer);
    }

    async function putImageDataAtBounds(dataUrl, bounds, layerName, documentId) {
        initCompatibility();
        if (!psAPI.app || !psAPI.core || !psAPI.action || !psAPI.uxp || !psAPI.uxp.storage) {
            throw new Error('Photoshop 回图 API 不可用');
        }
        const normalizedBounds = normalizeBoundsObject(bounds);
        if (!normalizedBounds) throw new Error('回图目标范围无效');
        const requestedDocumentId = Number(documentId);
        const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
        if (!match) throw new Error('回图数据不是有效的 Base64 图像');
        const mimeType = match[1].toLowerCase();
        const extension = mimeType.indexOf('jpeg') > -1 ? 'jpg'
            : mimeType.indexOf('webp') > -1 ? 'webp'
            : 'png';
        const bytes = new Uint8Array(base64ToArrayBuffer(match[2].replace(/\s+/g, '')));
        const fs = psAPI.uxp.storage.localFileSystem;
        const tempFolder = await fs.getTemporaryFolder();
        const tempFile = await tempFolder.createFile(
            'huanmeng_return_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.' + extension,
            { overwrite: true }
        );
        try {
            const binaryFormat = psAPI.uxp.storage.formats && psAPI.uxp.storage.formats.binary;
            await tempFile.write(bytes, binaryFormat ? { format: binaryFormat } : undefined);
            return await psAPI.core.executeAsModal(async function() {
                let targetDocument = null;
                if (Number.isFinite(requestedDocumentId)) {
                    targetDocument = Array.from(psAPI.app.documents || []).find(function(item) {
                        return Number(item.id) === requestedDocumentId;
                    }) || null;
                }
                if (Number.isFinite(requestedDocumentId) && !targetDocument) {
                    throw new Error('生成时绑定的 Photoshop 原文档已关闭，为避免错贴已停止');
                }
                if (!targetDocument) targetDocument = psAPI.app.activeDocument;
                if (!targetDocument) throw new Error('没有可用于回图的 Photoshop 文档');

                if (!psAPI.app.activeDocument || Number(psAPI.app.activeDocument.id) !== Number(targetDocument.id)) {
                    await psAPI.action.batchPlay([{
                        _obj: 'select',
                        _target: [{ _ref: 'document', _id: targetDocument.id }]
                    }], { synchronousExecution: true });
                }

                const sessionToken = await fs.createSessionToken(tempFile);
                await psAPI.action.batchPlay([{
                    _obj: 'placeEvent',
                    null: { _path: sessionToken, _kind: 'local' },
                    linked: false,
                    freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
                    offset: {
                        _obj: 'offset',
                        horizontal: { _unit: 'pixelsUnit', _value: 0 },
                        vertical: { _unit: 'pixelsUnit', _value: 0 }
                    }
                }], { synchronousExecution: true });

                const readActiveBounds = async function() {
                    const result = await psAPI.action.batchPlay([{
                        _obj: 'get',
                        _target: [
                            { _property: 'boundsNoEffects' },
                            { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }
                        ]
                    }], { synchronousExecution: true });
                    const raw = result && result[0] && result[0].boundsNoEffects;
                    if (!raw) throw new Error('无法读取置入图层范围');
                    const value = function(input) {
                        return Number(input && input._value !== undefined ? input._value : input) || 0;
                    };
                    const left = value(raw.left);
                    const top = value(raw.top);
                    const right = value(raw.right);
                    const bottom = value(raw.bottom);
                    return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
                };

                let placedBounds = await readActiveBounds();
                if (placedBounds.width <= 0 || placedBounds.height <= 0) {
                    throw new Error('Photoshop 返回的置入图层尺寸无效');
                }
                const scaleX = normalizedBounds.width / placedBounds.width * 100;
                const scaleY = normalizedBounds.height / placedBounds.height * 100;
                if (Math.abs(scaleX - 100) > 0.01 || Math.abs(scaleY - 100) > 0.01) {
                    await psAPI.action.batchPlay([{
                        _obj: 'transform',
                        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSCorner0' },
                        width: { _unit: 'percentUnit', _value: scaleX },
                        height: { _unit: 'percentUnit', _value: scaleY },
                        interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubicAutomatic' }
                    }], { synchronousExecution: true });
                }

                placedBounds = await readActiveBounds();
                const moveX = normalizedBounds.left - placedBounds.left;
                const moveY = normalizedBounds.top - placedBounds.top;
                if (Math.abs(moveX) > 0.01 || Math.abs(moveY) > 0.01) {
                    await psAPI.action.batchPlay([{
                        _obj: 'move',
                        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                        to: {
                            _obj: 'offset',
                            horizontal: { _unit: 'pixelsUnit', _value: moveX },
                            vertical: { _unit: 'pixelsUnit', _value: moveY }
                        }
                    }], { synchronousExecution: true });
                }

                await psAPI.action.batchPlay([{
                    _obj: 'rasterizeLayer',
                    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
                }], { synchronousExecution: true });

                const activeDocument = psAPI.app.activeDocument;
                const layer = activeDocument && activeDocument.activeLayers && activeDocument.activeLayers[0];
                if (!layer) throw new Error('Photoshop 未返回回图图层');
                layer.name = layerName || '幻梦 AI 回图';
                return layer;
            }, { commandName: '幻梦 AI 精确回图' });
        } finally {
            try { await tempFile.delete(); } catch (ignoreTempCleanupError) {}
        }
    }

    const Photoshop = {
        async getSelectedRegion() {
            if (!psAPI.app) {
                return { error: "UXP模块未加载" };
            }
            
            try {
                const doc = psAPI.app.activeDocument;
                if (!doc) {
                    return { error: "没有活动文档" };
                }
                
                const sel = doc.selection;
                if (!sel || sel.bounds === undefined) {
                    return { error: "没有选区", hasSelection: false };
                }
                
                const b = sel.bounds;
                return { 
                    hasSelection: true, 
                    bounds: { 
                        left: b[0], 
                        top: b[1], 
                        right: b[2], 
                        bottom: b[3], 
                        width: b[2] - b[0], 
                        height: b[3] - b[1] 
                    } 
                };
            } catch (e) {
                return { error: e.message };
            }
        },
        
        async createDocument(base64Data, width, height, name) {
            if (!psAPI.app || !psAPI.core || !psAPI.uxp || !psAPI.uxp.storage) {
                return { error: "UXP模块未加载" };
            }

            try {
                const match = String(base64Data || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
                if (!match) return { error: '回图数据不是有效的 Base64 图像' };
                const mimeType = match[1].toLowerCase();
                const extension = mimeType.indexOf('jpeg') > -1 ? 'jpg'
                    : mimeType.indexOf('webp') > -1 ? 'webp'
                    : 'png';
                const bytes = new Uint8Array(base64ToArrayBuffer(match[2].replace(/\s+/g, '')));
                const fs = psAPI.uxp.storage.localFileSystem;
                const tempFolder = await fs.getTemporaryFolder();
                const safeName = String(name || 'AI 生成')
                    .replace(/[\\/:*?"<>|]+/g, '_')
                    .slice(0, 48) || 'AI 生成';
                const tempFile = await tempFolder.createFile(
                    safeName + '_' + Date.now() + '.' + extension,
                    { overwrite: true }
                );
                await tempFile.write(bytes);
                const document = await psAPI.core.executeAsModal(async function() {
                    return psAPI.app.open(tempFile);
                }, { commandName: '打开 AI 生成图像' });
                if (!document) return { error: 'Photoshop 未返回新文档' };
                return {
                    success: true,
                    document: document,
                    documentName: document.name || safeName,
                    width: width,
                    height: height
                };
            } catch (e) {
                return { error: e.message };
            }
        }
    };

    async function downloadAndCreateDocument(imageUrl, width, height, prompt, type, timestamp, model) {
        try {
            let base64;
            
            if (imageUrl.startsWith('data:')) {
                base64 = imageUrl;
            } else {
                base64 = await fetchImageAsDataUrl(imageUrl);
            }
            
            const docResult = await Photoshop.createDocument(base64, width, height, 'Gemini AI - ' + type);
            
            if (docResult && docResult.success) {
                showStatus('图像已生成并创建新文档: ' + docResult.documentName, 'success');
                showToast('图像已创建: ' + docResult.documentName);
                
                Config.addLog({
                    timestamp: timestamp,
                    model: model,
                    prompt: prompt,
                    width: width,
                    height: height,
                    type: type,
                    status: '成功',
                    documentName: docResult.documentName
                });
                return true;
            } else {
                const errorMsg = docResult ? docResult.error : '未知错误';
                showStatus('创建文档失败：' + errorMsg, 'error');
                
                Config.addLog({
                    timestamp: timestamp,
                    model: model,
                    prompt: prompt,
                    width: width,
                    height: height,
                    type: type,
                    status: '失败',
                    error: 'API调用成功但创建文档失败: ' + errorMsg
                });
                return false;
            }
        } catch (e) {
            showStatus('处理图像失败：' + e.message, 'error');
            
            Config.addLog({
                timestamp: timestamp,
                model: model,
                prompt: prompt,
                width: width,
                height: height,
                type: type,
                status: '失败',
                error: '处理图像失败: ' + e.message
            });
            return false;
        }
    }
    
    async function downloadAndPlaceDocument(imageUrl, width, height, prompt, type, timestamp, model, placementContext) {
        initCompatibility();
        const context = placementContext || {};
        const targetBounds = context.bounds ? Object.assign({}, context.bounds) : (savedSelectionBounds ? Object.assign({}, savedSelectionBounds) : null);
        // 取消信号由调用方经 placementContext 传进来。
        // 以前读的是全局的 currentGenerationAbortController —— 并发下那个
        // 只指向最后一个任务，会让先跑的任务误判成「被取消」。
        const abortSignal = context.abortSignal || null;
        const targetDocumentId = context.documentId == null ? savedDocumentId : context.documentId;
        const targetDocumentName = context.documentName || '';
        debugLog("开始处理图像...");
        debugLog("imageUrl 长度:", imageUrl ? imageUrl.length : 0);
        debugLog("imageUrl 前100字符:", imageUrl ? imageUrl.substring(0, 100) : '');
        debugLog("targetBounds:", targetBounds);
        debugLog("对齐模式:", currentSettings && currentSettings.alignmentMode);
        
        let galleryItem = null;
        try {
            let base64;
            
            if (imageUrl.startsWith('data:')) {
                debugLog("使用 data URL 格式");
                base64 = imageUrl;
                debugLog("data URL 长度:", base64.length);
            } else {
                debugLog("从 URL 下载图像:", imageUrl.substring(0, 100));
                try {
                    const response = await fetch(imageUrl);
                    debugLog("下载响应状态:", response.status);
                    if (!response.ok) {
                        throw new Error('下载失败: ' + response.status);
                    }
                    const arrayBuffer = await response.arrayBuffer();
                    debugLog("ArrayBuffer 大小:", arrayBuffer.byteLength);
                    const mimeType = detectImageMimeType(arrayBuffer, response.headers && response.headers.get && response.headers.get('content-type'));
                    base64 = "data:" + mimeType + ";base64," + arrayBufferToBase64(arrayBuffer);
                    debugLog("Base64 长度:", base64.length);
                } catch (downloadError) {
                    console.error("下载图像失败:", downloadError);
                    throw downloadError;
                }
            }
            
            debugLog("Base64 长度:", base64.length);

            if (abortSignal && abortSignal.aborted) {
                throw new Error('生成任务已取消');
            }

            if (context.galleryItemId) {
                galleryItem = { id: context.galleryItemId };
            } else if (!context.skipArchive) {
                galleryItem = await archiveGeneratedImage(base64, {
                    type: type,
                    sourceLabel: getGenerationSourceLabel(type, model),
                    model: model || '',
                    prompt: prompt || '',
                    width: Number(width) || (targetBounds && targetBounds.width) || 0,
                    height: Number(height) || (targetBounds && targetBounds.height) || 0,
                    bounds: targetBounds,
                    documentId: targetDocumentId,
                    documentName: targetDocumentName,
                    placed: false
                });
                if (galleryItem) {
                    Config.addLog({
                        timestamp: timestamp,
                        model: model,
                        prompt: prompt,
                        width: Number(width) || (targetBounds && targetBounds.width) || 0,
                        height: Number(height) || (targetBounds && targetBounds.height) || 0,
                        type: type,
                        status: '已生成',
                        galleryItemId: galleryItem.id,
                        documentName: targetDocumentName
                    });
                    renderGallery().catch(function(error) { console.warn('刷新画廊失败:', error); });
                    try { updateLogDisplay(); } catch (ignore) {}
                }
            }

            // H5 / 浏览器没有 Photoshop 文档目标。输出只进入画廊，由画廊统一
            // 负责放大与下载；不在生成函数里自动下载，也不尝试创建文档。
            if (!psAPI.isAvailable) {
                if (!galleryItem && !context.skipArchive) {
                    throw new Error('输出图片未能保存到画廊');
                }
                if (galleryItem && window.HuanmengGalleryStore) {
                    await window.HuanmengGalleryStore.update(galleryItem.id, {
                        placed: false,
                        browserReady: true,
                        lastSavedAt: Date.now()
                    });
                }
                showStatus('图片已保存到画廊', 'success');
                showToast('已加入画廊');
                renderGallery().catch(function(error) { console.warn('刷新画廊失败:', error); });
                return true;
            }

            let autoColorTimeoutId = null;
            try {
                base64 = await Promise.race([
                    maybeAutoColorMatchReturnedImage(base64),
                    new Promise(function(resolve) {
                        autoColorTimeoutId = setTimeout(function() {
                            console.warn('自动融合校色超过 20 秒，已跳过并继续回图');
                            resolve(base64);
                        }, 20000);
                    })
                ]);
            } finally {
                if (autoColorTimeoutId) clearTimeout(autoColorTimeoutId);
            }
            debugLog("校色后 Base64 长度:", base64.length);

            if (abortSignal && abortSignal.aborted) {
                throw new Error('生成任务已取消');
            }

            if (psAPI.app && psAPI.core && psAPI.action && targetBounds) {
                const layerName = type === 'space-fx' ? '空间特效 · ' + (model || '本地')
                    : type === 'color-match' ? '融合校色 · ' + (model || '')
                    : '幻梦 AI 回图 · ' + (model || type || '图像');
                const placedLayer = await putImageDataAtBounds(base64, targetBounds, layerName, targetDocumentId);
                if (!placedLayer) throw new Error('Photoshop 回图未创建图层');
                if (galleryItem && window.HuanmengGalleryStore) {
                    await window.HuanmengGalleryStore.update(galleryItem.id, { placed: true, layerId: placedLayer.id, lastPlacedAt: Date.now() });
                    // 回图后图已经在文档里了，直接从画布抓一张 320px 的小图当缩略图。
                    // 这条路不经过 JS 图片解码——实测 UXP 解不了几 MB 的 data URL
                    // （naturalWidth 为 0），所以不能在存档时用 new Image() 生成缩略图。
                    // 缩略图失败不影响主流程，静默降级为「卡片无预览」。
                    try {
                        const thumbSource = await captureBoundsToBrowserImageData(targetBounds, 240);
                        if (!thumbSource || !thumbSource.width) {
                            console.warn('画廊缩略图：画布抓取为空，卡片将没有预览');
                        } else {
                            const thumbUrl = await encodeBrowserImageDataToDataUrl(thumbSource);
                            if (!thumbUrl) {
                                console.warn('画廊缩略图：编码结果为空，卡片将没有预览');
                            } else {
                                await window.HuanmengGalleryStore.setThumbnail(galleryItem.id, thumbUrl);
                                console.log('画廊缩略图已写入:', galleryItem.id,
                                    thumbSource.width + 'x' + thumbSource.height,
                                    Math.round(thumbUrl.length / 1024) + 'KB');
                            }
                        }
                    } catch (thumbError) {
                        console.warn('画廊缩略图生成失败，卡片将没有预览:', thumbError);
                    }
                    renderGallery().catch(function(error) { console.warn('刷新画廊失败:', error); });
                }
                showStatus('图像已精确回写到原位置', 'success');
                showToast('图像已回写 Photoshop');
                Config.addLog({
                    timestamp: timestamp,
                    model: model,
                    prompt: prompt,
                    width: targetBounds.width,
                    height: targetBounds.height,
                    type: type,
                    status: '成功',
                    layerId: placedLayer.id
                });
                return true;
            }
            
            // 获取生成图像的尺寸
            let generatedWidth = width;
            let generatedHeight = height;
            debugLog("生成图像尺寸:", generatedWidth, generatedHeight);
            
            if (psAPI.app && psAPI.core && savedSelectionBounds) {
                debugLog("尝试放置到选区...");
                try {
                    if (!psAPI.uxp || !psAPI.uxp.storage || !psAPI.uxp.storage.localFileSystem) {
                        throw new Error("UXP storage API not available");
                    }
                    const fs = psAPI.uxp.storage.localFileSystem;
                    const base64Content = base64.replace(/^data:image\/\w+;base64,/, "");
                    debugLog("base64Content 长度:", base64Content.length);
                    
                    try {
                        const buffer = base64ToArrayBuffer(base64Content);
                        const bytes = new Uint8Array(buffer);
                        debugLog("字节长度:", bytes.byteLength);
                        
                        const tempFolder = await fs.getTemporaryFolder();
                        debugLog("临时文件夹:", tempFolder);
                        
                        const fileName = `generated_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
                        debugLog("临时文件名:", fileName);
                        
                        const tempFile = await tempFolder.createFile(fileName, { overwrite: true });
                        debugLog("临时文件创建成功:", tempFile);
                        
                        await tempFile.write(bytes);
                        debugLog("临时文件写入成功:", tempFile.nativePath);
                        
                        // 处理对齐模式
                        let exportBounds = savedSelectionBounds;
                        let selectionWidth = savedSelectionBounds.width;
                        let selectionHeight = savedSelectionBounds.height;
                        
                        const alignmentMode = currentSettings.alignmentMode || 'normal';
                        const scaleToSelection = alignmentMode === 'fit-layer' || alignmentMode === 'force1x1' || alignmentMode === 'smart';
                        debugLog("对齐模式:", alignmentMode);
                        
                        if (alignmentMode === 'force1x1') {
                            // 1:1 强制无偏移模式
                            debugLog("使用 1:1 强制无偏移模式");
                            const captureResult = await captureWithNoOffset(savedSelectionBounds);
                            exportBounds = captureResult.exportBounds;
                            selectionWidth = captureResult.width;
                            selectionHeight = captureResult.height;
                            debugLog("1:1 强制无偏移模式处理后的边界:", exportBounds);
                        } else if (alignmentMode === 'smart') {
                            // 智能对齐模式
                            debugLog("使用智能对齐模式");
                            // 创建智能对齐任务
                            const smartAlignTask = {
                                ratio: "auto",
                                bounds: savedSelectionBounds,
                                baseImageWidth: selectionWidth,
                                baseImageHeight: selectionHeight,
                                platform: "photoshop",
                                baseImage: psAPI.app.activeDocument
                            };
                            
                            // 执行智能对齐
                            await smartAlignImage(smartAlignTask);
                            debugLog("智能对齐完成，比例锁定为:", smartAlignTask.ratio);
                        }
                        
                        await psAPI.core.executeAsModal(async () => {
                            const doc = psAPI.app.activeDocument;
                            if (!doc) {
                                throw new Error('没有活动文档');
                            }
                            debugLog("活动文档:", doc.name);
                            
                            debugLog("创建 session token...");
                            const sessionToken = fs.createSessionToken(tempFile);
                            debugLog("session token:", sessionToken);
                            
                            // 保存当前选区
                            let originalSelection = null;
                            try {
                                originalSelection = doc.selection.bounds;
                                debugLog("保存原始选区:", originalSelection);
                            } catch (e) {
                                debugLog("无法保存原始选区:", e);
                            }
                            
                            // 计算选区的精确坐标和尺寸（原图尺寸）
                            const selectionLeft = exportBounds.left;
                            const selectionTop = exportBounds.top;
                            const selectionRight = exportBounds.right;
                            const selectionBottom = exportBounds.bottom;
                            
                            debugLog("原图选区坐标:", {
                                left: selectionLeft,
                                top: selectionTop,
                                right: selectionRight,
                                bottom: selectionBottom,
                                width: selectionWidth,
                                height: selectionHeight
                            });
                            
                            // 根据对齐模式计算缩放比例
                            let scaleX = selectionWidth / generatedWidth;
                            let scaleY = selectionHeight / generatedHeight;
                            
                            debugLog("对齐模式:", alignmentMode);
                            
                            if (scaleToSelection) {
                                if (alignmentMode === 'force1x1') {
                                    const minScale = Math.min(scaleX, scaleY);
                                    scaleX = minScale;
                                    scaleY = minScale;
                                    debugLog("1:1 强制无偏移模式，使用缩放比例:", minScale);
                                } else if (alignmentMode === 'smart') {
                                    const maxScale = Math.min(scaleX, scaleY);
                                    scaleX = maxScale;
                                    scaleY = maxScale;
                                    debugLog("智能对齐模式，使用缩放比例:", maxScale);
                                }
                            } else {
                                scaleX = 1;
                                scaleY = 1;
                            }
                            
                            debugLog("缩放比例 (原图/生成图):", scaleX, scaleY);
                            
                            // 设置选区
                            const setSelectionCommand = {
                                "_obj": "set",
                                "_target": [
                                    {
                                        "_property": "selection",
                                        "_ref": "channel"
                                    }
                                ],
                                "to": {
                                    "_obj": "rectangle",
                                    "bottom": {
                                        "_unit": "pixelsUnit",
                                        "_value": selectionBottom
                                    },
                                    "left": {
                                        "_unit": "pixelsUnit",
                                        "_value": selectionLeft
                                    },
                                    "right": {
                                        "_unit": "pixelsUnit",
                                        "_value": selectionRight
                                    },
                                    "top": {
                                        "_unit": "pixelsUnit",
                                        "_value": selectionTop
                                    }
                                }
                            };
                            
                            // 放置图像命令 - 使用左上角作为变换中心
                            const placeCommand = {
                                _obj: "placeEvent",
                                null: { _path: sessionToken, _kind: "local" },
                                linked: false,
                                freeTransformCenterState: {
                                    _enum: "quadCenterState",
                                    _value: "QCSCorner0"
                                }
                            };
                            
                            debugLog("开始 batchPlay...");
                            try {
                                const result = await psAPI.app.batchPlay(
                                    [
                                        setSelectionCommand,
                                        placeCommand
                                    ],
                                    { synchronousExecution: true }
                                );
                                debugLog("batchPlay 完成，结果:", result);
                            } catch (batchPlayError) {
                                console.error("batchPlay 错误:", batchPlayError);
                                throw batchPlayError;
                            }
                            
                            // 确保图层被正确放置
                            let placedLayer = doc.activeLayers[0];
                            if (!placedLayer) {
                                // 尝试获取所有图层并找到最新的一个
                                const layers = doc.layers;
                                if (layers.length > 0) {
                                    placedLayer = layers[layers.length - 1];
                                    debugLog("使用最后一个图层:", placedLayer.name);
                                } else {
                                    throw new Error("没有图层被放置");
                                }
                            }
                            debugLog("已放置图层:", placedLayer.name);
                            
                            // 重新获取图层边界 - 使用boundsNoEffects获取更精确的边界
                            let currentBounds = null;
                            let currentLeft = 0, currentTop = 0, currentWidth = 0, currentHeight = 0;
                            
                            try {
                                const boundsResult = await psAPI.app.batchPlay([{
                                    _obj: "get",
                                    _target: [{ _property: "boundsNoEffects" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
                                }], {});
                                
                                if (boundsResult && boundsResult[0] && boundsResult[0].boundsNoEffects) {
                                    const b = boundsResult[0].boundsNoEffects;
                                    currentLeft = (b.left && b.left._value !== undefined) ? b.left._value : (b.left || 0);
                                    currentTop = (b.top && b.top._value !== undefined) ? b.top._value : (b.top || 0);
                                    const bRight = (b.right && b.right._value !== undefined) ? b.right._value : (b.right || 0);
                                    const bBottom = (b.bottom && b.bottom._value !== undefined) ? b.bottom._value : (b.bottom || 0);
                                    currentWidth = bRight - currentLeft;
                                    currentHeight = bBottom - currentTop;
                                    currentBounds = { left: currentLeft, top: currentTop, right: bRight, bottom: bBottom };
                                }
                            } catch (boundsError) {
                                debugLog("获取boundsNoEffects失败，尝试使用普通bounds:", boundsError);
                            }
                            
                            // 降级处理：如果boundsNoEffects失败，使用普通bounds
                            if (!currentBounds || currentWidth <= 0 || currentHeight <= 0) {
                                try {
                                    const boundsResult2 = await psAPI.app.batchPlay([{
                                        _obj: "get",
                                        _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
                                    }], {});
                                    
                                    if (boundsResult2 && boundsResult2[0] && boundsResult2[0].bounds) {
                                        const b2 = boundsResult2[0].bounds;
                                        currentLeft = (b2.left && b2.left._value !== undefined) ? b2.left._value : (b2.left || 0);
                                        currentTop = (b2.top && b2.top._value !== undefined) ? b2.top._value : (b2.top || 0);
                                        const b2Right = (b2.right && b2.right._value !== undefined) ? b2.right._value : (b2.right || 0);
                                        const b2Bottom = (b2.bottom && b2.bottom._value !== undefined) ? b2.bottom._value : (b2.bottom || 0);
                                        currentWidth = b2Right - currentLeft;
                                        currentHeight = b2Bottom - currentTop;
                                        currentBounds = { left: currentLeft, top: currentTop, right: b2Right, bottom: b2Bottom };
                                    }
                                } catch (boundsError2) {
                                    debugLog("获取bounds失败，使用默认值:", boundsError2);
                                    currentBounds = placedLayer.bounds;
                                    currentLeft = currentBounds.left;
                                    currentTop = currentBounds.top;
                                    currentWidth = currentBounds.right - currentBounds.left;
                                    currentHeight = currentBounds.bottom - currentBounds.top;
                                }
                            }
                            
                            debugLog("当前图层尺寸:", currentWidth, currentHeight);
                            debugLog("目标尺寸:", selectionWidth, selectionHeight);
                            
                            // 计算从当前大小到目标大小的缩放比例
                            const finalScaleX = selectionWidth / currentWidth;
                            const finalScaleY = selectionHeight / currentHeight;
                            debugLog("缩放比例 (目标/当前):", finalScaleX, finalScaleY);
                            
                            // 根据对齐模式计算移动距离
                            let translateX = selectionLeft - currentLeft;
                            let translateY = selectionTop - currentTop;
                            
                            if (alignmentMode === 'force1x1' || alignmentMode === 'smart') {
                                // 计算缩放后的图像尺寸
                                const scaledWidth = currentWidth * finalScaleX;
                                const scaledHeight = currentHeight * finalScaleY;

                                // 计算居中位置
                                const centerX = selectionLeft + (selectionWidth - scaledWidth) / 2;
                                const centerY = selectionTop + (selectionHeight - scaledHeight) / 2;

                                // 计算从当前左上角到居中位置的移动距离
                                translateX = centerX - currentLeft;
                                translateY = centerY - currentTop;
                                debugLog("居中对齐模式，移动距离:", translateX, translateY);
                            } else {
                                // 普通对齐，使用左上角对齐
                                debugLog("普通对齐模式，移动距离:", translateX, translateY);
                            }
                            
                            // 分步执行变换：先缩放，再移动，确保更高的精度
                            try {
                                let scaleXPercent = finalScaleX * 100;
                                let scaleYPercent = finalScaleY * 100;

                                // 1. 缩放到目标尺寸
                                if (currentWidth > 0 && currentHeight > 0) {
                                    if (alignmentMode === 'force1x1' || alignmentMode === 'smart') {
                                        // 保持 1:1 比例
                                        const minScalePercent = Math.min(scaleXPercent, scaleYPercent);
                                        scaleXPercent = minScalePercent;
                                        scaleYPercent = minScalePercent;
                                        debugLog("使用 1:1 缩放比例:", minScalePercent);
                                    }

                                    if (scaleToSelection && (Math.abs(scaleXPercent - 100) > 0.01 || Math.abs(scaleYPercent - 100) > 0.01)) {
                                        debugLog("执行缩放命令");
                                        const scaleCommand = {
                                            _obj: "transform",
                                            _target: {
                                                _ref: "layer",
                                                _id: placedLayer.id
                                            },
                                            freeTransformCenterState: {
                                                _enum: "quadCenterState",
                                                _value: "QCSCorner0"
                                            },
                                            width: { _unit: "percentUnit", _value: scaleXPercent },
                                            height: { _unit: "percentUnit", _value: scaleYPercent },
                                            interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubicAutomatic" }
                                        };
                                        await psAPI.app.batchPlay([scaleCommand], { synchronousExecution: true });
                                        debugLog("图层缩放成功");
                                    }
                                }

                                // 2. 重新获取缩放后的边界
                                let scaledBounds = null;
                                try {
                                    const scaledBoundsResult = await psAPI.app.batchPlay([{
                                        _obj: "get",
                                        _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
                                    }], {});
                                    if (scaledBoundsResult && scaledBoundsResult[0] && scaledBoundsResult[0].bounds) {
                                        scaledBounds = scaledBoundsResult[0].bounds;
                                    }
                                } catch (scaledBoundsError) {
                                    debugLog("获取缩放后边界失败:", scaledBoundsError);
                                }
                                
                                // 3. 精确移动到目标位置
                                let scaledLeft = currentLeft;
                                let scaledTop = currentTop;
                                if (scaledBounds) {
                                    scaledLeft = (scaledBounds.left && scaledBounds.left._value !== undefined) ? scaledBounds.left._value : (scaledBounds.left || 0);
                                    scaledTop = (scaledBounds.top && scaledBounds.top._value !== undefined) ? scaledBounds.top._value : (scaledBounds.top || 0);
                                }
                                
                                let moveX, moveY;
                                
                                if (alignmentMode === 'force1x1' || alignmentMode === 'smart') {
                                    // 计算缩放后的图像尺寸
                                    const scaledWidth = currentWidth * (scaleXPercent / 100);
                                    const scaledHeight = currentHeight * (scaleYPercent / 100);
                                    
                                    // 计算居中位置
                                    const centerX = selectionLeft + (selectionWidth - scaledWidth) / 2;
                                    const centerY = selectionTop + (selectionHeight - scaledHeight) / 2;
                                    
                                    // 计算从当前左上角到居中位置的移动距离
                                    moveX = centerX - scaledLeft;
                                    moveY = centerY - scaledTop;
                                    debugLog("居中对齐模式，需要移动:", moveX, moveY);
                                } else {
                                    // 普通对齐，使用左上角对齐
                                    moveX = selectionLeft - scaledLeft;
                                    moveY = selectionTop - scaledTop;
                                    debugLog("普通对齐模式，需要移动:", moveX, moveY);
                                }
                                
                                debugLog("缩放后位置:", scaledLeft, scaledTop);
                                debugLog("目标位置:", selectionLeft, selectionTop);
                                
                                if (Math.abs(moveX) > 0.1 || Math.abs(moveY) > 0.1) {
                                    debugLog("执行移动命令");
                                    const moveCommand = {
                                        _obj: "move",
                                        _target: {
                                            _ref: "layer",
                                            _id: placedLayer.id
                                        },
                                        to: {
                                            _obj: "offset",
                                            horizontal: { _unit: "pixelsUnit", _value: moveX },
                                            vertical: { _unit: "pixelsUnit", _value: moveY }
                                        }
                                    };
                                    await psAPI.app.batchPlay([moveCommand], { synchronousExecution: true });
                                    debugLog("图层移动成功");
                                }
                                
                                debugLog("图层变换成功");
                            } catch (transformError) {
                                console.error("变换命令失败:", transformError);
                                
                                // 如果变换命令失败，尝试使用set命令直接设置图层边界
                                try {
                                    debugLog("尝试使用set命令设置图层边界");
                                    const setBoundsCommand = {
                                        _obj: "set",
                                        _target: {
                                            _ref: "layer",
                                            _id: placedLayer.id
                                        },
                                        to: {
                                            _obj: "layer",
                                            bounds: {
                                                _obj: "rectangle",
                                                left: {
                                                    _unit: "pixelsUnit",
                                                    _value: selectionLeft
                                                },
                                                top: {
                                                    _unit: "pixelsUnit",
                                                    _value: selectionTop
                                                },
                                                right: {
                                                    _unit: "pixelsUnit",
                                                    _value: selectionRight
                                                },
                                                bottom: {
                                                    _unit: "pixelsUnit",
                                                    _value: selectionBottom
                                                }
                                            }
                                        }
                                    };
                                    
                                    debugLog("执行设置边界命令:", JSON.stringify(setBoundsCommand, null, 2));
                                    await psAPI.app.batchPlay([setBoundsCommand], { synchronousExecution: true });
                                    debugLog("图层边界设置成功");
                                } catch (setError) {
                                    console.error("设置边界失败:", setError);
                                }
                            }
                            
                            // 提交最终变换
                            try {
                                const commitTransformCommand = {
                                    _obj: "commitTransformEvent"
                                };
                                await psAPI.app.batchPlay([commitTransformCommand], { synchronousExecution: true });
                                debugLog("最终变换已提交");
                            } catch (commitError) {
                                debugLog("提交最终变换失败:", commitError);
                            }
                            
                            // 添加5%边缘羽化
                            try {
                                // 计算羽化半径（20%的最小边长）
                                const featherRadius = Math.min(selectionWidth, selectionHeight) * 0.20;
                                debugLog("羽化半径:", featherRadius);
                                
                                // 为图层添加蒙版
                                const addMaskCommand = {
                                    _obj: "add",
                                    _target: [{
                                        _ref: "layer",
                                        _id: placedLayer.id
                                    }],
                                    using: {
                                        _obj: "layerMask",
                                        invert: false
                                    }
                                };
                                await psAPI.app.batchPlay([addMaskCommand], { synchronousExecution: true });
                                debugLog("已添加图层蒙版");
                                
                                // 对蒙版应用羽化
                                const featherCommand = {
                                    _obj: "feather",
                                    _target: [{
                                        _ref: "channel",
                                        _property: "transparency"
                                    }],
                                    distance: {
                                        _unit: "pixelsUnit",
                                        _value: featherRadius
                                    }
                                };
                                await psAPI.app.batchPlay([featherCommand], { synchronousExecution: true });
                                debugLog("蒙版已羽化");
                            } catch (featherError) {
                                debugLog("添加羽化失败:", featherError);
                            }
                            
                            // 转换为智能对象
                            try {
                                const convertToSmartObjectCommand = {
                                    _obj: "newPlacedLayer",
                                    _target: [{
                                        _ref: "layer",
                                        _id: placedLayer.id
                                    }]
                                };
                                await psAPI.app.batchPlay([convertToSmartObjectCommand], { synchronousExecution: true });
                                debugLog("图层已转换为智能对象");
                            } catch (smartObjectError) {
                                debugLog("转换为智能对象失败:", smartObjectError);
                            }
                            
                            try {
                                await applyVfxBlendModeToActiveLayer();
                                debugLog('已应用 VFX 混合模式');
                            } catch (blendModeError) {
                                debugLog('应用 VFX 混合模式失败:', blendModeError);
                            }

                            // 再次确认图层位置和大小 - 使用boundsNoEffects获取更精确的边界
                            try {
                                let finalBounds = null;
                                let finalLeft = 0, finalTop = 0, finalWidth = 0, finalHeight = 0;
                                
                                try {
                                    const finalBoundsResult = await psAPI.app.batchPlay([{
                                        _obj: "get",
                                        _target: [{ _property: "boundsNoEffects" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
                                    }], {});
                                    
                                    if (finalBoundsResult && finalBoundsResult[0] && finalBoundsResult[0].boundsNoEffects) {
                                        const b = finalBoundsResult[0].boundsNoEffects;
                                        finalLeft = (b.left && b.left._value !== undefined) ? b.left._value : (b.left || 0);
                                        finalTop = (b.top && b.top._value !== undefined) ? b.top._value : (b.top || 0);
                                        const bRight = (b.right && b.right._value !== undefined) ? b.right._value : (b.right || 0);
                                        const bBottom = (b.bottom && b.bottom._value !== undefined) ? b.bottom._value : (b.bottom || 0);
                                        finalWidth = bRight - finalLeft;
                                        finalHeight = bBottom - finalTop;
                                        finalBounds = { left: finalLeft, top: finalTop, right: bRight, bottom: bBottom };
                                    }
                                } catch (finalBoundsError) {
                                    debugLog("获取最终boundsNoEffects失败，尝试使用普通bounds:", finalBoundsError);
                                }
                                
                                // 降级处理：如果boundsNoEffects失败，使用普通bounds
                                if (!finalBounds || finalWidth <= 0 || finalHeight <= 0) {
                                    try {
                                        const finalBoundsResult2 = await psAPI.app.batchPlay([{
                                            _obj: "get",
                                            _target: [{ _property: "bounds" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }]
                                        }], {});
                                        
                                        if (finalBoundsResult2 && finalBoundsResult2[0] && finalBoundsResult2[0].bounds) {
                                            const b2 = finalBoundsResult2[0].bounds;
                                            finalLeft = (b2.left && b2.left._value !== undefined) ? b2.left._value : (b2.left || 0);
                                            finalTop = (b2.top && b2.top._value !== undefined) ? b2.top._value : (b2.top || 0);
                                            const b2Right = (b2.right && b2.right._value !== undefined) ? b2.right._value : (b2.right || 0);
                                            const b2Bottom = (b2.bottom && b2.bottom._value !== undefined) ? b2.bottom._value : (b2.bottom || 0);
                                            finalWidth = b2Right - finalLeft;
                                            finalHeight = b2Bottom - finalTop;
                                            finalBounds = { left: finalLeft, top: finalTop, right: b2Right, bottom: b2Bottom };
                                        }
                                    } catch (finalBoundsError2) {
                                        debugLog("获取最终bounds失败，使用默认值:", finalBoundsError2);
                                        finalBounds = placedLayer.bounds;
                                        finalLeft = finalBounds.left;
                                        finalTop = finalBounds.top;
                                        finalWidth = finalBounds.right - finalBounds.left;
                                        finalHeight = finalBounds.bottom - finalBounds.top;
                                    }
                                }
                                
                                debugLog("最终图层尺寸:", finalWidth, finalHeight);
                                debugLog("最终图层位置:", finalLeft, finalTop);
                                debugLog("目标位置:", savedSelectionBounds.left, savedSelectionBounds.top);
                                debugLog("目标尺寸:", savedSelectionBounds.width, savedSelectionBounds.height);
                                
                                // 计算误差
                                let targetLeft, targetTop;
                                
                                if (alignmentMode === 'force1x1' || alignmentMode === 'smart') {
                                    // 计算居中位置
                                    const centerX = savedSelectionBounds.left + (savedSelectionBounds.width - finalWidth) / 2;
                                    const centerY = savedSelectionBounds.top + (savedSelectionBounds.height - finalHeight) / 2;
                                    targetLeft = centerX;
                                    targetTop = centerY;
                                } else {
                                    // 普通对齐，使用左上角对齐
                                    targetLeft = savedSelectionBounds.left;
                                    targetTop = savedSelectionBounds.top;
                                }
                                
                                const positionErrorX = Math.abs(finalLeft - targetLeft);
                                const positionErrorY = Math.abs(finalTop - targetTop);
                                const sizeErrorWidth = Math.abs(finalWidth - savedSelectionBounds.width);
                                const sizeErrorHeight = Math.abs(finalHeight - savedSelectionBounds.height);
                                debugLog("位置误差:", positionErrorX, positionErrorY);
                                debugLog("尺寸误差:", sizeErrorWidth, sizeErrorHeight);
                                
                                // 校正位置误差
                                const fixX = targetLeft - finalLeft;
                                const fixY = targetTop - finalTop;
                                
                                if (Math.abs(fixX) > 0.05 || Math.abs(fixY) > 0.05) {
                                    await psAPI.app.batchPlay([{
                                        _obj: "move",
                                        _target: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
                                        to: {
                                            _obj: "offset",
                                            horizontal: { _unit: "pixelsUnit", _value: fixX },
                                            vertical: { _unit: "pixelsUnit", _value: fixY }
                                        }
                                    }], { synchronousExecution: true });
                                    debugLog("位置校正完成，移动距离:", fixX, fixY);
                                }
                            } catch (e) {
                                debugLog("获取最终图层信息失败:", e);
                            }
                            
                            try {
                                    // 检查是否启用 1:1 强制无偏移模式
                                    if (alignmentMode === 'force1x1') {
                                        // 使用精确还原函数
                                        await restorePosition(placedLayer, exportBounds);
                                        debugLog("1:1 强制无偏移模式 - 图层位置已精确还原");
                                    }
                                    
                                    await tempFile.delete();
                                    debugLog("临时文件已删除");
                                } catch (e) {
                                    debugLog("删除临时文件失败:", e);
                                }
                                
                                debugLog("完美放回原处！");
                            }, { commandName: "AI 图像回填" });
                            
                            showStatus('图像已生成并放置到原位置', 'success');
                            showToast('图像已放置到原位置');
                        
                        Config.addLog({
                            timestamp: timestamp,
                            model: model,
                            prompt: prompt,
                            width: width,
                            height: height,
                            type: type,
                            status: '成功'
                        });
                        return true;
                    } catch (tempFileError) {
                        console.error("临时文件处理失败:", tempFileError);
                        throw tempFileError;
                    }
                } catch (placeError) {
                    console.error("放置到选区失败，尝试创建新文档:", placeError);
                    return await downloadAndCreateDocument(imageUrl, width, height, prompt, type, timestamp, model);
                }
            } else {
                debugLog("没有选区，创建新文档...");
                return await downloadAndCreateDocument(imageUrl, width, height, prompt, type, timestamp, model);
            }
        } catch (e) {
            console.error('处理图像失败:', e);
            showStatus('处理图像失败：' + e.message, 'error');
            if (galleryItem && window.HuanmengGalleryStore) {
                try {
                    await window.HuanmengGalleryStore.update(galleryItem.id, {
                        placed: false,
                        placementError: e && e.message ? e.message : String(e),
                        lastPlacementAttemptAt: Date.now()
                    });
                    await renderGallery();
                } catch (galleryError) {
                    console.warn('记录画廊回图失败状态失败:', galleryError);
                }
            }
            
            Config.addLog({
                timestamp: timestamp,
                model: model,
                prompt: prompt,
                width: width,
                height: height,
                type: type,
                status: '失败',
                error: '处理图像失败: ' + e.message
            });
            return false;
        }
    }

    function escapeLogHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getLogTypeLabel(type) {
        switch (type) {
            case 'txt2img':
                return '文生图';
            case 'img2img':
                return '图生图';
            case 'chat':
                return '对话';
            default:
                return type || '记录';
        }
    }

    function updateLogDisplay() {
        const logs = Config.getLogs();
        const container = document.getElementById('logContainer');
        const searchInput = document.getElementById('logSearch');
        const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';

        if (!container) return;

        if (!logs || logs.length === 0) {
            container.innerHTML = '<div class="info-text empty-state">暂无日志记录</div>';
            return;
        }

        let filteredLogs = logs;
        if (searchTerm) {
            filteredLogs = logs.filter(function(log) {
                return (log.prompt && log.prompt.toLowerCase().includes(searchTerm)) ||
                       (log.response && log.response.toLowerCase().includes(searchTerm)) ||
                       (log.model && log.model.toLowerCase().includes(searchTerm)) ||
                       (log.status && log.status.toLowerCase().includes(searchTerm)) ||
                       (log.error && log.error.toLowerCase().includes(searchTerm)) ||
                       (log.type && log.type.toLowerCase().includes(searchTerm));
            });
        }

        if (filteredLogs.length === 0) {
            container.innerHTML = '<div class="info-text empty-state">没有匹配的日志记录</div>';
            return;
        }

        const visibleLogs = filteredLogs.slice(0, 200);
        let html = '';
        visibleLogs.forEach(function(log) {
            const statusClass = log.status === '成功' ? 'success' : (log.status === '失败' ? 'error' : 'neutral');
            const typeLabel = getLogTypeLabel(log.type);
            const statusText = log.status || '未知';
            const metaParts = [];
            const logIndex = logs.indexOf(log);

            if (log.timestamp) {
                metaParts.push('<span class="log-time">' + escapeLogHtml(log.timestamp) + '</span>');
            }
            if (log.model) {
                metaParts.push('<span class="log-model">模型：' + escapeLogHtml(log.model) + '</span>');
            }
            if (log.width && log.height) {
                metaParts.push('<span class="log-size">尺寸：' + escapeLogHtml(log.width) + ' × ' + escapeLogHtml(log.height) + '</span>');
            }
            if (log.documentName) {
                metaParts.push('<span class="log-doc">文档：' + escapeLogHtml(log.documentName) + '</span>');
            }

            html += '<div class="log-entry ' + statusClass + '" role="button" tabindex="0" data-log-index="' + logIndex + '">';
            html += '<div class="log-head">';
            html += '<div class="log-title">' + escapeLogHtml(typeLabel) + '</div>';
            html += '<div class="log-badge">' + escapeLogHtml(statusText) + '</div>';
            html += '</div>';
            if (metaParts.length) {
                html += '<div class="log-meta">' + metaParts.join('') + '</div>';
            }
            html += '<div class="log-body">';
            if (log.prompt) {
                html += '<div class="log-text">消息：' + escapeLogHtml(log.prompt) + '</div>';
            }
            if (log.response) {
                html += '<div class="log-text">回复：' + escapeLogHtml(log.response) + '</div>';
            }
            if (log.error) {
                html += '<div class="log-error">错误：' + escapeLogHtml(log.error) + '</div>';
            }
            if (log.prompt && log.type !== 'chat') {
                html += '<div class="log-record-actions"><button class="btn btn-secondary log-reload-prompt" type="button">载入提示词</button></div>';
            }
            html += '</div>';
            html += '</div>';
        });

        container.innerHTML = html;
        bindLogEntryToggle(container);
    }

    function bindLogEntryToggle(container) {
        if (!container) return;
        const entries = container.querySelectorAll('.log-entry');
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            entry.addEventListener('click', function(event) {
                const reloadButton = event.target.closest('.log-reload-prompt');
                if (reloadButton) {
                    event.preventDefault();
                    event.stopPropagation();
                    const index = Number(entry.getAttribute('data-log-index'));
                    const log = Config.getLogs()[index];
                    const promptInput = document.getElementById('imgPrompt');
                    if (log && promptInput) {
                        promptInput.value = log.prompt || '';
                        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
                        switchTab('img2img');
                        showToast('已载入生成记录中的提示词');
                    }
                    return;
                }
                entry.classList.toggle('expanded');
            });
            entry.addEventListener('keydown', function(event) {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    entry.classList.toggle('expanded');
                }
            });
        }
    }

    function searchLogs() {
        if (logSearchTimer) {
            clearTimeout(logSearchTimer);
        }
        logSearchTimer = setTimeout(function() {
            logSearchTimer = null;
            updateLogDisplay();
        }, 120);
    }

    async function exportLogs() {
        const logs = Config.getLogs();
        
        if (!logs || logs.length === 0) {
            showStatus('没有日志可导出', 'error');
            return;
        }
        
        let content = '幻梦AI 修图插件 日志导出\n';
        content += '========================================\n\n';
        
        logs.forEach(function(log, index) {
            content += '[' + (index + 1) + '] ' + log.timestamp + '\n';
            content += '类型: ' + (log.type === 'txt2img' ? '文生图' : '图生图') + '\n';
            content += '模型: ' + log.model + '\n';
            content += '尺寸: ' + log.width + 'x' + log.height + '\n';
            content += '提示词: ' + log.prompt + '\n';
            content += '状态: ' + log.status + '\n';
            if (log.error) {
                content += '错误: ' + log.error + '\n';
            }
            if (log.documentName) {
                content += '文档: ' + log.documentName + '\n';
            }
            content += '\n--------------------------------------\n\n';
        });
        
        try {
            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'gemini_ai_logs_' + new Date().toISOString().slice(0, 10) + '.txt';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            showToast('日志已导出');
        } catch (e) {
            showStatus('导出失败: ' + e.message, 'error');
        }
    }

    function clearLogs() {
        Config.clearLogs();
        updateLogDisplay();
        showToast('日志已清空');
        showStatus('日志已清空', 'success');
    }
    
    // 应用文字大小倍数
    function applyTextSizeMultiplier(multiplier) {
        const scale = Number(multiplier) || 1;
        document.documentElement.style.setProperty('--ui-scale', String(scale));
        const textSizeValueEl = document.getElementById('textSizeValue');
        if (textSizeValueEl) {
            textSizeValueEl.textContent = '当前倍数: ' + scale.toFixed(1) + 'x';
        }
    }

    function positionCustomSelectPanel(state) {
        if (!state || !state.trigger || !state.panel) return;

        // 全部下拉都是内联展开：面板作为正常文档流内容接在触发器下方，
        // 下方内容随之下移，因此不可能被其它元素遮挡。
        // 详见 shouldUseInlineFakeSelect 的说明。
        if (state.wrapper) {
            state.wrapper.style.setProperty('position', 'relative', 'important');
        }
        state.panel.style.setProperty('position', 'relative', 'important');
        state.panel.style.setProperty('left', '0', 'important');
        state.panel.style.setProperty('right', 'auto', 'important');
        state.panel.style.setProperty('top', 'auto', 'important');
        state.panel.style.setProperty('bottom', 'auto', 'important');
        state.panel.style.setProperty('width', '100%', 'important');
        state.panel.style.setProperty('min-width', '100%', 'important');
        state.panel.style.setProperty('max-height', '220px', 'important');
        state.panel.style.setProperty('margin-top', '6px', 'important');
        state.panel.style.setProperty('margin-bottom', '0', 'important');
        state.panel.style.setProperty('z-index', '1', 'important');
        state.panel.style.setProperty('transform', 'none', 'important');
    }

    function repositionOpenCustomSelects() {
        customSelectRegistry.forEach(function(state) {
            if (!state || !state.wrapper || !state.panel) return;
            if (state.wrapper.classList.contains('open') && state.panel.classList.contains('open')) {
                positionCustomSelectPanel(state);
            }
        });
    }
    function closeAllCustomSelects(exceptSelectEl) {
        customSelectRegistry.forEach(function(state) {
            if (!state || !state.wrapper || !state.selectEl) return;
            if (exceptSelectEl && state.selectEl === exceptSelectEl) return;
            state.wrapper.classList.remove('open');
            if (state.panel) {
                state.panel.classList.remove('open');
            }
            if (state.hostGroup) {
                state.hostGroup.classList.remove('select-open-host');
            }
        });
    }

    function cleanupCustomSelectState(selectId) {
        if (!selectId) return;
        const stale = customSelectRegistry.get(selectId);
        if (!stale) return;

        try {
            if (stale.observer && typeof stale.observer.disconnect === 'function') {
                stale.observer.disconnect();
            }
        } catch (e) {
            console.warn('断开下拉观察器失败:', selectId, e);
        }

        try {
            if (stale.panel && stale.panel.parentNode) {
                stale.panel.parentNode.removeChild(stale.panel);
            }
        } catch (e) {
            console.warn('移除下拉面板失败:', selectId, e);
        }

        try {
            if (stale.wrapper && stale.wrapper.parentNode && stale.selectEl) {
                const host = stale.wrapper.parentNode;
                host.insertBefore(stale.selectEl, stale.wrapper);
                stale.wrapper.parentNode.removeChild(stale.wrapper);
            }
        } catch (e) {
            console.warn('拆除下拉包装失败:', selectId, e);
        }

        try {
            if (stale.selectEl) {
                stale.selectEl.classList.remove('native-select-hidden');
            }
        } catch (e) {
            console.warn('恢复原生下拉可见性失败:', selectId, e);
        }

        customSelectRegistry.delete(selectId);
    }

    function getCustomSelectState(selectEl) {
        if (!selectEl) return null;
        const selectId = selectEl.id;
        if (!selectId) return null;

        const state = customSelectRegistry.get(selectId) || null;
        if (!state) return null;

        const invalid = (
            state.selectEl !== selectEl ||
            !state.selectEl ||
            !state.selectEl.isConnected ||
            !state.wrapper ||
            !state.wrapper.isConnected ||
            !state.panel ||
            !state.panel.isConnected
        );

        if (invalid) {
            cleanupCustomSelectState(selectId);
            return null;
        }

        return state;
    }

    function getCustomSelectOptionsSignature(options) {
        return options.map(function(option) {
            return [
                option.value || '',
                option.textContent || '',
                option.disabled ? '1' : '0'
            ].join('\u001f');
        }).join('\u001e');
    }

    function updateRenderedOptionSelection(panel, options, selectedIndex) {
        Array.from(panel.children || []).forEach(function(item, index) {
            const option = options[index];
            item.classList.toggle('selected', index === selectedIndex);
            item.classList.toggle('disabled', !!(option && option.disabled));
        });
    }

    function commitCustomSelectOption(state, index, event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        if (!state || !state.selectEl || !state.panel || !state.wrapper) return;
        try {
            const selectEl = state.selectEl;
            const option = selectEl.options[index];
            if (!option || selectEl.disabled || option.disabled) return;

            const changed = selectEl.selectedIndex !== index;
            selectEl.selectedIndex = index;
            state.wrapper.classList.remove('open');
            state.panel.classList.remove('open');
            if (state.hostGroup) state.hostGroup.classList.remove('select-open-host');
            refreshCustomSelectByElement(selectEl);
            if (changed) {
                selectEl.dispatchEvent(new Event('input', { bubbles: true }));
                selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (error) {
            console.error('提交预渲染下拉选项失败:', error);
            if (state.wrapper) state.wrapper.classList.remove('open');
            if (state.panel) state.panel.classList.remove('open');
            try { showStatus('选择失败：' + error.message, 'error'); } catch (ignore) {}
        }
    }

    function refreshCustomSelectByElement(selectEl, allowInitFake) {
        const allowInit = allowInitFake !== false;
        let state = getCustomSelectState(selectEl);
        if (!state) {
            if (allowInit) {
                initFakeSelect(selectEl);
                state = getCustomSelectState(selectEl);
            }
            if (!state) {
                if (selectEl) {
                    selectEl.classList.remove('native-select-hidden');
                    selectEl.style.setProperty('display', 'block', 'important');
                    selectEl.style.setProperty('width', '100%', 'important');
                    selectEl.style.setProperty('visibility', 'visible', 'important');
                    // 这条回退是静默的，之前出问题根本不知道走了这里。
                    // UXP 的原生 select 会忽略 CSS 背景渲染成白块，
                    // 只要看到这条日志，就说明该下拉退化成了原生控件。
                    console.warn('[下拉] 伪下拉不可用，已回退原生 select:', selectEl.id);
                }
                return;
            }
        }

        const trigger = state.trigger;
        const panel = state.panel;
        const wrapper = state.wrapper;
        if (!trigger || !panel || !wrapper) {
            selectEl.classList.remove('native-select-hidden');
            selectEl.style.setProperty('display', 'block', 'important');
            selectEl.style.setProperty('width', '100%', 'important');
            selectEl.style.setProperty('visibility', 'visible', 'important');
            return;
        }
        const options = Array.from(selectEl.options || []);
        if (options.length > 0 && selectEl.selectedIndex < 0) {
            selectEl.selectedIndex = 0;
        }
        const selectedOption = options[selectEl.selectedIndex] || options.find(function(item) { return item.selected; }) || options[0];
        const label = selectedOption ? selectedOption.textContent : '-- 请选择 --';

        trigger.textContent = label || '-- 请选择 --';
        wrapper.classList.toggle('disabled', !!selectEl.disabled);

        const shouldRenderPanel = true; // 内联预渲染式：始终渲染全部选项，展开即时、定位准确
        if (shouldRenderPanel) {
            const optionsSignature = getCustomSelectOptionsSignature(options);
            if (state.panelOptionsSignature !== optionsSignature) {
                const fragment = document.createDocumentFragment();
                panel.innerHTML = '';
                options.forEach(function(option, index) {
                    const item = document.createElement('div');
                    item.className = 'custom-select-option';
                    item.textContent = option.textContent || option.value || '';
                    item.dataset.index = String(index);
                    // UXP 对通过 portal 移出的节点偶尔不会把 click 正确冒泡回面板；
                    // 每个预渲染选项直接绑定提交，确保提示词预设等所有下拉都可选。
                    item.addEventListener('click', function(event) {
                        commitCustomSelectOption(state, index, event);
                    });
                    fragment.appendChild(item);
                });
                panel.appendChild(fragment);
                state.panelOptionsSignature = optionsSignature;
            }
            updateRenderedOptionSelection(panel, options, selectEl.selectedIndex);
        }

        if (wrapper.classList.contains('open')) {
            positionCustomSelectPanel(state);
        }
    }

    function refreshCustomSelectById(selectId) {
        const selectEl = document.getElementById(selectId);
        if (!selectEl) return;
        refreshCustomSelectByElement(selectEl, true);
    }

    function initFakeSelect(selectEl) {
        if (!selectEl || selectEl.tagName !== 'SELECT' || !selectEl.id) return;
        const existingState = customSelectRegistry.get(selectEl.id);
        if (existingState) {
            const isSameLiveState = (
                existingState.selectEl === selectEl &&
                existingState.wrapper &&
                existingState.wrapper.isConnected &&
                existingState.panel &&
                existingState.panel.isConnected
            );
            if (isSameLiveState) {
                return;
            }
            cleanupCustomSelectState(selectEl.id);
        }
        try {
            const existingWrapper = selectEl.parentElement;
            if (existingWrapper && existingWrapper.classList && existingWrapper.classList.contains('custom-select')) {
                const host = existingWrapper.parentElement;
                if (host) {
                    host.insertBefore(selectEl, existingWrapper);
                }
                existingWrapper.remove();
            }

            const parent = selectEl.parentElement;
            if (!parent) return;

            const wrapper = document.createElement('div');
            wrapper.className = 'custom-select';
            wrapper.dataset.selectId = selectEl.id;

            const trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.className = 'custom-select-trigger';

            const panel = document.createElement('div');
            panel.className = 'custom-select-panel';
            panel.dataset.selectFor = selectEl.id;
            // UXP 对嵌套 stacking-context 的处理比浏览器严格。把最近的控件行也提升，
            // 避免下拉面板被 textarea、下一张卡片或相邻列盖住。
            const hostGroup = selectEl.closest(
                '.form-group, .tt-preset-inline, .tt-control-row, .parameter-item, .tt-platform-cell, .img2img-inline-cell'
            ) || parent;
            const inlinePanel = shouldUseInlineFakeSelect(selectEl.id);
            panel.dataset.inline = inlinePanel ? 'true' : 'false';

            parent.insertBefore(wrapper, selectEl);
            wrapper.appendChild(selectEl);
            wrapper.appendChild(trigger);
            // 面板一律留在 .custom-select 内做绝对定位。
            // 实测数据表明：挂到 body 级 portal 时，UXP 合成器不会按 z-index
            // 把它排到最上层，面板会被同页其它元素盖住；留在文档流内则正常。
            wrapper.appendChild(panel);
            selectEl.classList.add('native-select-hidden');

            panel.addEventListener('pointerdown', function(event) {
                event.stopPropagation();
            });
            panel.addEventListener('click', function(event) {
                const item = event.target && event.target.closest ? event.target.closest('.custom-select-option') : null;
                if (!item || !panel.contains(item)) return;
                const index = parseInt(item.dataset.index || '-1', 10);
                commitCustomSelectOption(customSelectRegistry.get(selectEl.id), index, event);
            });

            trigger.addEventListener('click', function(event) {
                try {
                    if (event) {
                        event.preventDefault();
                        event.stopPropagation();
                    }
                    if (selectEl.disabled) return;
                    const isOpen = wrapper.classList.contains('open');
                    closeAllCustomSelects(selectEl);
                    const shouldOpen = !isOpen;
                    wrapper.classList.toggle('open', shouldOpen);
                    panel.classList.toggle('open', shouldOpen);
                    if (hostGroup) {
                        hostGroup.classList.toggle('select-open-host', shouldOpen);
                    }
                    if (shouldOpen) {
                        refreshCustomSelectByElement(selectEl, false);
                    }
                } catch (error) {
                    console.error('打开预渲染下拉失败:', error);
                    wrapper.classList.remove('open');
                    panel.classList.remove('open');
                }
            });

            trigger.addEventListener('keydown', function(event) {
                if (selectEl.disabled) return;
                if (event.key === 'Escape') {
                    wrapper.classList.remove('open');
                    panel.classList.remove('open');
                    if (hostGroup) {
                        hostGroup.classList.remove('select-open-host');
                    }
                    return;
                }
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    trigger.click();
                }
            });

            selectEl.addEventListener('change', function() {
                refreshCustomSelectByElement(selectEl);
            });

            customSelectRegistry.set(selectEl.id, {
                selectEl: selectEl,
                wrapper: wrapper,
                trigger: trigger,
                panel: panel,
                hostGroup: hostGroup,
                inlinePanel: inlinePanel,
                observer: null,
                panelOptionsSignature: null
            });
            refreshCustomSelectByElement(selectEl);

            if (typeof MutationObserver === 'function') {
                let refreshQueued = false;
                const queueRefresh = function() {
                    if (refreshQueued) return;
                    refreshQueued = true;
                    const run = function() {
                        refreshQueued = false;
                        refreshCustomSelectByElement(selectEl);
                    };
                    if (typeof requestAnimationFrame === 'function') {
                        requestAnimationFrame(run);
                    } else {
                        setTimeout(run, 0);
                    }
                };
                const observer = new MutationObserver(queueRefresh);
                observer.observe(selectEl, { childList: true });
                const state = customSelectRegistry.get(selectEl.id);
                if (state) {
                    state.observer = observer;
                }
            }
        } catch (error) {
            console.error('初始化假下拉失败，回退原生select:', selectEl.id, error);
            selectEl.classList.remove('native-select-hidden');
            const wrapper = selectEl.parentElement;
            if (wrapper && wrapper.classList && wrapper.classList.contains('custom-select')) {
                const host = wrapper.parentElement;
                if (host) {
                    host.insertBefore(selectEl, wrapper);
                }
                wrapper.remove();
            }
            const floatingPanel = document.querySelector('.custom-select-panel[data-select-for="' + selectEl.id + '"]');
            if (floatingPanel) {
                floatingPanel.remove();
            }
            if (selectEl.options.length > 0 && selectEl.selectedIndex < 0) {
                selectEl.selectedIndex = 0;
            }
        }
    }

    let automaticSelectIdCounter = 0;
    function ensureAutomaticSelectId(selectEl) {
        if (!selectEl) return '';
        if (selectEl.id) return selectEl.id;
        automaticSelectIdCounter++;
        let generatedId = 'huanmengAutoSelect_' + automaticSelectIdCounter;
        while (document.getElementById(generatedId)) {
            automaticSelectIdCounter++;
            generatedId = 'huanmengAutoSelect_' + automaticSelectIdCounter;
        }
        selectEl.id = generatedId;
        return generatedId;
    }

    function initAllFakeSelects(root) {
        const scope = root && root.querySelectorAll ? root : document;
        const selectElements = [];
        if (root && root.tagName === 'SELECT') selectElements.push(root);
        Array.from(scope.querySelectorAll('select')).forEach(function(selectEl) { selectElements.push(selectEl); });
        selectElements.forEach(function(selectEl) {
            if (!selectEl || selectEl.multiple) return;
            if (selectEl.classList && selectEl.classList.contains('reference-native-state-select')) return;
            ensureAutomaticSelectId(selectEl);
            try {
                initFakeSelect(selectEl);
            } catch (error) {
                console.error('全局预渲染下拉初始化失败:', selectEl.id, error);
                selectEl.classList.remove('native-select-hidden');
            }
        });
    }

    function bindGlobalFakeSelectObserver() {
        if (document.documentElement.dataset.globalFakeSelectObserverBound === '1') return;
        if (typeof MutationObserver !== 'function' || !document.body) return;
        let refreshQueued = false;
        const observer = new MutationObserver(function(mutations) {
            let hasSelectChange = false;
            mutations.forEach(function(mutation) {
                if (hasSelectChange) return;
                const target = mutation.target;
                if (target && (target.tagName === 'SELECT' || (target.querySelector && target.querySelector('select')))) {
                    hasSelectChange = true;
                    return;
                }
                Array.from(mutation.addedNodes || []).some(function(node) {
                    if (!node || node.nodeType !== 1) return false;
                    if (node.tagName === 'SELECT' || (node.querySelector && node.querySelector('select'))) {
                        hasSelectChange = true;
                        return true;
                    }
                    return false;
                });
            });
            if (!hasSelectChange || refreshQueued) return;
            refreshQueued = true;
            const run = function() {
                refreshQueued = false;
                initAllFakeSelects(document);
            };
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
            else setTimeout(run, 0);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        document.documentElement.dataset.globalFakeSelectObserverBound = '1';
    }

    function initFakeSelects(selectIds) {
        if (Array.isArray(selectIds) && selectIds.length > 0) {
            selectIds.forEach(function(selectId) {
                const selectEl = document.getElementById(selectId);
                if (!selectEl) return;
                ensureAutomaticSelectId(selectEl);
                try { initFakeSelect(selectEl); }
                catch (error) {
                    console.error('initFakeSelects 单项初始化失败:', selectId, error);
                    selectEl.classList.remove('native-select-hidden');
                }
            });
        } else {
            initAllFakeSelects(document);
            bindGlobalFakeSelectObserver();
        }

        if (!document.documentElement.dataset.fakeSelectBound) {
            document.addEventListener('click', function(event) {
                const target = event.target;
                const insideCustomSelect = target && target.closest && (
                    target.closest('.custom-select') || target.closest('.custom-select-panel')
                );
                if (!insideCustomSelect) {
                    closeAllCustomSelects(null);
                }
            });
            document.documentElement.dataset.fakeSelectBound = '1';
        }

        if (!document.documentElement.dataset.fakeSelectRepositionBound) {
            let repositionQueued = false;
            const reposition = function() {
                if (repositionQueued) return;
                repositionQueued = true;
                const run = function() {
                    repositionQueued = false;
                    repositionOpenCustomSelects();
                };
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(run);
                } else {
                    setTimeout(run, 0);
                }
            };
            window.addEventListener('resize', reposition);
            document.addEventListener('scroll', reposition, true);
            document.documentElement.dataset.fakeSelectRepositionBound = '1';
        }
    }

    function ensureSettingsUiCompatibility() {
        ensureSettingsModelActionsVisible();
    }

    function organizeSettingsPage() {
        const settings = document.getElementById('settings');
        if (!settings || settings.dataset.organized === '1') return;
        const saveWrap = document.getElementById('btnSaveSettings')?.closest('.settings-save-wrap') || null;
        const syncCard = document.getElementById('promptSyncServerCard');
        if (syncCard) {
            const cloudWrap = document.createElement('div');
            cloudWrap.className = 'module-card settings-priority-card';
            cloudWrap.innerHTML = '<section class="settings-group" data-group="cloud"><button type="button" class="settings-group-toggle" aria-expanded="true">1. 云端提示词同步</button><div class="settings-group-body provider-settings-grid"></div></section>';
            const body = cloudWrap.querySelector('.settings-group-body');
            body.appendChild(syncCard);
            const firstCard = settings.querySelector('.settings-priority-card');
            settings.insertBefore(cloudWrap, firstCard || null);
        }
        const order = ['cloud','grs','volcengine','grok2api','xai','sub2api','firefly','newapi','other','runninghub','server','gallery','system-prompts','advanced','ring'];
        const titles = {
            grs: '2. 主力云端生成 · GRS',
            volcengine: '3. 火山引擎 · 方舟图像与文字',
            grok2api: '4. 图像模型 · Grok2API（推荐）',
            xai: '5. 图像模型 · xAI 官方',
            sub2api: '6. 图像模型 · Sub2API',
            firefly: '7. 图像模型 · Firefly',
            newapi: '8. 统一 API 网关 · NewAPI',
            other: '9. Photoshop 回写与本地处理',
            runninghub: '10. RunningHub 应用管理',
            server: '11. 公告与插件更新',
            gallery: '12. 画廊自动保存',
            'system-prompts': '13. 系统提示词 · 文字 / 生图',
            advanced: '14. 界面、任务与高级设置',
            ring: '15. 圆环按钮'
        };
        order.forEach(function(key) {
            const section = settings.querySelector('.settings-group[data-group="' + key + '"]');
            if (!section) return;
            const card = section.closest('.settings-priority-card');
            if (card) settings.insertBefore(card, saveWrap);
            const toggle = section.querySelector('.settings-group-toggle');
            if (toggle && titles[key]) toggle.textContent = titles[key];
            if (toggle && key !== 'cloud' && key !== 'grs') toggle.setAttribute('aria-expanded', 'false');
        });
        const description = settings.querySelector('.module-hero .module-desc');
        if (description) description.textContent = '按账号与云服务、主力模型、备用接口、应用管理、更新和高级设置重新分组。';
        settings.dataset.organized = '1';
    }

    function initFloatingToolbarDrag() {}

    // ---------- 圆环按钮（槽位）设置 ----------
    //
    // 槽位清单和可选动作都由 ring-bridge 提供（window.HuanmengRingBridge.slots() / actions()），
    // 这里**不重复定义** —— 否则「加了个动作但下拉里没有」是迟早的事。
    //
    // 注意：必须在 initFakeSelects() 之前把 <option> 填好。
    // 面板会把这些原生 <select> 换成自绘下拉，换完再改 option 是不会同步的。
    //
    // 另外自绘下拉**不支持 <optgroup>**（全项目没有一行处理它的代码），
    // 所以选项是平铺的，分组信息只在 ACTIONS 表里留着备用。

    function ringBridge() {
        return (typeof window !== 'undefined' && window.HuanmengRingBridge) || null;
    }

    function readRingSectors() {
        const config = Config.read();
        const ring = (config && config.settings && config.settings.ring) || {};
        return ring.sectors || {};
    }

    function writeRingSector(slotId, patch) {
        const config = Config.read();
        if (!config.settings) config.settings = {};
        if (!config.settings.ring) config.settings.ring = {};
        if (!config.settings.ring.sectors) config.settings.ring.sectors = {};
        const current = config.settings.ring.sectors[slotId] || {};
        config.settings.ring.sectors[slotId] = Object.assign({}, current, patch);
        Config.write(config);
    }

    function clearRingSectors() {
        const config = Config.read();
        if (config && config.settings && config.settings.ring) {
            config.settings.ring.sectors = {};
            Config.write(config);
        }
    }

    /// 改动后立刻推给圆环，不用等下一次状态轮询
    function syncRingSlots(message) {
        const bridge = ringBridge();
        const statusEl = document.getElementById('ringSlotStatus');
        if (bridge) {
            try {
                if (typeof bridge.notifyConfigChanged === 'function') bridge.notifyConfigChanged();
            } catch (error) {
                console.error('同步圆环槽位失败:', error);
            }
        }
        if (statusEl) {
            const online = bridge && typeof bridge.isConnected === 'function' && bridge.isConnected();
            statusEl.textContent = online ? message : message + '（圆环助手没连上，连上后会自动生效）';
        }
    }

    function initRingSlotSettings() {
        const bridge = ringBridge();
        const statusEl = document.getElementById('ringSlotStatus');

        if (!bridge || typeof bridge.slots !== 'function') {
            if (statusEl) statusEl.textContent = '圆环桥接模块没加载，圆环按钮暂时无法配置。';
            return;
        }

        const slots = bridge.slots();
        const actions = bridge.actions();
        const defaults = bridge.defaultActions();
        const saved = readRingSectors();

        // 取某个槽位的「出厂设置」。不能拿 slotId 当默认动作 ——
        // chat 槽位的默认动作是 openChat，两者名字不一样。
        function defaultActionOf(slotId) {
            return (defaults && defaults[slotId]) || slotId;
        }

        slots.forEach(function (slotId, index) {
            const select = document.getElementById('ringSlotAction_' + slotId);
            const labelInput = document.getElementById('ringSlotLabel_' + slotId);
            const hintEl = document.getElementById('ringSlotHint_' + slotId);
            if (!select || !labelInput) return;

            actions.forEach(function (action) {
                const option = document.createElement('option');
                option.value = action.value;
                option.textContent = action.label;
                select.appendChild(option);
            });

            const entry = saved[slotId] || {};
            // 没配过就用默认动作 —— 也就是行为和改造前一模一样
            select.value = entry.action || defaultActionOf(slotId);
            labelInput.value = entry.label || '';

            function currentAction() {
                for (let i = 0; i < actions.length; i += 1) {
                    if (actions[i].value === select.value) return actions[i];
                }
                return null;
            }

            function refreshHint() {
                if (!hintEl) return;
                const picked = currentAction();
                hintEl.textContent = picked && picked.hint ? picked.hint : '';
            }
            refreshHint();

            select.addEventListener('change', function () {
                const picked = currentAction();
                writeRingSector(slotId, { action: select.value });
                refreshHint();
                syncRingSlots('按钮 ' + (index + 1) + ' 已改为「' + (picked ? picked.label : select.value) + '」');
            });

            labelInput.addEventListener('change', function () {
                writeRingSector(slotId, { label: labelInput.value.trim() });
                syncRingSlots('按钮 ' + (index + 1) + ' 的名称已更新');
            });
        });

        const resetBtn = document.getElementById('btnResetRingSlots');
        if (resetBtn) {
            resetBtn.addEventListener('click', function () {
                clearRingSectors();
                slots.forEach(function (slotId) {
                    const select = document.getElementById('ringSlotAction_' + slotId);
                    const labelInput = document.getElementById('ringSlotLabel_' + slotId);
                    if (select) select.value = defaultActionOf(slotId);
                    if (labelInput) labelInput.value = '';
                });
                syncRingSlots('六个按钮都已恢复默认');
            });
        }

        const pushBtn = document.getElementById('btnPushRingSlots');
        if (pushBtn) {
            pushBtn.addEventListener('click', function () { syncRingSlots('已同步到圆环'); });
        }

        initRingChatQuestions();
    }

    // ---------- 圆环 · 对话快捷提问 ----------
    //
    // 存成多行文本（一行一条）而不是数组：这是给人手写的配置，
    // 一个 textarea 比一堆「添加/删除」按钮省事得多，改完立刻生效。
    // 解析规则在 ring-bridge.js 的 parseChatQuestions 里，两边**共用同一份**——
    // 这里只负责存原文。

    function readRingChatQuestions() {
        const config = Config.read();
        const ring = (config && config.settings && config.settings.ring) || {};
        return typeof ring.chatQuestions === 'string' ? ring.chatQuestions : '';
    }

    function writeRingChatQuestions(text) {
        const config = Config.read();
        if (!config.settings) config.settings = {};
        if (!config.settings.ring) config.settings.ring = {};
        config.settings.ring.chatQuestions = String(text || '');
        Config.write(config);
    }

    function initRingChatQuestions() {
        const box = document.getElementById('ringChatQuestions');
        const statusEl = document.getElementById('ringChatQuestionStatus');
        if (!box) return;

        box.value = readRingChatQuestions();

        const bridge = ringBridge();
        const describe = function () {
            if (!bridge || typeof bridge.parseChatQuestions !== 'function') return '';
            const count = bridge.parseChatQuestions(box.value).length;
            return count ? '圆环上会显示 ' + count + ' 条。' : '留空则使用内置的六条。';
        };
        if (statusEl) statusEl.textContent = describe();

        // 只在失焦/停止输入时写盘并同步，敲一个字就同步一次太吵
        box.addEventListener('change', function () {
            writeRingChatQuestions(box.value);
            if (statusEl) statusEl.textContent = describe();
            syncRingSlots('快捷提问已更新');
        });
        box.addEventListener('input', function () {
            if (statusEl) statusEl.textContent = describe();
        });
    }

    async function init() {
        debugLog('开始初始化...');
        try {
            if (document.readyState === 'loading') {
                await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
            }

            initFloatingToolbarDrag();
            organizeSettingsPage();
            try {
                await loadSettings();
            } catch (error) {
                console.error('加载设置失败:', error);
                showStatus('加载设置失败: ' + error.message, 'error');
            }
            setupEventListeners();
            setupGenerationImageInputs();
            // 必须排在 initFakeSelects() 前面：下拉被换成自绘控件之后就改不动选项了
            initRingSlotSettings();
            initFakeSelects();
            refreshPresetsForGenerationEntry().catch(function(error) {
                console.warn('启动时刷新预设失败:', error && error.message);
            });

            initAllRenderedRanges(document);
            loadTaskEntries();

            const imgModelSelect = document.getElementById('imgModel');
            if (imgModelSelect && imgModelSelect.options.length === 0) {
                fillImageModels([]);
                imgModelSelect.selectedIndex = 0;
            }

            updateLogDisplay();
            debugLog('初始化完成');
        } catch (e) {
            console.error('初始化失败:', e);
            showStatus('初始化失败: ' + e.message, 'error');
        }
    }

    // 在UXP环境中，直接调用init()
    init();
    setTimeout(function() {
        scheduleDeferredStartupWork();
    }, 2500);

    // 调试日志：检查每个卡片的可见性和高度
    function debugElementVisibility() {
        const img2img = document.getElementById('img2img');
        const renderRow = document.querySelector('.tt-render-row');
        const btnImg2Img = document.getElementById('btnImg2Img');
        const imageCount = document.getElementById('imageCount');

        const lines = [
            '========== Element Visibility Debug ==========',
            'Time: ' + new Date().toISOString(),
            '#img2img exists: ' + !!img2img,
            '#img2img has .active: ' + (img2img ? img2img.classList.contains('active') : 'N/A'),
            '#img2img offsetHeight: ' + (img2img ? img2img.offsetHeight : 'N/A'),
            '#img2img display: ' + (img2img ? window.getComputedStyle(img2img).display : 'N/A'),
            '#img2img visibility: ' + (img2img ? window.getComputedStyle(img2img).visibility : 'N/A'),
            '',
            '--- .tt-render-row ---',
            '  exists: ' + !!renderRow,
            '  offsetHeight: ' + (renderRow ? renderRow.offsetHeight : 'N/A'),
            '  offsetParent: ' + (renderRow ? !!renderRow.offsetParent : 'N/A'),
            '  display: ' + (renderRow ? window.getComputedStyle(renderRow).display : 'N/A'),
            '  visibility: ' + (renderRow ? window.getComputedStyle(renderRow).visibility : 'N/A'),
            '  rect: ' + (renderRow ? renderRow.getBoundingClientRect().height.toFixed(0) + 'px' : 'N/A'),
            '',
            '--- #btnImg2Img ---',
            '  exists: ' + !!btnImg2Img,
            '  offsetHeight: ' + (btnImg2Img ? btnImg2Img.offsetHeight : 'N/A'),
            '  display: ' + (btnImg2Img ? window.getComputedStyle(btnImg2Img).display : 'N/A'),
            '  visibility: ' + (btnImg2Img ? window.getComputedStyle(btnImg2Img).visibility : 'N/A'),
            '  width: ' + (btnImg2Img ? btnImg2Img.offsetWidth + 'px' : 'N/A'),
            '',
            '--- #imageCount ---',
            '  exists: ' + !!imageCount,
            '  offsetHeight: ' + (imageCount ? imageCount.offsetHeight : 'N/A'),
            '  display: ' + (imageCount ? window.getComputedStyle(imageCount).display : 'N/A'),
            '  visibility: ' + (imageCount ? window.getComputedStyle(imageCount).visibility : 'N/A'),
            '',
            '=================================='
        ];

        console.log(lines.join('\n'));
    }

    // 暴露到全局
    window.debugElementVisibility = debugElementVisibility;

    // 定期打印元素状态（仅在调试模式开启时，前10次，每500ms一次）
    if (isDebugEnabled()) {
        let debugCount = 0;
        const debugTimer = setInterval(function() {
            debugElementVisibility();
            debugCount++;
            if (debugCount >= 10) {
                clearInterval(debugTimer);
            }
        }, 500);
    }

})();
