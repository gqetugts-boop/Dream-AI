/*
 * ui/pages/batch.js — 批处理队列
 *
 * 职责：编辑批处理队列、启动串行批处理、查看每一项的状态。
 * 边界：真正的执行与回写由 DreamAI.Batch + TaskQueue 负责。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    DreamAI.Router.register({
        id: 'batch',
        group: 'asset',
        labelKey: 'nav.batch',
        glyph: '☰',
        order: 30,
        build: function (W) {
            var items = [];
            var disposers = [];
            var listBox = el('div', { class: 'stack', style: { gap: '6px' } });
            var progressBar = el('span', { class: 'progress-bar' });
            var progressWrap = el('div', { class: 'progress', hidden: true }, [progressBar]);
            var summary = el('div', { class: 'field-hint' });

            var promptArea = W.textarea({ placeholderKey: 'ws.promptPlaceholder', rows: 3 });
            var countSelect = W.select([1, 2, 3, 4].map(function (n) { return { value: n, label: String(n) }; }), 1, {});
            var providerSelect = W.select([], '', { placeholderKey: 'field.provider' });
            var startBtn = W.button('batch.start', { variant: 'primary', glyph: '▶', onClick: start });
            var stopBtn = W.button('app.stop', { variant: 'quiet', onClick: stop, disabled: true });
            var clearBtn = W.button('batch.clear', { variant: 'ghost', onClick: clearAll });
            var addBtn = W.button('batch.add', { variant: 'ghost', glyph: '＋', onClick: addItem });

            var addCard = W.card('batch.add', { persistKey: 'batch-add' }, null);
            addCard.cardBody.appendChild(W.field('field.positive', promptArea));
            addCard.cardBody.appendChild(el('div', { class: 'param-grid' }, [
                el('div', { class: 'param-cell' }, [W.field('field.provider', providerSelect)]),
                el('div', { class: 'param-cell' }, [W.field('field.count', countSelect)])
            ]));
            addCard.cardBody.appendChild(el('div', { class: 'btn-row' }, [addBtn]));

            var queueCard = W.card('batch.title', { extra: el('div', { class: 'inline' }, [clearBtn]) }, null);
            queueCard.cardBody.appendChild(summary);
            queueCard.cardBody.appendChild(progressWrap);
            queueCard.cardBody.appendChild(listBox);

            var page = W.page('batch.title', { id: 'batch' });
            page.appendChild(queueCard);
            page.appendChild(addCard);
            page.appendChild(el('div', { class: 'action-bar' }, [
                el('div', { class: 'action-bar-main' }, [startBtn]),
                stopBtn
            ]));

            function refreshProviders() {
                var providers = DreamAI.Providers ? DreamAI.Providers.list() : [];
                var items2 = providers.map(function (p) { return { value: p.id, labelKey: p.labelKey, label: p.id }; });
                providerSelect.setItems(items2, true);
                var preferred = DreamAI.App.get('settings.activeChannelId', '');
                var found = items2.some(function (i) { return i.value === preferred; });
                providerSelect.setValue(found ? preferred : (items2.length ? items2[0].value : ''), true);
            }

            function render() {
                items = DreamAI.Batch ? DreamAI.Batch.list() : [];
                util.clear(listBox);
                if (!items.length) {
                    listBox.appendChild(W.empty('☰', 'batch.empty'));
                    summary.textContent = '';
                } else {
                    summary.textContent = W.t('batch.progress', { done: doneCount(), total: items.length });
                    for (var i = 0; i < items.length; i++) {
                        listBox.appendChild(buildRow(items[i], i));
                    }
                }
                var running = DreamAI.Batch ? DreamAI.Batch.isRunning() : false;
                startBtn.setAttribute('disabled', running || !items.length ? '' : null);
                stopBtn.setAttribute('disabled', running ? null : '');
                if (!running) progressWrap.setAttribute('hidden', '');
            }

            function doneCount() {
                var count = 0;
                for (var i = 0; i < items.length; i++) {
                    if (items[i].state === 'done' || items[i].state === 'failed') count++;
                }
                return count;
            }

            function buildRow(item, index) {
                var tone = item.state === 'done' ? 'ok' : item.state === 'failed' ? 'error'
                    : item.state === 'running' ? 'running' : 'idle';
                return el('div', { class: 'batch-row' }, [
                    el('span', { class: 'batch-row-index', text: String(index + 1) }),
                    el('div', { class: 'batch-row-body' }, [
                        el('div', { class: 'truncate', text: util.truncate(item.prompt || '', 56), style: { fontSize: 'var(--fs-sm)' } }),
                        el('div', { class: 'field-hint', text: (item.providerId || '') + ' · ' + (item.size || '') + (item.error ? ' · ' + item.error : '') })
                    ]),
                    W.pill('state.' + (item.state || 'idle'), tone),
                    W.miniButton('app.remove', {
                        onClick: function () { DreamAI.Batch.remove(item.id); render(); }
                    })
                ]);
            }

            function addItem() {
                if (!DreamAI.Batch) return;
                var prompt = (promptArea.value || '').trim();
                if (!prompt) {
                    DreamAI.Shell.toast('ws.needPrompt', { tone: 'warn' });
                    return;
                }
                DreamAI.Batch.add({
                    prompt: prompt,
                    providerId: providerSelect.getValue(),
                    count: util.toNumber(countSelect.getValue(), 1)
                });
                promptArea.value = '';
                DreamAI.Shell.toast('batch.added', { tone: 'ok' });
                render();
            }

            function clearAll() {
                if (!DreamAI.Batch) return;
                DreamAI.Batch.clear();
                render();
            }

            function start() {
                if (!DreamAI.Batch || DreamAI.Batch.isRunning()) return;
                progressWrap.removeAttribute('hidden');
                DreamAI.Batch.start().then(function (result) {
                    DreamAI.Shell.toast(W.t('batch.finished', { ok: result.ok, fail: result.fail }), {
                        tone: result.fail ? 'warn' : 'ok'
                    });
                    render();
                }, function (error) {
                    DreamAI.Shell.toast(W.t('state.failed') + ': ' + (error && error.message ? error.message : String(error)), { tone: 'error' });
                    render();
                });
                render();
            }

            function stop() {
                if (DreamAI.Batch) DreamAI.Batch.stop();
                DreamAI.Shell.toast('batch.stopped', { tone: 'warn' });
                render();
            }

            disposers.push(DreamAI.bus.on('batch:change', function () { render(); }));
            disposers.push(DreamAI.bus.on('task:update', function (payload) {
                var task = payload && payload.task;
                if (!task || task.progress < 0) return;
                progressBar.style.width = util.clamp(task.progress, 0, 100) + '%';
            }));

            return {
                el: page,
                mount: function () {
                    refreshProviders();
                    render();
                },
                refresh: function () { render(); }
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
