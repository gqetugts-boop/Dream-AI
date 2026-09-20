/*
 * ui/pages/gallery.js — 画廊
 *
 * 职责：展示已归档的生成结果，支持回写 PS、下载、复用提示词、删除与按规则清理。
 * 边界：图片二进制的存取全交给 DreamAI.Gallery，本页只管界面与交互。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    DreamAI.Router.register({
        id: 'gallery',
        group: 'asset',
        labelKey: 'nav.gallery',
        glyph: '▦',
        order: 10,
        build: function (W) {
            var items = [];
            var disposers = [];
            var grid = el('div', { class: 'gallery-grid' });
            var summary = el('div', { class: 'field-hint' });
            var busy = false;

            var refreshBtn = W.miniButton('app.refresh', { onClick: function () { load(true); } });
            var pruneBtn = W.miniButton('gallery.prune', { onClick: pruneNow });
            var detailFrame = W.previewFrame({ placeholderKey: 'gallery.empty' });
            var detailMeta = el('div', { class: 'stack', style: { gap: '2px' } });

            var detailCard = W.card('ws.resultTitle', { persistKey: 'gallery-detail', collapsed: true }, null);
            detailCard.cardBody.appendChild(detailFrame);
            detailCard.cardBody.appendChild(detailMeta);

            var listCard = W.card('gallery.title', {
                extra: el('div', { class: 'inline' }, [refreshBtn, pruneBtn])
            }, null);
            listCard.cardBody.appendChild(summary);
            listCard.cardBody.appendChild(grid);

            var page = W.page('gallery.title', { id: 'gallery', subtitleKey: 'gallery.retentionCount' });
            page.appendChild(listCard);
            page.appendChild(detailCard);

            function load(showBusy) {
                if (!DreamAI.Gallery) {
                    summary.textContent = W.t('app.notConfigured');
                    return Promise.resolve();
                }
                if (busy) return Promise.resolve();
                busy = true;
                if (showBusy) summary.textContent = W.t('app.loading');
                return Promise.resolve(DreamAI.Gallery.list()).then(function (list) {
                    items = Array.isArray(list) ? list : [];
                    renderList();
                }, function (error) {
                    summary.textContent = W.t('state.failed') + ': ' + (error && error.message ? error.message : String(error));
                }).then(function () { busy = false; });
            }

            function renderList() {
                util.clear(grid);
                summary.textContent = W.t('gallery.count', { count: items.length });
                if (!items.length) {
                    grid.appendChild(W.empty('▦', 'gallery.empty'));
                    return;
                }
                for (var i = 0; i < items.length; i++) {
                    grid.appendChild(buildTile(items[i]));
                }
            }

            function buildTile(item) {
                var tile = el('div', {
                    class: 'gallery-tile',
                    title: item.prompt || item.id,
                    onclick: function () { showDetail(item); }
                });
                if (item.dataUrl) {
                    tile.appendChild(el('img', { src: item.dataUrl, alt: '' }));
                } else {
                    tile.style.display = 'flex';
                    tile.style.alignItems = 'center';
                    tile.style.justifyContent = 'center';
                    tile.appendChild(el('span', { class: 'field-hint', text: W.t('app.loading') }));
                    Promise.resolve(DreamAI.Gallery.getDataUrl(item.id)).then(function (dataUrl) {
                        if (!dataUrl) return;
                        util.clear(tile);
                        tile.appendChild(el('img', { src: dataUrl, alt: '' }));
                        tile.appendChild(el('div', { class: 'gallery-tile-meta', text: util.truncate(item.prompt || '', 26) }));
                    });
                }
                tile.appendChild(el('div', {
                    class: 'gallery-tile-meta',
                    text: util.truncate(item.prompt || W.t('app.unknown'), 26)
                }));
                return tile;
            }

            function showDetail(item) {
                detailCard.setCollapsed(false);
                detailFrame.setImage(item.dataUrl || '');
                if (!item.dataUrl) {
                    Promise.resolve(DreamAI.Gallery.getDataUrl(item.id)).then(function (dataUrl) {
                        if (dataUrl) detailFrame.setImage(dataUrl);
                    });
                }
                util.clear(detailMeta);
                var rows = [
                    ['field.provider', item.providerId || '-'],
                    ['field.model', item.modelId || '-'],
                    ['ws.mode', item.mode || '-'],
                    ['field.size', (item.width && item.height) ? item.width + ' × ' + item.height : '-'],
                    ['ws.prompt', item.prompt ? util.truncate(item.prompt, 90) : '-'],
                    ['about.version', new Date(item.createdAt || Date.now()).toLocaleString()]
                ];
                for (var i = 0; i < rows.length; i++) {
                    detailMeta.appendChild(W.kv(rows[i][0], rows[i][1]));
                }
                detailMeta.appendChild(el('div', { class: 'btn-row' }, [
                    W.button('gallery.saveToPs', {
                        variant: 'primary',
                        size: 'sm',
                        onClick: function () { saveToPs(item); }
                    }),
                    W.button('gallery.download', {
                        size: 'sm',
                        onClick: function () {
                            Promise.resolve(DreamAI.Gallery.getDataUrl(item.id)).then(function (dataUrl) {
                                if (!dataUrl) return;
                                DreamAI.Gallery.download(dataUrl, 'dream-ai-' + item.id + '.png');
                            });
                        }
                    }),
                    W.button('gallery.reusePrompt', {
                        size: 'sm',
                        onClick: function () {
                            DreamAI.App.saveWorkbench({ prompt: item.prompt || '' });
                            DreamAI.Router.activate('workbench');
                            DreamAI.Shell.toast('gallery.reusePrompt', { tone: 'info' });
                        }
                    }),
                    W.button('gallery.remove', {
                        variant: 'danger',
                        size: 'sm',
                        onClick: function () { removeItem(item); }
                    })
                ]));
            }

            function saveToPs(item) {
                if (!DreamAI.PhotoReturn || !DreamAI.PhotoReturn.isAvailable()) {
                    DreamAI.Shell.toast('return.disabled', { tone: 'warn' });
                    return;
                }
                DreamAI.Shell.status('state.returning', { key: 'state.returning', tone: 'busy' });
                Promise.resolve(DreamAI.Gallery.saveToPhotoshop(item.id)).then(function () {
                    DreamAI.Shell.status('return.done', { text: W.t('app.ready'), key: 'app.ready', tone: 'ok', autoClear: 2200 });
                }, function (error) {
                    DreamAI.Shell.toast(W.t('return.failed', { reason: error && error.message ? error.message : String(error) }), { tone: 'error' });
                });
            }

            function removeItem(item) {
                DreamAI.Shell.confirm('gallery.confirmRemove').then(function (ok) {
                    if (!ok) return;
                    return Promise.resolve(DreamAI.Gallery.remove(item.id)).then(function () {
                        DreamAI.Shell.toast('gallery.removed', { tone: 'ok' });
                        load();
                    });
                });
            }

            function pruneNow() {
                if (!DreamAI.Gallery) return;
                Promise.resolve(DreamAI.Gallery.prune(DreamAI.Gallery.policy())).then(function (result) {
                    DreamAI.Shell.toast(W.t('gallery.pruned', { count: result && result.removed ? result.removed : 0 }), { tone: 'ok' });
                    load();
                }, function (error) {
                    DreamAI.Shell.toast(W.t('state.failed') + ': ' + (error && error.message ? error.message : String(error)), { tone: 'error' });
                });
            }

            disposers.push(DreamAI.bus.on('gallery:change', function () { load(); }));
            disposers.push(DreamAI.bus.on('task:finished', function (payload) {
                if (payload && payload.task && payload.task.state === 'done') load();
            }));

            return {
                el: page,
                mount: function () { load(); },
                refresh: function () { load(); }
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
