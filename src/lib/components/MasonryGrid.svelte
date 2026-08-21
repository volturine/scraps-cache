<script lang="ts">
	import type { Note } from '$lib/types';
	import type { Snippet } from 'svelte';
	import NoteCard from './NoteCard.svelte';

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

	let colCount = $state(2);

	$effect(() => {
		const update = () => {
			const w = window.innerWidth;
			colCount = w >= 1700 ? 7 : w >= 1400 ? 6 : w >= 1100 ? 5 : w >= 768 ? 4 : w >= 600 ? 3 : 2;
		};
		update();
		window.addEventListener('resize', update);
		return () => window.removeEventListener('resize', update);
	});

	/** Rough height for shortest-column packing (cards scroll at max-h 320px). */
	function estimateHeight(note: Note): number {
		let h = 20;
		if (note.reminder != null) h += 26;
		if (note.title) h += 22;
		const body = note.body ?? '';
		const lineEstimate = (body.split('\n').length + 1) * 18;
		h += Math.min(280, Math.max(36, lineEstimate));
		if (note.labels?.length) h += 26;
		return Math.min(h, 320);
	}

	// Always pack into the responsive column count so a single card keeps
	// the same width as multi-note gallery (never stretches full width).
	// $derived memoizes this while mounted; views persist across navigation,
	// so no cross-mount cache is needed.
	const columns = $derived.by(() => {
		const cols: Note[][] = Array.from({ length: colCount }, () => []);
		const heights: number[] = Array(colCount).fill(0);
		for (const note of notes) {
			let minIdx = 0;
			for (let i = 1; i < colCount; i++) {
				if (heights[i] < heights[minIdx]) minIdx = i;
			}
			cols[minIdx].push(note);
			heights[minIdx] += estimateHeight(note) + 10;
		}
		return cols;
	});
</script>

<div class="masonry-balanced {className}" style="--masonry-cols: {colCount}">
	{#each columns as col, i (i)}
		<div class="masonry-balanced-col">
			{#each col as note (note.id)}
				{#if children}
					{@render children(note)}
				{:else}
					<NoteCard {note} {onOpen} />
				{/if}
			{/each}
		</div>
	{/each}
</div>
