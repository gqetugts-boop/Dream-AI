// ============================================================
//  probe.js — 第六轮：摸清 pluginManager 到底能做什么
//
//  第六轮（需要 ipc 权限）已经确认 pluginManager 存在，
//  现在要问的是：能不能调用另一个插件的命令、能不能传数据。
//  这决定「卫星复用主插件能力」有没有干净的实现路径。
// ============================================================

(function () {
    var out = { state: 'running', phase6: true, findings: {} };
    globalThis.__satIpc = out;

    function note(key, value) {
        out.findings[key] = value;
    }

    function describe(obj, label) {
        if (obj === null || obj === undefined) return label + ' = ' + String(obj);
        var own = [];
        var proto = [];
        try { own = Object.getOwnPropertyNames(obj); } catch (e) { own = ['<err>']; }
        try {
            var p = Object.getPrototypeOf(obj);
            if (p && p !== Object.prototype) proto = Object.getOwnPropertyNames(p);
        } catch (e) {}
        return {
            type: typeof obj,
            own: own.filter(function (n) { return n !== 'constructor'; }).sort(),
            proto: proto.filter(function (n) { return n !== 'constructor'; }).sort()
        };
    }

    try {
        var uxp = require('uxp');
        var pm = uxp.pluginManager;
        if (!pm) {
            out.state = 'completed';
            note('pluginManager', '不可用');
            return;
        }

        var plugins = pm.plugins;
        note('plugins.constructor', plugins ? plugins.constructor.name : 'null');
        note('plugins.describe', describe(plugins, 'plugins'));

        // plugins 可能是 Map 或普通对象
        var entries = [];
        try {
            if (typeof plugins.forEach === 'function') {
                plugins.forEach(function (value, key) {
                    entries.push({ key: String(key), descriptor: describe(value, 'plugin') });
                });
            } else {
                Object.keys(plugins).forEach(function (key) {
                    entries.push({ key: key, descriptor: describe(plugins[key], 'plugin') });
                });
            }
        } catch (error) {
            note('plugins.enumerateError', String(error.message || error));
        }
        note('plugins.entries', entries);

        // 试着按 id 取一个（主插件）
        var ids = ['com.huanmeng.ai.retouch', 'com.huanmeng.ai.satellite'];
        ids.forEach(function (id) {
            try {
                var found = null;
                if (typeof plugins.get === 'function') found = plugins.get(id);
                else if (plugins[id]) found = plugins[id];
                note('lookup[' + id + ']', found ? describe(found, 'plugin') : '未找到');
            } catch (error) {
                note('lookup[' + id + ']', 'error: ' + String(error.message || error));
            }
        });

        out.state = 'completed';
    } catch (error) {
        out.state = 'failed';
        out.error = String(error && error.message || error);
    }
})();
