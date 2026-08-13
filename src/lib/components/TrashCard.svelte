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

	function restore() {
		notesStore.restoreNote(note.id);
	}
	function deleteForever() {
		notesStore.deleteNoteForever(note.id);
	}

	function openUnlessAction(e: MouseEvent) {
		if (swipe.wasDrag()) {
			e.stopPropagation();
			return;
		}
		const t = e.target as HTMLElement;
		if (t.closest('[data-checklist-toggle], [data-photo], [data-file], [data-link], button'))
			return;
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
		onSwipeLeft: () => deleteForever(),
		onSwipeRight: () => restore(),
		setVisual: (s) => {
			offsetX = s.offsetX;
			dragging = s.dragging;
		}
	});
</script>

<div class="group relative overflow-hidden rounded-lg">
	{#if offsetX < 0}
		<div
			class="absolute inset-0 flex items-center justify-end rounded-lg bg-red-600 pr-4 text-white"
		>
			<svg
				viewBox="0 0 24 24"
				class="h-6 w-6 fill-none stroke-current"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				><path
					d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"
				/></svg
			>
		</div>
	{:else if offsetX > 0}
		<div
			class="absolute inset-0 flex items-center justify-start rounded-lg bg-blue-500 pl-4 text-white"
		>
			<svg
				viewBox="0 0 24 24"
				class="h-6 w-6 fill-none stroke-current"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg
			>
		</div>
	{/if}

	<div
		class="absolute right-2 top-2 z-[2] flex gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
	>
		<button
			type="button"
			onclick={(e) => {
				e.stopPropagation();
				restore();
			}}
			class="grid h-8 w-8 place-items-center rounded-full bg-black/10 text-blue-600 backdrop-blur-sm transition-colors hover:bg-black/20 dark:text-blue-400 dark:bg-white/10 dark:hover:bg-white/20"
			aria-label="Restore note"
			title="Restore"
		>
			<svg
				viewBox="0 0 24 24"
				class="h-4 w-4 fill-none stroke-current"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg
			>
		</button>
		<button
			type="button"
			onclick={(e) => {
				e.stopPropagation();
				deleteForever();
			}}
			class="grid h-8 w-8 place-items-center rounded-full bg-black/10 text-red-600 backdrop-blur-sm transition-colors hover:bg-black/20 dark:text-red-400 dark:bg-white/10 dark:hover:bg-white/20"
			aria-label="Delete forever"
			title="Delete forever"
		>
			<svg
				viewBox="0 0 24 24"
				class="h-4 w-4 fill-none stroke-current"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				><path
					d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"
				/></svg
			>
		</button>
	</div>

	<div
		role="button"
		tabindex="0"
		aria-label={`Open ${note.title || 'untitled note'} in trash`}
		class="relative z-[1] flex w-full max-h-[320px] cursor-pointer flex-col overflow-hidden rounded-lg border border-black/5 shadow-sm transition-shadow dark:border-white/10"
		style="background-color: {bgColor(note.color)}; {cardSwipeStyle(offsetX, dragging)}"
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

			<div class="block w-full p-3 pb-2 text-left opacity-60">
				{#if note.title}
					<h3
						class="mb-1 text-[15px] font-semibold leading-snug tracking-tight text-[var(--gkc-text)]"
					>
						{note.title}
					</h3>
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
