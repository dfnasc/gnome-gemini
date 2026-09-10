/**
 * commandParser.js
 *
 * Parses Gemini model responses to detect structured command suggestions
 * alongside normal markdown text.
 */

/**
 * Parses a markdown response into an array of segments:
 * - Text segments: { type: 'text', content: string }
 * - Command segments: { type: 'command', command: string, description: string }
 *
 * @param {string} text
 * @returns {Array<Object>}
 */
export function parseResponseSegments(text) {
    if (!text || typeof text !== 'string') {
        return [];
    }

    const segments = [];
    const blockRegex = /```([a-zA-Z0-9_:-]*)\s*\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = blockRegex.exec(text)) !== null) {
        const lang = (match[1] || '').toLowerCase().trim();
        const codeContent = match[2].trim();
        let commandItems = null;

        const isCommandTag = ['json:command', 'command', 'gnome-command', 'bash:command', 'sh:command'].includes(lang);
        const isJsonTag = lang === 'json' || isCommandTag;

        // Try parsing JSON if content looks like an object or array
        if ((isJsonTag || lang === 'bash' || lang === 'sh' || lang === '') &&
            (codeContent.startsWith('{') || codeContent.startsWith('['))) {
            let data = null;
            try {
                data = JSON.parse(codeContent);
            } catch (_) {
                // Try cleaning trailing commas
                try {
                    const cleaned = codeContent.replace(/,\s*([}\]])/g, '$1');
                    data = JSON.parse(cleaned);
                } catch (_) {}
            }

            if (data && typeof data === 'object') {
                if (typeof data.command === 'string' && data.command.trim()) {
                    commandItems = [{
                        command: data.command.trim(),
                        description: data.description || '',
                    }];
                } else if (Array.isArray(data.commands)) {
                    commandItems = data.commands
                        .filter(item => item && typeof item.command === 'string' && item.command.trim())
                        .map(item => ({
                            command: item.command.trim(),
                            description: item.description || '',
                        }));
                } else if (Array.isArray(data)) {
                    commandItems = data
                        .filter(item => item && typeof item.command === 'string' && item.command.trim())
                        .map(item => ({
                            command: item.command.trim(),
                            description: item.description || '',
                        }));
                }
            }
        }

        // If explicitly tagged as a command block and not JSON
        if ((!commandItems || commandItems.length === 0) && isCommandTag && codeContent) {
            commandItems = [{
                command: codeContent,
                description: '',
            }];
        }

        if (commandItems && commandItems.length > 0) {
            const textBefore = text.slice(lastIndex, match.index);
            if (textBefore.trim()) {
                segments.push({ type: 'text', content: textBefore });
            }
            for (const item of commandItems) {
                segments.push({
                    type: 'command',
                    command: item.command,
                    description: item.description || '',
                });
            }
            lastIndex = match.index + match[0].length;
        }
    }

    const remaining = text.slice(lastIndex);
    if (remaining.trim()) {
        segments.push({ type: 'text', content: remaining });
    }

    if (segments.length === 0 && text.trim()) {
        segments.push({ type: 'text', content: text });
    }

    return segments;
}
