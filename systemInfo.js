/**
 * systemInfo.js
 *
 * Gathers host operating system and desktop environment information,
 * and builds enriched system instructions for Gemini.
 */

import GLib from 'gi://GLib';

/**
 * Gathers host system information: distribution, kernel version, GNOME version, session type.
 *
 * @param {Object} [options]
 * @param {string} [options.gnomeVersion] - Explicit GNOME Shell version if known
 * @param {Object} [options.extension] - Extension instance for metadata fallback
 * @returns {Object} System details
 */
export function getSystemInfo(options = {}) {
    let distro = 'Linux';
    try {
        distro = GLib.get_os_info('PRETTY_NAME') || GLib.get_os_info('NAME') || 'Linux';
    } catch (e) {
        console.warn(`GnomeGemini: Erro ao obter nome da distribuição: ${e.message}`);
    }

    let distroId = '';
    try {
        distroId = GLib.get_os_info('ID') || '';
    } catch (_) {}

    let kernel = 'Desconhecido';
    try {
        const [ok, contents] = GLib.file_get_contents('/proc/sys/kernel/osrelease');
        if (ok) {
            const decoder = new TextDecoder('utf-8');
            kernel = decoder.decode(contents).trim();
        }
    } catch (e) {
        console.warn(`GnomeGemini: Erro ao obter versão do kernel: ${e.message}`);
    }

    let gnomeVersion = options.gnomeVersion || '';
    if (!gnomeVersion) {
        try {
            const [ok, out] = GLib.spawn_command_line_sync('gnome-shell --version');
            if (ok) {
                const str = new TextDecoder('utf-8').decode(out).trim();
                const match = str.match(/[\d.]+/);
                if (match)
                    gnomeVersion = match[0];
            }
        } catch (_) {}
    }

    if (!gnomeVersion && options.extension?.metadata?.['shell-version']) {
        const sv = options.extension.metadata['shell-version'];
        gnomeVersion = Array.isArray(sv) ? sv[0] : String(sv);
    }

    if (!gnomeVersion) {
        gnomeVersion = '50';
    }

    let sessionType = '';
    try {
        sessionType = GLib.getenv('XDG_SESSION_TYPE') || 'wayland';
    } catch (_) {}

    return {
        distro,
        distroId,
        kernel,
        gnomeVersion,
        sessionType,
    };
}

/**
 * Builds the complete system instruction for Gemini, combining:
 * 1. User-configured base instructions (personality/language)
 * 2. Host OS, Kernel, GNOME version, and Desktop environment context
 * 3. Structured JSON format instructions for any suggested system command execution
 *
 * @param {string} userInstruction
 * @param {Object} sysInfo
 * @returns {string} Enriched system instruction prompt
 */
export function buildSystemInstruction(userInstruction, sysInfo) {
    const basePrompt = (userInstruction && userInstruction.trim() !== '')
        ? userInstruction.trim()
        : 'Você é o assistente inteligente Gnome Gemini, perfeitamente integrado ao desktop GNOME Shell.';

    const systemInfoLines = [
        '--- INFORMAÇÕES DO AMBIENTE DO SISTEMA OPERACIONAL ---',
        `• Distribuição Linux: ${sysInfo.distro}${sysInfo.distroId ? ` (ID: ${sysInfo.distroId})` : ''}`,
        `• Versão do Kernel: ${sysInfo.kernel}`,
        `• Versão do GNOME Shell: ${sysInfo.gnomeVersion}`,
        `• Tipo de Sessão: ${sysInfo.sessionType}`,
        'Sempre considere esse ambiente ao propor soluções e comandos (por exemplo, utilize o gerenciador de pacotes correto da distribuição, como pacman no Arch Linux, apt no Debian/Ubuntu, dnf no Fedora, etc., e comandos compatíveis com a versão do GNOME e kernel informados).',
        '',
        '--- DIRETRIZ ESTRUTURADA PARA SUGESTÃO DE COMANDOS ---',
        'Sempre que for feita uma pergunta sobre como executar uma determinada tarefa relacionada ao sistema, ou quando você for sugerir a execução de comandos de terminal/shell no sistema operacional:',
        '1. Além da sua explicação normal ao usuário, você DEVE fornecer cada comando sugerido em formato estruturado JSON dentro de um bloco de código markdown identificado como ```json:command.',
        '2. O JSON dentro do bloco ```json:command DEVE seguir rigorosamente a estrutura abaixo:',
        '```json:command',
        '{',
        '  "command": "comando executável aqui",',
        '  "description": "Breve descrição em uma linha sobre o que este comando faz"',
        '}',
        '```',
        '3. Se houver múltiplos comandos sequenciais ou alternativas distintas, forneça múltiplos blocos ```json:command ao longo da resposta ou um bloco com a lista "commands":',
        '```json:command',
        '{',
        '  "commands": [',
        '    {',
        '      "command": "primeiro_comando",',
        '      "description": "Descrição do passo 1"',
        '    },',
        '    {',
        '      "command": "segundo_comando",',
        '      "description": "Descrição do passo 2"',
        '    }',
        '  ]',
        '}',
        '```',
        '4. Nunca use o bloco ```json:command para explicações de código genérico (como tutoriais de Python/C); use-o exclusivamente para comandos prontos a serem executados no terminal do sistema.',
        '5. Mantenha explicações claras em markdown antes ou depois do bloco do comando.',
    ].join('\n');

    return `${basePrompt}\n\n${systemInfoLines}`;
}
