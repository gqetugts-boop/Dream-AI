/*
 * ui/widgets.js — 控件工厂
 *
 * 职责：把 UXP 上样式不可控的原生控件（range / select / color / checkbox）
 * 统一替换为自绘控件，并给页面提供一套声明式的小组件。
 * 所有 factory 都返回真实 DOM 节点；需要读写的控件额外挂方法在节点上。
 * 边界：不做业务请求、不读写 Store、不认识任何具体页面的语义。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.Widgets) return;

    var util = DreamAI.util;
    var el = util.el;
    var I18n = DreamAI.I18n;

    function t(key, params) {
        if (!key) return '';
        return I18n && I18n.has(key) ? I18n.t(key, params) : key;
    }

    /** 已展开的下拉面板，用于互斥关闭 */
    var openSelectPanel = null;

    function closeOpenSelect() {
        if (!openSelectPanel) return;
        openSelectPanel.setAttribute('hidden', '');
        openSelectPanel.parentNode.setAttribute('data-open', 'false');
        openSelectPanel = null;
    }

    if (typeof global.document !== 'undefined' && global.document.addEventListener) {
        global.document.addEventListener('click', function (event) {
            if (!openSelectPanel) return;
            if (openSelectPanel.parentNode && openSelectPanel.parentNode.contains(event.target)) return;
            closeOpenSelect();
        });
    }

    /* ============================================================
     * 页面与卡片
     * ============================================================ */

    /**
     * 页面外壳。
     * @param {string} titleKey i18n 键
     * @param {{subtitleKey?:string}} [options]
     */
    function page(titleKey, options) {
        var opts = options || {};
        var node = el('section', { class: 'page', dataset: { page: opts.id || '' } });
        if (titleKey) {
            node.appendChild(el('div', { class: 'page-head stack' }, [
                el('div', { class: 'page-title strong', text: t(titleKey), 'data-i18n': titleKey }),
                opts.subtitleKey ? el('div', { class: 'page-subtitle muted', text: t(opts.subtitleKey), 'data-i18n': opts.subtitleKey }) : null
            ]));
        }
        return node;
    }

    /**
     * 可折叠卡片。
     * @param {string} titleKey
     * @param {{collapsed?:boolean, subtitleKey?:string, emphasis?:'primary', extra?:Node, static?:boolean, bodyGap?:number}} [options]
     * @returns {HTMLElement} 卡片节点，body 挂在 `.card-body`，折叠状态写 data-collapsed
     */
    function card(titleKey, options) {
        var opts = options || {};
        var collapsed = !!opts.collapsed;
        var body = el('div', { class: 'card-body' });
        var caret = el('span', { class: 'card-caret', text: '▾', 'aria-hidden': 'true' });
        var head;
        if (opts.static) {
            head = el('div', { class: 'card-head card-head-static' }, [
                el('div', { class: 'card-titles' }, [
                    el('div', { class: 'card-title', text: t(titleKey), 'data-i18n': titleKey }),
                    opts.subtitleKey ? el('div', { class: 'card-subtitle', text: t(opts.subtitleKey), 'data-i18n': opts.subtitleKey }) : null
                ])
            ]);
            if (opts.extra) head.appendChild(el('div', { class: 'card-head-extra' }, [opts.extra]));
        } else {
            head = el('button', {
                type: 'button',
                class: 'card-head',
                'aria-expanded': String(!collapsed),
                onclick: function () {
                    var next = node.getAttribute('data-collapsed') === 'true';
                    node.setAttribute('data-collapsed', next ? 'false' : 'true');
                    head.setAttribute('aria-expanded', next ? 'true' : 'false');
                    if (DreamAI.Store && opts.persistKey) {
                        DreamAI.Store.write('collapsed', {});
                        try {
                            global.localStorage.setItem(DreamAI.Store.PREFIX + 'collapsed:' + opts.persistKey, next ? '0' : '1');
                        } catch (error) { /* 忽略 */ }
                    }
                }
            }, [
                caret,
                el('div', { class: 'card-titles' }, [
                    el('div', { class: 'card-title', text: t(titleKey), 'data-i18n': titleKey }),
                    opts.subtitleKey ? el('div', { class: 'card-subtitle', text: t(opts.subtitleKey), 'data-i18n': opts.subtitleKey }) : null
                ]),
                opts.extra ? el('div', { class: 'card-head-extra' }, [opts.extra]) : null
            ]);
        }

        // 恢复折叠状态
        if (!opts.static && opts.persistKey) {
            try {
                var saved = global.localStorage.getItem(DreamAI.Store.PREFIX + 'collapsed:' + opts.persistKey);
                if (saved === '1') collapsed = true;
                if (saved === '0') collapsed = false;
            } catch (error) { /* 忽略 */ }
        }

        var node = el('section', {
            class: 'card',
            dataset: {
                collapsed: collapsed ? 'true' : 'false',
                emphasis: opts.emphasis || ''
            }
        }, [
            opts.emphasis === 'primary' ? el('div', { class: 'card-accent-line' }) : null,
            head,
            body
        ]);
        node.cardBody = body;
        node.setCollapsed = function (value) {
            var next = !!value;
            node.setAttribute('data-collapsed', next ? 'true' : 'false');
            head.setAttribute('aria-expanded', next ? 'true' : 'false');
        };
        return node;
    }

    /* ============================================================
     * 基础排版
     * ============================================================ */

    /** 标签 + 控件 + 提示 的竖排字段 */
    function field(labelKey, control, hintKey) {
        return el('div', { class: 'field' }, [
            labelKey ? el('div', { class: 'field-label', text: t(labelKey), 'data-i18n': labelKey }) : null,
            control,
            hintKey ? el('div', { class: 'field-hint', text: t(hintKey), 'data-i18n': hintKey }) : null
        ]);
    }

    /** 左右两列：左边标题，右边控件 */
    function row(label, right, hintKey) {
        var leftChildren = [];
        if (label && label.nodeType) leftChildren.push(label);
        else leftChildren.push(el('div', { class: 'row-label', text: t(label), 'data-i18n': label || '' }));
        if (hintKey) leftChildren.push(el('div', { class: 'row-hint', text: t(hintKey), 'data-i18n': hintKey }));
        return el('div', { class: 'row' }, [
            el('div', { class: 'row-left' }, leftChildren),
            el('div', { class: 'row-right' }, [right])
        ]);
    }

    function divider() {
        return el('div', { class: 'divider' });
    }

    function spacer(size) {
        return el('div', { class: 'spacer', style: size ? { height: size + 'px' } : null });
    }

    /** flex 百分比栅格（UXP 不用 CSS Grid） */
    function grid(children, columns) {
        var cols = Math.max(1, util.toNumber(columns, 3));
        var gap = 8;
        var basis = 'calc(' + (100 / cols) + '% - ' + Math.round(gap * (cols - 1) / cols) + 'px)';
        var cells = [];
        for (var i = 0; i < children.length; i++) {
            cells.push(el('div', { class: 'grid-cell', style: { flexBasis: basis, width: basis } }, [children[i]]));
        }
        return el('div', { class: 'grid' }, cells);
    }

    function hint(textOrKey, tone, glyph) {
        var isKey = I18n && I18n.has(textOrKey);
        var textNode = el('span', {
            text: isKey ? t(textOrKey) : String(textOrKey == null ? '' : textOrKey),
            'data-i18n': isKey ? textOrKey : ''
        });
        var node = el('div', { class: 'hint-block', dataset: { tone: tone || 'plain' } }, [
            el('span', { class: 'hint-glyph', text: glyph || (tone === 'warn' ? '!' : tone === 'error' ? '×' : tone === 'info' ? 'i' : '·') }),
            textNode
        ]);
        // 调用方更新文案/语气时用这两个方法，不要依赖 lastChild 之类的位置假设
        node.setText = function (value, i18nKey) {
            if (i18nKey && I18n && I18n.has(i18nKey)) {
                textNode.textContent = t(i18nKey);
                textNode.setAttribute('data-i18n', i18nKey);
            } else {
                textNode.textContent = String(value == null ? '' : value);
                textNode.removeAttribute('data-i18n');
            }
        };
        node.setTone = function (value) { node.setAttribute('data-tone', value || 'plain'); };
        node.textNode = textNode;
        return node;
    }

    function empty(glyph, textOrKey) {
        var isKey = I18n && I18n.has(textOrKey);
        return el('div', { class: 'empty-state' }, [
            el('div', { class: 'empty-glyph', text: glyph || '◌' }),
            el('div', { text: isKey ? t(textOrKey) : String(textOrKey == null ? '' : textOrKey), 'data-i18n': isKey ? textOrKey : '' })
        ]);
    }

    function pill(text, tone) {
        var isKey = I18n && I18n.has(text);
        return el('span', { class: 'pill', dataset: { tone: tone || 'idle' } }, [
            el('span', { text: isKey ? t(text) : String(text == null ? '' : text), 'data-i18n': isKey ? text : '' })
        ]);
    }

    function kv(keyOrKey, value) {
        var isKey = I18n && I18n.has(keyOrKey);
        return el('div', { class: 'kv' }, [
            el('span', { class: 'kv-key', text: isKey ? t(keyOrKey) : String(keyOrKey), 'data-i18n': isKey ? keyOrKey : '' }),
            el('span', { class: 'kv-value', text: String(value == null ? '' : value) })
        ]);
    }

    /* ============================================================
     * 按钮
     * ============================================================ */

    /**
     * @param {string} labelKeyOrText i18n 键或直接文案
     * @param {{variant?:'primary'|'ghost'|'danger'|'quiet'|'plain', size?:'sm'|'lg', glyph?:string,
     *          onClick?:Function, block?:boolean, titleKey?:string, disabled?:boolean}} [options]
     */
    function button(labelKeyOrText, options) {
        var opts = options || {};
        var isKey = I18n && I18n.has(labelKeyOrText);
        var classes = ['btn'];
        if (opts.variant && opts.variant !== 'plain') classes.push('btn-' + opts.variant);
        if (opts.size === 'sm') classes.push('btn-sm');
        if (opts.size === 'lg') classes.push('btn-lg');
        if (opts.block) classes.push('btn-block');
        var node = el('button', {
            type: 'button',
            class: classes.join(' '),
            dataset: { variant: opts.variant || 'plain' },
            title: opts.titleKey ? t(opts.titleKey) : (isKey ? '' : ''),
            disabled: opts.disabled ? true : null
        }, [
            opts.glyph ? el('span', { class: 'btn-glyph', text: opts.glyph, 'aria-hidden': 'true' }) : null,
            el('span', {
                class: 'btn-label',
                text: isKey ? t(labelKeyOrText) : String(labelKeyOrText == null ? '' : labelKeyOrText),
                'data-i18n': isKey ? labelKeyOrText : ''
            })
        ]);
        if (opts.onClick) {
            node.addEventListener('click', function (event) {
                if (node.hasAttribute('disabled')) return;
                opts.onClick(event, node);
            });
        }
        return node;
    }

    function iconButton(glyph, options) {
        var opts = options || {};
        var node = el('button', {
            type: 'button',
            class: 'chip-btn',
            title: opts.titleKey ? t(opts.titleKey) : (opts.title || ''),
            'aria-label': opts.titleKey ? t(opts.titleKey) : (opts.title || glyph)
        }, [el('span', { class: 'chip-glyph', text: glyph, 'aria-hidden': 'true' })]);
        if (opts.onClick) node.addEventListener('click', function () { opts.onClick(null, node); });
        return node;
    }

    function miniButton(labelKeyOrText, options) {
        var opts = options || {};
        var isKey = I18n && I18n.has(labelKeyOrText);
        var node = el('button', {
            type: 'button',
            class: 'mini-btn',
            text: isKey ? t(labelKeyOrText) : String(labelKeyOrText),
            'data-i18n': isKey ? labelKeyOrText : ''
        });
        if (opts.onClick) node.addEventListener('click', function () { opts.onClick(null, node); });
        return node;
    }

    function buttonRow(children, alignEnd) {
        return el('div', { class: 'btn-row' + (alignEnd ? ' btn-row-end' : '') }, children);
    }

    /**
     * 标签式切换组。
     * @param {Array} items `[{ value, labelKey, glyph }]`
     * @param {string} active
     * @param {Function} onChange
     */
    function chipGroup(items, active, onChange) {
        var nodes = [];
        var group = el('div', { class: 'chip-group', role: 'group' });
        for (var i = 0; i < items.length; i++) {
            (function (item) {
                var isKey = I18n && I18n.has(item.labelKey);
                var chip = el('button', {
                    type: 'button',
                    class: 'chip',
                    dataset: { value: item.value },
                    'aria-pressed': String(item.value === active),
                    onclick: function () {
                        var children = group.children;
                        for (var j = 0; j < children.length; j++) children[j].setAttribute('aria-pressed', 'false');
                        chip.setAttribute('aria-pressed', 'true');
                        if (typeof onChange === 'function') onChange(item.value);
                    }
                }, [
                    item.glyph ? el('span', { text: item.glyph, 'aria-hidden': 'true' }) : null,
                    el('span', { text: isKey ? t(item.labelKey) : String(item.labelKey || item.value), 'data-i18n': isKey ? item.labelKey : '' })
                ]);
                nodes.push(chip);
                group.appendChild(chip);
            })(items[i]);
        }
        group.setValue = function (value) {
            for (var k = 0; k < group.children.length; k++) {
                group.children[k].setAttribute('aria-pressed', String(group.children[k].getAttribute('data-value') === String(value)));
            }
        };
        return group;
    }

    /* ============================================================
     * 文本输入
     * ============================================================ */

    /**
     * @param {{value?:string, placeholderKey?:string, placeholder?:string, type?:string,
     *          onInput?:Function, onChange?:Function, onEnter?:Function, mono?:boolean,
     *          number?:boolean, min?:number, max?:number, step?:number, maxLength?:number,
     *          spellcheck?:boolean, id?:string}} [options]
     */
    function input(options) {
        var opts = options || {};
        var className = 'input';
        if (opts.mono) className += ' input-mono';
        if (opts.number) className += ' input-number';
        var attrs = {
            class: className,
            type: opts.type || (opts.number ? 'number' : 'text'),
            value: opts.value === undefined || opts.value === null ? '' : String(opts.value),
            id: opts.id || null,
            spellcheck: opts.spellcheck === false ? 'false' : null,
            autocomplete: 'off'
        };
        if (opts.placeholderKey && I18n && I18n.has(opts.placeholderKey)) {
            attrs.placeholder = t(opts.placeholderKey);
            attrs['data-i18n-placeholder'] = opts.placeholderKey;
        } else if (opts.placeholder) {
            attrs.placeholder = opts.placeholder;
        }
        if (opts.number) {
            if (opts.min !== undefined) attrs.min = String(opts.min);
            if (opts.max !== undefined) attrs.max = String(opts.max);
            if (opts.step !== undefined) attrs.step = String(opts.step);
        }
        if (opts.maxLength) attrs.maxlength = String(opts.maxLength);
        var node = el('input', attrs);
        if (typeof opts.onInput === 'function') {
            node.addEventListener('input', function () { opts.onInput(node.value, node); });
        }
        if (typeof opts.onChange === 'function') {
            node.addEventListener('change', function () { opts.onChange(node.value, node); });
        }
        if (typeof opts.onEnter === 'function') {
            node.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    opts.onEnter(node.value, node);
                }
            });
        }
        return node;
    }

    /**
     * 多行文本。返回值带 `setCount` 能力：配合 counter 显示字数。
     * @param {{value?:string, placeholderKey?:string, placeholder?:string, rows?:number,
     *          tall?:boolean, mono?:boolean, maxLength?:number, onInput?:Function, onEnter?:Function}} [options]
     */
    function textarea(options) {
        var opts = options || {};
        var className = 'textarea';
        if (opts.tall) className += ' textarea-tall';
        if (opts.mono) className += ' textarea-mono';
        var attrs = {
            class: className,
            rows: opts.rows ? String(opts.rows) : null,
            value: opts.value === undefined || opts.value === null ? '' : String(opts.value),
            spellcheck: opts.spellcheck === false ? 'false' : null,
            autocomplete: 'off',
            wrap: 'soft'
        };
        if (opts.placeholderKey && I18n && I18n.has(opts.placeholderKey)) {
            attrs.placeholder = t(opts.placeholderKey);
            attrs['data-i18n-placeholder'] = opts.placeholderKey;
        } else if (opts.placeholder) {
            attrs.placeholder = opts.placeholder;
        }
        if (opts.maxLength) attrs.maxlength = String(opts.maxLength);
        var node = el('textarea', attrs);
        if (typeof opts.onInput === 'function') {
            node.addEventListener('input', function () { opts.onInput(node.value, node); });
        }
        if (typeof opts.onEnter === 'function') {
            node.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    opts.onEnter(node.value, node);
                }
            });
        }
        return node;
    }

    /** 字符计数条 */
    function counter(max) {
        var node = el('span', { class: 'range-readout', text: '0 / ' + max });
        node.setCount = function (value) {
            node.textContent = String(value) + ' / ' + String(max);
        };
        return node;
    }

    /* ============================================================
     * 自绘下拉
     * ============================================================ */

    /**
     * @param {Array} items `[{ value, labelKey, label, note, group }]`
     * @param {string} value 当前值
     * @param {{onChange?:Function, placeholderKey?:string, disabled?:boolean, emptyKey?:string}} [options]
     * @returns {HTMLElement} 节点带 `setValue(v)` / `setItems(items)` / `getValue()`
     */
    function select(items, value, options) {
        var opts = options || {};
        var current = value;
        var list = Array.isArray(items) ? items.slice() : [];

        var valueNode = el('span', { class: 'select-value' });
        var panel = el('div', { class: 'select-panel', hidden: true });
        var trigger = el('button', {
            type: 'button',
            class: 'select-trigger',
            'aria-haspopup': 'listbox',
            'aria-expanded': 'false',
            disabled: opts.disabled ? true : null
        }, [
            valueNode,
            el('span', { class: 'select-arrow', text: '▾', 'aria-hidden': 'true' })
        ]);
        var node = el('div', { class: 'select', dataset: { open: 'false' } }, [trigger, panel]);

        function labelOf(item) {
            if (!item) return '';
            if (item.labelKey && I18n && I18n.has(item.labelKey)) return t(item.labelKey);
            return String(item.label || item.labelKey || item.value || '');
        }

        function renderValue() {
            var found = null;
            for (var i = 0; i < list.length; i++) {
                if (String(list[i].value) === String(current)) { found = list[i]; break; }
            }
            var label = found ? labelOf(found) : '';
            valueNode.textContent = label || (opts.placeholderKey ? t(opts.placeholderKey) : '');
            valueNode.setAttribute('data-placeholder', label ? 'false' : 'true');
        }

        function renderPanel() {
            util.clear(panel);
            if (!list.length) {
                panel.appendChild(el('div', { class: 'select-empty', text: opts.emptyKey ? t(opts.emptyKey) : t('app.empty') }));
                return;
            }
            var lastGroup = null;
            for (var i = 0; i < list.length; i++) {
                var item = list[i];
                if (item.group && item.group !== lastGroup) {
                    lastGroup = item.group;
                    panel.appendChild(el('div', { class: 'select-group-label', text: labelOf({ labelKey: item.group, label: item.group }) }));
                }
                (function (entry) {
                    var option = el('button', {
                        type: 'button',
                        class: 'select-option',
                        role: 'option',
                        'aria-selected': String(String(entry.value) === String(current)),
                        onclick: function (event) {
                            event.stopPropagation();
                            current = entry.value;
                            renderValue();
                            closeOpenSelect();
                            node.setAttribute('data-open', 'false');
                            trigger.setAttribute('aria-expanded', 'false');
                            if (typeof opts.onChange === 'function') opts.onChange(entry.value, entry);
                        }
                    }, [
                        el('span', { class: 'truncate', text: labelOf(entry) }),
                        entry.note ? el('span', { class: 'select-option-note', text: String(entry.note) }) : null
                    ]);
                    panel.appendChild(option);
                })(item);
            }
        }

        function toggle(open) {
            if (opts.disabled) return;
            var next = open === undefined ? panel.hasAttribute('hidden') : !!open;
            if (next) {
                closeOpenSelect();
                panel.removeAttribute('hidden');
                node.setAttribute('data-open', 'true');
                trigger.setAttribute('aria-expanded', 'true');
                openSelectPanel = panel;
            } else {
                panel.setAttribute('hidden', '');
                node.setAttribute('data-open', 'false');
                trigger.setAttribute('aria-expanded', 'false');
                if (openSelectPanel === panel) openSelectPanel = null;
            }
        }

        trigger.addEventListener('click', function (event) {
            event.stopPropagation();
            toggle();
        });

        node.setValue = function (next, silent) {
            current = next;
            renderValue();
            renderPanel();
            if (!silent && typeof opts.onChange === 'function') opts.onChange(current, null);
        };
        node.getValue = function () { return current; };
        node.setItems = function (next, keepValue) {
            list = Array.isArray(next) ? next.slice() : [];
            if (!keepValue) {
                var stillThere = false;
                for (var i = 0; i < list.length; i++) {
                    if (String(list[i].value) === String(current)) { stillThere = true; break; }
                }
                if (!stillThere) current = list.length ? list[0].value : '';
            }
            renderValue();
            renderPanel();
        };
        node.close = function () { toggle(false); };

        renderValue();
        renderPanel();
        return node;
    }

    /* ============================================================
     * 复选框
     * ============================================================ */

    /**
     * @param {string} labelKey i18n 键
     * @param {boolean} checked
     * @param {{onChange?:Function, hintKey?:string}} [options]
     */
    function checkbox(labelKey, checked, options) {
        var opts = options || {};
        var isKey = I18n && I18n.has(labelKey);
        var box = el('span', { class: 'checkbox-box', text: '✓', 'aria-hidden': 'true' });
        var inputNode = el('input', { type: 'checkbox' });
        if (checked) inputNode.checked = true;
        var label = el('label', { class: 'checkbox' }, [
            inputNode,
            box,
            el('span', { class: 'checkbox-label', text: isKey ? t(labelKey) : String(labelKey), 'data-i18n': isKey ? labelKey : '' }),
            opts.hintKey ? el('span', { class: 'checkbox-hint', text: t(opts.hintKey), 'data-i18n': opts.hintKey }) : null
        ]);
        inputNode.addEventListener('change', function () {
            if (typeof opts.onChange === 'function') opts.onChange(!!inputNode.checked, inputNode);
        });
        label.input = inputNode;
        label.getValue = function () { return !!inputNode.checked; };
        label.setValue = function (value) { inputNode.checked = !!value; };
        return label;
    }

    /* ============================================================
     * 自绘滑块
     * ============================================================ */

    /**
     * @param {{labelKey?:string, min?:number, max?:number, step?:number, value?:number,
     *          onInput?:Function, readonlyLabel?:boolean}} [options]
     * @returns {HTMLElement} 带 `setValue(v)` / `getValue()`
     */
    function slider(options) {
        var opts = options || {};
        var min = util.toNumber(opts.min, 0);
        var max = util.toNumber(opts.max, 100);
        var step = util.toNumber(opts.step, 1) || 1;
        var value = util.clamp(opts.value === undefined ? min : opts.value, min, max, min);
        if (max === min) max = min + 1;

        var raw = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
        var fill = el('span', { class: 'range-fill' });
        var thumb = el('span', { class: 'range-thumb' });
        var rail = el('span', { class: 'range-rail' }, [fill]);
        var track = el('span', { class: 'range-track' }, [rail, thumb]);
        var readout = el('span', { class: 'range-readout', text: formatValue(value) });
        var labelNode = el('span', { text: opts.labelKey ? t(opts.labelKey) : '', 'data-i18n': opts.labelKey || '' });
        var head = el('div', { class: 'range-head' }, [
            labelNode,
            opts.readonlyLabel === false ? null : readout
        ]);
        var node = el('div', { class: 'range', dataset: { dragging: 'false' } }, [head, track, raw]);

        function formatValue(v) {
            var decimals = String(step).indexOf('.') === -1 ? 0 : String(step).split('.')[1].length;
            return decimals ? Number(v).toFixed(decimals) : String(Math.round(Number(v)));
        }

        function sync(fromUser) {
            var ratio = max === min ? 0 : (value - min) / (max - min);
            node.style.setProperty('--range-ratio', String(util.clamp(ratio, 0, 1)));
            readout.textContent = formatValue(value);
            raw.value = String(value);
            if (fromUser && typeof opts.onInput === 'function') opts.onInput(value, node);
        }

        /*
         * 把指针位置换算成数值。
         *
         * 拇指的可行区间是 [inset, width - inset]（见 widgets.css 的几何说明），
         * 所以这里要按"拇指可移动宽度"来算，而不是整个轨道宽度；
         * 否则拖到两端会差半个拇指，表现为数值到不了 min/max。
         * inset 直接读 CSS 变量，保证与样式始终一致。
         */
        function readInset() {
            var fallback = 6;
            if (!global.getComputedStyle) return fallback;
            var computed = global.getComputedStyle(node);
            if (!computed || !computed.getPropertyValue) return fallback;
            var raw = computed.getPropertyValue('--range-inset');
            var parsed = parseFloat(raw);
            return isFinite(parsed) ? parsed : fallback;
        }

        function valueFromEvent(event) {
            var rect = track.getBoundingClientRect ? track.getBoundingClientRect() : null;
            if (!rect || !rect.width) return value;
            var inset = readInset();
            var usable = Math.max(1, rect.width - inset * 2);
            var ratio = util.clamp((event.clientX - rect.left - inset) / usable, 0, 1);
            var next = min + ratio * (max - min);
            var steps = Math.round((next - min) / step);
            return util.clamp(min + steps * step, min, max, value);
        }

        function onPointerMove(event) {
            value = valueFromEvent(event);
            sync(true);
        }

        function onPointerUp() {
            node.setAttribute('data-dragging', 'false');
            if (global.document.removeEventListener) {
                global.document.removeEventListener('mousemove', onPointerMove);
                global.document.removeEventListener('mouseup', onPointerUp);
            }
            if (track.releasePointerCapture && track.__pointerId !== undefined) {
                try { track.releasePointerCapture(track.__pointerId); } catch (error) { /* 忽略 */ }
                track.__pointerId = undefined;
            }
        }

        track.addEventListener('mousedown', function (event) {
            event.preventDefault();
            value = valueFromEvent(event);
            sync(true);
            node.setAttribute('data-dragging', 'true');
            if (global.document.addEventListener) {
                global.document.addEventListener('mousemove', onPointerMove);
                global.document.addEventListener('mouseup', onPointerUp);
            }
        });

        // 支持触屏 / 触控板的 Pointer Events
        track.addEventListener('pointerdown', function (event) {
            if (event.pointerType === 'mouse') return;
            event.preventDefault();
            track.__pointerId = event.pointerId;
            if (track.setPointerCapture) {
                try { track.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
            }
            value = valueFromEvent(event);
            sync(true);
            node.setAttribute('data-dragging', 'true');
        });
        track.addEventListener('pointermove', function (event) {
            if (node.getAttribute('data-dragging') !== 'true') return;
            if (event.pointerType === 'mouse') return;
            value = valueFromEvent(event);
            sync(true);
        });
        track.addEventListener('pointerup', onPointerUp);
        track.addEventListener('pointercancel', onPointerUp);

        track.setAttribute('role', 'slider');
        track.setAttribute('tabindex', '0');
        track.setAttribute('aria-valuemin', String(min));
        track.setAttribute('aria-valuemax', String(max));
        track.setAttribute('aria-valuenow', String(value));
        track.addEventListener('keydown', function (event) {
            var delta = 0;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') delta = -step;
            else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') delta = step;
            else if (event.key === 'PageDown') delta = -(max - min) / 10;
            else if (event.key === 'PageUp') delta = (max - min) / 10;
            else return;
            event.preventDefault();
            value = util.clamp(value + delta, min, max, value);
            sync(true);
            track.setAttribute('aria-valuenow', String(value));
        });

        node.setValue = function (next, silent) {
            value = util.clamp(next, min, max, value);
            sync(!silent);
            track.setAttribute('aria-valuenow', String(value));
        };
        node.getValue = function () { return value; };
        node.setRange = function (nextMin, nextMax, nextStep) {
            min = util.toNumber(nextMin, min);
            max = util.toNumber(nextMax, max);
            if (nextStep !== undefined) step = util.toNumber(nextStep, step) || 1;
            raw.min = String(min); raw.max = String(max); raw.step = String(step);
            track.setAttribute('aria-valuemin', String(min));
            track.setAttribute('aria-valuemax', String(max));
            node.setValue(value, true);
        };
        node.setLabel = function (text) {
            labelNode.textContent = String(text == null ? '' : text);
            labelNode.removeAttribute('data-i18n');
        };
        node.setReadout = function (text) { readout.textContent = String(text == null ? '' : text); };

        sync(false);
        return node;
    }

    /* ============================================================
     * 图片槽位与预览
     * ============================================================ */

    /**
     * @param {{index?:number, dataUrl?:string, onRemove?:Function, onClick?:Function,
     *          emptyKey?:string, size?:number}} [options]
     */
    function imageSlot(options) {
        var opts = options || {};
        var node = el('div', {
            class: 'image-slot',
            dataset: { filled: opts.dataUrl ? 'true' : 'false' },
            style: opts.size ? { height: opts.size + 'px' } : null
        });
        if (opts.index !== undefined) {
            node.appendChild(el('span', { class: 'image-slot-index', text: String(opts.index + 1) }));
        }
        if (opts.dataUrl) {
            /*
             * 槽位里的图同样从静态池借：UXP 只渲染标记里静态声明的 <img>
             * （动态创建的既不加载、也不渲染，参考图会变成空槽）。
             * 借不到时退回动态创建，至少逻辑不崩。
             */
            var image = el('img', { alt: '' });
            image.addEventListener('error', function () {
                node.setAttribute('data-broken', 'true');
                if (!node.querySelector || !node.querySelector('.image-slot-broken')) {
                    node.appendChild(el('span', { class: 'image-slot-broken', text: t('state.failed') }));
                }
            });
            node.appendChild(image);
            acquireStaticImage().then(function (staticImage) {
                if (!staticImage) return;
                if (image.parentNode) image.parentNode.replaceChild(staticImage, image);
                else node.appendChild(staticImage);
                staticImage.setAttribute('src', opts.dataUrl);
                staticImage.style.maxWidth = '100%';
                staticImage.style.maxHeight = '100%';
                staticImage.style.objectFit = 'contain';
                staticImage.style.display = 'block';
            });
            image.setAttribute('src', opts.dataUrl);
            image.src = opts.dataUrl;
            if (opts.onRemove) {
                node.appendChild(el('button', {
                    type: 'button',
                    class: 'image-slot-remove',
                    text: '×',
                    'aria-label': 'remove',
                    onclick: function (event) {
                        event.stopPropagation();
                        opts.onRemove(opts.index);
                    }
                }));
            }
        } else {
            node.appendChild(el('span', { class: 'image-slot-label', text: t(opts.emptyKey || 'reference.empty') }));
        }
        if (opts.onClick) {
            node.addEventListener('click', function () { opts.onClick(opts.index, node); });
        }
        return node;
    }

    /** 参考图槽位区（最多 4 格，flex 两列） */
    function slotGrid(children) {
        return el('div', { class: 'slot-grid' }, children);
    }

    /**
     * 预览框。
     * @param {{dataUrl?:string, placeholderKey?:string, maxHeight?:number, toolbar?:Node[]}} [options]
     * @returns {HTMLElement} 带 `setImage(dataUrl)` / `clear()`
     */
    /* ============================================================
     * 静态图片池
     *
     * UXP 实测：标记里静态声明的 <img> 会渲染，运行时 createElement('img')
     * 创建的不渲染（参考插件里能显示的预览全是静态声明的）。
     * 所以图片元素从 index.html 的池子里"借"，用完还回去，
     * 而不是现场创建。
     * ============================================================ */
    var poolWaiters = [];
    var POOL_SIZE = 8;

    function poolRoot() {
        return global.document ? global.document.getElementById('imagePool') : null;
    }

    /** 借一个静态 <img>；池子空了就排队等归还 */
    function acquireStaticImage() {
        var root = poolRoot();
        if (root && root.children && root.children.length) {
            var node = root.children[0];
            if (node && node.parentNode) node.parentNode.removeChild(node);
            if (node) {
                node.style.display = 'none';
                node.removeAttribute('src');
                return Promise.resolve(node);
            }
        }
        return new Promise(function (resolve) { poolWaiters.push(resolve); });
    }

    /** 归还：把节点放回池子，让下一个预览复用 */
    function releaseStaticImage(node) {
        if (!node) return;
        var root = poolRoot();
        var waiter = poolWaiters.shift();
        if (waiter) {
            node.style.display = 'none';
            node.removeAttribute('src');
            waiter(node);
            return;
        }
        if (!root) return;
        try {
            node.style.display = 'none';
            node.style.width = '1px';
            node.style.height = '1px';
            node.removeAttribute('src');
            if (node.parentNode) node.parentNode.removeChild(node);
            root.appendChild(node);
        } catch (error) { /* 归还失败不影响主流程 */ }
    }

    void POOL_SIZE;

    function previewFrame(options) {
        var opts = options || {};

        /*
         * 预览完全照参考插件（zhuangai）的方案实现，不做任何额外加工。
         *
         * 它的做法：
         *   1. 元素在 index.html 里**静态声明**（UXP 不渲染运行时创建的图片）；
         *   2. 容器固定高度 + overflow hidden，图片靠 CSS 缩放；
         *   3. 有图时给它加一个状态类，由 CSS 把图片显成
         *      `display:block; width:100%; height:auto; max-width:none; max-height:none`。
         *
         * 第 3 条是关键：图片必须显式 width:100%（而不是 width:auto）。
         * width:auto 会让图片按固有尺寸铺开（选区常是 683×1536），
         * 远超容器后被 overflow 裁掉 —— 元素在、也已 loaded，但屏幕上什么都没有。
         */
        var holder = el('div', { class: 'preview-frame' });

        var placeholder = el('div', {
            class: 'preview-placeholder',
            text: t(opts.placeholderKey || 'tools.previewEmpty'),
            'data-i18n': opts.placeholderKey || 'tools.previewEmpty'
        });

        var image = el('img', { class: 'preview-image', alt: '' });
        image.style.display = 'none';

        holder.appendChild(placeholder);
        holder.appendChild(image);

        var node = el('div', { class: 'stack', style: { gap: '6px' } });
        node.appendChild(holder);
        if (opts.toolbar && opts.toolbar.length) {
            node.appendChild(el('div', { class: 'preview-toolbar' }, opts.toolbar));
        }

        // 有图 → 加状态类（和参考插件的 has-selection 一个作用）
        function showImage() {
            holder.setAttribute('data-has-image', 'true');
            placeholder.style.display = 'none';
            image.style.display = 'block';
        }

        function clear() {
            lastDataUrl = '';
            holder.removeAttribute('data-has-image');
            image.removeAttribute('src');
            image.style.display = 'none';
            placeholder.textContent = t(opts.placeholderKey || 'tools.previewEmpty');
            placeholder.style.display = 'block';
        }

        var lastDataUrl = '';
        image.addEventListener('error', function () {
            if (!image.getAttribute('src')) return;
            if (DreamAI.logbus) {
                DreamAI.logbus.warn('预览图片加载失败（data URL 可能不被宿主支持）',
                    { domain: 'ui', source: 'preview' });
            }
        });

        node.setImage = function (dataUrl) {
            if (!dataUrl) { clear(); return; }
            lastDataUrl = dataUrl;
            // 顺序照参考插件：先设 src，再设 display
            image.setAttribute('src', dataUrl);
            try { image.src = dataUrl; } catch (error) { /* 某些宿主只认 setAttribute */ }
            showImage();
        };

        node.setCanvas = function () { /* 参考方案不需要 canvas */ };
        node.getHolder = function () { return holder; };
        node.getElement = function () { return image; };
        node.clear = clear;
        node.dispose = function () { clear(); };
        if (opts.dataUrl) node.setImage(opts.dataUrl);
        return node;
    }

    /**
     * 选区状态条 + 预览图。
     *
     * 状态行会明确写出"有没有图、图多大"，而不是只显示一句泛泛的提示 ——
     * 预览不出来时，用户/排查者一眼就能看出是没读到选区、还是读到了但图没加载，
     * 不必去翻日志。
     */
    /* ============================================================
     * 色板（自绘，替代 UXP 无法定位的 input[type=color]）
     * ============================================================ */

    function hexToRgb(hex) {
        var text = String(hex || '').replace('#', '').trim();
        if (text.length === 3) text = text[0] + text[0] + text[1] + text[1] + text[2] + text[2];
        if (!/^[0-9a-fA-F]{6}$/.test(text)) return { r: 255, g: 210, b: 122 };
        return {
            r: parseInt(text.slice(0, 2), 16),
            g: parseInt(text.slice(2, 4), 16),
            b: parseInt(text.slice(4, 6), 16)
        };
    }

    function rgbToHex(r, g, b) {
        var toHex = function (v) {
            var text = Math.round(util.clamp(v, 0, 255)).toString(16);
            return text.length === 1 ? '0' + text : text;
        };
        return '#' + toHex(r) + toHex(g) + toHex(b);
    }

    function rgbToHsv(r, g, b) {
        var rn = r / 255, gn = g / 255, bn = b / 255;
        var max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
        var delta = max - min;
        var h = 0;
        if (delta > 1e-6) {
            if (max === rn) h = ((gn - bn) / delta) % 6;
            else if (max === gn) h = (bn - rn) / delta + 2;
            else h = (rn - gn) / delta + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        return { h: h, s: max <= 0 ? 0 : delta / max, v: max };
    }

    function hsvToRgb(h, s, v) {
        var c = v * s;
        var hh = (h % 360) / 60;
        var x = c * (1 - Math.abs((hh % 2) - 1));
        var r = 0, g = 0, b = 0;
        if (hh < 1) { r = c; g = x; }
        else if (hh < 2) { r = x; g = c; }
        else if (hh < 3) { g = c; b = x; }
        else if (hh < 4) { g = x; b = c; }
        else if (hh < 5) { r = x; b = c; }
        else { r = c; b = x; }
        var m = v - c;
        return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
    }

    /** 色相条 + 饱和/明度 + 十六进制输入 */
    function colorPicker(options) {
        var opts = options || {};
        var initial = hexToRgb(opts.value);
        var hsv = rgbToHsv(initial.r, initial.g, initial.b);

        var swatch = el('span', {
            style: {
                display: 'block', width: '22px', height: '22px', flex: '0 0 auto',
                borderRadius: 'var(--radius-sm)',
                boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.12)',
                backgroundColor: opts.value || '#ffd27a'
            }
        });
        var hexInput = input({ value: opts.value || '#ffd27a', mono: true, onChange: function (value) { applyHex(value, true); } });

        var hueStrip = el('div', {
            class: 'range-track',
            style: {
                height: '14px',
                borderRadius: 'var(--radius-pill)',
                background: 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'
            },
            role: 'slider',
            tabindex: '0',
            'aria-label': 'hue'
        });
        var hueThumb = el('span', {
            class: 'range-thumb',
            style: { width: '10px', height: '10px', marginLeft: '-5px', border: '2px solid #fff', background: 'transparent' }
        });
        hueStrip.appendChild(hueThumb);

        var satSlider = slider({
            labelKey: 'tools.saturation', min: 0, max: 100, step: 1,
            value: Math.round(hsv.s * 100),
            onInput: function (value) { hsv.s = value / 100; emit(); }
        });
        var valSlider = slider({
            labelKey: 'tools.detail', min: 0, max: 100, step: 1,
            value: Math.round(hsv.v * 100),
            onInput: function (value) { hsv.v = value / 100; emit(); }
        });
        valSlider.setLabel(t('field.quality'));

        var node = el('div', { class: 'stack', style: { gap: '6px' } }, [
            hueStrip, satSlider, valSlider,
            el('div', { class: 'color-row' }, [swatch, hexInput])
        ]);

        function emit() {
            var rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
            var hex = rgbToHex(rgb.r, rgb.g, rgb.b);
            swatch.style.backgroundColor = hex;
            hexInput.value = hex;
            hueThumb.style.left = ((hsv.h / 360) * 100) + '%';
            if (typeof opts.onChange === 'function') opts.onChange(hex, { r: rgb.r, g: rgb.g, b: rgb.b });
        }

        function applyHex(value, notify) {
            var rgb = hexToRgb(value);
            var next = rgbToHsv(rgb.r, rgb.g, rgb.b);
            hsv.h = next.h; hsv.s = next.s; hsv.v = next.v;
            satSlider.setValue(Math.round(hsv.s * 100), true);
            valSlider.setValue(Math.round(hsv.v * 100), true);
            if (notify) emit();
            else {
                swatch.style.backgroundColor = value;
                hueThumb.style.left = ((hsv.h / 360) * 100) + '%';
            }
        }

        hueStrip.addEventListener('mousedown', function (event) {
            event.preventDefault();
            var rect = hueStrip.getBoundingClientRect();
            var set = function (clientX) {
                hsv.h = util.clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * 360;
                emit();
            };
            set(event.clientX);
            var move = function (moveEvent) { set(moveEvent.clientX); };
            var up = function () {
                global.document.removeEventListener('mousemove', move);
                global.document.removeEventListener('mouseup', up);
            };
            global.document.addEventListener('mousemove', move);
            global.document.addEventListener('mouseup', up);
        });

        node.setValue = function (value) { applyHex(value, false); };
        node.getValue = function () {
            var rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
            return rgbToHex(rgb.r, rgb.g, rgb.b);
        };
        emit();
        return node;
    }

    function selectionPreview(options) {
        var opts = options || {};
        var info = el('div', { class: 'field-hint', text: t('selection.none'), 'data-i18n': 'selection.none' });
        var frame = previewFrame({ placeholderKey: 'selection.none' });
        var head = el('div', { class: 'inline', style: { justifyContent: 'space-between' } }, [
            info,
            opts.actions ? el('div', { class: 'inline' }, opts.actions) : null
        ]);
        var node = el('div', { class: 'stack', style: { gap: '6px' } }, [head, frame]);

        function setStatus(text, tone) {
            info.textContent = text;
            info.removeAttribute('data-i18n');
            if (tone) info.setAttribute('data-tone', tone);
            else info.removeAttribute('data-tone');
        }

        node.update = function (selection) {
            if (!selection) {
                info.textContent = t('selection.none');
                info.setAttribute('data-i18n', 'selection.none');
                frame.clear();
                return;
            }
            var dataUrl = String(selection.dataUrl || '');
            var size = t('selection.info', { w: selection.width, h: selection.height });
            if (!dataUrl) {
                // 读到了选区却没图：明确说出来，而不是留一个空框
                setStatus(size + ' · ' + t('selection.noImageData'), 'warn');
                frame.clear();
                return;
            }
            setStatus(size + ' · ' + Math.round(dataUrl.length / 1024) + ' KB');
            frame.setImage(dataUrl);
        };
        node.setStatus = setStatus;
        node.frame = frame;
        return node;
    }

    DreamAI.Widgets = {
        page: page,
        card: card,
        field: field,
        row: row,
        divider: divider,
        spacer: spacer,
        grid: grid,
        hint: hint,
        empty: empty,
        pill: pill,
        kv: kv,
        button: button,
        iconButton: iconButton,
        miniButton: miniButton,
        buttonRow: buttonRow,
        chipGroup: chipGroup,
        input: input,
        textarea: textarea,
        counter: counter,
        select: select,
        checkbox: checkbox,
        slider: slider,
        imageSlot: imageSlot,
        slotGrid: slotGrid,
        previewFrame: previewFrame,
        colorPicker: colorPicker,
        selectionPreview: selectionPreview,
        t: t,
        closeOpenSelect: closeOpenSelect,
        hexToRgb: hexToRgb,
        rgbToHex: rgbToHex,
        rgbToHsv: rgbToHsv,
        hsvToRgb: hsvToRgb
    };
})(typeof window !== 'undefined' ? window : this);
