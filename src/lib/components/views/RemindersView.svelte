<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import ReminderCalendar from '$lib/components/ReminderCalendar.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { AlarmClock } from '@lucide/svelte';
	import { dayKey } from '$lib/utils';
	import { notesShellClass } from '$lib/notesShell';

	const { openNote: openEditor } = useEditorActions();
	const reminders = $derived(notesStore.notesWithReminders);
	let selectedDay = $state<string | null>(null);

	const searched = $derived(
		uiStore.search ? notesStore.search(uiStore.search, reminders) : reminders
	);
	const visible = $derived(
		selectedDay
			? searched.filter((n) => n.reminder != null && dayKey(n.reminder) === selectedDay)
			: searched
	);
</script>

<div class="pt-4 pb-8">
	{#if reminders.length === 0}
		<EmptyState
			icon={AlarmClock}
			description="Create a note, then add a reminder when you need to return to it."
		/>
	{:else}
		<div class={notesShellClass()}>
			<ReminderCalendar notes={reminders} bind:selected={selectedDay} />
		</div>
		{#if visible.length === 0}
			<EmptyState
				icon={AlarmClock}
				description={selectedDay || uiStore.search
					? 'No reminders match the current filters.'
					: 'Create a note, then add a reminder when you need to return to it.'}
			/>
		{:else}
			<SectionHeader label="Reminders" count={visible.length} />
			<NotesFeed notes={visible} onOpen={openEditor} />
		{/if}
	{/if}
</div>
