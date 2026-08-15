<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Archive } from '@lucide/svelte';

	const { openNote: openEditor } = useEditorActions();
	const archived = $derived(notesStore.archivedNotes);
	const shell = $derived(notesShellClass());
</script>

<div class="pt-4 pb-8">
	<div class={shell}>
		<PageHeader title="Archive" count={archived.length} />
	</div>

	{#if archived.length === 0}
		<EmptyState
			icon={Archive}
			description="Archive notes you want to keep without showing them in Notes."
		/>
	{:else}
		<NotesFeed notes={archived} onOpen={openEditor} />
	{/if}
</div>
