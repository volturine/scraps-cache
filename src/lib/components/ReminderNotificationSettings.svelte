<script lang="ts">
	import { Bell } from '@lucide/svelte';
	import { notificationPermission, requestReminderPermission } from '$lib/reminderNotify';
	import { registerReminderDevice } from '$lib/reminderWake';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { reminderStore } from '$lib/stores/reminders.svelte';

	let permission = $state(notificationPermission());

	async function enable() {
		permission = await requestReminderPermission();
		if (permission !== 'granted') return;
		if (await registerReminderDevice()) reminderStore.publish(notesStore.notes);
	}

	const status = $derived(
		permission === 'granted'
			? 'Enabled on this device'
			: permission === 'denied'
				? 'Blocked in browser settings'
				: permission === 'unsupported'
					? 'Unavailable here; on iPhone or iPad, add Shard to the Home Screen'
					: 'Allow reminders when Shard is in the background'
	);
</script>

<section class="border-t border-[var(--shard-border)] px-3 py-2.5" aria-label="Notifications">
	<div class="flex items-start gap-2.5">
		<Bell class="mt-0.5 h-4 w-4 shrink-0 text-[var(--shard-text)]" aria-hidden="true" />
		<div class="min-w-0 flex-1">
			<p class="text-sm font-medium text-[var(--shard-text)]">Notifications</p>
			<p class="mt-0.5 text-xs leading-snug text-[var(--shard-text-muted)]">{status}</p>
		</div>
		{#if permission === 'default'}
			<button
				type="button"
				onclick={() => void enable()}
				class="shard-button shard-button-primary shrink-0 px-2.5 py-1.5 text-xs font-medium"
			>
				Enable
			</button>
		{/if}
	</div>
</section>
