/* 幻梦AI 主题切换：亮/暗
 * UXP 禁止内联 <script>，故放独立外部文件。
 * 用一个纯函数：applyTheme(forceTheme) 可被任何处调用；
 * 预应用（防闪烁）与按钮点击都走这里。
 */
(function () {
    'use strict';
    var THEME_KEY = 'huanmeng-theme';

    function getStoredTheme() {
        try {
            return (window.localStorage && localStorage.getItem(THEME_KEY)) || 'light';
        } catch (e) {
            return 'light';
        }
    }

    function applyTheme(theme) {
        if (theme === 'dark') {
            document.body.classList.add('theme-dark');
        } else {
            document.body.classList.remove('theme-dark');
        }
        var button = document.getElementById('btnToggleTheme');
        if (button) button.textContent = theme === 'dark' ? '☀' : '☾';
        try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 忽略 */ }
    }

    function initTheme() {
        // 预应用：body 未就绪时挂到 DOMContentLoaded，避免亮/暗闪烁
        if (document.body) {
            applyTheme(getStoredTheme());
        } else {
            document.addEventListener('DOMContentLoaded', function () {
                applyTheme(getStoredTheme());
            });
        }

        // 绑定切换按钮
        var btn = document.getElementById('btnToggleTheme');
        if (btn) {
            btn.addEventListener('click', function () {
                var isDark = document.body.classList.contains('theme-dark');
                applyTheme(isDark ? 'light' : 'dark');
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTheme);
    } else {
        initTheme();
    }
})();
