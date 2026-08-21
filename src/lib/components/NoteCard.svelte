<script lang="ts">
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { NOTE_COLORS, NOTE_DARK_COLORS, type Note, type NoteColor } from '$lib/types';
	import { activateOnKeyboard, formatReminder, isReminderOverdue } from '$lib/utils';
	import { cardSwipeStyle, createCardSwipe } from '$lib/cardSwipe';
	import NoteBodyDisplay from './NoteBodyDisplay.svelte';
	import ReminderLabel from './ReminderLabel.svelte';
	import { Archive, RotateCcw, Trash2 } from '@lucide/svelte';

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
			.map((id) => notesStore.labelsById.get(id))
			.filter((l): l is NonNullable<typeof l> => !!l)
	);

	const openLabel = $derived.by(() => {
		const title = note.title || 'untitled note';
		if (note.reminder == null) return `Open ${title}`;
		const when = formatReminder(note.reminder);
		return isReminderOverdue(note.reminder)
			? `Open ${title}, overdue reminder ${when}`
			: `Open ${title}, reminder ${when}`;
	});

	let offsetX = $state(0);
	let dragging = $state(false);

	const swipe = createCardSwipe({
		onSwipeLeft: () => {
			if (note.trashed) notesStore.restoreNote(note.id);
			else notesStore.toggleArchive(note.id);
		},
		onSwipeRight: () => {
			if (note.trashed) void notesStore.deleteNoteForever(note.id);
			else notesStore.trashNote(note.id);
		},
		setVisual: (s) => {
			offsetX = s.offsetX;
			dragging = s.dragging;
		}
	});

	$effect(() => {
		return () => swipe.dispose();
	});
</script>

<div class="card-stream-in relative overflow-hidden rounded-lg">
	{#if offsetX < 0}
		<div
			class="absolute inset-0 flex items-center justify-end rounded-lg bg-green-500 pr-4 text-white"
		>
			{#if note.trashed}
				<RotateCcw class="h-6 w-6" aria-hidden="true" />
			{:else}
				<Archive class="h-6 w-6" aria-hidden="true" />
			{/if}
		</div>
	{:else if offsetX > 0}
		<div
			class="absolute inset-0 flex items-center justify-start rounded-lg bg-red-500 pl-4 text-white"
		>
			<Trash2 class="h-6 w-6" aria-hidden="true" />
		</div>
	{/if}

	<div
		role="button"
		tabindex="0"
		aria-label={openLabel}
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
		{#if note.reminder != null}
			<div class="shrink-0">
				<ReminderLabel reminder={note.reminder} />
			</div>
		{/if}

		<div class="scrollable min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
			<div class="block w-full p-3 pb-2 text-left" class:opacity-60={note.trashed}>
				{#if note.title}
					<h3
						class="mb-1 text-[15px] font-semibold leading-snug tracking-tight text-[var(--scraps-cache-text)]"
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
						class="rounded px-1.5 py-0.5 text-[10px] font-medium bg-black/5 text-[var(--scraps-cache-text-muted)] dark:bg-white/10"
					>
						{label.name}
					</span>
				{/each}
			</div>
		{/if}
	</div>
</div>
