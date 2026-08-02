<script lang="ts">
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { KEEP_COLORS, KEEP_DARK_COLORS, type Note, type NoteColor } from '$lib/types';
	import { activateOnKeyboard, formatReminder } from '$lib/utils';
	import { cardSwipeStyle, createCardSwipe } from '$lib/cardSwipe';
	import NoteBodyDisplay from './NoteBodyDisplay.svelte';

	let {
		note,
		onOpen
	}: {
		note: Note;
		onOpen: (id: string) => void;
	} = $props();

	function bgColor(c: NoteColor): string {
		return uiStore.effectiveDark ? KEEP_DARK_COLORS[c] : KEEP_COLORS[c];
	}

	function openUnlessAction(e: MouseEvent) {
		if (swipe.wasDrag()) {
			e.stopPropagation();
			return;
		}
		const t = e.target as HTMLElement;
		if (t.closest('[data-checklist-toggle], [data-photo], [data-file], [data-link]')) return;
		onOpen(note.id);
	}

	const labelsForNote = $derived(
		note.labels
			.map((id) => notesStore.labels.find((l) => l.id === id))
			.filter((l): l is NonNullable<typeof l> => !!l)
	);

	let offsetX = $state(0);
	let dragging = $state(false);

	const swipe = createCardSwipe({
		onSwipeLeft: () => notesStore.toggleArchive(note.id),
		onSwipeRight: () => notesStore.trashNote(note.id),
		setVisual: (s) => {
			offsetX = s.offsetX;
			dragging = s.dragging;
		}
	});
</script>

<div class="relative overflow-hidden rounded-lg">
	{#if offsetX < 0}
		<div class="absolute inset-0 flex items-center justify-end rounded-lg bg-green-500 pr-4 text-white">
			<svg viewBox="0 0 24 24" class="h-6 w-6 fill-current"><path d="M20 6h-8V4H4v2H2v4h20V6h-2zM4 12v8h16v-8H4z"/></svg>
		</div>
	{:else if offsetX > 0}
		<div class="absolute inset-0 flex items-center justify-start rounded-lg bg-red-500 pl-4 text-white">
			<svg viewBox="0 0 24 24" class="h-6 w-6 fill-current"><path d="M6 7h12v13H6zM9 4h6v2h2v2H7V6h2zM10 10v6M14 10v6" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
		</div>
	{/if}

		<div
			role="button"
			tabindex="0"
			aria-label={`Open ${note.title || 'untitled note'}`}
		class="relative z-[1] flex w-full max-h-[320px] cursor-pointer flex-col overflow-hidden rounded-lg border border-black/5 shadow-sm transition-shadow dark:border-white/10"
		style="background-color: {bgColor(note.color)}; {cardSwipeStyle(offsetX, dragging)}"
		class:shadow-md={note.pinned}
		onpointerdown={swipe.onPointerDown}
		onpointermove={swipe.onPointerMove}
		onpointerup={swipe.onPointerUp}
		onpointercancel={swipe.onPointerCancel}
			onclick={openUnlessAction}
			onkeydown={(event) => activateOnKeyboard(event, () => onOpen(note.id))}
	>
		<div class="scrollable min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
			{#if note.reminder != null}
				<div
					class="flex items-center gap-1 rounded-t-lg bg-black/5 px-3 py-1 text-xs text-[var(--gkc-text-muted)] dark:bg-white/5"
				>
					<span>⏰</span>
					<span>{formatReminder(note.reminder)}</span>
				</div>
			{/if}

			<div class="block w-full p-3 pb-2 text-left">
				{#if note.title}
					<h3 class="mb-1 text-[15px] font-semibold leading-snug tracking-tight text-[var(--gkc-text)]">{note.title}</h3>
				{/if}
				<NoteBodyDisplay {note} />
			</div>
		</div>

		{#if labelsForNote.length}
			<div class="flex shrink-0 flex-wrap gap-1 px-3 pb-3 pt-2">
				{#each labelsForNote as label (label.id)}
					<span
						class="rounded px-1.5 py-0.5 text-[10px] font-medium bg-black/5 text-[var(--gkc-text-muted)] dark:bg-white/10"
					>
						{label.name}
					</span>
				{/each}
			</div>
		{/if}
		</div>
</div>
