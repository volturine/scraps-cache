<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { StickyNote } from '@lucide/svelte';

	const { openNote: openEditor, startNewNote } = useEditorActions();

	const pinned = $derived(notesStore.pinnedNotes);
	const others = $derived(notesStore.unpinnedNotes);
	const search = $derived(uiStore.search);
	const filteredPinned = $derived(search ? notesStore.search(search, pinned) : pinned);
	const filteredOthers = $derived(search ? notesStore.search(search, others) : others);
	const shell = $derived(notesShellClass());
</script>

<div class="pt-4 pb-8">
	{#if filteredPinned.length > 0}
		<div class={shell}>
			<h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--shard-text-muted)]">
				Pinned
			</h2>
		</div>
		<NotesFeed notes={filteredPinned} onOpen={openEditor} class="mb-8" />
	{/if}

	{#if filteredOthers.length > 0 && filteredPinned.length > 0}
		<div class={shell}>
			<h2
				class="mb-3 mt-6 text-xs font-semibold uppercase tracking-wide text-[var(--shard-text-muted)]"
			>
				Others
			</h2>
		</div>
	{/if}

	{#if filteredOthers.length === 0 && filteredPinned.length === 0}
		<EmptyState
			icon={StickyNote}
			description="Capture an idea, task, or anything you want to keep."
			actionLabel="Create note"
			onAction={startNewNote}
		/>
	{:else if filteredOthers.length > 0}
		<NotesFeed notes={filteredOthers} onOpen={openEditor} />
	{/if}
</div>
