<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		count,
		children
	}: {
		title: string;
		count?: number;
		children?: Snippet;
	} = $props();
</script>

<div class="mb-3 flex min-h-7 items-center gap-2 px-2">
	<h1 class="min-w-0 truncate text-xl font-medium text-[var(--shard-text)]">{title}</h1>
	{#if count !== undefined}
		<span class="shrink-0 text-xs tabular-nums text-[var(--shard-text-muted)]">{count}</span>
	{/if}
	{#if children}
		<div class="ml-auto flex shrink-0 items-center gap-2">
			{@render children()}
		</div>
	{/if}
</div>
