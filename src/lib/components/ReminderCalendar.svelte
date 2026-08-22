<script lang="ts">
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';
	import type { Note } from '$lib/types';
	import { dayKey } from '$lib/utils';

	let {
		notes,
		selected = $bindable(null)
	}: {
		notes: Note[];
		selected?: string | null;
	} = $props();

	const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

	const openedAt = new Date();
	let today = $state(openedAt);
	let viewYear = $state(openedAt.getFullYear());
	let viewMonth = $state(openedAt.getMonth());

	const monthLabel = $derived(
		new Date(viewYear, viewMonth, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })
	);
	const leadingBlanks = $derived((new Date(viewYear, viewMonth, 1).getDay() + 6) % 7);
	const daysInMonth = $derived(new Date(viewYear, viewMonth + 1, 0).getDate());
	const reminderDays = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const note of notes) {
			if (note.reminder == null) continue;
			const key = dayKey(note.reminder);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return counts;
	});

	function keyFor(day: number): string {
		return `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
	}

	function shiftMonth(delta: number) {
		const next = new Date(viewYear, viewMonth + delta, 1);
		viewYear = next.getFullYear();
		viewMonth = next.getMonth();
	}

	function backToToday() {
		today = new Date();
		viewYear = today.getFullYear();
		viewMonth = today.getMonth();
	}

	function toggleDay(day: number) {
		const key = keyFor(day);
		selected = selected === key ? null : key;
	}
</script>

<div
	class="select-none rounded-2xl border border-[var(--scraps-cache-border)] bg-[var(--scraps-cache-surface)] px-3 py-3"
>
	<div class="mb-2 flex items-center justify-between">
		<button
			type="button"
			class="rounded-full p-1.5 text-[var(--scraps-cache-text-muted)] hover:bg-black/5 dark:hover:bg-white/10"
			aria-label="Previous month"
			onclick={() => shiftMonth(-1)}
		>
			<ChevronLeft size={16} />
		</button>
		<div class="flex items-center gap-2">
			<span class="text-sm font-semibold">{monthLabel}</span>
			{#if viewYear !== today.getFullYear() || viewMonth !== today.getMonth()}
				<button
					type="button"
					class="rounded-full px-2 py-0.5 text-xs text-[var(--scraps-cache-text-muted)] hover:bg-black/5 dark:hover:bg-white/10"
					onclick={backToToday}
				>
					Today
				</button>
			{/if}
		</div>
		<button
			type="button"
			class="rounded-full p-1.5 text-[var(--scraps-cache-text-muted)] hover:bg-black/5 dark:hover:bg-white/10"
			aria-label="Next month"
			onclick={() => shiftMonth(1)}
		>
			<ChevronRight size={16} />
		</button>
	</div>

	<div
		class="grid grid-cols-7 text-center text-xs font-medium text-[var(--scraps-cache-text-muted)]"
	>
		{#each WEEKDAYS as label (label)}
			<span>{label}</span>
		{/each}
	</div>

	<div class="mt-1 grid grid-cols-7 gap-y-0.5 text-center text-sm">
		{#each { length: leadingBlanks } as _, i (i)}
			<span></span>
		{/each}
		{#each { length: daysInMonth } as _, i}
			{@const day = i + 1}
			{@const key = keyFor(day)}
			{@const count = reminderDays.get(key) ?? 0}
			{@const isToday =
				viewYear === today.getFullYear() &&
				viewMonth === today.getMonth() &&
				day === today.getDate()}
			<button
				type="button"
				class="relative mx-auto flex h-8 w-8 flex-col items-center justify-center rounded-full
					{selected === key
					? 'bg-[var(--scraps-cache-accent)] text-[var(--scraps-cache-accent-foreground)]'
					: isToday
						? 'font-bold ring-1 ring-[var(--scraps-cache-border)]'
						: 'hover:bg-black/5 dark:hover:bg-white/10'}"
				aria-pressed={selected === key}
				aria-label="{monthLabel} {day}{count ? `, ${count} reminder${count === 1 ? '' : 's'}` : ''}"
				onclick={() => toggleDay(day)}
			>
				<span>{day}</span>
				{#if count > 0}
					<span
						class="absolute bottom-1 h-1 w-1 rounded-full {selected === key
							? 'bg-[var(--scraps-cache-accent-foreground)]'
							: 'bg-[var(--scraps-cache-accent)]'}"
					></span>
				{/if}
			</button>
		{/each}
	</div>

	{#if selected}
		<div
			class="mt-2 flex items-center justify-between border-t border-[var(--scraps-cache-border)] pt-2 text-xs text-[var(--scraps-cache-text-muted)]"
		>
			<span>Filtered to one day</span>
			<button
				type="button"
				class="hover:text-[var(--scraps-cache-text)]"
				onclick={() => (selected = null)}
			>
				Clear
			</button>
		</div>
	{/if}
</div>
