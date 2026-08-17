<script lang="ts">
	import { flushSync, tick } from 'svelte';
	import { CHECK_RE, formatCheckLine, parseCheckLine } from '$lib/checklistBody';
	import { revealEditorField } from '$lib/editorVisibility';

	const MAX_TASK_INDENT = 1;

	let {
		body = $bindable(''),
		oninput,
		placeholder = '',
		focusSignal = 0,
		focusLine = null,
		onFocusTask,
		onExitTaskFocus
	}: {
		body?: string;
		oninput?: () => void;
		placeholder?: string;
		focusSignal?: number;
		focusLine?: number | null;
		onFocusTask?: (line: number) => void;
		onExitTaskFocus?: () => void;
	} = $props();

	type Line = { id: number; text: string; checked: boolean; isCheck: boolean; indent: number };
	type EditorPoint = { line: number; offset: number; global: number };
	type EditorRange = { start: EditorPoint; end: EditorPoint; collapsed: boolean };

	let lineIdCounter = 0;
	function newLine(text = '', isCheck = false, checked = false, indent = 0): Line {
		return {
			id: lineIdCounter++,
			text,
			isCheck,
			checked,
			indent: Math.max(0, Math.min(MAX_TASK_INDENT, indent))
		};
	}

	function parseBodyToLines(raw: string): Line[] {
		if (!raw) return [newLine()];
		return raw.split('\n').map((text) => {
			const check = parseCheckLine(text);
			return check ? newLine(check.text, true, check.checked, check.indent) : newLine(text, false);
		});
	}

	function serializeLines(rows: Line[]): string {
		return rows
			.map((line) =>
				line.isCheck ? formatCheckLine(line.indent, line.checked, line.text) : line.text
			)
			.join('\n');
	}

	let lines = $state<Line[]>([newLine()]);
	let container: HTMLDivElement | null = $state(null);
	let focusedRootId = $state<number | null>(null);
	let draftTaskId = $state<number | null>(null);
	let ignoredFocusLine = $state<number | null>(null);
	let checklistPointerId: number | null = null;
	let handledFocusSignal = 0;
	let lastBody = '';
	let composing = false;

	$effect(() => {
		if (body === lastBody) return;
		lastBody = body;
		lines = parseBodyToLines(body);
		focusedRootId = null;
		draftTaskId = null;
	});

	function makeEditable(node: HTMLDivElement) {
		node.setAttribute('contenteditable', 'plaintext-only');
		return {
			destroy() {
				node.removeAttribute('contenteditable');
			}
		};
	}

	function syncEditableText(node: HTMLElement, value: string) {
		const apply = (next: string) => {
			// The browser mutates this text node directly. Only reconcile when state
			// actually differs so iOS and Svelte never insert the first character twice.
			if (node.textContent !== next) node.textContent = next;
		};
		apply(value);
		return { update: apply };
	}

	function syncBody() {
		const next = serializeLines(lines.filter((line) => line.id !== draftTaskId));
		lastBody = next;
		body = next;
		oninput?.();
	}

	function lineElement(index: number): HTMLElement | null {
		return container?.querySelector(`[data-editor-line="${index}"]`) as HTMLElement | null;
	}

	function textElement(index: number): HTMLElement | null {
		return lineElement(index)?.querySelector('[data-line-text]') as HTMLElement | null;
	}

	function closestLineElement(node: Node | null): HTMLElement | null {
		const element = node instanceof Element ? node : node?.parentElement;
		return element?.closest('[data-editor-line]') as HTMLElement | null;
	}

	function globalOffset(line: number, offset: number): number {
		let total = 0;
		for (let index = 0; index < line; index++) total += lines[index].text.length + 1;
		return total + offset;
	}

	function pointFromDom(node: Node | null, offset: number): EditorPoint | null {
		if (!container || !node) return null;
		if (node === container) {
			const childIndex = Math.max(0, Math.min(offset, lines.length));
			if (childIndex >= lines.length) {
				const line = Math.max(0, lines.length - 1);
				const end = lines[line]?.text.length ?? 0;
				return { line, offset: end, global: globalOffset(line, end) };
			}
			return { line: childIndex, offset: 0, global: globalOffset(childIndex, 0) };
		}

		const row = closestLineElement(node);
		if (!row || !container.contains(row)) return null;
		const line = Number(row.dataset.editorLine);
		if (!Number.isInteger(line) || !lines[line]) return null;
		const text = row.querySelector('[data-line-text]') as HTMLElement | null;
		if (!text) return null;

		let local = 0;
		try {
			const range = document.createRange();
			range.selectNodeContents(text);
			if (text.contains(node) || node === text) range.setEnd(node, offset);
			else if (node.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)
				local = lines[line].text.length;
			local = Math.min(lines[line].text.length, range.toString().length || local);
		} catch {
			local = 0;
		}
		return { line, offset: local, global: globalOffset(line, local) };
	}

	function editorRange(): EditorRange | null {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return null;
		const anchor = pointFromDom(selection.anchorNode, selection.anchorOffset);
		const focus = pointFromDom(selection.focusNode, selection.focusOffset);
		if (!anchor || !focus) return null;
		const [start, end] = anchor.global <= focus.global ? [anchor, focus] : [focus, anchor];
		return { start, end, collapsed: start.global === end.global };
	}

	function focusAt(index: number, offset: number | null = 0, lineId: number | null = null) {
		flushSync();
		let resolved = index;
		if (lineId !== null) {
			const byId = lines.findIndex((line) => line.id === lineId);
			if (byId >= 0) resolved = byId;
		}
		resolved = Math.max(0, Math.min(resolved, lines.length - 1));
		const text = textElement(resolved);
		if (!container || !text) return;
		try {
			container.focus({ preventScroll: true });
		} catch {
			container.focus();
		}
		const caret = Math.max(
			0,
			Math.min(offset ?? lines[resolved].text.length, lines[resolved].text.length)
		);
		const selection = window.getSelection();
		const range = document.createRange();
		const textNode = text.firstChild;
		if (textNode?.nodeType === Node.TEXT_NODE) range.setStart(textNode, caret);
		else range.setStart(text, 0);
		range.collapse(true);
		selection?.removeAllRanges();
		selection?.addRange(range);
		const scroller = container.closest('.scrollable') as HTMLElement | null;
		const row = lineElement(resolved);
		if (scroller && row) revealEditorField(scroller, row);
	}

	async function focusAfterRender(index: number, offset: number, lineId: number | null = null) {
		await tick();
		focusAt(index, offset, lineId);
	}

	function parentTaskIndex(index: number): number {
		const line = lines[index];
		if (!line?.isCheck || line.indent === 0) return index;
		for (let cursor = index - 1; cursor >= 0; cursor--) {
			if (lines[cursor].isCheck && lines[cursor].indent === 0) return cursor;
		}
		return index;
	}

	function focusTask(index: number) {
		const line = lines[index];
		if (!line?.isCheck) {
			focusedRootId = null;
			onExitTaskFocus?.();
			return;
		}
		const root = parentTaskIndex(index);
		focusedRootId = lines[root]?.id ?? line.id;
		onFocusTask?.(index);
	}

	function dropTaskFocus() {
		focusedRootId = null;
		ignoredFocusLine = focusLine;
		onExitTaskFocus?.();
	}

	function handleEditorClick(event: MouseEvent) {
		// A touch can start on the checkbox and finish over the editable label. In
		// that case Safari may retarget its synthetic click to the task row. Keep
		// the whole gesture owned by the checkbox so it cannot open the keyboard.
		if (checklistPointerId !== null) return;
		const row = closestLineElement(event.target as Node);
		if (!row) return;
		const index = Number(row.dataset.editorLine);
		if (!Number.isInteger(index)) return;
		const scroller = container?.closest('.scrollable') as HTMLElement | null;
		const anchorTop = row.getBoundingClientRect().top;
		focusTask(index);
		flushSync();
		if (scroller) scroller.scrollTop += row.getBoundingClientRect().top - anchorTop;
	}

	function readDomIntoLines() {
		if (!container) return;
		for (let index = 0; index < lines.length; index++) {
			const text = textElement(index)?.textContent ?? '';
			lines[index].text = text.replaceAll('\u00a0', ' ');
			if (!lines[index].isCheck && CHECK_RE.test(lines[index].text)) {
				const parsed = parseCheckLine(lines[index].text);
				if (parsed) {
					lines[index].isCheck = true;
					lines[index].checked = parsed.checked;
					lines[index].indent = Math.min(MAX_TASK_INDENT, parsed.indent);
					lines[index].text = parsed.text;
					focusedRootId = lines[index].id;
					onFocusTask?.(index);
					flushSync();
					focusAt(index, lines[index].text.length, lines[index].id);
				}
			}
			if (lines[index].id === draftTaskId && lines[index].text.trim()) draftTaskId = null;
		}
		syncBody();
	}

	function handleInput(rawEvent: Event) {
		const event = rawEvent as InputEvent;
		if (composing || event.isComposing) return;
		readDomIntoLines();
	}

	function replaceSelectedRange(range: EditorRange, replacement = ''): EditorPoint {
		const { start, end } = range;
		if (start.line === end.line) {
			const line = lines[start.line];
			const removesWholeRow =
				replacement.length === 0 && start.offset === 0 && end.offset === line.text.length;
			if (removesWholeRow) {
				lines.splice(start.line, 1);
				if (line.id === draftTaskId) draftTaskId = null;
				if (lines.length === 0) lines.push(newLine());
				const nextLine = Math.min(start.line, lines.length - 1);
				syncBody();
				return { line: nextLine, offset: 0, global: globalOffset(nextLine, 0) };
			}
			line.text = line.text.slice(0, start.offset) + replacement + line.text.slice(end.offset);
			syncBody();
			return {
				line: start.line,
				offset: start.offset + replacement.length,
				global: start.global + replacement.length
			};
		}

		const first = lines[start.line];
		const last = lines[end.line];
		const merged = first.text.slice(0, start.offset) + replacement + last.text.slice(end.offset);
		const removesWholeRows =
			start.offset === 0 && end.offset === last.text.length && replacement.length === 0;
		if (removesWholeRows) {
			lines.splice(start.line, end.line - start.line + 1);
			if (lines.length === 0) lines.push(newLine());
			const nextLine = Math.min(start.line, lines.length - 1);
			syncBody();
			return { line: nextLine, offset: 0, global: globalOffset(nextLine, 0) };
		}

		first.text = merged;
		lines.splice(start.line + 1, end.line - start.line);
		syncBody();
		return {
			line: start.line,
			offset: start.offset + replacement.length,
			global: start.global + replacement.length
		};
	}

	function handleBeforeInput(rawEvent: Event) {
		const event = rawEvent as InputEvent;
		const range = editorRange();
		if (!range || range.collapsed) return;
		if (!event.inputType.startsWith('delete')) return;
		event.preventDefault();
		const caret = replaceSelectedRange(range);
		dropTaskFocus();
		focusAt(caret.line, caret.offset, lines[caret.line]?.id ?? null);
	}

	function selectedText(range: EditorRange): string {
		const selected: string[] = [];
		for (let index = range.start.line; index <= range.end.line; index++) {
			const line = lines[index];
			const start = index === range.start.line ? range.start.offset : 0;
			const end = index === range.end.line ? range.end.offset : line.text.length;
			const text = line.text.slice(start, end);
			selected.push(
				line.isCheck && start === 0 && end === line.text.length
					? formatCheckLine(line.indent, line.checked, text)
					: text
			);
		}
		return selected.join('\n');
	}

	function writeSelectionToClipboard(event: ClipboardEvent): EditorRange | null {
		const range = editorRange();
		if (!range || range.collapsed || !event.clipboardData) return null;
		event.clipboardData.setData('text/plain', selectedText(range));
		event.preventDefault();
		return range;
	}

	function handleCopy(event: ClipboardEvent) {
		writeSelectionToClipboard(event);
	}

	function handleCut(event: ClipboardEvent) {
		const range = writeSelectionToClipboard(event);
		if (!range) return;
		const caret = replaceSelectedRange(range);
		dropTaskFocus();
		focusAt(caret.line, caret.offset, lines[caret.line]?.id ?? null);
	}

	function replaceRangeWithText(range: EditorRange, rawText: string): EditorPoint {
		const parts = rawText.replace(/\r\n?/g, '\n').split('\n');
		if (parts.length === 1) {
			const first = lines[range.start.line];
			const last = lines[range.end.line];
			const prefix = first.text.slice(0, range.start.offset);
			const check = prefix.length === 0 ? parseCheckLine(parts[0]) : null;
			if (!check) return replaceSelectedRange(range, parts[0]);
			first.text = check.text + last.text.slice(range.end.offset);
			first.isCheck = true;
			first.checked = check.checked;
			first.indent = Math.min(MAX_TASK_INDENT, check.indent);
			lines.splice(range.start.line + 1, range.end.line - range.start.line);
			syncBody();
			return {
				line: range.start.line,
				offset: check.text.length,
				global: globalOffset(range.start.line, check.text.length)
			};
		}

		const first = lines[range.start.line];
		const last = lines[range.end.line];
		const removedIds = new Set(
			lines.slice(range.start.line, range.end.line + 1).map((line) => line.id)
		);
		const prefix = first.text.slice(0, range.start.offset);
		const suffix = last.text.slice(range.end.offset);
		const firstCheck = prefix.length === 0 ? parseCheckLine(parts[0]) : null;
		const inserted: Line[] = [
			firstCheck
				? {
						...first,
						text: firstCheck.text,
						isCheck: true,
						checked: firstCheck.checked,
						indent: Math.min(MAX_TASK_INDENT, firstCheck.indent)
					}
				: { ...first, text: prefix + parts[0] }
		];
		for (let index = 1; index < parts.length; index++) {
			const check = parseCheckLine(parts[index]);
			const trailing = index === parts.length - 1 ? suffix : '';
			inserted.push(
				check
					? newLine(
							check.text + trailing,
							true,
							check.checked,
							Math.min(MAX_TASK_INDENT, check.indent)
						)
					: newLine(parts[index] + trailing, first.isCheck, false, first.indent)
			);
		}

		lines.splice(range.start.line, range.end.line - range.start.line + 1, ...inserted);
		if (draftTaskId !== null && removedIds.has(draftTaskId)) draftTaskId = null;
		syncBody();
		const line = range.start.line + inserted.length - 1;
		return {
			line,
			offset: parts.at(-1)?.length ?? 0,
			global: globalOffset(line, parts.at(-1)?.length ?? 0)
		};
	}

	function handlePaste(event: ClipboardEvent) {
		const range = editorRange();
		if (!range || !event.clipboardData) return;
		const text = event.clipboardData.getData('text/plain');
		if (!text) return;
		event.preventDefault();
		const caret = replaceRangeWithText(range, text);
		focusAt(caret.line, caret.offset, lines[caret.line]?.id ?? null);
	}

	function toggleCheck(index: number, event: MouseEvent) {
		event.stopPropagation();
		lines[index].checked = !lines[index].checked;
		syncBody();
	}

	function keepEditorFocus(event: PointerEvent) {
		// A checklist toggle is an action within the editing surface, not a focus target.
		// Preventing the pointer default avoids blurring the editor and dismissing its keyboard.
		// Stopping propagation also keeps note-detail touch handling from treating the
		// toggle as a body tap and scrolling the selected row into view.
		event.preventDefault();
		event.stopPropagation();
		checklistPointerId = event.pointerId;
		const toggle = event.currentTarget as HTMLElement;
		try {
			toggle.setPointerCapture?.(event.pointerId);
		} catch {
			// Pointer capture is best-effort on older Safari versions.
		}
	}

	function finishChecklistPointer(event: PointerEvent) {
		if (event.pointerId !== checklistPointerId) return;
		queueMicrotask(() => {
			if (checklistPointerId === event.pointerId) checklistPointerId = null;
		});
	}

	function cancelChecklistPointer(event: PointerEvent) {
		if (event.pointerId === checklistPointerId) checklistPointerId = null;
	}

	function indentLine(index: number, delta: number): boolean {
		const line = lines[index];
		if (!line?.isCheck) return false;
		const next = Math.max(0, Math.min(MAX_TASK_INDENT, line.indent + delta));
		if (next === line.indent) return false;
		if (delta > 0) {
			const previous = [...lines.slice(0, index)].reverse().find((candidate) => candidate.isCheck);
			line.indent = Math.min(next, previous ? previous.indent + 1 : 0, MAX_TASK_INDENT);
		} else {
			line.indent = next;
		}
		return true;
	}

	function previousTaskIndex(index: number): number {
		const indent = lines[index]?.isCheck ? lines[index].indent : 0;
		for (let cursor = index - 1; cursor >= 0; cursor--) {
			const candidate = lines[cursor];
			if (!candidate.isCheck) continue;
			if (indent > 0 ? candidate.indent <= indent : candidate.indent === 0) return cursor;
		}
		return Math.max(0, index - 1);
	}

	function handleEnter(range: EditorRange) {
		let index = range.start.line;
		let offset = range.start.offset;
		if (!range.collapsed) {
			const caret = replaceSelectedRange(range);
			index = caret.line;
			offset = caret.offset;
		}
		const line = lines[index];
		if (!line) return;

		if (line.isCheck && line.text.trim() === '') {
			if (line.indent === 0) {
				const replacement = newLine();
				lines.splice(index, 1, replacement);
				if (line.id === draftTaskId) draftTaskId = null;
				focusedRootId = null;
				onExitTaskFocus?.();
				syncBody();
				focusAt(index, 0, replacement.id);
				return;
			}
			line.indent = 0;
			syncBody();
			focusTask(index);
			focusAt(index, 0, line.id);
			return;
		}

		const before = line.text.slice(0, offset);
		const after = line.text.slice(offset);
		line.text = before;
		const splitIntoSubtask = line.isCheck && line.indent === 0 && after.length > 0;
		const next = newLine(
			after,
			line.isCheck,
			false,
			splitIntoSubtask ? 1 : line.isCheck ? line.indent : 0
		);
		lines.splice(index + 1, 0, next);
		if (line.isCheck && !after.trim()) draftTaskId = next.id;
		syncBody();
		if (next.isCheck) focusTask(index + 1);
		focusAt(index + 1, 0, next.id);
	}

	function handleBackspace(range: EditorRange) {
		if (!range.collapsed || range.start.offset !== 0 || range.start.line <= 0) return false;
		const index = range.start.line;
		const line = lines[index];
		if (line.isCheck && line.text.trim() === '') {
			const targetIndex = previousTaskIndex(index);
			const target = lines[targetIndex];
			lines.splice(index, 1);
			if (line.id === draftTaskId) draftTaskId = null;
			syncBody();
			focusTask(targetIndex);
			focusAt(targetIndex, target.text.length, target.id);
			return true;
		}
		if (line.isCheck && line.indent > 0) {
			line.indent = 0;
			syncBody();
			focusTask(index);
			focusAt(index, 0, line.id);
			return true;
		}
		const previous = lines[index - 1];
		const join = previous.text.length;
		previous.text += line.text;
		lines.splice(index, 1);
		syncBody();
		focusTask(index - 1);
		focusAt(index - 1, join, previous.id);
		return true;
	}

	function handleKeydown(event: KeyboardEvent) {
		const range = editorRange();
		if (!range) return;
		if (event.key === 'Tab' && range.collapsed && lines[range.start.line]?.isCheck) {
			event.preventDefault();
			if (indentLine(range.start.line, event.shiftKey ? -1 : 1)) {
				syncBody();
				focusTask(range.start.line);
				focusAt(range.start.line, range.start.offset, lines[range.start.line].id);
			}
			return;
		}
		if (event.key === 'Enter' || event.key === 'NumpadEnter') {
			event.preventDefault();
			handleEnter(range);
			return;
		}
		if (event.key === 'Backspace' && handleBackspace(range)) event.preventDefault();
	}

	function addSubtask(rootIndex: number) {
		const root = lines[rootIndex];
		if (!root?.isCheck || root.indent !== 0) return;
		if (draftTaskId !== null) {
			const existing = lines.findIndex((line) => line.id === draftTaskId);
			if (existing >= 0) {
				focusAt(existing, 0, draftTaskId);
				return;
			}
			draftTaskId = null;
		}
		let insertAt = rootIndex + 1;
		while (insertAt < lines.length && lines[insertAt].isCheck && lines[insertAt].indent > 0)
			insertAt++;
		const draft = newLine('', true, false, 1);
		lines.splice(insertAt, 0, draft);
		draftTaskId = draft.id;
		focusedRootId = root.id;
		onFocusTask?.(insertAt);
		focusAt(insertAt, 0, draft.id);
	}

	function activateAddSubtask(event: PointerEvent, rootIndex: number) {
		// iOS does not reliably dispatch click for a non-editable button embedded in a
		// plaintext-only editing host. Activate on pointerdown and keep focus in the host.
		event.preventDefault();
		event.stopPropagation();
		addSubtask(rootIndex);
	}

	function discardEmptyDraft() {
		if (draftTaskId === null) return;
		const index = lines.findIndex((line) => line.id === draftTaskId);
		if (index < 0 || lines[index].text.trim()) {
			draftTaskId = null;
			return;
		}
		lines.splice(index, 1);
		draftTaskId = null;
		syncBody();
	}

	function handleEditorBlur(event: FocusEvent) {
		discardEmptyDraft();
		if (event.relatedTarget instanceof Node && container?.contains(event.relatedTarget)) return;
		dropTaskFocus();
	}

	$effect(() => {
		if (focusSignal <= 0 || focusSignal === handledFocusSignal) return;
		handledFocusSignal = focusSignal;
		const index = focusLine === null ? 0 : Math.max(0, Math.min(focusLine, lines.length - 1));
		void focusAfterRender(index, lines[index]?.text.length ?? 0, lines[index]?.id ?? null);
	});

	$effect(() => {
		if (focusLine === null) {
			ignoredFocusLine = null;
			focusedRootId = null;
			return;
		}
		if (focusLine === ignoredFocusLine) return;
		ignoredFocusLine = null;
		const index = Math.max(0, Math.min(focusLine, lines.length - 1));
		const root = parentTaskIndex(index);
		focusedRootId = lines[root]?.isCheck ? lines[root].id : null;
	});

	const focusedGroupRows = $derived.by(() => {
		if (focusedRootId === null) return [] as { line: Line; index: number }[];
		const rootIndex = lines.findIndex((line) => line.id === focusedRootId);
		if (rootIndex < 0 || !lines[rootIndex].isCheck) return [];
		const rows = [{ line: lines[rootIndex], index: rootIndex }];
		for (let index = rootIndex + 1; index < lines.length; index++) {
			if (lines[index].isCheck && lines[index].indent === 0) break;
			if (lines[index].isCheck) rows.push({ line: lines[index], index });
		}
		return rows;
	});

	const focusedGroupIds = $derived(new Set(focusedGroupRows.map(({ line }) => line.id)));
	const focusedGroupLastId = $derived(focusedGroupRows.at(-1)?.line.id ?? null);

	function taskShellClass(line: Line): string {
		if (!focusedGroupIds.has(line.id)) return '';
		return [
			'-mx-2 bg-black/[0.035] px-2 dark:bg-white/[0.06]',
			line.id === focusedRootId ? 'mt-0.5 rounded-t-lg pt-1' : '',
			line.id === focusedGroupLastId ? 'mb-0.5 rounded-b-lg pb-1' : ''
		]
			.filter(Boolean)
			.join(' ');
	}
