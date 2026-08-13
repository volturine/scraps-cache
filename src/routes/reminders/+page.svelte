<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { notificationPermission, requestReminderPermission } from '$lib/reminderNotify';
	import { ensurePushSubscription } from '$lib/reminderWake';
	import { reminderStore } from '$lib/stores/reminders.svelte';
	import { AlarmClock } from '@lucide/svelte';

	const { openNote: openEditor, startNewNote } = useEditorActions();
	const reminders = $derived(notesStore.notesWithReminders);
	const shell = $derived(notesShellClass());
	let permission = $state(notificationPermission());

	async function enableNotifications() {
		permission = await requestReminderPermission();
		await ensurePushSubscription();
		reminderStore.sync(notesStore.notes);
	}
</script>

<div class="pt-4 pb-8">
	{#if reminders.length === 0}
		<EmptyState
			icon={AlarmClock}
			description="Create a note, then add a reminder when you need to return to it."
			actionLabel="Create note"
			onAction={startNewNote}
		/>
	{:else}
		<div class={shell}>
			<h2
				class="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-[var(--shard-text-muted)]"
			>
				Reminders
			</h2>
			{#if permission === 'default'}
				<div
					class="mb-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--gkc-border)] bg-[var(--gkc-surface)] px-3 py-2.5"
				>
					<p class="text-xs text-[var(--gkc-text-muted)]">
						Allow notifications. Closed-app alerts also need Sync on this device.
					</p>
					<button
						type="button"
						class="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
						onclick={() => void enableNotifications()}
					>
						Enable
					</button>
				</div>
			{/if}
		</div>
		<NotesFeed notes={reminders} onOpen={openEditor} />
	{/if}
</div>
