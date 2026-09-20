// ============================================================
//  main-link.js — 把请求转交给主插件执行
//
//  卫星插件自己不发任何渠道请求。它是「圆环 ⇄ 主插件」之间的
//  界面与中继：真正的生成由主插件用它自己的渠道层完成，
//  这样两边行为不会漂移，密钥也只有一份。
//
//  信令与数据分开走：
//    信令  uxp.pluginManager.invokeCommand（官方跨插件通道，需 ipc 权限，
//          **不能携带数据**）
//    数据  ~/Documents/Dream AI/huanmeng-satellite-cmd.json
//          ~/Documents/Dream AI/huanmeng-satellite-result.json
//  之所以还挂一路轮询：invokeCommand 是即发即忘的，如果调用发生时
//  主插件还没加载完，信令就丢了，轮询能兜住。
// ============================================================

window.SatMainLink = (function () {
    'use strict';

    var MAIN_PLUGIN_ID = 'com.huanmeng.ai.retouch';
    var MAIN_COMMAND_ID = 'huanmengSatelliteCommand';
    var CMD_RELATIVE = '/Documents/Dream AI/huanmeng-satellite-cmd.json';
    var RESULT_RELATIVE = '/Documents/Dream AI/huanmeng-satellite-result.json';
    var POLL_MS = 1200;

    function fs() {
        return require('uxp').storage.localFileSystem;
    }

    function homeDir() {
        try { return require('os').homedir(); } catch (error) { return ''; }
    }

    function toUrl(path) {
        var value = String(path || '').trim();
        if (!value) return '';
        if (value.indexOf('file:') === 0) {
            return 'file://' + value.replace(/^file:\/{1,3}/, '/');
        }
        return 'file:///' + value.replace(/^\/+/, '');
    }

    function cmdPath() { return homeDir() + CMD_RELATIVE; }
    function resultPath() { return homeDir() + RESULT_RELATIVE; }

    async function readJson(path) {
        try {
            var entry = await fs().getEntryWithUrl(toUrl(path));
            return JSON.parse(String(await entry.read() || '{}'));
        } catch (error) {
            return null;
        }
    }

    async function writeJson(path, payload) {
        var entry = await fs().createEntryWithUrl(toUrl(path), { overwrite: true });
        await entry.write(JSON.stringify(payload, null, 2),
            { format: require('uxp').storage.formats.utf8 });
        return entry;
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // ---------- 主插件发现 ----------

    function pluginManager() {
        try {
            return require('uxp').pluginManager || null;
        } catch (error) {
            return null;
        }
    }

    function findMainPlugin() {
        var manager = pluginManager();
        if (!manager || !manager.plugins) return null;
        var found = null;
        try {
            manager.plugins.forEach(function (plugin) {
                if (plugin && plugin.id === MAIN_PLUGIN_ID) found = plugin;
            });
        } catch (error) {
            return null;
        }
        return found;
    }

    function isAvailable() {
        return !!findMainPlugin();
    }

    function unavailableReason() {
        if (!pluginManager()) {
            return '没有 ipc 权限，无法与主插件通信（检查 manifest 的 requiredPermissions.ipc）';
        }
        if (!findMainPlugin()) {
            return '主插件「幻梦AI 修图插件」没有加载';
        }
        return '';
    }

    // ---------- 指令 ----------

    var counter = 0;

    function nextCommandId() {
        counter += 1;
        return 'cmd-' + Date.now() + '-' + counter + '-' + Math.random().toString(36).slice(2, 6);
    }

    /** 下发指令并叫醒主插件。返回 commandId。 */
    async function invoke(action, payload) {
        var commandId = nextCommandId();
        await writeJson(cmdPath(), {
            id: commandId,
            action: action,
            payload: payload || {},
            issuedAt: new Date().toISOString()
        });

        var plugin = findMainPlugin();
        if (plugin && typeof plugin.invokeCommand === 'function') {
            try {
                await plugin.invokeCommand(MAIN_COMMAND_ID);
            } catch (error) {
                // 调用失败不要紧：主插件那侧还有文件轮询兜底
                console.warn('[卫星] invokeCommand 失败，靠轮询兜底：'
                    + (error && error.message ? error.message : error));
            }
        }
        return commandId;
    }

    /**
     * 等主插件把结果写回来。
     * onUpdate(state, message, extra) 会在每次状态变化时被调用，
     * 用于把进度转给圆环。
     */
    async function waitForResult(commandId, onUpdate, timeoutMs) {
        var deadline = Date.now() + (timeoutMs || 300000);
        var lastState = '';
        while (Date.now() < deadline) {
            await sleep(POLL_MS);
            var result = await readJson(resultPath());
            if (!result || result.commandId !== commandId) continue;
            if (result.state !== lastState || result.state === 'running') {
                lastState = result.state;
                if (typeof onUpdate === 'function') {
                    onUpdate(result.state, result.message, result);
                }
            }
            if (result.state === 'success' || result.state === 'failure') return result;
        }
        return { state: 'failure', message: '等待主插件返回超时' };
    }

    return {
        MAIN_PLUGIN_ID: MAIN_PLUGIN_ID,
        MAIN_COMMAND_ID: MAIN_COMMAND_ID,
        isAvailable: isAvailable,
        unavailableReason: unavailableReason,
        invoke: invoke,
        waitForResult: waitForResult,
        readJson: readJson,
        writeJson: writeJson,
        cmdPath: cmdPath,
        resultPath: resultPath
    };
})();
