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
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import { GeminiApiClient } from './geminiApi.js';
import { markdownToPango } from './md2pango.js';
import { getSystemInfo, buildSystemInstruction } from './systemInfo.js';
import { parseResponseSegments } from './commandParser.js';
import { CommandExecutor } from './commandExecutor.js';

const GeminiCenterDialog = GObject.registerClass(
class GeminiCenterDialog extends ModalDialog.ModalDialog {
    _init(indicator) {
        super._init({
            styleClass: 'gemini-center-dialog-overlay',
            destroyOnClose: false,
            shellReactive: false,
        });

        this._indicator = indicator;
        this._chatWidget = null;

        // Hide default button box since we use custom controls in the chat UI
        this.dialogLayout.buttonLayout.hide();

        // Allow dialog and content box to expand freely
        this.dialogLayout._dialog.add_style_class_name('gemini-modal-dialog');
        this.contentLayout.add_style_class_name('gemini-modal-content');
        this.contentLayout.x_expand = true;
        this.contentLayout.y_expand = true;

        // Close on clicking backdrop outside dialog
        this.connect('button-press-event', (_actor, event) => {
            const target = event.get_source();
            if (this.dialogLayout._dialog && !this.dialogLayout._dialog.contains(target)) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            if (this.isOpen)
                this._updateSize();
        });
    }

    setChatWidget(widget) {
        if (this._chatWidget === widget)
            return;

        if (this._chatWidget && this._chatWidget.get_parent() === this.contentLayout) {
            this.contentLayout.remove_child(this._chatWidget);
        }

        this._chatWidget = widget;
        if (widget) {
            this.contentLayout.add_child(widget);
            widget.x_expand = true;
            widget.y_expand = true;
        }
    }

    removeChatWidget() {
        if (this._chatWidget && this._chatWidget.get_parent() === this.contentLayout) {
            this.contentLayout.remove_child(this._chatWidget);
            this._chatWidget = null;
        }
    }

    vfunc_key_press_event(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        // Close on Alt+G if pressed while dialog is focused
        const state = event.get_state();
        const isAlt = (state & Clutter.ModifierType.MOD1_MASK) || (state & Clutter.ModifierType.ALT_MASK);
        if (isAlt && (symbol === Clutter.KEY_g || symbol === Clutter.KEY_G)) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        return super.vfunc_key_press_event(event);
    }

    _updateSize() {
        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const targetWidth = Math.max(480, Math.round(monitor.width * 0.8));
        const targetHeight = Math.max(400, Math.round(monitor.height * 0.8));

        this.dialogLayout._dialog.set_width(targetWidth);
        this.dialogLayout._dialog.set_height(targetHeight);
    }

    open() {
        this._updateSize();
        const opened = super.open();
        if (opened) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                this._indicator?.focusInput();
                return GLib.SOURCE_REMOVE;
            });
        }
        return opened;
    }

    get isOpen() {
        return this.state === ModalDialog.State.OPENED || this.state === ModalDialog.State.OPENING;
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    destroy() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        this.removeChatWidget();
        super.destroy();
    }
});

