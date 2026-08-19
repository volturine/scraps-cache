<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import SectionHeader from '$lib/components/SectionHeader.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { StickyNote } from '@lucide/svelte';

	const { openNote: openEditor } = useEditorActions();

	const pinned = $derived(notesStore.pinnedNotes);
	const others = $derived(notesStore.unpinnedNotes);
	const search = $derived(uiStore.search);
	const filteredPinned = $derived(search ? notesStore.search(search, pinned) : pinned);
	const filteredOthers = $derived(search ? notesStore.search(search, others) : others);
	const visibleCount = $derived(filteredPinned.length + filteredOthers.length);
	const shell = $derived(notesShellClass());
</script>

<div class="pt-4 pb-8">
	{#if visibleCount === 0}
		<EmptyState
			icon={StickyNote}
			description="Capture an idea, task, or anything you want to keep."
		/>
	{:else}
		<SectionHeader label="Notes" count={visibleCount} />

		{#if filteredPinned.length > 0 && filteredOthers.length > 0}
			<div class={shell}>
				<h2
					class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--scraps-cache-text-muted)]"
				>
					Pinned
				</h2>
			</div>
		{/if}

		{#if filteredPinned.length > 0}
			<NotesFeed
				notes={filteredPinned}
				onOpen={openEditor}
				class={filteredOthers.length > 0 ? 'mb-8' : ''}
			/>
		{/if}

		{#if filteredOthers.length > 0 && filteredPinned.length > 0}
			<div class={shell}>
				<h2
					class="mb-3 mt-6 text-xs font-semibold uppercase tracking-wide text-[var(--scraps-cache-text-muted)]"
				>
					Others
				</h2>
			</div>
		{/if}

		{#if filteredOthers.length > 0}
			<NotesFeed notes={filteredOthers} onOpen={openEditor} />
		{/if}
	{/if}
</div>
