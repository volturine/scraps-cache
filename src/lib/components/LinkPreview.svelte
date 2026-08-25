<script lang="ts">
	import { localLinkCard } from '$lib/linkPreview';

	let { url }: { url: string } = $props();
	const card = $derived(localLinkCard(url));

	function keepCardClosed(event: MouseEvent) {
		event.stopPropagation();
	}
</script>

<a
	class="mt-2 flex overflow-hidden rounded-lg border border-black/10 bg-black/[0.035] text-left no-underline transition-colors hover:bg-black/[0.07] focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/10 dark:bg-white/[0.045] dark:hover:bg-white/[0.09]"
	data-link
	href={url}
	target="_blank"
	rel="noreferrer noopener"
	onclick={keepCardClosed}
	aria-label={`Open ${card?.hostname ?? url}`}
>
	<div
		class="grid h-14 w-14 shrink-0 place-items-center bg-black/[0.06] text-lg font-semibold uppercase text-[var(--scrapscache-text-muted)] dark:bg-white/[0.08]"
		aria-hidden="true"
	>
		{card?.badge ?? '↗'}
	</div>
	<div class="min-w-0 flex-1 px-3 py-2.5">
		<div class="truncate text-sm font-medium text-[var(--scrapscache-text)]">
			{card?.hostname ?? url}
		</div>
		<div class="mt-0.5 truncate text-xs text-[var(--scrapscache-text-muted)]">
			{card?.path || 'Open website'}
		</div>
	</div>
	<div
		class="grid w-10 shrink-0 place-items-center text-sm text-[var(--scrapscache-text-muted)]"
		aria-hidden="true"
	>
		↗
	</div>
</a>
