<script lang="ts">
	import { flushSync, tick } from 'svelte';
	import { CHECK_RE, formatCheckLine, parseCheckLine } from '$lib/checklistBody';

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
			if (check) return newLine(check.text, true, check.checked, check.indent);
			return newLine(text, false);
		});
	}

	function serializeLines(rows: Line[]): string {
		return rows
			.map((l) => (l.isCheck ? formatCheckLine(l.indent, l.checked, l.text) : l.text))
			.join('\n');
	}

	let lines = $state<Line[]>([newLine()]);
	let container: HTMLDivElement | null = $state(null);
	let focusedRootId = $state<number | null>(null);
	let handledInlineFocusLine: number | null = null;
	// Empty checklist rows created by Enter or Add sub-task stay UI-only until typed.
	let draftTaskId = $state<number | null>(null);
	let handledFocusSignal = 0;
	let focusRequestSeq = 0;

	let lastBody = '';
	$effect(() => {
		if (body !== lastBody) {
			lastBody = body;
			lines = parseBodyToLines(body);
		}
	});

	function syncBody() {
		// A blank task draft is UI-only until the user enters text.
		const newBody = serializeLines(lines.filter((line) => line.id !== draftTaskId));
		lastBody = newBody;
		body = newBody;
		oninput?.();
	}

	function discardEmptyDraft(id: number) {
		if (draftTaskId !== id) return;
		const index = lines.findIndex((line) => line.id === id);
		if (index < 0 || lines[index].text.trim()) {
			draftTaskId = null;
			return;
		}
		lines.splice(index, 1);
		draftTaskId = null;
		syncBody();
	}

	function previousTaskIndex(index: number): number {
		const indent = lines[index]?.isCheck ? lines[index].indent : 0;
		for (let i = index - 1; i >= 0; i--) {
			const candidate = lines[i];
			if (!candidate.isCheck) continue;
			// A sibling sub-task wins; otherwise this is the parent task.
			if (indent > 0 ? candidate.indent <= indent : candidate.indent === 0) return i;
		}
		return Math.max(0, index - 1);
	}

	function onLineInput(i: number, e: Event) {
		const input = e.target as HTMLTextAreaElement;
		const value = input.value;

		// Plain text line → auto-convert to checklist when user types [ ] / [x]
		if (!lines[i].isCheck) {
			const m = value.match(CHECK_RE);
			if (m) {
				const check = parseCheckLine(value);
				lines[i].isCheck = true;
				lines[i].checked = check?.checked ?? false;
				lines[i].indent = check?.indent ?? 0;
				lines[i].text = check?.text ?? '';
				syncBody();
				return;
			}
		}

		lines[i].text = value;
		if (lines[i].id === draftTaskId && value.trim()) draftTaskId = null;
		syncBody();
	}

	/** Consecutive non-task lines share one textarea so multi-line select works. Tasks stay per-row. */
	function isPlainRunStart(index: number): boolean {
		if (!lines[index] || lines[index].isCheck) return false;
		return index === 0 || lines[index - 1].isCheck;
	}

	function plainRunEnd(start: number): number {
		let end = start;
		while (end + 1 < lines.length && !lines[end + 1].isCheck) end += 1;
		return end;
	}

	function plainRunText(start: number): string {
		return lines
			.slice(start, plainRunEnd(start) + 1)
			.map((line) => line.text)
			.join('\n');
	}

	function onPlainRunInput(start: number, e: Event) {
		const input = e.target as HTMLTextAreaElement;
		const selectionStart = input.selectionStart;
		const selectionEnd = input.selectionEnd;
		const parts = input.value.split('\n');
		const end = plainRunEnd(start);
		const oldCount = end - start + 1;
		const oldLines = lines.slice(start, end + 1);
		const next: Line[] = parts.map((part, offset) => {
			const existing = oldLines[offset];
			const checkMatch = part.match(CHECK_RE);
			if (checkMatch) {
				const check = parseCheckLine(part);
				if (existing) {
					existing.isCheck = true;
					existing.checked = check?.checked ?? false;
					existing.indent = check?.indent ?? 0;
					existing.text = check?.text ?? '';
					return existing;
				}
				return newLine(check?.text ?? '', true, check?.checked ?? false, check?.indent ?? 0);
			}
			if (existing && !existing.isCheck) {
				existing.text = part;
				existing.isCheck = false;
				existing.checked = false;
				existing.indent = 0;
				return existing;
			}
			return newLine(part, false);
		});
		if (next.length === 0) next.push(newLine());
		lines.splice(start, oldCount, ...next);
		syncBody();
		// Keep caret stable after the run is re-rendered from state.
		const runStart = start;
		void tick().then(() => {
			requestAnimationFrame(() => {
				const el = container?.querySelector(
					`[data-plain-run="${runStart}"]`
				) as HTMLTextAreaElement | null;
				if (!el) return;
				const max = el.value.length;
				el.setSelectionRange(Math.min(selectionStart, max), Math.min(selectionEnd, max));
			});
		});
	}

	function onPlainRunKeydown(e: KeyboardEvent, start: number) {
		// Enter stays native so multi-line plain text can grow inside one control.
		if (e.key !== 'Backspace' || start <= 0) return;
		const input = e.target as HTMLTextAreaElement;
		if (input.selectionStart !== 0 || input.selectionEnd !== 0) return;
		e.preventDefault();
		// Merge the first plain line into the previous row (task or text).
		const first = lines[start];
		const prev = lines[start - 1];
		const prevLen = prev.text.length;
		prev.text += first.text;
		lines.splice(start, 1);
		syncBody();
		focusLineNow(start - 1, prevLen, prev.id);
	}

	function toggleCheck(i: number, e: MouseEvent) {
		e.stopPropagation();
		lines[i].checked = !lines[i].checked;
		syncBody();
	}

	function indentLine(i: number, delta: number) {
		const line = lines[i];
		if (!line.isCheck) return false;
		const next = Math.max(0, Math.min(MAX_TASK_INDENT, line.indent + delta));
		if (next === line.indent) return false;
		// Sub-task can only be one level deeper than the previous checklist item.
		if (delta > 0) {
			const prev = [...lines.slice(0, i)].reverse().find((row) => row.isCheck);
			const maxAllowed = prev ? prev.indent + 1 : 0;
			line.indent = Math.min(next, maxAllowed, MAX_TASK_INDENT);
		} else {
			line.indent = next;
		}
		return true;
	}

	function onLineKeydown(e: KeyboardEvent, i: number) {
		if (e.key === 'Tab' && lines[i].isCheck) {
			e.preventDefault();
			if (indentLine(i, e.shiftKey ? -1 : 1)) {
				syncBody();
				const input = e.target as HTMLTextAreaElement;
				focusLineNow(i, input.selectionStart);
			}
			return;
		}

		if (e.key === 'Enter' || e.key === 'NumpadEnter') {
			e.preventDefault();
			const line = lines[i];
			const input = e.target as HTMLTextAreaElement;
			const start = input.selectionStart ?? 0;
			const end = input.selectionEnd ?? start;

			if (line.isCheck && line.text.trim() === '') {
				if (line.indent === 0) {
					// Empty root task + Enter → remove the task and leave an editable
					// plain-text line in its place. This also applies to a newly added,
					// unsaved root task rather than returning focus to the prior row.
					const replacement = newLine();
					lines.splice(i, 1, replacement);
					if (line.id === draftTaskId) draftTaskId = null;
					syncBody();
					focusLineNow(i, 0, replacement.id);
					return;
				}

				if (line.id === draftTaskId) {
					const prevIndex = Math.max(0, i - 1);
					const prevId = lines[prevIndex]?.id;
					const caret = lines[prevIndex]?.text.length ?? 0;
					// Focus the surviving row BEFORE removing this one — mobile drops
					// the keyboard if the active element is destroyed first.
					handoffFocusToExisting(prevIndex, caret, prevId);
					lines.splice(i, 1);
					draftTaskId = null;
					const focusIndex = prevId != null ? lines.findIndex((row) => row.id === prevId) : -1;
					const idx = focusIndex >= 0 ? focusIndex : Math.max(0, i - 1);
					handoffFocusToExisting(idx, caret, prevId);
					return;
				}
				// Empty sub-task + Enter → outdent one level
				line.indent -= 1;
				syncBody();
				handoffFocusToExisting(i, 0, line.id);
			} else {
				// Split at the cursor: text after it moves to the newly-created line.
				const before = line.text.slice(0, start);
				const after = line.text.slice(end);
				line.text = before;
				// A split with trailing text turns that remainder into a direct sub-task.
				// At the end of a task (or within a sub-task), Enter stays at the same level.
				const splitIntoSubtask = line.isCheck && line.indent === 0 && after.length > 0;
				if (line.isCheck) {
					const next = newLine(after, true, false, splitIntoSubtask ? 1 : line.indent);
					lines.splice(i + 1, 0, next);
					if (!after.trim()) draftTaskId = next.id;
					syncBody();
					// Keep inline focus chrome on the new row (or its root for sub-tasks).
					const rootId = next.indent > 0 ? lines[parentTaskIndex(i + 1)]?.id : next.id;
					if (rootId != null) focusedRootId = rootId;
					onFocusTask?.(i + 1);
					// Synchronous focus is required: await/rAF lose the mobile user-gesture.
					focusLineNow(i + 1, 0, next.id);
				} else {
					const next = newLine(after);
					lines.splice(i + 1, 0, next);
					syncBody();
					focusLineNow(i + 1, 0, next.id);
				}
			}
			return;
		}

		if (e.key === 'Backspace' && i > 0) {
			const input = e.target as HTMLTextAreaElement;
			if (input.selectionStart === 0 && input.selectionEnd === 0) {
				e.preventDefault();
				const line = lines[i];
				if (line.isCheck && line.text.trim() === '') {
					// Remove an empty sub-task and return to its previous sibling, or its
					// parent root when it was the first/only sub-task.
					const targetIndex = previousTaskIndex(i);
					const targetId = lines[targetIndex]?.id;
					const caret = lines[targetIndex]?.text.length ?? 0;
					// Critical: hand focus to the upper task while this empty row still
					// exists. Deleting the active textarea first leaves mobile without
					// a focused field even if the caret position is updated later.
					handoffFocusToExisting(targetIndex, caret, targetId);
					lines.splice(i, 1);
					if (line.id === draftTaskId) draftTaskId = null;
					syncBody();
					const nextIndex = targetId != null ? lines.findIndex((row) => row.id === targetId) : -1;
					const focusIndex = nextIndex >= 0 ? nextIndex : Math.max(0, i - 1);
					handoffFocusToExisting(focusIndex, caret, targetId);
					return;
				}
				// At start of a non-empty indented task: outdent before merging.
				if (line.isCheck && line.indent > 0) {
					line.indent -= 1;
					syncBody();
					handoffFocusToExisting(i, 0, line.id);
					return;
				}
				const prevLine = lines[i - 1];
				const prevLen = prevLine.text.length;
				const prevId = prevLine.id;
				// Focus the upper row first, then merge text into it.
				handoffFocusToExisting(i - 1, prevLen, prevId);
				prevLine.text += lines[i].text;
				lines.splice(i, 1);
				syncBody();
				const focusIndex = lines.findIndex((row) => row.id === prevId);
				const idx = focusIndex >= 0 ? focusIndex : Math.max(0, i - 1);
				// Caret at the join point after the original previous text.
				handoffFocusToExisting(idx, prevLen, prevId);
			}
		}
	}

	function parentTaskIndex(index: number): number {
		const line = lines[index];
		if (!line?.isCheck || line.indent === 0) return index;
		for (let i = index - 1; i >= 0; i--) {
			if (lines[i].isCheck && lines[i].indent === 0) return i;
		}
		return index;
	}

	function addSubtask(rootIndex: number) {
		const root = lines[rootIndex];
		// Two levels only: a sub-task cannot have sub-tasks.
		if (!root?.isCheck || root.indent !== 0) return;
		if (draftTaskId !== null) {
			const existingIndex = lines.findIndex((line) => line.id === draftTaskId);
			if (existingIndex >= 0) {
				focusLineNow(existingIndex, 0, lines[existingIndex]?.id);
				return;
			}
			// Discard a stale draft marker and make a fresh editable row.
			draftTaskId = null;
		}
		let insertAt = rootIndex + 1;
		while (
			insertAt < lines.length &&
			(!lines[insertAt].isCheck || lines[insertAt].indent > root.indent)
		) {
			insertAt += 1;
		}
		const draft = newLine('', true, false, 1);
		lines.splice(insertAt, 0, draft);
		draftTaskId = draft.id;
		focusedRootId = root.id;
		onFocusTask?.(insertAt);
		focusLineNow(insertAt, 0, draft.id);
	}

	function resolveFocusElement(
		idx: number,
		lineId: number | null,
		cursor: number | null
	): { el: HTMLTextAreaElement; caret: number } | null {
		let resolvedIndex = idx;
		if (lineId != null) {
			const byId = lines.findIndex((line) => line.id === lineId);
			if (byId >= 0) resolvedIndex = byId;
		}
		let caret = cursor ?? lines[resolvedIndex]?.text.length ?? 0;
		// Prefer stable line id so inserts/deletes cannot point at the wrong row.
		let el =
			(lineId != null
				? (container?.querySelector(`[data-line-id="${lineId}"]`) as HTMLTextAreaElement | null)
				: null) ??
			(container?.querySelector(`[data-line="${resolvedIndex}"]`) as HTMLTextAreaElement | null);
		// Plain multi-line runs use one textarea keyed by the run start.
		if (!el && lines[resolvedIndex] && !lines[resolvedIndex].isCheck) {
			let start = resolvedIndex;
			while (start > 0 && !lines[start - 1].isCheck) start -= 1;
			el = container?.querySelector(`[data-plain-run="${start}"]`) as HTMLTextAreaElement | null;
			if (el) {
				let offset = caret;
				for (let i = start; i < resolvedIndex; i++) offset += (lines[i]?.text.length ?? 0) + 1;
				caret = offset;
			}
		}
		if (!el) return null;
		return { el, caret };
	}

	function applyFocusToElement(el: HTMLTextAreaElement, caret: number | null) {
		try {
			el.focus({ preventScroll: true });
		} catch {
			el.focus();
		}
		if (caret !== null) {
			const max = el.value.length;
			const next = Math.max(0, Math.min(caret, max));
			el.setSelectionRange(next, next);
		}
		// Keep the selected task visible without snapping the whole note back to its
		// old scroll position. This is especially important when iOS has panned for
		// the keyboard: restoring the old position fights that native movement.
		const scroller = container?.closest('.scrollable') as HTMLElement | null;
		if (!scroller) return;
		const fieldRect = el.getBoundingClientRect();
		const scrollerRect = scroller.getBoundingClientRect();
		const padding = 12;
		let nextTop = scroller.scrollTop;
		if (fieldRect.top < scrollerRect.top + padding) {
			nextTop += fieldRect.top - scrollerRect.top - padding;
		} else if (fieldRect.bottom > scrollerRect.bottom - padding) {
			nextTop += fieldRect.bottom - scrollerRect.bottom + padding;
		}
		scroller.scrollTop = Math.max(0, nextTop);
	}

	/** Keep NoteEditor taskFocusLine + root chrome aligned with the active row. */
	function setTaskFocusChrome(index: number) {
		const line = lines[index];
		if (!line) return;
		if (line.isCheck) {
			const root = parentTaskIndex(index);
			focusedRootId = lines[root]?.isCheck ? lines[root].id : line.id;
		}
		onFocusTask?.(index);
	}

	/**
	 * Move keyboard focus to a row that is already mounted (e.g. parent when deleting
	 * a sub-task). Must run before removing the currently focused element on mobile.
	 */
	function handoffFocusToExisting(idx: number, cursor: number | null = 0, lineId?: number | null) {
		const requestId = ++focusRequestSeq;
		const resolvedId = lineId ?? lines[idx]?.id ?? null;
		setTaskFocusChrome(idx);
		// Prefer live DOM immediately — no flush needed when the target already exists.
		const live = resolveFocusElement(idx, resolvedId, cursor);
		if (live) {
			applyFocusToElement(live.el, live.caret);
		}
		// Then flush any pending state (e.g. after splice) and re-assert focus/caret.
		flushSync();
		if (requestId !== focusRequestSeq) return;
		const resolved = resolveFocusElement(idx, resolvedId, cursor);
		if (resolved) applyFocusToElement(resolved.el, resolved.caret);
	}

	/**
	 * Focus a task/text row after state mutations that create new DOM (Enter / Add sub-task).
	 * Uses flushSync so the new textarea exists and receives focus inside the same
	 * user-gesture (keydown/click). Deferred focus (tick/rAF alone) fails on mobile
	 * and leaves the caret on the previous task.
	 */
	function focusLineNow(idx: number, cursor: number | null = 0, lineId?: number | null) {
		const requestId = ++focusRequestSeq;
		const resolvedId = lineId ?? lines[idx]?.id ?? null;
		flushSync();
		if (requestId !== focusRequestSeq) return;
		const resolved = resolveFocusElement(idx, resolvedId, cursor);
		if (resolved) {
			applyFocusToElement(resolved.el, resolved.caret);
			return;
		}
		// Rare: DOM not ready even after flush — retry once on the next frame.
		requestAnimationFrame(() => {
			if (requestId !== focusRequestSeq) return;
			const retry = resolveFocusElement(idx, resolvedId, cursor);
			if (retry) applyFocusToElement(retry.el, retry.caret);
		});
	}

	async function focusLineAfterRender(
		idx: number,
		cursor: number | null,
		lineId: number | null = null
	) {
		const requestId = ++focusRequestSeq;
		await tick();
		if (requestId !== focusRequestSeq) return;
		const resolved = resolveFocusElement(idx, lineId, cursor);
		if (resolved) applyFocusToElement(resolved.el, resolved.caret);
	}

	// Focus a tapped task, or leave the sub-view and restore the full note.
	$effect(() => {
		if (focusSignal <= 0 || focusSignal === handledFocusSignal) return;
		handledFocusSignal = focusSignal;
		if (focusLine === null) {
			const restoreLineId = focusedRootId;
			const fallbackLineId = focusedRootId;
			if (draftTaskId !== null) {
				lines = lines.filter((line) => line.id !== draftTaskId);
				draftTaskId = null;
			}
			focusedRootId = null;
			const restoreIndex = lines.findIndex((line) => line.id === restoreLineId);
			const fallbackIndex = lines.findIndex((line) => line.id === fallbackLineId);
			const index = restoreIndex >= 0 ? restoreIndex : fallbackIndex >= 0 ? fallbackIndex : 0;
			const restoreId = lines[index]?.id ?? restoreLineId;
			void focusLineAfterRender(index, lines[index]?.text.length ?? 0, restoreId ?? null);
			return;
		}

		let selectedLine = Math.max(0, Math.min(focusLine, lines.length - 1));
		const selectedId = lines[selectedLine]?.id;
		if (draftTaskId !== null) {
			lines = lines.filter((line) => line.id !== draftTaskId);
			draftTaskId = null;
		}
		selectedLine = Math.max(
			0,
			lines.findIndex((line) => line.id === selectedId)
		);
		const rootLine = parentTaskIndex(selectedLine);
		focusedRootId = lines[rootLine]?.isCheck ? lines[rootLine].id : null;
		// Preserve the exact task the user tapped; the root only controls which
		// inline group is expanded, not where text focus is moved.
		// Tap path: browser already focused the textarea — only restore when needed.
		void focusLineAfterRender(
			selectedLine,
			lines[selectedLine]?.text.length ?? 0,
			lines[selectedLine]?.id ?? selectedId ?? null
		);
	});

	// A direct task tap keeps the textarea mounted and native-focused. Update
	// only the inline group chrome; re-focusing here would restart iOS keyboard
	// scrolling and produce a visible shake.
	$effect(() => {
		if (focusLine === null) {
			handledInlineFocusLine = null;
			if (draftTaskId !== null) {
				lines = lines.filter((line) => line.id !== draftTaskId);
				draftTaskId = null;
			}
			focusedRootId = null;
			return;
		}
		if (focusLine === handledInlineFocusLine) return;
		handledInlineFocusLine = focusLine;
		const selectedLine = Math.max(0, Math.min(focusLine, lines.length - 1));
		const rootLine = parentTaskIndex(selectedLine);
		focusedRootId = lines[rootLine]?.isCheck ? lines[rootLine].id : null;
	});

	const focusedRootIndent = $derived(
		focusedRootId === null ? 0 : (lines.find((line) => line.id === focusedRootId)?.indent ?? 0)
	);

	/** Root + its sub-tasks — used for the shared focus styling. */
	const focusedGroupRows = $derived.by(() => {
		if (focusedRootId === null) return [] as { line: Line; index: number }[];
		const rootIndex = lines.findIndex((line) => line.id === focusedRootId);
		if (rootIndex < 0 || !lines[rootIndex].isCheck) return [];
		const root = lines[rootIndex];
		const rows = [{ line: root, index: rootIndex }];
		for (let index = rootIndex + 1; index < lines.length; index++) {
			const line = lines[index];
			if (line.isCheck && line.indent <= root.indent) break;
			if (line.isCheck && line.indent > root.indent) rows.push({ line, index });
		}
		return rows;
	});

	const focusedGroupIds = $derived(new Set(focusedGroupRows.map(({ line }) => line.id)));
	const focusedGroupLastId = $derived(focusedGroupRows.at(-1)?.line.id ?? null);

	function taskShellClass(lineId: number): string {
		if (!focusedGroupIds.has(lineId)) return '';
		return [
			'-mx-2 bg-black/[0.035] px-2 dark:bg-white/[0.06]',
			lineId === focusedRootId ? 'mt-0.5 rounded-t-lg pt-1' : '',
			lineId === focusedGroupLastId ? 'mb-0.5 rounded-b-lg pb-1' : ''
		]
			.filter(Boolean)
			.join(' ');
	}
