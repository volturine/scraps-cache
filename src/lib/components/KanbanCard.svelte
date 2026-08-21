<script lang="ts">
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { NOTE_COLORS, NOTE_DARK_COLORS, type Note, type NoteColor } from '$lib/types';
	import { activateOnKeyboard } from '$lib/utils';
	import { PHONE_MEDIA } from '$lib/appViewport';
	import { isSidebarEdgeStart } from '$lib/sidebarSwipe';
	import NoteBodyDisplay from './NoteBodyDisplay.svelte';
	import ReminderLabel from './ReminderLabel.svelte';

	let {
		note,
		sourceColumnId,
		onOpen,
		onMove
	}: {
		note: Note;
		sourceColumnId: string;
		onOpen: (id: string) => void;
		onMove: (noteId: string, sourceColumnId: string, destinationColumnId: string) => void;
	} = $props();

	const labelsForNote = $derived(
		note.labels
			.map((id) => notesStore.labelsById.get(id))
			.filter((label): label is NonNullable<typeof label> => !!label)
	);

	function background(color: NoteColor): string {
		return uiStore.effectiveDark ? NOTE_DARK_COLORS[color] : NOTE_COLORS[color];
	}

	function interactiveTarget(target: EventTarget | null): boolean {
		return (
			target instanceof Element &&
			Boolean(
				target.closest(
					'button, a, input, textarea, select, [data-checklist-toggle], [data-photo], [data-file], [data-link]'
				)
			)
		);
	}

	let pointerId: number | null = null;
	let startX = 0;
	let startY = 0;
	let dragX = $state(0);
	let dragY = $state(0);
	let touchDragging = $state(false);
	let suppressOpen = false;
	let nativeDragGhost: HTMLElement | null = null;

	function resetTouchDrag() {
		pointerId = null;
		touchDragging = false;
		dragX = 0;
		dragY = 0;
	}

	function onPointerDown(event: PointerEvent) {
		// Desktop gets the native HTML drag path; this path makes touch dragging work on iPhone.
		if (event.pointerType === 'mouse' || interactiveTarget(event.target)) return;
		if (window.matchMedia(PHONE_MEDIA).matches && isSidebarEdgeStart(event.clientX)) return;
		pointerId = event.pointerId;
		startX = event.clientX;
		startY = event.clientY;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onPointerMove(event: PointerEvent) {
		if (event.pointerId !== pointerId) return;
		dragX = event.clientX - startX;
		dragY = event.clientY - startY;
		if (!touchDragging && Math.hypot(dragX, dragY) < 10) return;
		touchDragging = true;
		event.preventDefault();
	}

	function onPointerUp(event: PointerEvent) {
		if (event.pointerId !== pointerId) return;
		if (touchDragging) {
			suppressOpen = true;
			const target = document.elementFromPoint(event.clientX, event.clientY);
			const destination =
				target instanceof Element
					? target.closest<HTMLElement>('[data-kanban-column]')?.dataset.kanbanColumn
					: undefined;
			if (destination) onMove(note.id, sourceColumnId, destination);
			setTimeout(() => {
				suppressOpen = false;
			}, 0);
		}
		resetTouchDrag();
	}

	function clearNativeDragGhost() {
		nativeDragGhost?.remove();
		nativeDragGhost = null;
	}

	function solidColumnBackground(element: HTMLElement): string {
		const layers: HTMLElement[] = [];
		for (let current: HTMLElement | null = element; current; current = current.parentElement)
			layers.push(current);
		const seed = uiStore.effectiveDark ? 0 : 255;
		let red = seed;
		let green = seed;
		let blue = seed;
		for (const layer of layers.reverse()) {
			const parts = getComputedStyle(layer)
				.backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1]
				.split(',')
				.map(Number);
			if (!parts || parts.length < 3) continue;
			const alpha = parts[3] ?? 1;
			red = parts[0] * alpha + red * (1 - alpha);
			green = parts[1] * alpha + green * (1 - alpha);
			blue = parts[2] * alpha + blue * (1 - alpha);
		}
		return `rgb(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)})`;
	}

	function setNativeDragGhost(event: DragEvent) {
		if (!event.dataTransfer || typeof document === 'undefined') return;
		clearNativeDragGhost();
		const source = event.currentTarget as HTMLElement;
		const rect = source.getBoundingClientRect();
		const column = source.closest<HTMLElement>('[data-kanban-column]');
		const ghost = document.createElement('div');
		const preview = source.cloneNode(true) as HTMLElement;
		ghost.setAttribute('aria-hidden', 'true');
		preview.removeAttribute('draggable');
		preview.setAttribute('aria-hidden', 'true');
		// Preserve the real card exactly. Only the transparent pixels outside its rounded
		// corners are replaced by the opaque, composited column colour.
		ghost.style.cssText = [
			'position: fixed',
			'left: -10000px',
			'top: -10000px',
			'box-sizing: border-box',
			`width: ${Math.round(rect.width + 16)}px`,
			'padding: 8px',
			`background: ${solidColumnBackground(column ?? source)}`,
			'border-radius: 0',
			'pointer-events: none'
		].join(';');
		preview.style.cssText += `; width: ${Math.round(rect.width)}px; left: 0; top: 0; transition: none; pointer-events: none;`;
		ghost.append(preview);
		document.body.append(ghost);
		nativeDragGhost = ghost;
		const offsetX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
		const offsetY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
		event.dataTransfer.setDragImage(ghost, Math.round(offsetX + 8), Math.round(offsetY + 8));
		setTimeout(clearNativeDragGhost, 0);
	}

	function onNativeDragStart(event: DragEvent) {
		if (!event.dataTransfer) return;
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData(
			'application/x-scraps-cache-kanban',
			JSON.stringify({ noteId: note.id, sourceColumnId })
		);
		setNativeDragGhost(event);
		suppressOpen = true;
	}

	function onNativeDragEnd() {
		clearNativeDragGhost();
		setTimeout(() => {
			suppressOpen = false;
		}, 0);
	}

	function open(event: MouseEvent) {
		if (suppressOpen || interactiveTarget(event.target)) return;
		onOpen(note.id);
	}
