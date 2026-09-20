/*
 * ui/pages/about.js — 关于
 *
 * 职责：版本、宿主环境、快捷键与设计说明。
 * 边界：只读展示，不承载任何业务逻辑。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    var VERSION = '1.0.0';

    DreamAI.Router.register({
        id: 'about',
        group: 'system',
        labelKey: 'nav.about',
        glyph: 'ⓘ',
        order: 20,
        build: function (W) {
            var hero = el('div', { class: 'about-hero' }, [
                el('div', { class: 'about-mark', 'aria-hidden': 'true' }),
                el('div', { class: 'about-name', text: 'Dream AI' }),
                el('div', { class: 'about-version', text: 'v' + VERSION }),
                el('div', { class: 'field-hint', text: W.t('app.brandSub'), 'data-i18n': 'app.brandSub' })
            ]);

            var envBox = el('div', { class: 'stack', style: { gap: '2px' } });

            var shortcutBox = el('div', { class: 'stack', style: { gap: '2px' } });

            var designCard = W.card('about.title', null, null);
            designCard.cardBody.appendChild(el('div', { class: 'about-text', text: W.t('app.brandSub') }));
            designCard.cardBody.appendChild(el('div', { class: 'divider' }));
            designCard.cardBody.appendChild(envBox);
            designCard.cardBody.appendChild(el('div', { class: 'divider' }));
            designCard.cardBody.appendChild(el('div', { class: 'strong', text: W.t('about.shortcuts'), 'data-i18n': 'about.shortcuts' }));
            designCard.cardBody.appendChild(shortcutBox);

            var page = W.page('about.title', { id: 'about' });
            page.appendChild(hero);
            page.appendChild(designCard);

            function refreshEnv() {
                util.clear(envBox);
                var host = DreamAI.host || {};
                var info = host.info || {};
                var envLabel = host.isUxp
                    ? (info.appName || 'UXP') + (info.appVersion ? ' ' + info.appVersion : '')
                    : 'Browser preview';
                envBox.appendChild(W.kv('about.version', VERSION));
                envBox.appendChild(W.kv('about.host', envLabel));
                envBox.appendChild(W.kv('field.language', DreamAI.I18n.getLang()));
                envBox.appendChild(W.kv('field.theme', DreamAI.Theme.get()));
                envBox.appendChild(W.kv('settings.channels', String(DreamAI.Providers ? DreamAI.Providers.list().length : 0)));
            }

            function refreshShortcuts() {
                util.clear(shortcutBox);
                shortcutBox.appendChild(W.kv('about.shortcutSendChat', 'Enter'));
                shortcutBox.appendChild(W.kv('about.shortcutNewline', 'Shift + Enter'));
                shortcutBox.appendChild(W.kv('about.shortcutReadSelection', 'Ctrl / Cmd + R'));
                shortcutBox.appendChild(W.kv('about.shortcutSaveSettings', 'Ctrl / Cmd + S'));
                shortcutBox.appendChild(W.kv('app.close', 'Esc'));
            }

            return {
                el: page,
                mount: function () {
                    refreshEnv();
                    refreshShortcuts();
                },
                refresh: refreshEnv
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