const GnomeGeminiIndicator = GObject.registerClass(
class GnomeGeminiIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, _('Gnome Gemini'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._apiClient = new GeminiApiClient();
        this._history = [];
        this._isLoading = false;
        this._isDestroyed = false;
        this._activeCommandCancellables = new Set();
        this._requestTimestamps = [];

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

        // Center dialog instance
        this._centerDialog = new GeminiCenterDialog(this);
        this._centerDialog.connect('opened', () => {
            this.add_style_pseudo_class('active');
        });
        this._centerDialog.connect('closed', () => {
            this.remove_style_pseudo_class('active');
        });

        // Intercept menu.toggle so panel button clicks respect popup-position
        this.menu.toggle = () => {
            this.toggle();
        };

        // Build popup menu
        this._buildMenu();

        // Keyboard shortcuts
        this._bindShortcuts();

        // Listen for settings changes
        this._settingsChangedId = this._settings.connect('changed::model', () => {
            this._updateModelBadge();
        });

        this._positionChangedId = this._settings.connect('changed::popup-position', () => {
            this._updatePopupPlacement();
        });

        this._shortcutChangedId = this._settings.connect('changed::toggle-shortcut', () => {
            this._bindShortcuts();
        });

        // Apply initial placement
        this._updatePopupPlacement();
    }

    _buildMenu() {
        this._menuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            hover: false,
            activate: false,
        });

        this._chatContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-chat-container gemini-chat-corner',
            x_expand: true,
            y_expand: true,
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
            text: this._settings.get_string('model') || 'gemini-3.8-flash',
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
            this.close();
            this._openPreferences();
        });
        headerBox.add_child(settingsBtn);

        // Close button
        const closeBtn = new St.Button({
            style_class: 'gemini-icon-button',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 16,
            }),
            can_focus: true,
        });
        closeBtn.connect('clicked', () => {
            this.close();
        });
        headerBox.add_child(closeBtn);

        this._chatContainer.add_child(headerBox);

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
        this._chatContainer.add_child(this._scrollView);

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

        this._chatContainer.add_child(inputRow);

        this._rateLimitsBox = new St.BoxLayout({
            style_class: 'gemini-rate-limits-box',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.END,
        });

        this._tokensLabel = new St.Label({
            text: 'Tokens: 0 / 1M',
            style_class: 'gemini-rate-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._tokensProgressBg = new St.BoxLayout({
            style_class: 'gemini-rate-progress-bg',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._tokensProgressBar = new St.BoxLayout({
            style_class: 'gemini-rate-progress-bar',
        });
        
        // Use set_width on the progress bar later. Initially 0%
        this._tokensProgressBar.set_width(0);

        this._tokensProgressBg.add_child(this._tokensProgressBar);

        this._rateLimitsBox.add_child(this._tokensLabel);
        this._rateLimitsBox.add_child(this._tokensProgressBg);

        
        // Add RPM bar
        this._requestsLabel = new St.Label({
            text: 'Requests (min): 0 / 15',
            style_class: 'gemini-rate-label',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 12px;'
        });

        this._requestsProgressBg = new St.BoxLayout({
            style_class: 'gemini-rate-progress-bg',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._requestsProgressBar = new St.BoxLayout({
            style_class: 'gemini-rate-progress-bar',
        });
        this._requestsProgressBar.set_width(0);
        this._requestsProgressBg.add_child(this._requestsProgressBar);

        this._rateLimitsBox.add_child(this._requestsLabel);
        this._rateLimitsBox.add_child(this._requestsProgressBg);
        
        this._chatContainer.add_child(this._rateLimitsBox);


        this._menuItem.add_child(this._chatContainer);
        this.menu.addMenuItem(this._menuItem);

        // Focus input when popup opens
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                    this.focusInput();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        // Show welcome view initially
        this._showWelcomeView();
    }

    _updatePopupPlacement() {
        const position = this._settings.get_string('popup-position') || 'corner';

        if (position === 'center') {
            if (this.menu.isOpen)
                this.menu.close();

            if (this._chatContainer.get_parent() === this._menuItem) {
                this._menuItem.remove_child(this._chatContainer);
            }
            this._centerDialog.setChatWidget(this._chatContainer);

            this._chatContainer.remove_style_class_name('gemini-chat-corner');
            this._chatContainer.add_style_class_name('gemini-chat-center');
        } else {
            if (this._centerDialog.isOpen)
                this._centerDialog.close();

            this._centerDialog.removeChatWidget();
            if (this._chatContainer.get_parent() !== this._menuItem) {
                this._menuItem.add_child(this._chatContainer);
            }

            this._chatContainer.remove_style_class_name('gemini-chat-center');
            this._chatContainer.add_style_class_name('gemini-chat-corner');
        }
    }

    toggle() {
        const position = this._settings.get_string('popup-position') || 'corner';
        if (position === 'center') {
            if (this.menu?.isOpen)
                this.menu.close();
            this._centerDialog?.toggle();
        } else {
            if (this._centerDialog?.isOpen)
                this._centerDialog.close();
            if (this.menu?.isOpen)
                this.menu.close();
            else
                this.menu?.open();
        }
    }

    close() {
        if (this.menu?.isOpen)
            this.menu.close();
        if (this._centerDialog?.isOpen)
            this._centerDialog.close();
    }

    focusInput() {
        if (global.stage && this._entry && !this._isDestroyed) {
            global.stage.set_key_focus(this._entry);
        }
    }

    _bindShortcuts() {
        this._unbindShortcuts();

        try {
            Main.wm.addKeybinding(
                'toggle-shortcut',
                this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.ALL,
                () => {
                    this.toggle();
                }
            );
        } catch (e) {
            console.error(`GnomeGemini: Erro ao registrar atalho: ${e.message || e}`);
        }
    }

    _unbindShortcuts() {
        try {
            Main.wm.removeKeybinding('toggle-shortcut');
        } catch (_) {}
    }

    _openPreferences() {
        try {
            if (typeof this._extension.openPreferences === 'function') {
                this._extension.openPreferences();
                return;
            }
        } catch (e) {
            console.error(`GnomeGemini: Erro ao abrir preferências com openPreferences(): ${e.message || e}`);
        }

        try {
            Gio.Subprocess.new(
                ['gnome-extensions', 'prefs', this._extension.uuid],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            console.error(`GnomeGemini: Erro ao executar fallback gnome-extensions prefs: ${e.message || e}`);
        }
    }

    _updateModelBadge() {
        if (this._modelBadge) {
            this._modelBadge.text = this._settings.get_string('model') || 'gemini-3.8-flash';
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

    _updateRateLimitsUI(usageMetadata) {
        const now = Date.now();
        this._requestTimestamps.push(now);
        this._requestTimestamps = this._requestTimestamps.filter(t => now - t < 60000);
        
        const reqCount = this._requestTimestamps.length;
        const reqLimit = 15;
        const reqPercentage = Math.min(100, Math.max(0, (reqCount / reqLimit) * 100));
        this._requestsLabel.set_text(`Req/min: ${reqCount} / ${reqLimit}`);
        this._requestsProgressBar.set_style(`width: ${Math.max(1, Math.round(reqPercentage))}px;`);

        if (usageMetadata) {
            const total = usageMetadata.totalTokenCount || 0;
            const limit = 1000000;
            const percentage = Math.min(100, Math.max(0, (total / limit) * 100));
            
            let formattedTotal = total;
            if (total >= 1000000) {
                formattedTotal = (total / 1000000).toFixed(1) + 'M';
            } else if (total >= 1000) {
                formattedTotal = (total / 1000).toFixed(1) + 'k';
            }
            
            this._tokensLabel.set_text(`Tokens: ${formattedTotal} / 1M`);
            this._tokensProgressBar.set_style(`width: ${Math.max(1, Math.round(percentage))}px;`);
        }
    }

    _scrollToBottom() {
        if (this._isDestroyed)
            return;

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._isDestroyed || !this._scrollView)
                return GLib.SOURCE_REMOVE;
            try {
                const adj = this._scrollView?.vadjustment ?? this._scrollView?.get_vadjustment?.();
                if (adj) {
                    adj.set_value(Math.max(0, adj.get_upper() - adj.get_page_size()));
                }
            } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearChat() {
        this._apiClient.cancelCurrentRequest();
        for (const cancellable of this._activeCommandCancellables) {
            if (!cancellable.is_cancelled()) {
                cancellable.cancel();
            }
        }
        this._activeCommandCancellables.clear();
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

        const hbox = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const retryBtn = new St.Button({
            style_class: 'gemini-icon-button gemini-retry-button',
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                icon_size: 16,
            }),
            can_focus: true,
            visible: false,
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

        hbox.add_child(retryBtn);
        hbox.add_child(bubble);
        wrapper.add_child(hbox);
        this._messagesBox.add_child(wrapper);
        this._scrollToBottom();

        return { wrapper, retryBtn, text };
    }

    _createCommandCard(segment) {
        const card = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-command-card',
            x_expand: true,
        });

        // 1. Header Row: Left (icon + description/title), Right (buttons: Copiar, Executar)
        const headerRow = new St.BoxLayout({
            vertical: false,
            style_class: 'gemini-command-header-row',
            x_expand: true,
        });

        const leftBox = new St.BoxLayout({
            vertical: false,
            style_class: 'gemini-command-header-left',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        const terminalIcon = new St.Icon({
            icon_name: 'utilities-terminal-symbolic',
            icon_size: 14,
            style_class: 'gemini-command-icon',
        });
        leftBox.add_child(terminalIcon);

        const descText = segment.description && segment.description.trim()
            ? segment.description.trim()
            : _('Comando sugerido');

        const descLabel = new St.Label({
            text: descText,
            style_class: 'gemini-command-desc-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        descLabel.clutter_text.line_wrap = true;
        descLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        leftBox.add_child(descLabel);

        headerRow.add_child(leftBox);

        // Buttons Box (Copiar & Executar side-by-side)
        const buttonsBox = new St.BoxLayout({
            vertical: false,
            style_class: 'gemini-command-actions',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Button: Copiar
        const copyBtn = new St.Button({
            style_class: 'gemini-command-btn gemini-command-btn-copy',
            can_focus: true,
        });
        const copyContent = new St.BoxLayout({
            vertical: false,
            style_class: 'gemini-btn-content',
        });
        const copyIcon = new St.Icon({
            icon_name: 'edit-copy-symbolic',
            icon_size: 12,
        });
        const copyLabel = new St.Label({
            text: _('Copiar'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        copyContent.add_child(copyIcon);
        copyContent.add_child(copyLabel);
        copyBtn.set_child(copyContent);

        copyBtn.connect('clicked', () => {
            const clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, segment.command);
            copyLabel.text = _('✓ Copiado!');
            copyIcon.icon_name = 'emblem-ok-symbolic';
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                if (!this._isDestroyed) {
                    copyLabel.text = _('Copiar');
                    copyIcon.icon_name = 'edit-copy-symbolic';
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        buttonsBox.add_child(copyBtn);

        // Button: Executar
        const execBtn = new St.Button({
            style_class: 'gemini-command-btn gemini-command-btn-exec',
            can_focus: true,
        });
        const execContent = new St.BoxLayout({
            vertical: false,
            style_class: 'gemini-btn-content',
        });
        const execIcon = new St.Icon({
            icon_name: 'system-run-symbolic',
            icon_size: 12,
        });
        const execLabel = new St.Label({
            text: _('Executar'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        execContent.add_child(execIcon);
        execContent.add_child(execLabel);
        execBtn.set_child(execContent);
        buttonsBox.add_child(execBtn);

        headerRow.add_child(buttonsBox);
        card.add_child(headerRow);

        // 2. Command Code Block Box ($ command)
        const codeBox = new St.BoxLayout({
            vertical: false,
            style_class: 'gemini-command-code-box',
            x_expand: true,
        });

        const promptLabel = new St.Label({
            text: '$ ',
            style_class: 'gemini-command-prompt-symbol',
            y_align: Clutter.ActorAlign.START,
        });
        codeBox.add_child(promptLabel);

        const cmdLabel = new St.Label({
            text: segment.command,
            style_class: 'gemini-command-code-text',
            x_expand: true,
        });
        cmdLabel.clutter_text.line_wrap = true;
        cmdLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        cmdLabel.clutter_text.selectable = true;
        codeBox.add_child(cmdLabel);

        card.add_child(codeBox);

        // 3. Execution Feedback Area (dynamic)
        const feedbackBox = new St.BoxLayout({
            vertical: true,
            style_class: 'gemini-command-feedback-box',
            visible: false,
            x_expand: true,
        });
        card.add_child(feedbackBox);

        let runningCancellable = null;

        execBtn.connect('clicked', async () => {
            if (runningCancellable) {
                return;
            }

            runningCancellable = new Gio.Cancellable();
            this._activeCommandCancellables.add(runningCancellable);

            execBtn.reactive = false;
            execLabel.text = _('Executando...');
            execIcon.icon_name = 'process-working-symbolic';
            execBtn.add_style_class_name('gemini-command-btn-running');

            feedbackBox.remove_all_children();
            feedbackBox.visible = true;

            // Running status bar with Cancel button
            const runningRow = new St.BoxLayout({
                vertical: false,
                style_class: 'gemini-feedback-status-row gemini-feedback-running',
                x_expand: true,
            });
            const spinIcon = new St.Icon({
                icon_name: 'process-working-symbolic',
                icon_size: 14,
            });
            runningRow.add_child(spinIcon);

            const runningStatus = new St.Label({
                text: _('Executando comando no sistema em background...'),
                style_class: 'gemini-feedback-status-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            runningRow.add_child(runningStatus);

            const cancelSpacer = new St.Widget({ x_expand: true });
            runningRow.add_child(cancelSpacer);

            const cancelBtn = new St.Button({
                style_class: 'gemini-command-cancel-btn',
                label: _('Cancelar'),
                can_focus: true,
            });
            cancelBtn.connect('clicked', () => {
                if (runningCancellable && !runningCancellable.is_cancelled()) {
                    runningCancellable.cancel();
                }
            });
            runningRow.add_child(cancelBtn);

            feedbackBox.add_child(runningRow);
            this._scrollToBottom();

            // Run in background via CommandExecutor
            const result = await CommandExecutor.run(segment.command, runningCancellable);

            this._activeCommandCancellables.delete(runningCancellable);
            runningCancellable = null;

            if (this._isDestroyed)
                return;

            // Reset execute button
            execBtn.reactive = true;
            execLabel.text = _('Executar novamente');
            execIcon.icon_name = 'system-run-symbolic';
            execBtn.remove_style_class_name('gemini-command-btn-running');

            // Clear running status
            feedbackBox.remove_all_children();

            // Status Header
            const statusRow = new St.BoxLayout({
                vertical: false,
                style_class: result.success
                    ? 'gemini-feedback-status-row gemini-feedback-success'
                    : 'gemini-feedback-status-row gemini-feedback-error',
                x_expand: true,
            });

            const statusIcon = new St.Icon({
                icon_name: result.success ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
                icon_size: 14,
                style_class: 'gemini-feedback-icon',
            });
            statusRow.add_child(statusIcon);

            let statusText = '';
            if (result.isCancelled) {
                statusText = _('Execução cancelada pelo usuário.');
            } else if (result.success) {
                statusText = _(`Sucesso (código ${result.exitCode} • ${result.durationMs}ms)`);
            } else {
                statusText = result.error
                    ? _(`Erro: ${result.error}`)
                    : _(`Falha na execução (código ${result.exitCode} • ${result.durationMs}ms)`);
            }

            const statusLabel = new St.Label({
                text: statusText,
                style_class: 'gemini-feedback-status-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            statusRow.add_child(statusLabel);

            const statusSpacer = new St.Widget({ x_expand: true });
            statusRow.add_child(statusSpacer);

            // Copy output button (if there is output)
            const hasOutput = (result.stdout && result.stdout.trim().length > 0) ||
                              (result.stderr && result.stderr.trim().length > 0);

            if (hasOutput) {
                const copyOutBtn = new St.Button({
                    style_class: 'gemini-command-copy-out-btn',
                    label: _('Copiar saída'),
                    can_focus: true,
                });
                copyOutBtn.connect('clicked', () => {
                    const fullOut = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
                    const clipboard = St.Clipboard.get_default();
                    clipboard.set_text(St.ClipboardType.CLIPBOARD, fullOut);
                    copyOutBtn.label = _('✓ Copiado!');
                    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                        if (!this._isDestroyed) {
                            copyOutBtn.label = _('Copiar saída');
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                });
                statusRow.add_child(copyOutBtn);
            }

            feedbackBox.add_child(statusRow);

            // Output Display Box
            if (hasOutput) {
                const outContainer = new St.BoxLayout({
                    vertical: true,
                    style_class: 'gemini-feedback-output-container',
                    x_expand: true,
                });

                // Stdout
                if (result.stdout && result.stdout.trim().length > 0) {
                    const stdoutLabel = new St.Label({
                        style_class: 'gemini-terminal-output-text gemini-terminal-stdout',
                        x_expand: true,
                    });
                    stdoutLabel.clutter_text.set_text(result.stdout.trimEnd());
                    stdoutLabel.clutter_text.line_wrap = true;
                    stdoutLabel.clutter_text.line_wrap_mode = Pango.WrapMode.CHAR;
                    stdoutLabel.clutter_text.selectable = true;
                    outContainer.add_child(stdoutLabel);
                }

                // Stderr
                if (result.stderr && result.stderr.trim().length > 0) {
                    const stderrLabel = new St.Label({
                        style_class: 'gemini-terminal-output-text gemini-terminal-stderr',
                        x_expand: true,
                    });
                    stderrLabel.clutter_text.set_text(result.stderr.trimEnd());
                    stderrLabel.clutter_text.line_wrap = true;
                    stderrLabel.clutter_text.line_wrap_mode = Pango.WrapMode.CHAR;
                    stderrLabel.clutter_text.selectable = true;
                    outContainer.add_child(stderrLabel);
                }

                feedbackBox.add_child(outContainer);
            } else if (!result.isCancelled) {
                const noOutLabel = new St.Label({
                    text: _('(Comando executado sem saída de terminal)'),
                    style_class: 'gemini-feedback-empty-output',
                });
                feedbackBox.add_child(noOutLabel);
            }

            this._scrollToBottom();
        });

        return card;
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

        // Copy button for entire message
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
                if (!this._isDestroyed) {
                    copyBtn.label = _('Copiar');
                }
                return GLib.SOURCE_REMOVE;
            });
        });
        header.add_child(copyBtn);

        bubble.add_child(header);

        // Parse response for structured command suggestions
        const segments = parseResponseSegments(markdownText);
        for (const segment of segments) {
            if (segment.type === 'command') {
                const commandCard = this._createCommandCard(segment);
                bubble.add_child(commandCard);
            } else if (segment.content && segment.content.trim()) {
                const label = new St.Label({
                    style_class: 'gemini-text-label',
                });
                label.clutter_text.line_wrap = true;
                label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                label.clutter_text.set_markup(markdownToPango(segment.content));
                bubble.add_child(label);
            }
        }

        wrapper.add_child(bubble);
        this._messagesBox.add_child(wrapper);
        this._scrollToBottom();
        return wrapper;
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

    _addErrorBubble(message, showAction = false, actionLabel = _('Configurar Chave de API')) {
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

        if (showAction) {
            const btn = new St.Button({
                style_class: 'gemini-action-button',
                label: actionLabel,
                can_focus: true,
                style: 'margin-top: 6px;',
            });
            btn.connect('clicked', () => {
                this.menu.close();
                this._openPreferences();
            });
            bubble.add_child(btn);
        }

        wrapper.add_child(bubble);
        this._messagesBox.add_child(wrapper);
        this._scrollToBottom();
    }

    async _handleSend(forceText = null, oldWrapper = null, oldErrorBubble = null) {
        if (this._isLoading || this._isDestroyed) {
            return;
        }

        const text = typeof forceText === 'string' ? forceText : this._entry.get_text()?.trim();
        if (!text) {
            return;
        }

        if (oldWrapper) oldWrapper.destroy();
        if (oldErrorBubble) oldErrorBubble.destroy();

        if (typeof forceText !== 'string') {
            this._entry.set_text('');
        }
        
        const userMsgObj = this._addUserMessage(text);

        const apiKey = this._settings.get_string('api-key');
        if (!apiKey || apiKey.trim() === '') {
            const errBubble = this._addErrorBubble(_('A chave da API do Gemini não está configurada.'), true, _('Configurar Chave de API'));
            userMsgObj.retryBtn.show();
            userMsgObj.retryBtn.connect('clicked', () => {
                this._handleSend(userMsgObj.text, userMsgObj.wrapper, errBubble);
            });
            return;
        }

        const model = this._settings.get_string('model') || 'gemini-3.8-flash';
        const rememberHistory = this._settings.get_boolean('remember-history');
        const userSystemInstruction = this._settings.get_string('system-instruction') || '';
        const temperature = this._settings.get_double('temperature') || 0.7;

        const sysInfo = getSystemInfo({
            gnomeVersion: Config.PACKAGE_VERSION,
            extension: this._extension,
        });
        const systemInstruction = buildSystemInstruction(userSystemInstruction, sysInfo);

        this._isLoading = true;
        this._sendButton.reactive = false;
        this._showLoadingIndicator();

        const currentPrompt = {
            role: 'user',
            parts: [{ text: text }],
        };

        const contents = rememberHistory ? [...this._history, currentPrompt] : [currentPrompt];

        try {
            const replyObj = await this._apiClient.generateContent({
                apiKey: apiKey.trim(),
                model: model.trim(),
                contents: contents,
                systemInstruction: systemInstruction,
                temperature: temperature,
            });
            
            const reply = typeof replyObj === 'string' ? replyObj : (replyObj.text || '');

            if (this._isDestroyed)
                return;

            this._hideLoadingIndicator();
            this._addModelMessage(reply);

            if (typeof replyObj !== 'string' && replyObj.usageMetadata) {
                this._updateRateLimitsUI(replyObj.usageMetadata);
            }

            if (rememberHistory) {
                this._history.push(currentPrompt);
                this._history.push({
                    role: 'model',
                    parts: [{ text: reply }],
                });
            }
        } catch (error) {
            if (this._isDestroyed)
                return;

            this._hideLoadingIndicator();
            const msg = error.message || '';
            const isApiKeyError = msg.toLowerCase().includes('chave') || msg.toLowerCase().includes('api key');
            const isModelOrServiceError = msg.includes('503') ||
                                          msg.toLowerCase().includes('sobrecarregado') ||
                                          msg.includes('404') ||
                                          msg.toLowerCase().includes('modelo');

            let errBubble = null;
            if (isApiKeyError) {
                errBubble = this._addErrorBubble(msg, true, _('Configurar Chave de API'));
            } else if (isModelOrServiceError) {
                errBubble = this._addErrorBubble(msg, true, _('Trocar Modelo nas Preferências'));
            } else {
                errBubble = this._addErrorBubble(msg, false);
            }

            userMsgObj.retryBtn.show();
            userMsgObj.retryBtn.connect('clicked', () => {
                this._handleSend(userMsgObj.text, userMsgObj.wrapper, errBubble);
            });

        } finally {
            if (!this._isDestroyed) {
                this._isLoading = false;
                this._sendButton.reactive = true;
                this.focusInput();
            }
        }
    }

    destroy() {
        this._isDestroyed = true;
        this._unbindShortcuts();

        if (this._shortcutChangedId) {
            this._settings.disconnect(this._shortcutChangedId);
            this._shortcutChangedId = null;
        }
        if (this._positionChangedId) {
            this._settings.disconnect(this._positionChangedId);
            this._positionChangedId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._apiClient) {
            this._apiClient.cancelCurrentRequest();
        }
        if (this._activeCommandCancellables) {
            for (const cancellable of this._activeCommandCancellables) {
                if (!cancellable.is_cancelled()) {
                    cancellable.cancel();
                }
            }
            this._activeCommandCancellables.clear();
        }
        if (this._centerDialog) {
            if (this._centerDialog.isOpen)
                this._centerDialog.close();
            this._centerDialog.destroy();
            this._centerDialog = null;
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
