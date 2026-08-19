<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { AlarmClock } from '@lucide/svelte';

	const { openNote: openEditor } = useEditorActions();
	const reminders = $derived(notesStore.notesWithReminders);
</script>

<div class="pt-4 pb-8">
	{#if reminders.length === 0}
		<EmptyState
			icon={AlarmClock}
			description="Create a note, then add a reminder when you need to return to it."
		/>
	{:else}
		<SectionHeader label="Reminders" count={reminders.length} />
		<NotesFeed notes={reminders} onOpen={openEditor} />
	{/if}
</div>
