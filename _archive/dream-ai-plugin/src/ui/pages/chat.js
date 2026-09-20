/*
 * ui/pages/chat.js — 对话
 *
 * 职责：与文字模型多轮对话，可把选区画面作为上下文，并把回复转成生图提示词。
 * 边界：不改写文档；生成图片走工作台。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    var util = DreamAI.util;
    var el = util.el;

    var MAX_TURNS = 40;

    DreamAI.Router.register({
        id: 'chat',
        group: 'create',
        labelKey: 'nav.chat',
        glyph: '◌',
        order: 40,
        build: function (W) {
            var history = [];
            var sending = false;
            var includeSelection = true;

            var scroll = el('div', { class: 'chat-scroll' });
            var inputArea = W.textarea({
                placeholderKey: 'chat.placeholder',
                rows: 3,
                onEnter: function () { send(); }
            });
            var sendBtn = W.button('chat.send', { variant: 'primary', glyph: '➤', onClick: send });
            var clearBtn = W.button('chat.clear', { variant: 'ghost', onClick: clearChat });
            var toWorkbenchBtn = W.button('chat.toWorkbench', { variant: 'ghost', glyph: '◇', onClick: toWorkbench });
            var readSelectionBtn = W.miniButton('selection.read', { onClick: readSelection });
            var selectionInfo = el('div', { class: 'field-hint', text: W.t('selection.none'), 'data-i18n': 'selection.none' });
            var selectionCheck = W.checkbox('chat.contextOn', true, {
                onChange: function (checked) { includeSelection = checked; }
            });
            var providerSelect = W.select([], '', {
                placeholderKey: 'field.provider',
                onChange: function () {
                    restoreChatModel();
                    loadHistory();
                }
            });
            var modelSelect = W.select([], '', { placeholderKey: 'field.modelAuto' });

            var chatCard = W.card('chat.title', { extra: el('div', { class: 'inline' }, [clearBtn]) }, null);
            chatCard.cardBody.appendChild(scroll);
            chatCard.cardBody.appendChild(inputArea);
            chatCard.cardBody.appendChild(el('div', { class: 'inline', style: { justifyContent: 'space-between' } }, [
                el('div', { class: 'inline' }, [selectionCheck, readSelectionBtn]),
                el('div', { class: 'inline' }, [toWorkbenchBtn, sendBtn])
            ]));
            chatCard.cardBody.appendChild(selectionInfo);

            var configCard = W.card('field.provider', { persistKey: 'chat-config', collapsed: true }, null);
            configCard.cardBody.appendChild(W.row('field.provider', providerSelect));
            configCard.cardBody.appendChild(W.row('field.model', modelSelect));

            var page = W.page('chat.title', { id: 'chat' });
            page.appendChild(chatCard);
            page.appendChild(configCard);

            function refreshProviders() {
                var providers = DreamAI.Providers ? DreamAI.Providers.list() : [];
                var list = providers.filter(function (p) { return p.supports && p.supports.chat; });
                var items = list.map(function (p) { return { value: p.id, labelKey: p.labelKey, label: p.id }; });
                providerSelect.setItems(items, true);
                var preferred = DreamAI.App.get('settings.activeChatChannelId', '');
                var found = items.some(function (i) { return i.value === preferred; });
                providerSelect.setValue(found ? preferred : (items.length ? items[0].value : ''), true);
            }

            function currentProvider() {
                var id = providerSelect.getValue();
                return DreamAI.Providers ? DreamAI.Providers.get(id) : null;
            }

            function restoreChatModel() {
                var id = providerSelect.getValue();
                var provider = DreamAI.Providers ? DreamAI.Providers.get(id) : null;
                var configured = DreamAI.App.get('settings.channels.' + id + '.chatModel', '');
                var fallback = provider && provider.defaultChatModel ? provider.defaultChatModel : '';
                var candidates = [configured, fallback].filter(Boolean);
                var items = candidates.map(function (v) { return { value: v, label: v }; });
                modelSelect.setItems(items, true);
                modelSelect.setValue(candidates.length ? candidates[0] : '', true);
            }

            function readSelection() {
                if (!DreamAI.PhotoIO || !DreamAI.PhotoIO.isAvailable()) {
                    DreamAI.Shell.toast('selection.browserOnly', { tone: 'warn' });
                    return Promise.resolve(null);
                }
                DreamAI.Shell.status('selection.reading', { key: 'selection.reading', tone: 'busy' });
                return DreamAI.PhotoIO.readSelection().then(function (sample) {
                    selectionInfo.textContent = W.t('selection.info', { w: sample.width, h: sample.height });
                    return sample;
                }, function () {
                    DreamAI.Shell.toast('selection.empty', { tone: 'warn' });
                    return null;
                });
            }

            function refreshSelectionInfo() {
                var selection = DreamAI.App.selection;
                if (selection) {
                    selectionInfo.textContent = W.t('selection.info', { w: selection.width, h: selection.height });
                } else {
                    selectionInfo.textContent = W.t('selection.none');
                }
            }

            function renderHistory() {
                util.clear(scroll);
                if (!history.length) {
                    scroll.appendChild(W.empty('◌', 'chat.empty'));
                    return;
                }
                for (var i = 0; i < history.length; i++) {
                    scroll.appendChild(buildBubble(history[i]));
                }
                scroll.scrollTop = scroll.scrollHeight;
            }

            function buildBubble(message) {
                var isUser = message.role === 'user';
                return el('div', { class: 'chat-bubble', dataset: { role: isUser ? 'user' : 'assistant' } }, [
                    el('div', { text: message.content || '' }),
                    el('div', {
                        class: 'chat-bubble-meta',
                        text: (isUser ? W.t('chat.roleUser') : W.t('chat.roleAssistant')) + ' · ' + formatTime(message.at)
                    })
                ]);
            }

            function formatTime(stamp) {
                var date = new Date(stamp || Date.now());
                return pad(date.getHours()) + ':' + pad(date.getMinutes());
            }

            function pad(v) { return v < 10 ? '0' + v : String(v); }

            function saveHistory() {
                DreamAI.Store.write('chat.history', { items: history.slice(-MAX_TURNS) });
            }

            function loadHistory() {
                var stored = DreamAI.Store.read('chat.history', { items: [] });
                history = Array.isArray(stored.items) ? stored.items.slice(-MAX_TURNS) : [];
                renderHistory();
            }

            function clearChat() {
                history = [];
                saveHistory();
                renderHistory();
            }

            function send() {
                if (sending) return;
                var text = (inputArea.value || '').trim();
                if (!text) {
                    DreamAI.Shell.toast('chat.needInput', { tone: 'warn' });
                    return;
                }
                var provider = currentProvider();
                if (!provider || typeof provider.chat !== 'function') {
                    DreamAI.Shell.toast('app.notConfigured', { tone: 'warn' });
                    return;
                }
                var selection = DreamAI.App.selection;
                history.push({ role: 'user', content: text, at: Date.now() });
                inputArea.value = '';
                renderHistory();
                saveHistory();

                sending = true;
                sendBtn.setAttribute('disabled', '');
                DreamAI.Shell.status('chat.thinking', { key: 'chat.thinking', tone: 'busy' });
                scroll.appendChild(el('div', { class: 'chat-bubble', dataset: { role: 'assistant' } }, [
                    el('div', { class: 'muted', text: W.t('chat.thinking') })
                ]));
                scroll.scrollTop = scroll.scrollHeight;

                var messages = buildMessages(includeSelection && selection ? selection : null);
                var ctx = DreamAI.Providers.createContext(provider.id);
                ctx.modelId = modelSelect.getValue() || ctx.modelId;

                Promise.resolve(provider.chat(ctx, { messages: messages, model: ctx.modelId }))
                    .then(function (result) {
                        var reply = result && result.text ? result.text : '';
                        history.push({ role: 'assistant', content: reply, at: Date.now() });
                        renderHistory();
                        saveHistory();
                        DreamAI.Shell.status('app.ready', { key: 'app.ready', tone: 'idle' });
                    }, function (error) {
                        renderHistory();
                        var reason = error && error.message ? error.message : String(error);
                        DreamAI.Shell.toast(reason, { tone: 'error' });
                        DreamAI.logbus.error('对话失败：' + reason, { domain: 'chat' });
                    })
                    .then(function () {
                        sending = false;
                        sendBtn.removeAttribute('disabled');
                    });
            }

            function buildMessages(selection) {
                var systemPositive = DreamAI.App.get('settings.chatSystemPrompt.positive', '');
                var systemNegative = DreamAI.App.get('settings.chatSystemPrompt.negative', '');
                var system = [systemPositive, systemNegative].filter(Boolean).join('\n');
                var messages = [];
                if (system) messages.push({ role: 'system', content: system });
                for (var i = 0; i < history.length; i++) {
                    var entry = history[i];
                    if (i === history.length - 1 && entry.role === 'user' && selection) {
                        // 把选区画面作为图片上下文一并交给支持视觉的模型
                        messages.push({
                            role: 'user',
                            content: [
                                { type: 'text', text: entry.content },
                                { type: 'image_url', image_url: { url: selection.dataUrl } }
                            ]
                        });
                    } else {
                        messages.push({ role: entry.role, content: entry.content });
                    }
                }
                return messages;
            }

            function toWorkbench() {
                var last = null;
                for (var i = history.length - 1; i >= 0; i--) {
                    if (history[i].role === 'assistant') { last = history[i]; break; }
                }
                if (!last) {
                    DreamAI.Shell.toast('chat.empty', { tone: 'warn' });
                    return;
                }
                DreamAI.App.saveWorkbench({ prompt: last.content });
                DreamAI.Shell.toast('chat.sentToWorkbench', { tone: 'ok' });
                DreamAI.Router.activate('workbench');
            }

            return {
                el: page,
                mount: function () {
                    refreshProviders();
                    restoreChatModel();
                    loadHistory();
                    refreshSelectionInfo();
                },
                refresh: function () { refreshSelectionInfo(); }
            };
        }
    });
})(typeof window !== 'undefined' ? window : this);
