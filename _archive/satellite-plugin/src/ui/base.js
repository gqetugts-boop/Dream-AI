// ============================================================
//  base.js — UI 基础工具：DOM 助手、状态栏、形状映射
//
//  这里不碰插件业务，只提供其它模块共用的最小工具。
//  UXP 约束：不用 CSS Grid；不用 flex gap / calc()；
//  椭圆形状集中在这里映射，渲染异常时只改 SHAPE_RADIUS。
// ============================================================

window.SatBase = (function () {
    // 圆环的圆角映射。UXP 对 border-radius:50% 的接受度随版本变化，
    // 设置页可以切到 squircle 兜底，避免圆环整体不可用。
    var SHAPE_RADIUS = {
        circle: '50%',
        squircle: '12px'
    };

    function el(id) {
        return document.getElementById(id);
    }

    function make(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function clear(node) {
        if (!node) return;
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function show(node, visible) {
        if (!node) return;
        if (visible) node.classList.remove('sat-hidden');
        else node.classList.add('sat-hidden');
    }

    function shapeRadius(name) {
        return SHAPE_RADIUS[name] || SHAPE_RADIUS.circle;
    }

    // 状态提示。kind: 'info' | 'ok' | 'warn' | 'error'
    var STATUS_KINDS = ['ok', 'warn', 'err'];

    function status(message, kind) {
        var textNode = el('satStatus');
        var dot = el('satFooterDot');
        if (textNode) textNode.textContent = String(message === undefined ? '' : message);
        if (dot) {
            STATUS_KINDS.forEach(function (item) { dot.classList.remove('sat-' + item); });
            if (kind === 'ok') dot.classList.add('sat-ok');
            else if (kind === 'warn') dot.classList.add('sat-warn');
            else if (kind === 'error') dot.classList.add('sat-err');
        }
        if (kind === 'error') console.error('[卫星] ' + message);
    }

    // UXP 不提供 elementFromPoint，指针坐标统一在这里做兼容取值。
    function pointerX(event) {
        if (!event) return 0;
        if (typeof event.clientX === 'number') return event.clientX;
        if (typeof event.pageX === 'number') return event.pageX;
        if (typeof event.offsetX === 'number') return event.offsetX;
        return 0;
    }

    function pointerY(event) {
        if (!event) return 0;
        if (typeof event.clientY === 'number') return event.clientY;
        if (typeof event.pageY === 'number') return event.pageY;
        if (typeof event.offsetY === 'number') return event.offsetY;
        return 0;
    }

    function clamp(value, min, max) {
        var number = Number(value);
        if (!isFinite(number)) return min;
        if (number < min) return min;
        if (number > max) return max;
        return number;
    }

    function truncate(text, max) {
        var value = String(text === undefined || text === null ? '' : text);
        if (value.length <= max) return value;
        return value.slice(0, max - 1) + '…';
    }

    return {
        SHAPE_RADIUS: SHAPE_RADIUS,
        el: el,
        make: make,
        clear: clear,
        show: show,
        shapeRadius: shapeRadius,
        status: status,
        pointerX: pointerX,
        pointerY: pointerY,
        clamp: clamp,
        truncate: truncate
    };
})();
