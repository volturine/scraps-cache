<script lang="ts">
	import type { Note } from '$lib/types';
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import NoteCard from './NoteCard.svelte';
	import MasonryGrid from './MasonryGrid.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';

	/** Grid / list feed for notes pages — one place for layout branching. */
	let {
		notes,
		onOpen,
		class: className = '',
		children,
		leading
	}: {
		notes: Note[];
		onOpen: (id: string) => void;
		class?: string;
		children?: Snippet<[Note]>;
		/** Extra content packed into the grid before the notes (grid layout only). */
		leading?: Snippet;
	} = $props();

	const PAGE_SIZE = 200;
	/** Cards painted in the first frame of a view; the rest stream in over the next frames. */
	const FIRST_BATCH = 24;
	const BATCH_STEP = 40;
	let pageIndex = $state(0);
	let renderedCount = $state(FIRST_BATCH);
	const pageCount = $derived(Math.max(1, Math.ceil(notes.length / PAGE_SIZE)));
	const safePageIndex = $derived(Math.min(pageIndex, pageCount - 1));
	const visibleNotes = $derived(
		notes.slice(safePageIndex * PAGE_SIZE, (safePageIndex + 1) * PAGE_SIZE)
	);
	const shownNotes = $derived(visibleNotes.slice(0, renderedCount));

	let streamFrame: number | undefined;

	function pumpStream() {
		if (streamFrame !== undefined) cancelAnimationFrame(streamFrame);
		const tick = () => {
			streamFrame = undefined;
			if (renderedCount >= visibleNotes.length) return;
			renderedCount += BATCH_STEP;
			streamFrame = requestAnimationFrame(tick);
		};
		streamFrame = requestAnimationFrame(tick);
	}

	onMount(() => {
		pumpStream();
		return () => {
			if (streamFrame !== undefined) cancelAnimationFrame(streamFrame);
		};
	});
</script>

<div class="notes-content {className}">
	{#if uiStore.layout === 'grid'}
		<MasonryGrid notes={shownNotes} {onOpen} {children} {leading} />
	{:else}
		<div class="masonry masonry-list">
			{#each shownNotes as note (note.id)}
				<div>
					{#if children}
						{@render children(note)}
					{:else}
						<NoteCard {note} {onOpen} />
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if pageCount > 1}
		<nav class="mt-6 flex items-center justify-center gap-3" aria-label="Note pages">
			<button
				type="button"
				disabled={safePageIndex === 0}
				onclick={() => {
					pageIndex = Math.max(0, safePageIndex - 1);
					renderedCount = FIRST_BATCH;
					pumpStream();
				}}
				class="rounded-lg border border-[var(--scrapscache-border)] px-3 py-1.5 text-sm text-[var(--scrapscache-text)] disabled:opacity-40"
				>Previous</button
			>
			<span class="text-xs text-[var(--scrapscache-text-muted)]">
				{safePageIndex * PAGE_SIZE + 1}–{Math.min(notes.length, (safePageIndex + 1) * PAGE_SIZE)} of {notes.length}
			</span>
			<button
				type="button"
				disabled={safePageIndex >= pageCount - 1}
				onclick={() => {
					pageIndex = Math.min(pageCount - 1, safePageIndex + 1);
					renderedCount = FIRST_BATCH;
					pumpStream();
				}}
				class="rounded-lg border border-[var(--scrapscache-border)] px-3 py-1.5 text-sm text-[var(--scrapscache-text)] disabled:opacity-40"
				>Next</button
			>
		</nav>
	{/if}
</div>
