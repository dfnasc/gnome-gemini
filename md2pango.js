/**
 * md2pango.js
 *
 * Converts Markdown text into Pango markup suitable for St.Label / Clutter.
 */

import Pango from 'gi://Pango';

function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function processInlineStyles(line) {
    // Inline code: `code`
    line = line.replace(/`([^`]+)`/g, (match, code) => {
        return `<tt><span foreground="#b8c8f0">${code}</span></tt>`;
    });

    // Bold: **text** or __text__
    line = line.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    line = line.replace(/__([^_]+)__/g, '<b>$1</b>');

    // Italic: *text* or _text_
    line = line.replace(/(^|[^\*])\*([^*]+)\*([^\*]|$)/g, '$1<i>$2</i>$3');
    line = line.replace(/(^|[^_])_([^_]+)_([^_]|$)/g, '$1<i>$2</i>$3');

    // Strikethrough: ~~text~~
    line = line.replace(/~~([^~]+)~~/g, '<s>$1</s>');

    // Links: [text](url) -> <u>text</u> (url)
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<u>$1</u> (<span foreground="#78aeed">$2</span>)');

    return line;
}

export function markdownToPango(markdown) {
    if (!markdown) {
        return '';
    }

    try {
        const lines = markdown.split('\n');
        const output = [];
        let inCodeBlock = false;
        let codeBuffer = [];

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i];

            // Check for code block fence: ```[lang]
            if (rawLine.trim().startsWith('```')) {
                if (!inCodeBlock) {
                    inCodeBlock = true;
                    codeBuffer = [];
                } else {
                    inCodeBlock = false;
                    const escapedCode = codeBuffer.map(escapeXml).join('\n');
                    output.push(`<tt><span foreground="#dddddd" background="#2b2d30">${escapedCode}</span></tt>`);
                    codeBuffer = [];
                }
                continue;
            }

            if (inCodeBlock) {
                codeBuffer.push(rawLine);
                continue;
            }

            const trimmed = rawLine.trim();

            // Headings
            if (/^###\s+/.test(trimmed)) {
                const heading = escapeXml(trimmed.replace(/^###\s+/, ''));
                output.push(`\n<big><b>${processInlineStyles(heading)}</b></big>`);
                continue;
            }
            if (/^##\s+/.test(trimmed)) {
                const heading = escapeXml(trimmed.replace(/^##\s+/, ''));
                output.push(`\n<big><big><b>${processInlineStyles(heading)}</b></big></big>`);
                continue;
            }
            if (/^#\s+/.test(trimmed)) {
                const heading = escapeXml(trimmed.replace(/^#\s+/, ''));
                output.push(`\n<big><big><big><b>${processInlineStyles(heading)}</b></big></big></big>`);
                continue;
            }

            // Blockquote
            if (/^>\s+/.test(trimmed)) {
                const quote = escapeXml(trimmed.replace(/^>\s+/, ''));
                output.push(`  <i><span foreground="#aaaaaa">“${processInlineStyles(quote)}”</span></i>`);
                continue;
            }

            // Bullet lists: - item, * item, + item
            if (/^[\*\-\+]\s+/.test(trimmed)) {
                const item = escapeXml(trimmed.replace(/^[\*\-\+]\s+/, ''));
                output.push(`  • ${processInlineStyles(item)}`);
                continue;
            }

            // Numbered list: 1. item
            const numMatch = trimmed.match(/^(\d+\.)\s+(.+)$/);
            if (numMatch) {
                const item = escapeXml(numMatch[2]);
                output.push(`  <b>${numMatch[1]}</b> ${processInlineStyles(item)}`);
                continue;
            }

            // Horizontal rule
            if (/^(---|\*\*\*|___)$/.test(trimmed)) {
                output.push('<span foreground="#666666">──────────────────────────────</span>');
                continue;
            }

            // Normal text line
            const escapedLine = escapeXml(rawLine);
            output.push(processInlineStyles(escapedLine));
        }

        // If code block was not closed
        if (inCodeBlock && codeBuffer.length > 0) {
            const escapedCode = codeBuffer.map(escapeXml).join('\n');
            output.push(`<tt><span foreground="#dddddd" background="#2b2d30">${escapedCode}</span></tt>`);
        }

        const result = output.join('\n');

        // Validate markup with Pango parser
        Pango.parse_markup(result, -1, '\0');
        return result;
    } catch (e) {
        // Fallback safely to escaped plain text if parsing fails
        return escapeXml(markdown);
    }
}
