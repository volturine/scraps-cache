<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import { StickyNote } from '@lucide/svelte';

	const { openNote: openEditor } = useEditorActions();

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
		<div
			class="notes-content mt-16 flex flex-col items-center justify-center text-[var(--shard-text-muted)]"
		>
			<StickyNote class="mb-2 h-12 w-12" strokeWidth={1.5} aria-hidden="true" />
			<div class="text-sm">No notes here yet.</div>
		</div>
	{:else if filteredOthers.length > 0}
		<NotesFeed notes={filteredOthers} onOpen={openEditor} />
	{/if}
</div>
