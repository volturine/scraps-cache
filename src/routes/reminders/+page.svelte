<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { AlarmClock } from '@lucide/svelte';

	const { openNote: openEditor, startNewNote } = useEditorActions();
	const reminders = $derived(notesStore.notesWithReminders);
	const shell = $derived(notesShellClass());
</script>

<div class="pt-4 pb-8">
	<div class={shell}>
		<PageHeader title="Reminders" count={reminders.length} />
	</div>

	{#if reminders.length === 0}
		<EmptyState
			icon={AlarmClock}
			description="Create a note, then add a reminder when you need to return to it."
			actionLabel="Create note"
			onAction={startNewNote}
		/>
	{:else}
		<NotesFeed notes={reminders} onOpen={openEditor} />
	{/if}
</div>
