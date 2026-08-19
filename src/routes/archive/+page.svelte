<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { Archive } from '@lucide/svelte';

	const { openNote: openEditor } = useEditorActions();
	const archived = $derived(notesStore.archivedNotes);
</script>

<div class="pt-4 pb-8">
	{#if archived.length === 0}
		<EmptyState
			icon={Archive}
			description="Archive notes you want to keep without showing them in Notes."
		/>
	{:else}
		<SectionHeader label="Archive" count={archived.length} />
		<NotesFeed notes={archived} onOpen={openEditor} />
	{/if}
</div>
