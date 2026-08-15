<script lang="ts">
	import { onMount } from 'svelte';
	import { Bell, ChevronRight } from '@lucide/svelte';
	import { notificationPermission, requestReminderPermission } from '$lib/reminderNotify';
	import { registerReminderDevice } from '$lib/reminderWake';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { reminderStore } from '$lib/stores/reminders.svelte';

	let permission = $state(notificationPermission());
	const appleMobile =
		typeof navigator !== 'undefined' &&
		(/iPhone|iPad|iPod/.test(navigator.userAgent) ||
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

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

	const description = $derived(
		permission === 'granted'
			? 'Reminder alerts are allowed on this device'
			: permission === 'denied'
				? 'Notifications are off for Shard'
				: permission === 'unsupported'
					? 'Unavailable here; on iPhone or iPad, add Shard to the Home Screen'
					: 'Get reminder alerts on this device'
	);
</script>

<section class="border-t border-[var(--shard-border)]" aria-label="Notifications">
	{#if permission === 'default'}
		<button
			type="button"
			onclick={() => void enable()}
			class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-black/5 dark:hover:bg-white/10"
			aria-label="Turn on notifications"
		>
			<Bell class="h-4 w-4 shrink-0 text-[var(--shard-text)]" aria-hidden="true" />
			<div class="min-w-0 flex-1">
				<p class="text-sm font-medium text-[var(--shard-text)]">Notifications</p>
				<p class="mt-0.5 text-xs leading-snug text-[var(--shard-text-muted)]">{description}</p>
			</div>
			<span class="shrink-0 text-xs font-medium text-[var(--shard-text-muted)]">Turn on</span>
			<ChevronRight class="h-4 w-4 shrink-0 text-[var(--shard-text-muted)]" aria-hidden="true" />
		</button>
	{:else}
		<div class="flex items-start gap-2.5 px-3 py-2.5">
			<Bell class="mt-0.5 h-4 w-4 shrink-0 text-[var(--shard-text)]" aria-hidden="true" />
			<div class="min-w-0 flex-1">
				<p class="text-sm font-medium text-[var(--shard-text)]">Notifications</p>
				<p class="mt-0.5 text-xs leading-snug text-[var(--shard-text-muted)]">{description}</p>
			</div>
			<span class="shrink-0 text-xs font-medium text-[var(--shard-text-muted)]">
				{permission === 'granted' ? 'On' : permission === 'denied' ? 'Off' : 'Unavailable'}
			</span>
		</div>
		{#if permission === 'denied'}
			<p class="px-3 pb-2.5 pl-[2.375rem] text-xs leading-snug text-[var(--shard-text-muted)]">
				{appleMobile
					? 'To turn them back on: iPhone Settings → Notifications → Shard → Allow Notifications.'
					: 'Turn them back on in your device or browser notification settings.'}
			</p>
		{/if}
	{/if}
</section>
