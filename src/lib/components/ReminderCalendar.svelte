<script lang="ts" module>
	/** Day filter state: a single day (from === to) or an inclusive range. `null` to = picking the end day. */
	export type ReminderDayFilter = { from: string; to: string | null };
</script>

<script lang="ts">
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';
	import type { Note } from '$lib/types';
	import { dayKey } from '$lib/utils';

	let {
		notes,
		selected = $bindable<ReminderDayFilter | null>(null)
	}: {
		notes: Note[];
		selected?: ReminderDayFilter | null;
	} = $props();

	const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
	const LONG_PRESS_MS = 450;

	const openedAt = new Date();
	let today = $state(openedAt);
	let viewYear = $state(openedAt.getFullYear());
	let viewMonth = $state(openedAt.getMonth());

	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	let longPressed = false;

	const monthLabel = $derived(
		new Date(viewYear, viewMonth, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })
	);
	const leadingBlanks = $derived((new Date(viewYear, viewMonth, 1).getDay() + 6) % 7);
	const daysInMonth = $derived(new Date(viewYear, viewMonth + 1, 0).getDate());
	const pickingEnd = $derived(selected !== null && selected.to === null);
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

	function isInRange(key: string): boolean {
		if (!selected || selected.to === null) return false;
		return key >= selected.from && key <= selected.to;
	}

	function isEndpoint(key: string): boolean {
		if (!selected) return false;
		return key === selected.from || key === selected.to;
	}

	function shiftMonth(delta: number) {
		const next = new Date(viewYear, viewMonth + delta, 1);
		viewYear = next.getFullYear();
		viewMonth = next.getMonth();
	}

	function goToday() {
		today = new Date();
		viewYear = today.getFullYear();
		viewMonth = today.getMonth();
	}

	function startPress(day: number) {
		longPressed = false;
		cancelPress();
		pressTimer = setTimeout(() => {
			pressTimer = null;
			longPressed = true;
			selected = { from: keyFor(day), to: null };
		}, LONG_PRESS_MS);
	}

	function cancelPress() {
		if (pressTimer !== null) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
	}

	function handleClick(day: number) {
		cancelPress();
		if (longPressed) {
			longPressed = false;
			return;
		}
		const key = keyFor(day);
		if (selected && selected.to === null) {
			selected =
				key < selected.from ? { from: key, to: selected.from } : { from: selected.from, to: key };
			return;
		}
		if (selected && selected.from === key && selected.to === key) {
			selected = null;
			return;
		}
		selected = { from: key, to: key };
	}

	function filterToday() {
		const key = dayKey(today.getTime());
		if (selected && selected.to !== null && key >= selected.from && key <= selected.to) {
			selected = null;
			return;
		}
		goToday();
		selected = { from: key, to: key };
	}
</script>

<div
	class="w-full select-none rounded-2xl border border-[var(--scraps-cache-border)] bg-[var(--scraps-cache-surface)] px-3 py-3"
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
		<span class="text-sm font-semibold">{monthLabel}</span>
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
		{#each WEEKDAYS as label, i (i)}
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
			{@const endpoint = isEndpoint(key)}
			<button
				type="button"
				class="relative mx-auto flex h-8 w-8 flex-col items-center justify-center rounded-full
					{endpoint
					? 'bg-[var(--scraps-cache-accent)] text-[var(--scraps-cache-accent-foreground)]'
					: isInRange(key)
						? 'bg-[color-mix(in_srgb,var(--scraps-cache-accent)_18%,transparent)]'
						: isToday
							? 'font-bold ring-1 ring-[var(--scraps-cache-border)]'
							: 'hover:bg-black/5 dark:hover:bg-white/10'}"
				aria-pressed={endpoint}
				aria-label="{monthLabel} {day}{count ? `, ${count} reminder${count === 1 ? '' : 's'}` : ''}"
				onpointerdown={() => startPress(day)}
				onpointerup={cancelPress}
				onpointerleave={cancelPress}
				onpointercancel={cancelPress}
				oncontextmenu={(e) => e.preventDefault()}
				onclick={() => handleClick(day)}
			>
				<span>{day}</span>
				{#if count > 0}
					<span
						class="absolute bottom-1 h-1 w-1 rounded-full {endpoint
							? 'bg-[var(--scraps-cache-accent-foreground)]'
							: 'bg-[var(--scraps-cache-accent)]'}"
					></span>
				{/if}
			</button>
		{/each}
	</div>

	<div
		class="mt-2 flex items-center justify-between gap-2 border-t border-[var(--scraps-cache-border)] pt-3 text-xs"
	>
		<div class="flex flex-1 items-center">
			<button
				type="button"
				class="rounded-full px-2 py-0.5 font-medium leading-5 text-[var(--scraps-cache-text-muted)] hover:bg-black/5 hover:text-[var(--scraps-cache-text)] dark:hover:bg-white/10"
				onclick={filterToday}
			>
				Today
			</button>
		</div>
		<span class="shrink-0 truncate px-2 leading-5 text-[var(--scraps-cache-text-muted)]">
			{#if pickingEnd}
				Pick an end day
			{:else if selected && selected.from !== selected.to}
				Range filter active
			{:else if selected}
				Day filter active
			{/if}
		</span>
		<div class="flex flex-1 items-center justify-end">
			<button
				type="button"
				class="rounded-full px-2 py-0.5 leading-5 text-[var(--scraps-cache-text-muted)] hover:bg-black/5 hover:text-[var(--scraps-cache-text)] disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-white/10"
				disabled={!selected}
				onclick={() => (selected = null)}
			>
				Clear
			</button>
		</div>
	</div>
</div>
