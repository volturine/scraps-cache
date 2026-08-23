<script lang="ts">
	import type { Note } from '$lib/types';
	import type { Snippet } from 'svelte';
	import NoteCard from './NoteCard.svelte';

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
		/** Extra content packed as the first item of the first column (e.g. the reminders calendar). */
		leading?: Snippet;
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

	// Measured card heights replace estimates as soon as they exist, so packing
	// tracks real layout instead of drifting heuristics (photos, wrapped lines
	// and previews make estimates diverge wildly). Card heights do not depend on
	// which column holds them — all columns share one width — so a remeasure
	// settles instead of oscillating.
	let measuredHeights = $state(new Map<string, number>());
	let gridEl = $state<HTMLDivElement | null>(null);

	const columns = $derived.by(() => {
		const cols: Note[][] = Array.from({ length: colCount }, () => []);
		const heights: number[] = Array(colCount).fill(0);
		for (const note of notes) {
			let minIdx = 0;
			for (let i = 1; i < colCount; i++) {
				if (heights[i] < heights[minIdx]) minIdx = i;
			}
			cols[minIdx].push(note);
			heights[minIdx] += (measuredHeights.get(note.id) ?? estimateHeight(note)) + 10;
		}
		return cols;
	});

	$effect(() => {
		void columns;
		void colCount;
		const root = gridEl;
		if (!root || typeof ResizeObserver === 'undefined') return;
		const measure = () => {
			const cards = root.querySelectorAll<HTMLElement>('[data-note-height]');
			let changed = measuredHeights.size !== cards.length;
			const next = new Map<string, number>();
			for (const el of cards) {
				const id = el.dataset.noteHeight!;
				const h = Math.round(el.getBoundingClientRect().height);
				next.set(id, h);
				if (measuredHeights.get(id) !== h) changed = true;
			}
			if (changed) measuredHeights = next;
		};
		measure();
		const observer = new ResizeObserver(measure);
		root.querySelectorAll<HTMLElement>('[data-note-height]').forEach((el) => observer.observe(el));
		return () => observer.disconnect();
	});
</script>

<div bind:this={gridEl} class="masonry-wrap {className}" style="--masonry-cols: {colCount}">
	{#if leading}
		<div class="masonry-lead">{@render leading()}</div>
	{/if}
	<div class="masonry-balanced">
		{#each columns as col, i (i)}
			<div class="masonry-balanced-col">
				{#each col as note (note.id)}
					<div data-note-height={note.id}>
						{#if children}
							{@render children(note)}
						{:else}
							<NoteCard {note} {onOpen} />
						{/if}
					</div>
				{/each}
			</div>
		{/each}
	</div>
</div>
