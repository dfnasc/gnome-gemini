/* extension.js
 *
 * Gnome Gemini - AI Assistant extension for GNOME Shell.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { GeminiApiClient } from './geminiApi.js';
import { markdownToPango } from './md2pango.js';

const GnomeGeminiIndicator = GObject.registerClass(
class GnomeGeminiIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Gnome Gemini'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._apiClient = new GeminiApiClient();
        this._history = [];
        this._isLoading = false;

        // Top bar indicator layout
        const topHbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box gemini-panel-button',
        });
        const icon = new St.Icon({
            icon_name: 'starred-symbolic',
            style_class: 'system-status-icon gemini-panel-icon',
        });
        topHbox.add_child(icon);

        const label = new St.Label({
            text: 'Gemini',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold; margin-left: 4px;',
        });
        topHbox.add_child(label);

        this.add_child(topHbox);

        // Build popup menu
        this._buildMenu();

        // Listen for model change in settings
        this._settingsChangedId = this._settings.connect('changed::model', () => {
            this._updateModelBadge();
        });
    }

    _buildMenu() {
        const menuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            hover: false,
            activate: false,
        });

        const mainBox = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-chat-container',
        });

        // 1. Header Box
        const headerBox = new St.BoxLayout({
            style_class: 'gemini-header-box',
            vertical: false,
        });

        const titleLabel = new St.Label({
            text: 'Gnome Gemini',
            style_class: 'gemini-title-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(titleLabel);

        this._modelBadge = new St.Label({
            text: this._settings.get_string('model') || 'gemini-2.5-flash',
            style_class: 'gemini-model-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(this._modelBadge);

        const spacer = new St.Widget({
            x_expand: true,
        });
        headerBox.add_child(spacer);

        // Clear / New chat button
        const clearBtn = new St.Button({
            style_class: 'gemini-icon-button',
            child: new St.Icon({
                icon_name: 'edit-clear-symbolic',
                icon_size: 16,
            }),
            can_focus: true,
        });
        clearBtn.connect('clicked', () => {
            this._clearChat();
        });
        headerBox.add_child(clearBtn);

        // Settings button
        const settingsBtn = new St.Button({
            style_class: 'gemini-icon-button',
            child: new St.Icon({
                icon_name: 'preferences-system-symbolic',
                icon_size: 16,
            }),
            can_focus: true,
        });
        settingsBtn.connect('clicked', () => {
            this.menu.close();
            this._extension.openSettings();
        });
        headerBox.add_child(settingsBtn);

        mainBox.add_child(headerBox);

        // 2. Chat Scroll View & Messages Box
        this._scrollView = new St.ScrollView({
            style_class: 'gemini-scroll-view',
            enable_mouse_scrolling: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });

        this._messagesBox = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-messages-box',
            x_expand: true,
        });
        this._scrollView.set_child(this._messagesBox);
        mainBox.add_child(this._scrollView);

        // 3. Input Row
        const inputRow = new St.BoxLayout({
            style_class: 'gemini-input-row',
            vertical: false,
        });

        this._entry = new St.Entry({
            style_class: 'gemini-input-entry',
            hint_text: _('Pergunte algo ao Gemini... (Enter para enviar)'),
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => {
            this._handleSend();
        });
        inputRow.add_child(this._entry);

        this._sendButton = new St.Button({
            style_class: 'gemini-send-button',
            child: new St.Icon({
                icon_name: 'mail-send-symbolic',
                icon_size: 16,
            }),
            can_focus: true,
        });
        this._sendButton.connect('clicked', () => {
            this._handleSend();
        });
        inputRow.add_child(this._sendButton);

        mainBox.add_child(inputRow);

        menuItem.add_child(mainBox);
        this.menu.addMenuItem(menuItem);

        // Focus input when popup opens
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                    if (global.stage) {
                        global.stage.set_key_focus(this._entry);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        // Show welcome view initially
        this._showWelcomeView();
    }

    _updateModelBadge() {
        if (this._modelBadge) {
            this._modelBadge.text = this._settings.get_string('model') || 'gemini-2.5-flash';
        }
    }

    _showWelcomeView() {
        this._messagesBox.remove_all_children();
        this._isWelcomeState = true;

        const welcomeBox = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-welcome-box',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        const icon = new St.Icon({
            icon_name: 'starred-symbolic',
            style_class: 'gemini-welcome-icon',
        });
        welcomeBox.add_child(icon);

        const title = new St.Label({
            text: _('Como posso ajudar hoje?'),
            style_class: 'gemini-welcome-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        welcomeBox.add_child(title);

        const subtitle = new St.Label({
            text: _('Pergunte sobre código, ideias, resumos ou comandos do sistema.'),
            style_class: 'gemini-welcome-subtitle',
            x_align: Clutter.ActorAlign.CENTER,
        });
        subtitle.clutter_text.line_wrap = true;
        welcomeBox.add_child(subtitle);

        // Suggestion Chips
        const suggestionsBox = new St.BoxLayout({
            vertical: true,
            style: 'margin-top: 14px;',
            x_align: Clutter.ActorAlign.CENTER,
        });

        const suggestions = [
            _('💡 Explique o que é o GNOME Shell'),
            _('🐧 Comando bash para monitorar uso de memória'),
            _('✍️ Escreva um script em Python para renomear arquivos'),
        ];

        suggestions.forEach(text => {
            const btn = new St.Button({
                style_class: 'gemini-suggestion-chip',
                label: text,
                can_focus: true,
            });
            btn.connect('clicked', () => {
                const cleanText = text.replace(/^[^\s]+\s*/, '');
                this._entry.set_text(cleanText);
                this._handleSend();
            });
            suggestionsBox.add_child(btn);
        });

        welcomeBox.add_child(suggestionsBox);
        this._messagesBox.add_child(welcomeBox);
    }

    _scrollToBottom() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const vscroll = this._scrollView.get_vscroll_bar();
            if (vscroll) {
                const adj = vscroll.get_adjustment();
                if (adj) {
                    adj.set_value(adj.get_upper() - adj.get_page_size());
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearChat() {
        this._apiClient.cancelCurrentRequest();
        this._history = [];
        this._isLoading = false;
        this._sendButton.reactive = true;
        this._showWelcomeView();
    }

    _addUserMessage(text) {
        if (this._isWelcomeState) {
            this._messagesBox.remove_all_children();
            this._isWelcomeState = false;
        }

        const wrapper = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-message-wrapper gemini-message-wrapper-user',
            x_align: Clutter.ActorAlign.END,
        });

        const bubble = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-user-bubble',
        });

        const label = new St.Label({
            text: text,
            style_class: 'gemini-text-label',
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        bubble.add_child(label);

        wrapper.add_child(bubble);
        this._messagesBox.add_child(wrapper);
        this._scrollToBottom();
    }

    _addModelMessage(markdownText) {
        const wrapper = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-message-wrapper gemini-message-wrapper-model',
            x_align: Clutter.ActorAlign.START,
        });

        const bubble = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-model-bubble',
        });

        // Bubble Header
        const header = new St.BoxLayout({
            style_class: 'gemini-model-header',
            vertical: false,
        });

        const icon = new St.Icon({
            icon_name: 'starred-symbolic',
            icon_size: 14,
            style: 'color: #78aeed;',
        });
        header.add_child(icon);

        const nameLabel = new St.Label({
            text: 'Gemini',
            style_class: 'gemini-sender-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(nameLabel);

        const spacer = new St.Widget({ x_expand: true });
        header.add_child(spacer);

        // Copy button
        const copyBtn = new St.Button({
            style_class: 'gemini-copy-button',
            label: _('Copiar'),
            can_focus: true,
        });
        copyBtn.connect('clicked', () => {
            const clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, markdownText);
            copyBtn.label = _('✓ Copiado!');
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                copyBtn.label = _('Copiar');
                return GLib.SOURCE_REMOVE;
            });
        });
        header.add_child(copyBtn);

        bubble.add_child(header);

        // Text label with Pango markup
        const label = new St.Label({
            style_class: 'gemini-text-label',
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.set_markup(markdownToPango(markdownText));
        bubble.add_child(label);

        wrapper.add_child(bubble);
        this._messagesBox.add_child(wrapper);
        this._scrollToBottom();
    }

    _showLoadingIndicator() {
        this._loadingWrapper = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-message-wrapper gemini-message-wrapper-model',
            x_align: Clutter.ActorAlign.START,
        });

        const loadingBox = new St.BoxLayout({
            style_class: 'gemini-loading-box',
            vertical: false,
        });

        const icon = new St.Icon({
            icon_name: 'starred-symbolic',
            icon_size: 14,
            style: 'color: #78aeed;',
        });
        loadingBox.add_child(icon);

        const label = new St.Label({
            text: _('Gemini está pensando...'),
            style_class: 'gemini-loading-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        loadingBox.add_child(label);

        this._loadingWrapper.add_child(loadingBox);
        this._messagesBox.add_child(this._loadingWrapper);
        this._scrollToBottom();
    }

    _hideLoadingIndicator() {
        if (this._loadingWrapper) {
            this._messagesBox.remove_child(this._loadingWrapper);
            this._loadingWrapper.destroy();
            this._loadingWrapper = null;
        }
    }

    _addErrorBubble(message, showSettings = false) {
        if (this._isWelcomeState) {
            this._messagesBox.remove_all_children();
            this._isWelcomeState = false;
        }

        const wrapper = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-message-wrapper gemini-message-wrapper-model',
            x_align: Clutter.ActorAlign.START,
        });

        const bubble = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-error-bubble',
        });

        const label = new St.Label({
            text: message,
            style_class: 'gemini-error-text',
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        bubble.add_child(label);

        if (showSettings) {
            const btn = new St.Button({
                style_class: 'gemini-action-button',
                label: _('Configurar Chave de API'),
                can_focus: true,
                style: 'margin-top: 6px;',
            });
            btn.connect('clicked', () => {
                this.menu.close();
                this._extension.openSettings();
            });
            bubble.add_child(btn);
        }

        wrapper.add_child(bubble);
        this._messagesBox.add_child(wrapper);
        this._scrollToBottom();
    }

    async _handleSend() {
        if (this._isLoading) {
            return;
        }

        const text = this._entry.get_text()?.trim();
        if (!text) {
            return;
        }

        this._entry.set_text('');
        this._addUserMessage(text);

        const apiKey = this._settings.get_string('api-key');
        if (!apiKey || apiKey.trim() === '') {
            this._addErrorBubble(_('A chave da API do Gemini não está configurada.'), true);
            return;
        }

        const model = this._settings.get_string('model') || 'gemini-2.5-flash';
        const rememberHistory = this._settings.get_boolean('remember-history');
        const systemInstruction = this._settings.get_string('system-instruction');
        const temperature = this._settings.get_double('temperature') || 0.7;

        this._isLoading = true;
        this._sendButton.reactive = false;
        this._showLoadingIndicator();

        const currentPrompt = {
            role: 'user',
            parts: [{ text: text }],
        };

        const contents = rememberHistory ? [...this._history, currentPrompt] : [currentPrompt];

        try {
            const reply = await this._apiClient.generateContent({
                apiKey: apiKey.trim(),
                model: model.trim(),
                contents: contents,
                systemInstruction: systemInstruction,
                temperature: temperature,
            });

            this._hideLoadingIndicator();
            this._addModelMessage(reply);

            if (rememberHistory) {
                this._history.push(currentPrompt);
                this._history.push({
                    role: 'model',
                    parts: [{ text: reply }],
                });
            }
        } catch (error) {
            this._hideLoadingIndicator();
            const isApiKeyError = error.message.includes('chave') || error.message.includes('API key');
            this._addErrorBubble(error.message, isApiKeyError);
        } finally {
            this._isLoading = false;
            this._sendButton.reactive = true;
            if (global.stage) {
                global.stage.set_key_focus(this._entry);
            }
        }
    }

    destroy() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._apiClient) {
            this._apiClient.cancelCurrentRequest();
        }
        super.destroy();
    }
});

export default class GnomeGeminiExtension extends Extension {
    enable() {
        this._indicator = new GnomeGeminiIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
