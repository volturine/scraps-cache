<script lang="ts">
	import { onMount } from 'svelte';
	import { Bell, ChevronRight } from '@lucide/svelte';
	import { notificationPermission, requestReminderPermission } from '$lib/reminderNotify';
	import { registerReminderDevice } from '$lib/reminderWake';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { reminderStore } from '$lib/stores/reminders.svelte';

	let permission = $state(notificationPermission());

	onMount(() => {
		const refresh = () => {
			permission = notificationPermission();
		};
		window.addEventListener('focus', refresh);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			window.removeEventListener('focus', refresh);
			document.removeEventListener('visibilitychange', refresh);
		};
	});

	async function enable() {
		permission = await requestReminderPermission();
		if (permission !== 'granted') return;
		if (await registerReminderDevice()) reminderStore.publish(notesStore.notes);
	}
</script>

<section class="border-t border-[var(--scraps-cache-border)]" aria-label="Notifications">
	{#if permission === 'default'}
		<button
			type="button"
			onclick={() => void enable()}
			class="flex h-10 w-full items-center gap-2.5 px-3 text-left hover:bg-black/5 dark:hover:bg-white/10"
			aria-label="Turn on notifications"
		>
			<Bell class="h-4 w-4 shrink-0 text-[var(--scraps-cache-text)]" aria-hidden="true" />
			<span class="min-w-0 flex-1 text-sm font-medium text-[var(--scraps-cache-text)]"
				>Notifications</span
			>
			<span class="shrink-0 text-xs font-medium text-[var(--scraps-cache-text-muted)]">Not set</span
			>
			<ChevronRight
				class="h-4 w-4 shrink-0 text-[var(--scraps-cache-text-muted)]"
				aria-hidden="true"
			/>
		</button>
	{:else}
		<div class="flex h-10 items-center gap-2.5 px-3">
			<Bell class="h-4 w-4 shrink-0 text-[var(--scraps-cache-text)]" aria-hidden="true" />
			<span class="min-w-0 flex-1 text-sm font-medium text-[var(--scraps-cache-text)]"
				>Notifications</span
			>
			<span class="shrink-0 text-xs font-medium text-[var(--scraps-cache-text-muted)]">
				{permission === 'granted'
					? 'Enabled'
					: permission === 'denied'
						? 'Disabled'
						: 'Unsupported'}
			</span>
		</div>
	{/if}
</section>
