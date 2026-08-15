<script lang="ts">
	import type { LucideIcon } from '@lucide/svelte';

	type Props = {
		icon: LucideIcon;
		description: string;
		actionLabel?: string;
		onAction?: () => void;
		href?: string;
	};

	let { icon: Icon, description, actionLabel, onAction, href }: Props = $props();
</script>

<div
	class="notes-content mx-auto mt-10 flex max-w-sm flex-col items-center px-4 text-center text-[var(--shard-text-muted)]"
>
	<Icon class="h-6 w-6" strokeWidth={1.5} aria-hidden="true" />
	<p class="mt-3 text-sm leading-6">{description}</p>
	{#if actionLabel && href}
		<a
			{href}
			class="mt-3 rounded-full border border-[var(--shard-border)] px-3 py-1.5 text-sm font-medium text-[var(--shard-text)] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
		>
			{actionLabel}
		</a>
	{:else if actionLabel && onAction}
		<button
			type="button"
			onclick={onAction}
			class="mt-3 rounded-full border border-[var(--shard-border)] px-3 py-1.5 text-sm font-medium text-[var(--shard-text)] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
		>
			{actionLabel}
		</button>
	{/if}
</div>
