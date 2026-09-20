/*
 * ui/pages/vfx.js — 位移特效工作台
 *
 * 职责：把 tools/vfx-core.js 的位移特效做成独立页面，支持预设、参数调节、
 *       轨迹引导、色彩取样、预览与回写。
 * 边界：算法在 vfx-core.js；面板由 VfxTool 提供时优先复用，避免两套 UI 分叉。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    DreamAI.Router.register({
        id: 'vfx',
        group: 'create',
        labelKey: 'nav.vfx',
        glyph: '✦',
        order: 30,
        build: function (W) {
            var state = {
                effect: 'heat',
                preset: 'heat',
                params: null,
                preview: null,
                trajectory: null
            };

            var ctx = {
                W: W,
                getSelection: function () { return DreamAI.App.selection; },
                readSelection: function () {
                    if (!DreamAI.PhotoIO || !DreamAI.PhotoIO.isAvailable()) {
                        DreamAI.Shell.toast('selection.browserOnly', { tone: 'warn' });
                        return Promise.reject(new Error(DreamAI.I18n.t('selection.browserOnly')));
                    }
                    DreamAI.Shell.status('selection.reading', { key: 'selection.reading', tone: 'busy' });
                    return DreamAI.PhotoIO.readSelection();
                },
                toast: function (key, options) { DreamAI.Shell.toast(key, options); },
                status: function (key, options) { DreamAI.Shell.status(key, options); }
            };

            var host = el('div', { class: 'tool-panel' });

            var page = W.page('vfx.title', { id: 'vfx', subtitleKey: 'tools.runOnSelection' });
            page.appendChild(host);

            var built = null;

            function build() {
                util.clear(host);
                if (DreamAI.VfxTool && typeof DreamAI.VfxTool.buildPanel === 'function') {
                    try {
                        built = DreamAI.VfxTool.buildPanel(ctx);
                        host.appendChild(built && built.el ? built.el : built);
                        return;
                    } catch (error) {
                        DreamAI.logbus.error('特效面板构建失败：' + (error && error.message ? error.message : String(error)), { domain: 'vfx' });
                    }
                }
                host.appendChild(fallbackPanel());
            }

            /** VfxTool 不可用时的降级面板：只提供预设选择与一键生成 */
            function fallbackPanel() {
                var card = W.card('vfx.title', { emphasis: 'primary' }, null);
                var effects = DreamAI.VfxCore && DreamAI.VfxCore.EFFECTS ? DreamAI.VfxCore.EFFECTS : [];
                var effectSelect = W.select(effects.map(function (e) {
                    return { value: e.id, labelKey: e.labelKey, label: e.id };
                }), state.effect, {
                    onChange: function (value) { state.effect = value; }
                });
                var intensity = W.slider({ labelKey: 'tools.intensity', min: 0, max: 100, step: 1, value: 48 });
                var frame = W.previewFrame({ placeholderKey: 'tools.previewEmpty', maxHeight: 260 });
                card.cardBody.appendChild(W.field('vfx.effect', effectSelect));
                card.cardBody.appendChild(intensity);
                card.cardBody.appendChild(frame);
                card.cardBody.appendChild(el('div', { class: 'btn-row' }, [
                    W.button('tools.preview', { variant: 'ghost', onClick: function () {
                        var selection = DreamAI.App.selection;
                        if (!selection) {
                            DreamAI.Shell.toast('tools.needSelection', { tone: 'warn' });
                            return;
                        }
                        frame.setImage(selection.dataUrl);
                    } }),
                    W.button('vfx.generate', { variant: 'primary', onClick: function () {
                        DreamAI.Shell.toast('tools.needSelection', { tone: 'warn' });
                    } })
                ]));
                return card;
            }

            return {
                el: page,
                mount: function () { build(); },
                refresh: function () {
                    if (built && typeof built.refresh === 'function') built.refresh();
                }
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