</script>

<div
	bind:this={container}
	use:makeEditable
	data-body-editor
	role="textbox"
	tabindex="0"
	aria-multiline="true"
	aria-label="Note body"
	spellcheck="true"
	class="block w-full min-w-0 text-sm leading-relaxed text-[var(--shard-text)] outline-none"
	onbeforeinput={handleBeforeInput}
	oninput={handleInput}
	oncopy={handleCopy}
	oncut={handleCut}
	onpaste={handlePaste}
	onkeydown={handleKeydown}
	onpointerup={finishChecklistPointer}
	onpointercancel={cancelChecklistPointer}
	onclick={handleEditorClick}
	oncompositionstart={() => (composing = true)}
	oncompositionend={() => {
		composing = false;
		readDomIntoLines();
	}}
	onblur={handleEditorBlur}
>
	{#each lines as line, index (line.id)}
		<div
			data-editor-line={index}
			data-line-id={line.id}
			data-focus-group={line.id === focusedRootId ? '' : undefined}
			class={line.isCheck ? taskShellClass(line) : ''}
		>
			<div
				data-task-row={line.isCheck ? '' : undefined}
				class="flex w-full min-w-0 items-start gap-2 py-0.5"
				style={line.indent > 0 ? `padding-left: ${line.indent * 1.25}rem` : undefined}
			>
				{#if line.isCheck}
					<button
						type="button"
						contenteditable="false"
						data-checklist-toggle
						class="checklist-toggle shrink-0 {line.indent > 0 ? 'checklist-toggle-sub' : ''}"
						class:checked={line.checked}
						onpointerdown={keepEditorFocus}
						onclick={(event) => toggleCheck(index, event)}
						aria-label={line.indent > 0 ? 'Toggle sub-task' : 'Toggle item'}
						aria-pressed={line.checked}
					>
						{#if line.checked}
							<svg viewBox="0 0 16 16" class="checklist-toggle-mark" aria-hidden="true">
								<path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
							</svg>
						{/if}
					</button>
				{/if}
				<span
					data-line-text
					use:syncEditableText={line.text}
					data-placeholder={line.text.length === 0
						? line.isCheck
							? line.indent > 0
								? 'Sub-task'
								: 'Task'
							: index === 0 && lines.length === 1
								? placeholder
								: ''
						: undefined}
					class="block min-h-[1lh] min-w-0 flex-1 whitespace-pre-wrap break-words outline-none {line.checked
						? 'line-through opacity-50'
						: ''} {line.indent > 0 ? 'text-[13px]' : ''}"
				></span>
			</div>
			{#if line.id === focusedGroupLastId}
				<button
					type="button"
					contenteditable="false"
					data-add-subtask
					aria-label="Add sub-task"
					class="flex select-none items-center rounded px-1 py-1 pl-6 text-left text-xs text-[var(--shard-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--shard-text)] dark:hover:bg-white/10"
					onpointerdown={(event) => activateAddSubtask(event, focusedGroupRows[0]?.index ?? -1)}
				>
					<span class="add-subtask-label" aria-hidden="true"></span>
				</button>
			{/if}
		</div>
	{/each}
</div>

<style>
	[data-line-text][data-placeholder]:empty::before {
		content: attr(data-placeholder);
		color: var(--shard-text-muted);
		pointer-events: none;
	}

	.add-subtask-label::before {
		content: '+  Add sub-task';
	}
</style>
