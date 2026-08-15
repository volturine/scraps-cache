<script lang="ts">
	import { fly } from 'svelte/transition';
	import { AlarmClock, X } from '@lucide/svelte';
	import { reminderStore } from '$lib/stores/reminders.svelte';
	import { formatReminder } from '$lib/utils';

	const alerts = $derived(reminderStore.alerts);
</script>

{#if alerts.length > 0}
	<div
		class="pointer-events-none fixed inset-x-0 z-[70] flex flex-col items-center gap-2 px-3"
		style="top: max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.35rem))"
		role="region"
		aria-label="Due reminders"
	>
		{#each alerts as alert (alert.wakeId)}
			<div
				class="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-2xl border border-[var(--gkc-border)] bg-[var(--gkc-surface)] px-3 py-3 shadow-2xl"
				role="alert"
				transition:fly={{ y: -16, duration: 180 }}
			>
				<AlarmClock
					class="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400"
					aria-hidden="true"
				/>
				<button
					type="button"
					class="min-w-0 flex-1 text-left"
					onclick={() => reminderStore.open(alert.noteId)}
				>
					<div class="truncate text-sm font-semibold text-[var(--gkc-text)]">{alert.title}</div>
					<div class="text-xs text-[var(--gkc-text-muted)]">{formatReminder(alert.reminder)}</div>
				</button>
				<button
					type="button"
					class="icon-btn h-8 w-8 shrink-0 p-1.5"
					aria-label="Dismiss reminder"
					onclick={() => reminderStore.dismiss(alert.noteId)}
				>
					<X class="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
		{/each}
	</div>
{/if}