</script>

{#snippet taskRow(line: Line, i: number)}
	<div
		data-task-row
		class="flex w-full min-w-0 items-start gap-2 py-0.5"
		style={line.indent > 0 ? `padding-left: ${line.indent * 1.25}rem` : undefined}
	>
		<button
			type="button"
			data-checklist-toggle
			class="checklist-toggle shrink-0 {line.indent > 0 ? 'checklist-toggle-sub' : ''}"
			class:checked={line.checked}
			onclick={(e) => toggleCheck(i, e)}
			aria-label={line.indent > 0 ? 'Toggle sub-task' : 'Toggle item'}
			aria-pressed={line.checked}
		>
			{#if line.checked}
				<svg viewBox="0 0 16 16" class="checklist-toggle-mark" aria-hidden="true">
					<path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
				</svg>
			{/if}
		</button>
		<textarea
			rows="1"
			data-line={i}
			data-line-id={line.id}
			value={line.text}
			oninput={(e) => onLineInput(i, e)}
			onblur={() => discardEmptyDraft(line.id)}
			onkeydown={(e) => onLineKeydown(e, i)}
			enterkeyhint="enter"
			onfocus={() => {
				if (lines[parentTaskIndex(i)]?.id !== focusedRootId) onFocusTask?.(i);
			}}
			placeholder={line.indent > 0 ? 'Sub-task' : 'Task'}
			class="flex-1 min-w-0 resize-none overflow-hidden bg-transparent outline-none placeholder:text-[var(--shard-text-muted)] [field-sizing:content] {line.checked
				? 'line-through opacity-50'
				: ''} {line.indent > 0 ? 'text-[13px]' : ''}"></textarea>
	</div>
{/snippet}

<div
	bind:this={container}
	class="block w-full min-w-0 text-sm leading-relaxed text-[var(--shard-text)]"
>
	{#each lines as line, i (line.id)}
		{#if line.isCheck}
			<!--
				Every task keeps the same keyed shell and textarea while focus styling changes.
				Replacing rows here loses the browser-owned caret and breaks native keyboard scrolling.
			-->
			<div
				data-task-shell
				data-focus-group={line.id === focusedRootId ? '' : undefined}
				class={taskShellClass(line.id)}
			>
				{@render taskRow(line, i)}
				{#if line.id === focusedGroupLastId && focusedRootIndent === 0}
					<button
						type="button"
						data-add-subtask
						class="mt-0.5 flex items-center gap-1.5 rounded px-1 py-1 pl-6 text-left text-xs text-[var(--shard-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--shard-text)] dark:hover:bg-white/10"
						onclick={() => addSubtask(focusedGroupRows[0]?.index ?? -1)}
					>
						<span class="text-base leading-none" aria-hidden="true">+</span>
						Add sub-task
					</button>
				{/if}
			</div>
		{:else if isPlainRunStart(i)}
			<!-- One textarea for consecutive plain lines: multi-line select without affecting task focus. -->
			<textarea
				rows={plainRunEnd(i) - i + 1}
				data-line={i}
				data-line-id={line.id}
				data-plain-run={i}
				value={plainRunText(i)}
				oninput={(e) => onPlainRunInput(i, e)}
				onkeydown={(e) => onPlainRunKeydown(e, i)}
				placeholder={i === 0 && plainRunEnd(i) === 0 ? placeholder : ''}
				class="block w-full min-w-0 resize-none overflow-hidden bg-transparent py-0.5 outline-none placeholder:text-[var(--shard-text-muted)] [field-sizing:content]"
			></textarea>
		{/if}
	{/each}
</div>
