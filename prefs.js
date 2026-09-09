/* prefs.js
 *
 * Preferences window for Gnome Gemini extension.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
            'gemini-2.5-flash',
            'gemini-2.5-pro',
            'gemini-2.0-flash',
            'gemini-1.5-flash',
            'gemini-1.5-pro',
        ];
        const stringList = new Gtk.StringList();
        models.forEach(m => stringList.append(m));

        const modelRow = new Adw.ComboRow({
            title: _('Modelo Gemini'),
            subtitle: _('gemini-2.5-flash é o mais rápido e recomendado'),
            model: stringList,
        });

        const currentModel = settings.get_string('model');
        const selectedIndex = models.indexOf(currentModel);
        if (selectedIndex >= 0) {
            modelRow.set_selected(selectedIndex);
        }

        modelRow.connect('notify::selected', (row) => {
            const idx = row.get_selected();
            if (idx >= 0 && idx < models.length) {
                settings.set_string('model', models[idx]);
            }
        });
        modelGroup.add(modelRow);

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
    }
}
