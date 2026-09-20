// ============================================================
//  pie.js — 圆环菜单（Blender 风格饼菜单）
//
//  真机约束（UXP 8.0.1 实测）：
//    · document.elementFromPoint 不存在 → 命中测试全靠角度+半径计算
//    · 扇区角度从正上方 -90° 起算，顺时针排列
//
//  两种交互共用一套命中测试：
//    按住-拖动-松开  按下时唤出，移动高亮，松开执行（Blender 默认手感）
//    点击模式        唤出后常驻，点扇区确认，点圆心返回/关闭，Esc 取消
//
//  子环：带 children 的项，悬停 dwell 毫秒或点击即推进下一层，
//  圆心变成「返回」，Esc 逐层回退。
// ============================================================

window.SatPie = (function () {
    var DWELL_MS = 320;
    var MAX_ITEMS = 8;

    var state = {
        open: false,
        dragMode: false,
        stack: [],
        items: [],
        hoverIndex: -1,
        dwellTimer: null,
        pendingIndex: -1,
        geometry: null,
        onClose: null
    };

    function layer() { return SatBase.el('satPieLayer'); }
    function ring() { return SatBase.el('satPieRing'); }

    // 视图层与圆环层互斥。UXP 里 textarea 永远盖在最上层，
    // 不把视图藏掉的话输入框会穿到圆环上面。
    function setViewsHidden(hidden) {
        var root = SatBase.el('satRoot');
        if (!root) return;
        if (hidden) root.classList.add('sat-ring-open');
        else root.classList.remove('sat-ring-open');
    }
    function disc() { return SatBase.el('satPieDisc'); }
    function hub() { return SatBase.el('satPieHub'); }
    function hubTitle() { return SatBase.el('satPieHubTitle'); }
    function hubSub() { return SatBase.el('satPieHubSub'); }
    function breadcrumb() { return SatBase.el('satPieBreadcrumb'); }

    // ---------- 几何 ----------

    function computeGeometry() {
        var node = layer();
        var host = SatBase.el('satRoot');
        if (!node || !host) return null;

        // UXP 不支持绝对定位的 left+right / top+bottom 拉伸：
        // 只写 right/bottom 不会把元素撑开，而圆环层的内容又全是绝对定位，
        // 结果就是恒为 0×0。这里改成从宿主容器显式取尺寸再写死。
        var hostRect = host.getBoundingClientRect();
        var width = hostRect.width;
        var height = hostRect.height;
        if (!width || !height) return null;

        node.style.left = '0px';
        node.style.top = '0px';
        node.style.width = width + 'px';
        node.style.height = height + 'px';

        // 子容器同样不能用拉伸写法，一并显式定尺寸
        ['satPieRing', 'satPieBreadcrumb', 'satPieHint'].forEach(function (id) {
            var child = SatBase.el(id);
            if (!child) return;
            child.style.left = '0px';
            child.style.width = width + 'px';
        });
        var breadcrumbNode = SatBase.el('satPieBreadcrumb');
        if (breadcrumbNode) breadcrumbNode.style.top = '8px';
        var hintNode = SatBase.el('satPieHint');
        if (hintNode) hintNode.style.top = (height - 20) + 'px';
        var ringNode = ring();
        if (ringNode) ringNode.style.height = height + 'px';

        var rect = { left: hostRect.left, top: hostRect.top, width: width, height: height };

        var cx = width / 2;
        var cy = height / 2;
        var maxRadius = Math.min(width, height) / 2 - 12;
        if (maxRadius < 60) maxRadius = Math.min(width, height) / 2 - 4;

        var outerR = maxRadius;
        var innerR = maxRadius * 0.44;
        var itemSize = (outerR - innerR) * 0.92;
        if (itemSize > 76) itemSize = 76;
        if (itemSize < 30) itemSize = 30;

        return {
            rect: rect,
            cx: cx,
            cy: cy,
            outerR: outerR,
            innerR: innerR,
            ringR: (outerR + innerR) / 2,
            itemSize: itemSize,
            // 视口坐标 → 圆环层局部坐标
            offsetX: rect.left,
            offsetY: rect.top
        };
    }

    /** 把指针位置换算成扇区下标。返回 -1 圆心、-2 环外、>=0 扇区。 */
    function hitTest(clientX, clientY) {
        var geo = state.geometry;
        if (!geo) return -2;
        var dx = clientX - geo.offsetX - geo.cx;
        var dy = clientY - geo.offsetY - geo.cy;
        var distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < geo.innerR) return -1;
        if (distance > geo.outerR + 6) return -2;
        var count = state.items.length;
        if (!count) return -2;
        var step = 360 / count;
        var angle = Math.atan2(dy, dx) * 180 / Math.PI;
        var normalized = ((angle + 90 + step / 2) % 360 + 360) % 360;
        var index = Math.floor(normalized / step) % count;
        return index;
    }

    // ---------- 渲染 ----------

    function render() {
        var container = ring();
        var geo = state.geometry;
        if (!container || !geo) return;
        SatBase.clear(container);

        var shape = SatBase.shapeRadius(SatStore.get().shape);
        var count = state.items.length;
        var step = count ? 360 / count : 0;

        // 底盘
        var discNode = disc();
        if (discNode) {
            discNode.style.left = (geo.cx - geo.outerR) + 'px';
            discNode.style.top = (geo.cy - geo.outerR) + 'px';
            discNode.style.width = (geo.outerR * 2) + 'px';
            discNode.style.height = (geo.outerR * 2) + 'px';
            discNode.style.borderRadius = shape;
        }

        var hubSize = geo.innerR * 2;
        var hubNode = hub();
        if (hubNode) {
            hubNode.style.left = (geo.cx - geo.innerR) + 'px';
            hubNode.style.top = (geo.cy - geo.innerR) + 'px';
            hubNode.style.width = hubSize + 'px';
            hubNode.style.height = hubSize + 'px';
            hubNode.style.borderRadius = shape;
        }

        for (var i = 0; i < count; i += 1) {
            var item = state.items[i];
            var angle = (-90 + i * step) * Math.PI / 180;
            var x = geo.cx + geo.ringR * Math.cos(angle);
            var y = geo.cy + geo.ringR * Math.sin(angle);

            var button = SatBase.make('div', 'sat-pie-item');
            button.setAttribute('data-pie-index', String(i));
            button.style.left = (x - geo.itemSize / 2) + 'px';
            button.style.top = (y - geo.itemSize / 2) + 'px';
            button.style.width = geo.itemSize + 'px';
            button.style.height = geo.itemSize + 'px';
            button.style.borderRadius = shape;
            if (item.disabled) button.classList.add('sat-pie-disabled');
            if (i === state.hoverIndex) button.classList.add('sat-pie-hover');

            // 手动切成两行，不依赖 CSS 换行 —— UXP 的 word-break 行为不可靠，
            // 而扇区里塞不下完整标签时看不出来是哪一项就失去意义了。
            var perLine = Math.max(3, Math.floor(geo.itemSize / 7));
            var label = String(item.label);
            if (label.length <= perLine) {
                button.appendChild(SatBase.make('div', 'sat-pie-name', label));
            } else {
                button.appendChild(SatBase.make('div', 'sat-pie-name', label.slice(0, perLine)));
                var rest = label.slice(perLine);
                button.appendChild(SatBase.make('div', 'sat-pie-name',
                    rest.length > perLine ? rest.slice(0, perLine - 1) + '…' : rest));
            }
            if (item.children && item.children.length) {
                button.appendChild(SatBase.make('div', 'sat-pie-name', '▸'));
            }
            container.appendChild(button);
        }

        updateHub();
        updateBreadcrumb();
    }

    function updateHub() {
        var title = hubTitle();
        var sub = hubSub();
        var hovered = state.hoverIndex >= 0 ? state.items[state.hoverIndex] : null;

        if (hovered) {
            if (title) title.textContent = SatBase.truncate(hovered.label, 8);
            if (sub) {
                // hint 常用来放全名（扇区里显示的是缩写），别截太狠
                var hint = hovered.hint || '';
                if (hovered.children && hovered.children.length) hint = hint || '子菜单';
                sub.textContent = SatBase.truncate(hint, 20);
            }
            return;
        }

        var current = state.stack.length ? state.stack[state.stack.length - 1] : null;
        if (title) title.textContent = current ? SatBase.truncate(current.title, 6) : '圆环';
        if (sub) sub.textContent = state.stack.length ? '点圆心返回' : 'Esc 取消';
    }

    function updateBreadcrumb() {
        var node = breadcrumb();
        if (!node) return;
        if (!state.stack.length) {
            node.textContent = '';
            return;
        }
        node.textContent = state.stack.map(function (level) { return level.title; }).join(' › ');
    }

    // ---------- 层级 ----------

    function currentItems() {
        return state.items;
    }

    function setLevel(items, title, options) {
        var capped = items.slice(0, MAX_ITEMS);
        if (items.length > MAX_ITEMS) {
            capped[MAX_ITEMS - 1] = {
                id: '__more__',
                label: '更多…',
                hint: '还有 ' + (items.length - MAX_ITEMS + 1) + ' 项',
                run: options && options.onMore ? options.onMore : null
            };
        }
        state.items = capped;
        state.hoverIndex = -1;
        state.pendingIndex = -1;
        state.geometry = computeGeometry();
        render();
    }

    function pushLevel(item) {
        if (!item || !item.children || !item.children.length) return false;
        state.stack.push({ title: item.label, items: state.items });
        setLevel(item.children, item.label, { onMore: item.onMore });
        return true;
    }

    function popLevel() {
        if (!state.stack.length) return false;
        var previous = state.stack.pop();
        setLevel(previous.items, previous.title, {});
        return true;
    }

    // ---------- 悬停与确认 ----------

    function clearDwell() {
        if (state.dwellTimer) {
            clearTimeout(state.dwellTimer);
            state.dwellTimer = null;
        }
        state.pendingIndex = -1;
    }

    function setHover(index) {
        if (index === state.hoverIndex) return;
        state.hoverIndex = index;
        var buttons = ring() ? ring().children : [];
        for (var i = 0; i < buttons.length; i += 1) {
            if (i === index) buttons[i].classList.add('sat-pie-hover');
            else buttons[i].classList.remove('sat-pie-hover');
        }
        updateHub();

        clearDwell();
        var item = index >= 0 ? state.items[index] : null;
        if (item && item.children && item.children.length) {
            // 悬停 dwell 后自动展开子环，和 Blender 的子饼菜单一致
            state.pendingIndex = index;
            state.dwellTimer = setTimeout(function () {
                if (state.hoverIndex === index) pushLevel(state.items[index]);
            }, DWELL_MS);
        }
    }

    function activate(index) {
        var item = index >= 0 ? state.items[index] : null;
        if (item && item.disabled) return false;
        if (item && item.children && item.children.length) {
            pushLevel(item);
            return true;
        }
        if (index < 0) {
            // 圆心：有上层就返回，没有就关闭
            if (!popLevel()) closeWith('cancel');
            return true;
        }
        if (!item) return false;
        var run = item.run;
        closeWith('commit');
        if (typeof run === 'function') run(item);
        return true;
    }

    // ---------- 开关 ----------

    function open(options) {
        var opts = options || {};
        var node = layer();
        if (!node) return false;
        state.open = true;
        state.dragMode = !!opts.dragMode;
        state.stack = [];
        state.onClose = opts.onClose || null;
        setViewsHidden(true);
        SatBase.show(node, true);
        state.geometry = computeGeometry();
        if (!state.geometry) {
            SatBase.status('圆环层没有尺寸：请把面板拉大一些再试', 'warn');
            SatBase.show(node, false);
            setViewsHidden(false); // 提前失败也要把视图放回来，否则面板会空掉
            state.open = false;
            return false;
        }
        var items = typeof opts.items === 'function' ? opts.items() : (opts.items || []);
        setLevel(items, 'root', {});
        if (typeof opts.onOpen === 'function') opts.onOpen();
        return true;
    }

    function closeWith(reason) {
        clearDwell();
        var node = layer();
        if (node) SatBase.show(node, false);
        setViewsHidden(false);
        state.open = false;
        state.hoverIndex = -1;
        state.items = [];
        state.stack = [];
        var callback = state.onClose;
        state.onClose = null;
        if (typeof callback === 'function') callback(reason);
    }

    function close() {
        if (state.open) closeWith('cancel');
    }

    function isOpen() {
        return state.open;
    }

    // ---------- 事件绑定 ----------

    function bind(getMenuItems, handlers) {
        var node = layer();
        if (!node) return;

        node.addEventListener('pointermove', function (event) {
            if (!state.open) return;
            setHover(hitTest(SatBase.pointerX(event), SatBase.pointerY(event)));
        });

        node.addEventListener('pointerdown', function (event) {
            if (!state.open || !state.dragMode) return;
            if (event.preventDefault) event.preventDefault();
            setHover(hitTest(SatBase.pointerX(event), SatBase.pointerY(event)));
        });

        node.addEventListener('pointerup', function (event) {
            if (!state.open || !state.dragMode) return;
            if (event.preventDefault) event.preventDefault();
            var index = hitTest(SatBase.pointerX(event), SatBase.pointerY(event));
            if (index < 0) {
                closeWith('cancel');
                return;
            }
            activate(index);
        });

        node.addEventListener('click', function (event) {
            if (!state.open || state.dragMode) return;
            var index = hitTest(SatBase.pointerX(event), SatBase.pointerY(event));
            activate(index);
        });

        // 环外点击直接取消，和绝大多数饼菜单一致
        node.addEventListener('contextmenu', function (event) {
            if (event.preventDefault) event.preventDefault();
            if (state.open) closeWith('cancel');
        });

        document.addEventListener('keydown', function (event) {
            if (!state.open) return;
            var key = String(event.key || '');
            if (key === 'Escape') {
                event.preventDefault();
                if (!popLevel()) closeWith('cancel');
            }
        });

        if (handlers && typeof handlers.resummon === 'function') {
            node.addEventListener('dblclick', function () { handlers.resummon(); });
        }
    }

    /** 面板尺寸变化后重算几何，圆环打开时保持可用。 */
    function refresh() {
        if (!state.open) return;
        state.geometry = computeGeometry();
        render();
    }

    return {
        open: open,
        close: close,
        closeWith: closeWith,
        isOpen: isOpen,
        hitTest: hitTest,
        bind: bind,
        refresh: refresh,
        _state: state
    };
})();
