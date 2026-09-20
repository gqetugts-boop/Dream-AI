/*
 * ui/pages/logs.js — 活动日志（页面版）
 *
 * 为什么要有这一页：日志原来只放在右下角的抽屉里，而抽屉是
 * position:absolute 的覆盖层。在宿主里覆盖层一旦被裁切或压到下面，
 * 用户就完全看不到日志，排查问题时反而失去唯一的线索。
 * 放到主区页面里（跟着正常文档流走）就不存在这个问题。
 * 抽屉仍然保留，两者读的是同一份 logbus 缓冲。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    DreamAI.Router.register({
        id: 'logs',
        // 归到 asset 组而不是 system：system 组不进侧栏，日志必须一眼能找到
        group: 'asset',
        labelKey: 'logs.title',
        glyph: '≡',
        order: 40,
        build: function (W) {
            var filterLevel = 'all';
            var keyword = '';
            var autoRefresh = true;
            var timer = null;

            var listBox = el('div', { class: 'stack', style: { gap: '4px' } });
            var summary = el('div', { class: 'field-hint' });
            var levelSelect = W.select([
                { value: 'all', labelKey: 'logs.levelAll' },
                { value: 'error', label: 'error' },
                { value: 'warn', label: 'warn' },
                { value: 'info', label: 'info' },
                { value: 'success', label: 'success' },
                { value: 'debug', label: 'debug' }
            ], 'all', {
                onChange: function (value) { filterLevel = value; render(); }
            });
            var searchInput = W.input({
                placeholderKey: 'logs.filter',
                onInput: util.debounce(function (value) { keyword = value; render(); }, 200)
            });
            var liveCheck = W.checkbox('tools.scopeLive', true, {
                onChange: function (checked) { autoRefresh = checked; schedule(); }
            });

            var card = W.card('logs.title', {
                extra: el('div', { class: 'inline' }, [
                    W.miniButton('app.refresh', { onClick: render }),
                    W.miniButton('logs.copy', { onClick: copyAll }),
                    W.miniButton('app.clear', { onClick: clearAll })
                ])
            }, null);
            card.cardBody.appendChild(summary);
            card.cardBody.appendChild(el('div', { class: 'param-grid' }, [
                el('div', { class: 'param-cell' }, [W.field('logs.levelAll', levelSelect)]),
                el('div', { class: 'param-cell' }, [W.field('logs.filter', searchInput)])
            ]));
            card.cardBody.appendChild(liveCheck);
            card.cardBody.appendChild(listBox);

            var page = W.page('logs.title', { id: 'logs', subtitleKey: 'app.activityLog' });
            page.appendChild(card);

            function render() {
                var entries = DreamAI.logbus.filter({ level: filterLevel, keyword: keyword }).reverse();
                util.clear(listBox);
                summary.textContent = '共 ' + DreamAI.logbus.size + ' 条 · 显示 ' + entries.length + ' 条' +
                    '（缓冲上限 ' + DreamAI.logbus.limit + '）';
                if (!entries.length) {
                    listBox.appendChild(W.empty('≡', 'logs.empty'));
                    return;
                }
                for (var i = 0; i < entries.length; i++) {
                    listBox.appendChild(buildRow(entries[i]));
                }
            }

            function buildRow(entry) {
                var time = new Date(entry.at);
                var pad = function (v) { return v < 10 ? '0' + v : String(v); };
                var stamp = pad(time.getHours()) + ':' + pad(time.getMinutes()) + ':' + pad(time.getSeconds());
                var tone = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn'
                    : entry.level === 'success' ? 'ok' : 'idle';
                var metaText = '';
                if (entry.meta) {
                    try { metaText = JSON.stringify(entry.meta); } catch (e) { metaText = String(entry.meta); }
                    if (metaText === '{}') metaText = '';
                }
                return el('div', { class: 'stack', style: { gap: '2px' } }, [
                    el('div', { class: 'inline', style: { justifyContent: 'space-between' } }, [
                        el('span', { class: 'field-hint mono', text: stamp + ' · ' + entry.domain }),
                        W.pill(entry.level, tone)
                    ]),
                    el('div', { style: { fontSize: 'var(--fs-sm)', color: 'var(--text-main)', wordBreak: 'break-word' }, text: entry.message }),
                    metaText ? el('div', { class: 'field-hint mono', style: { wordBreak: 'break-all' }, text: metaText }) : null
                ]);
            }

            function copyAll() {
                var text = DreamAI.logbus.toText();
                DreamAI.Shell.copyText(text).then(function (ok) {
                    DreamAI.Shell.toast(ok ? 'logs.copied' : 'logs.copyFailed', { tone: ok ? 'ok' : 'warn' });
                    // 复制失败时把内容塞进模态，用户可以直接选中复制
                    if (!ok) {
                        DreamAI.Shell.modal({
                            titleKey: 'logs.title',
                            body: W.textarea({ value: text, mono: true, tall: true, rows: 14 }),
                            actions: [{ labelKey: 'app.close', variant: 'primary' }]
                        });
                    }
                });
            }

            function clearAll() {
                DreamAI.logbus.clear();
                render();
                DreamAI.Shell.toast('logs.cleared', { tone: 'ok' });
            }

            function schedule() {
                if (timer) { clearInterval(timer); timer = null; }
                if (!autoRefresh) return;
                if (typeof global.setInterval !== 'function') return;
                timer = setInterval(function () {
                    // 只在页面可见时刷新，避免后台无谓开销
                    if (!page.hasAttribute('hidden')) render();
                }, 1500);
                // 测试/Node 环境下不要让定时器拖住事件循环
                if (timer && typeof timer.unref === 'function') timer.unref();
            }

            return {
                el: page,
                mount: function () { render(); schedule(); },
                unmount: function () { if (timer) { clearInterval(timer); timer = null; } },
                refresh: render
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
