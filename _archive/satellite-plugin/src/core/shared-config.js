// ============================================================
//  shared-config.js — 跨插件共享配置（文件通道）
//
//  真机实测结论（UXP 8.0.1 / PS 26）：
//    · require('os').homedir() 可用，能推导默认绝对路径
//    · getEntryWithUrl 只能打开「已存在」的条目，文件不存在会抛
//      "Could not find an entry of ..."，所以要先 createEntryWithUrl
//    · URL 必须是三斜杠 file:/// + 绝对路径，file:/ 会被解析成主机名
//    · 用户手选的文件用 createPersistentToken 记住，令牌按插件隔离
// ============================================================

window.SatSharedConfig = (function () {
    var TOKEN_KEY = 'huanmeng_sat_shared_token';
    var DEFAULT_RELATIVE = '/Documents/Dream AI/huanmeng-shared.json';

    function storage() {
        return require('uxp').storage;
    }

    function fs() {
        return storage().localFileSystem;
    }

    function homeDir() {
        try {
            return require('os').homedir();
        } catch (error) {
            return '';
        }
    }

    function defaultPath() {
        var home = homeDir();
        if (!home) return '';
        return home + DEFAULT_RELATIVE;
    }

    function toUrl(path) {
        var value = String(path || '').trim();
        if (!value) return '';
        if (value.indexOf('file:') === 0) {
            // 统一成三斜杠形式，双斜杠会被解析成主机名
            return 'file://' + value.replace(/^file:\/{1,3}/, '/');
        }
        return 'file:///' + value.replace(/^\/+/, '');
    }

    function toNative(entry) {
        try {
            return fs().getNativePath(entry);
        } catch (error) {
            return '';
        }
    }

    /**
     * 把主插件导出的共享配置，或主插件原生配置（settings.imgApiKey 那一套）
     * 归一化成卫星插件使用的结构。两种都接受，用户手抄也不会卡住。
     */
    function normalize(raw) {
        if (!raw || typeof raw !== 'object') return null;

        var result = {
            version: raw.version || 1,
            source: raw.source || 'unknown',
            exportedAt: raw.exportedAt || '',
            channels: {},
            models: raw.models && typeof raw.models === 'object' ? raw.models : {},
            generation: raw.generation && typeof raw.generation === 'object' ? raw.generation : {}
        };

        if (raw.channels && typeof raw.channels === 'object') {
            Object.keys(raw.channels).forEach(function (name) {
                var channel = raw.channels[name] || {};
                result.channels[String(name).toLowerCase()] = {
                    baseUrl: String(channel.baseUrl || ''),
                    apiKey: String(channel.apiKey || ''),
                    imageModel: channel.imageModel ? String(channel.imageModel) : '',
                    chatModel: channel.chatModel ? String(channel.chatModel) : ''
                };
            });
            return result;
        }

        // 兼容主插件 localStorage 里的 huanmeng_config 原始结构
        var settings = raw.settings || raw;
        var map = {
            grs: ['imgApiUrl', 'imgApiKey'],
            newapi: ['newApiUrl', 'newApiKey'],
            xai: ['xaiApiUrl', 'xaiApiKey'],
            grok2api: ['grok2apiApiUrl', 'grok2apiApiKey'],
            sub2api: ['sub2apiApiUrl', 'sub2apiApiKey'],
            firefly: ['fireflyApiUrl', 'fireflyApiKey'],
            volcengine: ['volcengineApiUrl', 'volcengineApiKey'],
            gemini: ['googleApiUrl', 'googleApiKey']
        };
        Object.keys(map).forEach(function (name) {
            var urlKey = map[name][0];
            var keyKey = map[name][1];
            var baseUrl = String(settings[urlKey] || '');
            var apiKey = String(settings[keyKey] || '');
            if (!baseUrl && !apiKey) return;
            result.channels[name] = { baseUrl: baseUrl, apiKey: apiKey };
        });
        if (settings.grsRegion === 'domestic') result.channels.grs.baseUrl = 'https://grsai.dakka.com.cn';
        if (settings.grsRegion === 'overseas') result.channels.grs.baseUrl = 'https://grsaiapi.com';

        if (!result.models.image && settings.imgModel) result.models.image = String(settings.imgModel);
        if (!result.models.chat && settings.chatModel) result.models.chat = String(settings.chatModel);
        if (!result.generation.imageResolution && settings.imgResolution) {
            result.generation.imageResolution = String(settings.imgResolution);
        }
        if (settings.volcengineImageModel) result.channels.volcengine.imageModel = String(settings.volcengineImageModel);
        if (settings.volcengineChatModel) result.channels.volcengine.chatModel = String(settings.volcengineChatModel);
        return result;
    }

    function parseText(text) {
        var parsed = JSON.parse(String(text || ''));
        var normalized = normalize(parsed);
        if (!normalized) throw new Error('配置内容不是可识别的对象');
        return normalized;
    }

    /**
     * 只打开已存在的文件。
     * getEntryWithUrl 走的是真磁盘查找，文件没落盘就是找不到，会直接抛。
     */
    async function openExisting(path) {
        var url = toUrl(path);
        if (!url) throw new Error('配置路径为空');
        return await fs().getEntryWithUrl(url);
    }

    /**
     * 拿到可写句柄。真机实测（UXP 8.0.1）：
     *   createEntryWithUrl(url, {overwrite:true}) 对「不存在」和「已存在」
     *   两种情况都能返回可用条目，一步搞定创建与覆盖。
     *   而 fs.writeToFile / fs.readFromFile 在同一个条目上会抛
     *   "Source or Target must be of Entry type."，所以读写一律走
     *   条目自身的 entry.write / entry.read。
     */
    async function openForWrite(path) {
        var url = toUrl(path);
        if (!url) throw new Error('配置路径为空');
        return await fs().createEntryWithUrl(url, { overwrite: true });
    }

    async function readFromEntry(entry) {
        var text = await entry.read();
        var normalized = normalize(JSON.parse(String(text || '{}')));
        if (!normalized) throw new Error('配置文件内容无法识别');
        normalized.__path = toNative(entry) || '';
        return normalized;
    }

    async function writeToEntry(entry, payload) {
        await entry.write(JSON.stringify(payload, null, 2), { format: storage().formats.utf8 });
        return toNative(entry);
    }

    async function read(path) {
        var target = path || SatStore.get().sharedConfigPath || defaultPath();
        var entry = null;
        try {
            entry = await openExisting(target);
        } catch (openError) {
            throw new Error('共享配置文件不存在：' + target + '（先在主插件里导出一次）');
        }
        return readFromEntry(entry);
    }

    async function write(path, payload) {
        return await writeToEntry(await openForWrite(path), payload);
    }

    /** 让用户手选配置文件，并把持久化令牌存下来，下次直接复用。 */
    async function pick() {
        var entry = await fs().getFileForOpening({
            types: ['json'],
            allowMultiple: false
        });
        if (!entry) return null;
        var path = toNative(entry);
        try {
            var token = await fs().createPersistentToken(entry);
            localStorage.setItem(TOKEN_KEY, token);
        } catch (tokenError) {
            console.error('[卫星] 持久化令牌创建失败：' + tokenError.message);
        }
        return { path: path, config: await readFromEntry(entry) };
    }

    /** 用之前存的令牌重新打开手选过的文件；令牌失效时返回 null。 */
    async function readFromToken() {
        var token = null;
        try {
            token = localStorage.getItem(TOKEN_KEY);
        } catch (error) {
            return null;
        }
        if (!token) return null;
        try {
            var entry = await fs().getEntryForPersistentToken(token);
            if (!entry) return null;
            return await readFromEntry(entry);
        } catch (error) {
            return null;
        }
    }

    return {
        DEFAULT_RELATIVE: DEFAULT_RELATIVE,
        defaultPath: defaultPath,
        toUrl: toUrl,
        normalize: normalize,
        parseText: parseText,
        read: read,
        write: write,
        pick: pick,
        readFromToken: readFromToken
    };
})();
