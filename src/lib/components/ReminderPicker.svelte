<script lang="ts">
	import { SvelteDate } from 'svelte/reactivity';
	import WheelPicker from './WheelPicker.svelte';
	import { AlarmClock, ChevronLeft, ChevronRight } from '@lucide/svelte';

	let {
		reminder,
		onClose,
		onApply
	}: {
		reminder: number | null;
		onClose: () => void;
		onApply?: (value: number | null) => void;
	} = $props();

	const MONTH_ITEMS = Array.from({ length: 12 }, (_, month) => ({
		value: month,
		label: new Date(2020, month, 1).toLocaleDateString([], { month: 'long' })
	}));
	const HOUR_ITEMS = Array.from({ length: 24 }, (_, hour) => ({
		value: hour,
		label: String(hour).padStart(2, '0')
	}));
	const MINUTE_ITEMS = Array.from({ length: 60 }, (_, minute) => ({
		value: minute,
		label: String(minute).padStart(2, '0')
	}));

	// Initialize from existing reminder or now+1h default
	function initDate(ts: number | null): SvelteDate {
		if (ts == null) {
			const d = new SvelteDate();
			d.setHours(d.getHours() + 1, 0, 0, 0);
			return d;
		}
		return new SvelteDate(ts);
	}

	// A writable derived follows a changed prop but can still hold local picker edits.
	let selected = $derived(initDate(reminder));
	let monthYearOpen = $state(false);

	function apply(ts: number | null) {
		onApply?.(ts);
		onClose();
	}

	function daysInMonth(year: number, month: number): number {
		return new Date(year, month + 1, 0).getDate();
	}

	function setDateParts(parts: { year?: number; month?: number; day?: number }) {
		const d = new SvelteDate(selected);
		const year = parts.year ?? d.getFullYear();
		const month = parts.month ?? d.getMonth();
		const day = parts.day ?? d.getDate();
		d.setFullYear(year, month, Math.min(day, daysInMonth(year, month)));
		selected = d;
	}

	function shiftDay(delta: number) {
		const d = new SvelteDate(selected);
		d.setDate(d.getDate() + delta);
		selected = d;
	}

	const dateLabel = $derived(
		selected.toLocaleDateString([], {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		})
	);

	function formatCompact(d: Date): string {
		const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
		return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} · ${time}`;
	}

	const willSaveLabel = $derived(formatCompact(selected));
	const draftMs = $derived(selected.getTime());

	/** off = no reminder on note; active = saved & unchanged; unsaved = edits or new before Save */
	const uiStatus = $derived.by(() => {
		if (reminder == null) return 'new' as const;
		if (draftMs === reminder) return 'active' as const;
		return 'unsaved' as const;
	});

	const showRemove = $derived(reminder != null);
	const primaryIsSave = $derived(uiStatus !== 'active');

	function primaryAction() {
		if (primaryIsSave) save();
		else onClose();
	}

	const hours24 = $derived(selected.getHours());
	const minutes = $derived(selected.getMinutes());
	const selectedMonth = $derived(selected.getMonth());
	const selectedYear = $derived(selected.getFullYear());

	const yearItems = $derived.by(() => {
		const nowYear = new Date().getFullYear();
		const start = Math.min(nowYear - 10, selectedYear);
		const end = Math.max(nowYear + 15, selectedYear);
		const items: { value: number; label: string }[] = [];
		for (let year = start; year <= end; year++) {
			items.push({ value: year, label: String(year) });
		}
		return items;
	});

	function setHour(hour: number) {
		const d = new SvelteDate(selected);
		d.setHours(hour);
		selected = d;
	}

	function setMinute(minute: number) {
		const d = new SvelteDate(selected);
		d.setMinutes(minute);
		selected = d;
	}

	function save() {
		apply(selected.getTime());
	}
	function clear() {
		apply(null);
	}
</script>

<div
	class="w-80 rounded-2xl border border-[var(--shard-border)] bg-[var(--shard-surface)] p-5 shadow-2xl"
>
	<div class="mb-3 text-base font-medium text-[var(--shard-text)]">Reminder</div>

	<div
		class="mb-4 rounded-xl border px-3 py-2.5 {uiStatus === 'active'
			? 'border-green-600/35 bg-green-600/10 dark:bg-green-500/15'
			: uiStatus === 'unsaved'
				? 'border-amber-500/40 bg-amber-500/10 dark:bg-amber-500/15'
				: 'border-blue-500/35 bg-blue-500/10 dark:bg-blue-500/15'}"
	>
		<div class="flex items-center justify-between gap-2">
			<div
				class="min-w-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--shard-text-muted)]"
			>
				Will remind you
			</div>
			{#if uiStatus === 'active'}
				<span
					class="inline-flex min-w-[4.25rem] shrink-0 justify-center rounded-full bg-green-600/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-800 dark:text-green-300"
					>Active</span
				>
			{:else if uiStatus === 'unsaved'}
				<span
					class="inline-flex min-w-[4.25rem] shrink-0 justify-center rounded-full bg-amber-500/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900 dark:text-amber-200"
					>Edit</span
				>
			{:else}
				<span
					class="inline-flex min-w-[4.25rem] shrink-0 justify-center rounded-full bg-blue-600/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-800 dark:text-blue-300"
					>New</span
				>
			{/if}
		</div>
		<div class="mt-1.5 flex items-center gap-2 text-sm font-semibold text-[var(--shard-text)]">
			<AlarmClock class="h-4 w-4 shrink-0" aria-hidden="true" />
			<span class="min-w-0 truncate">{willSaveLabel}</span>
		</div>
	</div>

	<div class="mb-4 border-t border-[var(--shard-border)] pt-4">
		<div class="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--shard-text-muted)]">
			Pick date & time
		</div>

		<div class="mb-3 flex items-center">
			<button
				type="button"
				class="icon-btn h-8 w-8 shrink-0 p-2"
				onclick={() => shiftDay(-1)}
				aria-label="Previous day"
			>
				<ChevronLeft class="h-5 w-5" aria-hidden="true" />
			</button>
			<button
				type="button"
				class="mx-1 flex min-w-0 flex-1 items-center justify-center rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--shard-text)] {monthYearOpen
					? 'bg-[var(--shard-bg)]'
					: ''}"
				onclick={() => (monthYearOpen = !monthYearOpen)}
				aria-label="Choose month and year"
				aria-expanded={monthYearOpen}
			>
				<span class="truncate">{dateLabel}</span>
			</button>
			<button
				type="button"
				class="icon-btn h-8 w-8 shrink-0 p-2"
				onclick={() => shiftDay(1)}
				aria-label="Next day"
			>
				<ChevronRight class="h-5 w-5" aria-hidden="true" />
			</button>
		</div>

		{#if monthYearOpen}
			<div
				class="mb-1 flex justify-center gap-2 rounded-xl bg-black/[0.03] px-2 py-1 dark:bg-white/[0.04]"
			>
				<WheelPicker
					class="w-[9.5rem]"
					items={MONTH_ITEMS}
					value={selectedMonth}
					onChange={(month) => setDateParts({ month })}
					ariaLabel="Month"
				/>
				<WheelPicker
					class="w-[4.75rem]"
					items={yearItems}
					value={selectedYear}
					onChange={(year) => setDateParts({ year })}
					ariaLabel="Year"
				/>
			</div>
		{:else}
			<div
				class="flex justify-center gap-1 rounded-xl bg-black/[0.03] px-2 py-1 dark:bg-white/[0.04]"
			>
				<WheelPicker
					class="w-16"
					items={HOUR_ITEMS}
					value={hours24}
					onChange={setHour}
					ariaLabel="Hour"
				/>
				<div
					class="flex w-3 shrink-0 items-center justify-center text-xl font-semibold text-[var(--shard-text)]"
					aria-hidden="true"
				>
					:
				</div>
				<WheelPicker
					class="w-16"
					items={MINUTE_ITEMS}
					value={minutes}
					onChange={setMinute}
					ariaLabel="Minute"
				/>
			</div>
		{/if}
	</div>

	<div class="flex items-center justify-between gap-3 border-t border-[var(--shard-border)] pt-4">
		{#if showRemove}
			<button
				type="button"
				onclick={clear}
				class="shrink-0 rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--shard-text-muted)] hover:bg-black/5 dark:hover:bg-white/10"
			>
				Remove
			</button>
		{:else}
			<span class="shrink-0" aria-hidden="true"></span>
		{/if}
		<button
			type="button"
			onclick={primaryAction}
			class="min-w-[7.5rem] shrink-0 rounded-lg px-6 py-2.5 text-sm font-medium {primaryIsSave
				? 'bg-blue-600 text-white hover:bg-blue-700'
				: 'border border-[var(--shard-border)] bg-[var(--shard-bg)] text-[var(--shard-text)] hover:bg-black/5 dark:hover:bg-white/10'}"
		>
			{primaryIsSave ? 'Save' : 'Cancel'}
		</button>
	</div>
</div>
