/* prefs.js
 *
 * Preferences window for Gnome Gemini extension.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { getSystemInfo } from './systemInfo.js';

export default class GnomeGeminiPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(620, 560);

        // Page: General
        const page = new Adw.PreferencesPage({
            title: _('Geral'),
            icon_name: 'preferences-other-symbolic',
        });
        window.add(page);

        // Group: API Credentials
        const apiGroup = new Adw.PreferencesGroup({
            title: _('Autenticação da API'),
            description: _('Informe sua chave de API do Google Gemini. Você pode gerar uma chave gratuitamente em https://aistudio.google.com/app/apikey'),
        });
        page.add(apiGroup);

        const apiKeyRow = new Adw.PasswordEntryRow({
            title: _('Chave da API (Gemini API Key)'),
            text: settings.get_string('api-key'),
            show_apply_button: false,
        });
        apiKeyRow.connect('changed', (row) => {
            settings.set_string('api-key', row.text.trim());
        });
        apiGroup.add(apiKeyRow);

        // Group: Model & Generation
        const modelGroup = new Adw.PreferencesGroup({
            title: _('Modelo de IA e Opções'),
            description: _('Configure qual modelo do Gemini utilizar e os parâmetros de geração.'),
        });
        page.add(modelGroup);

        const models = [
            'gemini-3.8-flash',
            'gemini-3.7-flash',
            'gemini-3.6-flash',
            'gemini-3.5-flash',
            'gemini-3.5-flash-lite',
            'gemini-3.1-pro-preview',
            'gemini-3.1-flash-lite',
            'gemini-3-flash-preview',
            'gemini-2.5-flash',
            'gemini-2.5-pro',
            'gemini-2.5-flash-lite',
        ];

        let currentSequence = settings.get_strv('models-sequence');
        if (!currentSequence || currentSequence.length === 0) {
            currentSequence = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
        }
        
        currentSequence.forEach(m => {
            if (m && !models.includes(m)) {
                models.push(m);
            }
        });

        const stringList = new Gtk.StringList();
        models.forEach(m => stringList.append(m));

        const sequenceTitles = [
            _('Modelo Primário'),
            _('Modelo Secundário (Fallback 1)'),
            _('Modelo Terciário (Fallback 2)'),
            _('Modelo Quaternário (Fallback 3)'),
            _('Modelo Quinário (Fallback 4)')
        ];

        sequenceTitles.forEach((title, i) => {
            const row = new Adw.ComboRow({
                title: title,
                subtitle: i === 0 ? _('Modelo principal utilizado para geração.') : _('Usado automaticamente caso os anteriores atinjam o limite (rate limit)'),
                model: stringList,
            });

            const currentModelAtIdx = currentSequence[i] || models[0];
            const selectedIndex = models.indexOf(currentModelAtIdx);
            if (selectedIndex >= 0) {
                row.set_selected(selectedIndex);
            }

            row.connect('notify::selected', (r) => {
                const idx = r.get_selected();
                if (idx >= 0 && idx < models.length) {
                    let seq = settings.get_strv('models-sequence') || [];
                    while (seq.length < 5) seq.push(models[0]);
                    seq[i] = models[idx];
                    settings.set_strv('models-sequence', seq);
                    
                    if (i === 0) {
                        settings.set_string('model', models[idx]);
                    }
                }
            });
            modelGroup.add(row);
        });

        // Temperature Row
        const tempRow = new Adw.SpinRow({
            title: _('Temperatura'),
            subtitle: _('Controla a criatividade da resposta (0.0 mais preciso, 2.0 mais criativo)'),
            adjustment: new Gtk.Adjustment({
                lower: 0.0,
                upper: 2.0,
                step_increment: 0.1,
                page_increment: 0.2,
                value: settings.get_double('temperature'),
            }),
            digits: 1,
        });
        tempRow.connect('notify::value', (row) => {
            settings.set_double('temperature', row.value);
        });
        modelGroup.add(tempRow);

        // Remember History Switch
        const historyRow = new Adw.SwitchRow({
            title: _('Manter Histórico da Conversa'),
            subtitle: _('Preserva as mensagens anteriores para manter o contexto durante o chat'),
            active: settings.get_boolean('remember-history'),
        });
        historyRow.connect('notify::active', (row) => {
            settings.set_boolean('remember-history', row.active);
        });
        modelGroup.add(historyRow);

        // System Instruction Row
        const systemPromptRow = new Adw.EntryRow({
            title: _('Instrução do Sistema (Personalidade)'),
            text: settings.get_string('system-instruction'),
        });
        systemPromptRow.connect('changed', (row) => {
            settings.set_string('system-instruction', row.text);
        });
        modelGroup.add(systemPromptRow);

        // Detected System Info Row
        const sysInfo = getSystemInfo();
        const sysInfoRow = new Adw.ActionRow({
            title: _('Ambiente Detectado do Sistema'),
            subtitle: `${sysInfo.distro} • Kernel ${sysInfo.kernel} • GNOME ${sysInfo.gnomeVersion}`,
        });
        sysInfoRow.add_prefix(new Gtk.Image({
            icon_name: 'computer-symbolic',
        }));
        modelGroup.add(sysInfoRow);

        // Group: Appearance & Shortcuts
        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Aparência e Atalhos'),
            description: _('Configure a posição de abertura do popup e atalhos de teclado.'),
        });
        page.add(appearanceGroup);

        // Popup Position Row
        const positionOptions = [
            { id: 'corner', title: _('Canto da barra superior (Padrão)') },
            { id: 'center', title: _('Centro da tela (0.8 × tamanho do display)') },
        ];

        const posStringList = new Gtk.StringList();
        positionOptions.forEach(opt => posStringList.append(opt.title));

        const positionRow = new Adw.ComboRow({
            title: _('Posição de Abertura'),
            subtitle: _('Escolha entre abrir no canto superior ou centralizado ocupando 80% da tela'),
            model: posStringList,
        });

        const currentPosition = settings.get_string('popup-position') || 'corner';
        const posIndex = positionOptions.findIndex(opt => opt.id === currentPosition);
        if (posIndex >= 0) {
            positionRow.set_selected(posIndex);
        }

        positionRow.connect('notify::selected', (row) => {
            const idx = row.get_selected();
            if (idx >= 0 && idx < positionOptions.length) {
                settings.set_string('popup-position', positionOptions[idx].id);
            }
        });
        appearanceGroup.add(positionRow);

        // Keyboard Shortcut Row
        const shortcutRow = new Adw.ActionRow({
            title: _('Atalho de Teclado'),
            subtitle: _('Atalho para abrir ou fechar o Gemini rapidamente. Clique em Alterar e pressione as teclas (Backspace para desativar).'),
        });

        const shortcutBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });

        const getShortcutText = () => {
            const shortcuts = settings.get_strv('toggle-shortcut');
            return (shortcuts && shortcuts.length > 0) ? shortcuts[0] : '';
        };

        const shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: getShortcutText(),
            disabled_text: _('Desativado'),
            valign: Gtk.Align.CENTER,
        });
        shortcutBox.append(shortcutLabel);

        const editButton = new Gtk.Button({
            label: _('Alterar'),
            valign: Gtk.Align.CENTER,
        });

        const resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Restaurar atalho padrão (<Control>g)'),
            valign: Gtk.Align.CENTER,
            has_frame: false,
        });

        let keyController = null;

        const stopEditing = () => {
            if (keyController) {
                window.remove_controller(keyController);
                keyController = null;
            }
            editButton.set_label(_('Alterar'));
            editButton.remove_css_class('suggested-action');
            shortcutLabel.set_accelerator(getShortcutText());
        };

        const startEditing = () => {
            editButton.set_label(_('Pressione as teclas...'));
            editButton.add_css_class('suggested-action');

            keyController = new Gtk.EventControllerKey();
            window.add_controller(keyController);

            keyController.connect('key-pressed', (_ec, keyval, keycode, state) => {
                let mask = state & Gtk.accelerator_get_default_mod_mask();

                if (mask === 0) {
                    if (keyval === Gdk.KEY_Escape) {
                        stopEditing();
                        return Gdk.EVENT_STOP;
                    }
                    if (keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) {
                        settings.set_strv('toggle-shortcut', []);
                        shortcutLabel.set_accelerator('');
                        stopEditing();
                        return Gdk.EVENT_STOP;
                    }
                }

                if (!Gtk.accelerator_valid(keyval, mask)) {
                    return Gdk.EVENT_PROPAGATE;
                }

                const accelerator = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
                if (accelerator) {
                    settings.set_strv('toggle-shortcut', [accelerator]);
                    shortcutLabel.set_accelerator(accelerator);
                }

                stopEditing();
                return Gdk.EVENT_STOP;
            });
        };

        editButton.connect('clicked', () => {
            if (keyController) {
                stopEditing();
            } else {
                startEditing();
            }
        });

        resetButton.connect('clicked', () => {
            if (keyController) {
                stopEditing();
            }
            settings.set_strv('toggle-shortcut', ['<Control>g']);
            shortcutLabel.set_accelerator('<Control>g');
        });

        window.connect('close-request', () => {
            stopEditing();
            return false;
        });

        shortcutBox.append(editButton);
        shortcutBox.append(resetButton);
        shortcutRow.add_suffix(shortcutBox);
        appearanceGroup.add(shortcutRow);
    }
}
