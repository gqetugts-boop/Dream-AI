/* H5 / PWA 引导 —— 只在真正的浏览器环境执行。
 *
 * 为什么不用静态标签：
 *   1. UXP 拒绝执行内联 <script>，会抛
 *      "Refusing to load inline script tag as executable code"；
 *   2. UXP 会把 index.html 里所有 <link> 当作样式表去读取，
 *      `<link rel="apple-touch-icon" href="icons/pwa-192.png">`
 *      会报 "Failed to load CSS file: icons/pwa-192.png"。
 * 所以 PWA 的 manifest、iOS 图标与 Service Worker 全部在这里动态挂载，
 * 让 UXP 侧完全不看到这些标签。
 */
(function () {
    'use strict';

    var isBrowser = typeof navigator !== 'undefined'
        && typeof location !== 'undefined'
        && /^https?:$/i.test(location.protocol);
    if (!isBrowser) return;
    if (typeof document === 'undefined' || !document.head) return;

    function addLink(rel, href) {
        var link = document.createElement('link');
        link.setAttribute('rel', rel);
        link.setAttribute('href', href);
        document.head.appendChild(link);
    }

    addLink('manifest', 'manifest.webmanifest');
    addLink('apple-touch-icon', 'icons/pwa-192.png');

    if (navigator.serviceWorker) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('./sw.js').catch(function (error) {
                console.warn('H5 离线服务注册失败:', error);
            });
        });
    }
})();
