<script lang="ts">
	import type { Snippet } from 'svelte';
	import { notesShellClass } from '$lib/notesShell';

	let {
		label,
		count,
		class: className = '',
		children
	}: {
		label: string;
		count: number;
		class?: string;
		children?: Snippet;
	} = $props();

	const shell = $derived(notesShellClass());
</script>

<div class="{shell} {className}">
	<div class="mb-3 flex items-center gap-3 px-2">
		<h2 class="text-xs font-semibold uppercase tracking-wide text-[var(--scrapscache-text-muted)]">
			{label}
		</h2>
		<span class="text-xs text-[var(--scrapscache-text-muted)] opacity-60">{count}</span>
		{#if children}
			<div class="flex-1"></div>
			{@render children()}
		{/if}
	</div>
</div>
