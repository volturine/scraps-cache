<script lang="ts">
	import { appClock } from '$lib/appClock.svelte';
	import { formatReminder, isReminderOverdue } from '$lib/utils';
	import { AlarmClock } from '@lucide/svelte';

	let {
		reminder,
		variant = 'strip'
	}: {
		reminder: number;
		variant?: 'strip' | 'chip' | 'inline';
	} = $props();

	const overdue = $derived(isReminderOverdue(reminder, appClock.now));
	const label = $derived(formatReminder(reminder, appClock.now));
	const aria = $derived(overdue ? `Overdue reminder, ${label}` : `Reminder, ${label}`);

	const STYLES = {
		strip: {
			due: 'flex items-center gap-1 rounded-t-lg bg-black/5 px-3 py-1 text-xs text-[var(--scraps-cache-text-muted)] dark:bg-white/5',
			overdue:
				'flex items-center gap-1 rounded-t-lg bg-rose-600 px-3 py-1 text-xs font-medium text-white dark:bg-rose-500'
		},
		chip: {
			due: 'inline-flex max-w-full items-center gap-1 truncate rounded-full bg-black/10 px-2.5 py-1 text-xs text-[var(--scraps-cache-text-muted)] dark:bg-white/10',
			overdue:
				'inline-flex max-w-full items-center gap-1 truncate rounded-full bg-rose-600 px-2.5 py-1 text-xs font-medium text-white dark:bg-rose-500'
		},
		inline: {
			due: 'inline-flex items-center gap-1 text-xs text-[var(--scraps-cache-text-muted)]',
			overdue: 'inline-flex items-center gap-1 text-xs font-medium text-rose-700 dark:text-rose-400'
		}
	} as const;

	const box = $derived(STYLES[variant][overdue ? 'overdue' : 'due']);
</script>

<span class={box} aria-label={aria}>
	<AlarmClock class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
	<span class="truncate">{label}</span>
</span>
