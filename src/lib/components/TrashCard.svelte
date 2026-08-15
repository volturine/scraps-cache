<script lang="ts">
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { NOTE_COLORS, NOTE_DARK_COLORS, type Note, type NoteColor } from '$lib/types';
	import { activateOnKeyboard } from '$lib/utils';
	import { cardSwipeStyle, createCardSwipe } from '$lib/cardSwipe';
	import NoteBodyDisplay from './NoteBodyDisplay.svelte';
	import ReminderLabel from './ReminderLabel.svelte';
	import { RotateCcw, Trash2 } from '@lucide/svelte';

	let {
		note,
		onOpen
	}: {
		note: Note;
		onOpen: (id: string) => void;
	} = $props();

	function bgColor(c: NoteColor): string {
		return uiStore.effectiveDark ? NOTE_DARK_COLORS[c] : NOTE_COLORS[c];
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
			<Trash2 class="h-6 w-6" aria-hidden="true" />
		</div>
	{:else if offsetX > 0}
		<div
			class="absolute inset-0 flex items-center justify-start rounded-lg bg-blue-500 pl-4 text-white"
		>
			<RotateCcw class="h-6 w-6" aria-hidden="true" />
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
			<RotateCcw class="h-4 w-4" aria-hidden="true" />
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
			<Trash2 class="h-4 w-4" aria-hidden="true" />
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
				<ReminderLabel reminder={note.reminder} />
			{/if}

			<div class="block w-full p-3 pb-2 text-left opacity-60">
				{#if note.title}
					<h3
						class="mb-1 text-[15px] font-semibold leading-snug tracking-tight text-[var(--shard-text)]"
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
						class="rounded px-1.5 py-0.5 text-[10px] font-medium bg-black/5 text-[var(--shard-text-muted)] dark:bg-white/10"
					>
						{label.name}
					</span>
				{/each}
			</div>
		{/if}
	</div>
</div>