</script>

<div
	role="button"
	tabindex="0"
	draggable="true"
	class="kanban-card relative cursor-grab overflow-hidden rounded-xl border border-black/5 shadow-sm active:cursor-grabbing dark:border-white/10 {touchDragging
		? 'z-20 opacity-65 shadow-lg'
		: ''}"
	style="background-color: {background(note.color)}; left: {touchDragging
		? dragX
		: 0}px; top: {touchDragging ? dragY : 0}px; transition: {touchDragging
		? 'none'
		: 'left 120ms ease, top 120ms ease, box-shadow 120ms ease'};"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={resetTouchDrag}
	ondragstart={onNativeDragStart}
	ondragend={onNativeDragEnd}
	onclick={open}
	onkeydown={(event) => activateOnKeyboard(event, () => onOpen(note.id))}
	aria-label={`Drag ${note.title || 'untitled note'} to another Kanban column`}
>
	<div class="scrollable max-h-[220px] overflow-x-hidden overflow-y-auto p-3">
		{#if note.reminder != null}
			<div class="mb-1">
				<ReminderLabel reminder={note.reminder} variant="inline" />
			</div>
		{/if}
		{#if note.title}
			<h3
				class="mb-1 text-[15px] font-semibold leading-snug tracking-tight text-[var(--scraps-cache-text)]"
			>
				{note.title}
			</h3>
		{/if}
		<NoteBodyDisplay {note} />
	</div>

	{#if labelsForNote.length}
		<div class="flex flex-wrap gap-1 px-3 pb-3">
			{#each labelsForNote as label (label.id)}
				<span
					class="rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-[var(--scraps-cache-text-muted)] dark:bg-white/10"
					>{label.name}</span
				>
			{/each}
		</div>
	{/if}
</div>
