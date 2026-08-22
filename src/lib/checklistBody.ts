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

/**
 * Toggle one task and propagate across its group:
 * completing a parent task completes its sub-tasks, and completing every
 * sub-task of a parent completes the parent.
 */
export function toggleCheckEntries(
	entries: { indent: number; checked: boolean }[],
	index: number
): void {
	const entry = entries[index];
	if (!entry) return;
	entry.checked = !entry.checked;
	if (entry.checked && entry.indent === 0) {
		for (let cursor = index + 1; cursor < entries.length; cursor++) {
			if (entries[cursor].indent === 0) break;
			entries[cursor].checked = true;
		}
		return;
	}
	if (entry.checked && entry.indent > 0) {
		let parent = -1;
		for (let cursor = index - 1; cursor >= 0; cursor--) {
			if (entries[cursor].indent < entry.indent) {
				parent = cursor;
				break;
			}
		}
		if (parent < 0 || entries[parent].checked) return;
		let allChecked = true;
		for (let cursor = parent + 1; cursor < entries.length; cursor++) {
			if (entries[cursor].indent <= entries[parent].indent) break;
			if (!entries[cursor].checked) {
				allChecked = false;
				break;
			}
		}
		if (allChecked) entries[parent].checked = true;
	}
}

export function toggleLineAt(body: string, lineIndex: number): string {
	const rawLines = body.split('\n');
	const target = parseCheckLine(rawLines[lineIndex] ?? '');
	if (!target) return body;
	const parsed = rawLines.map((raw) => parseCheckLine(raw));
	const entries = parsed.map((check) =>
		check ? { indent: check.indent, checked: check.checked } : null
	);
	const positions = entries.flatMap((entry, i) => (entry ? [i] : []));
	toggleCheckEntries(
		positions.map((i) => entries[i]!),
		positions.indexOf(lineIndex)
	);
	return rawLines
		.map((raw, i) => {
			const check = parsed[i];
			const entry = entries[i];
			if (!check || !entry || entry.checked === check.checked) return raw;
			return formatCheckLine(check.indent, entry.checked, check.text);
		})
		.join('\n');
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
