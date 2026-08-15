<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import { Archive } from '@lucide/svelte';

	const { openNote: openEditor } = useEditorActions();
	const archived = $derived(notesStore.archivedNotes);
	const shell = $derived(notesShellClass());
</script>

<div class="pt-4 pb-8">
	<div class={shell}>
		<h1 class="mb-4 px-2 text-xl font-medium text-[var(--shard-text)]">Archive</h1>
	</div>

	{#if archived.length === 0}
		<div
			class="notes-content mt-16 flex flex-col items-center justify-center text-[var(--shard-text-muted)]"
		>
			<Archive class="mb-2 h-12 w-12" strokeWidth={1.5} aria-hidden="true" />
			<div class="text-sm">Your archived notes appear here.</div>
		</div>
	{:else}
		<NotesFeed notes={archived} onOpen={openEditor} />
	{/if}
</div>
