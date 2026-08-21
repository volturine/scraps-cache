<script lang="ts">
	import type { Note } from '$lib/types';
	import type { Snippet } from 'svelte';
	import NoteCard from './NoteCard.svelte';
	import MasonryGrid from './MasonryGrid.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';

	/** Grid / list feed for notes pages — one place for layout branching. */
	let {
		notes,
		onOpen,
		class: className = '',
		children
	}: {
		notes: Note[];
		onOpen: (id: string) => void;
		class?: string;
		children?: Snippet<[Note]>;
	} = $props();

	const PAGE_SIZE = 200;
	let pageIndex = $state(0);
	const pageCount = $derived(Math.max(1, Math.ceil(notes.length / PAGE_SIZE)));
	$effect.pre(() => {
		if (pageIndex > pageCount - 1) pageIndex = pageCount - 1;
	});
	const safePageIndex = $derived(Math.min(pageIndex, pageCount - 1));
	const visibleNotes = $derived(
		notes.slice(safePageIndex * PAGE_SIZE, (safePageIndex + 1) * PAGE_SIZE)
	);
</script>

<div class="notes-content {className}">
	{#if uiStore.layout === 'grid'}
		<MasonryGrid notes={visibleNotes} {onOpen} {children} />
	{:else}
		<div class="masonry masonry-list">
			{#each visibleNotes as note (note.id)}
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
				}}
				class="rounded-lg border border-[var(--scraps-cache-border)] px-3 py-1.5 text-sm text-[var(--scraps-cache-text)] disabled:opacity-40"
				>Previous</button
			>
			<span class="text-xs text-[var(--scraps-cache-text-muted)]">
				{safePageIndex * PAGE_SIZE + 1}–{Math.min(notes.length, (safePageIndex + 1) * PAGE_SIZE)} of {notes.length}
			</span>
			<button
				type="button"
				disabled={safePageIndex >= pageCount - 1}
				onclick={() => {
					pageIndex = Math.min(pageCount - 1, safePageIndex + 1);
				}}
				class="rounded-lg border border-[var(--scraps-cache-border)] px-3 py-1.5 text-sm text-[var(--scraps-cache-text)] disabled:opacity-40"
				>Next</button
			>
		</nav>
	{/if}
</div>
