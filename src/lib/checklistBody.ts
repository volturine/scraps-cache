import type { Note } from './types';

/** Lines like `[ ] task`, `[] task`, `[x] done`, indented sub-tasks, `- [ ] item` */
export const CHECK_RE = /^(\s*)(?:[-*•]\s+)?\[([xX ]?)\]\s*(.*)$/;

export const MAX_CHECK_INDENT = 4;

export type BodySegment =
	| { type: 'text'; text: string; lineIndex: number }
	| { type: 'check'; checked: boolean; text: string; lineIndex: number; indent: number };

/** Count nesting level from leading whitespace (tab = 1, every 2 spaces = 1). */
export function indentLevelFromWhitespace(ws: string): number {
	let indent = 0;
	for (let i = 0; i < ws.length;) {
		if (ws[i] === '\t') {
			indent += 1;
			i += 1;
			continue;
		}
		if (ws[i] === ' ') {
			let spaces = 0;
			while (i < ws.length && ws[i] === ' ') {
				spaces += 1;
				i += 1;
			}
			indent += Math.floor(spaces / 2);
			continue;
		}
		i += 1;
	}
	return Math.min(MAX_CHECK_INDENT, indent);
}

export function checkIndentPrefix(indent: number): string {
	const n = Math.max(0, Math.min(MAX_CHECK_INDENT, indent));
	return '  '.repeat(n);
}

export function parseCheckLine(
	line: string
): { indent: number; checked: boolean; text: string } | null {
	const m = line.match(CHECK_RE);
	if (!m) return null;
	return {
		indent: indentLevelFromWhitespace(m[1] ?? ''),
		checked: m[2].trim().toLowerCase() === 'x',
		text: m[3] ?? ''
	};
}

export function formatCheckLine(indent: number, checked: boolean, text: string): string {
	return `${checkIndentPrefix(indent)}${checked ? '[x]' : '[ ]'} ${text}`;
}

export function parseBody(body: string): BodySegment[] {
	if (body === '') return [{ type: 'text', text: '', lineIndex: 0 }];
	return body.split('\n').map((line, lineIndex) => {
		const check = parseCheckLine(line);
		if (check) {
			return {
				type: 'check' as const,
				checked: check.checked,
				text: check.text,
				indent: check.indent,
				lineIndex
			};
		}
		return { type: 'text' as const, text: line, lineIndex };
	});
}

export function toggleLineAt(body: string, lineIndex: number): string {
	const lines = body.split('\n');
	const line = lines[lineIndex];
	if (!line) return body;
	const check = parseCheckLine(line);
	if (!check) return body;
	lines[lineIndex] = formatCheckLine(check.indent, !check.checked, check.text);
	return lines.join('\n');
}

export function noteAttachments(note: Note) {
	return note.images ?? [];
}

export function noteToPlainText(note: Note): string {
	const attachments = noteAttachments(note);
	const images = attachments.filter((attachment) => attachment.mime.startsWith('image/')).length;
	const files = attachments.length - images;
	const parts = [images && `${images} image(s)`, files && `${files} file(s)`].filter(Boolean);
	const suffix = parts.length ? `\n[${parts.join(', ')}]` : '';
	return `${note.title}\n${note.body}${suffix}`.trim();
}
