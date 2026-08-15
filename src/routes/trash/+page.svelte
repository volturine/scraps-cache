<script lang="ts">
	import TrashCard from '$lib/components/TrashCard.svelte';
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Trash2 } from '@lucide/svelte';

	const { openNote: openEditor } = useEditorActions();
	const trashed = $derived(notesStore.trashedNotes);
	const shell = $derived(notesShellClass());

	let confirmEmpty = $state(false);

	function emptyTrash() {
		notesStore.emptyTrash();
		confirmEmpty = false;
	}
</script>

<div class="pt-4 pb-8">
	<div class={shell}>
		<PageHeader title="Trash" count={trashed.length}>
			{#if trashed.length > 0}
				{#if confirmEmpty}
					<span class="text-xs text-[var(--shard-text-muted)]">Delete all?</span>
					<button
						type="button"
						onclick={emptyTrash}
						class="rounded-full bg-red-600/10 px-3 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-600 hover:text-white dark:text-red-400"
						>Yes</button
					>
					<button
						type="button"
						onclick={() => (confirmEmpty = false)}
						class="rounded-full px-3 py-1 text-xs text-[var(--shard-text-muted)] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
						>No</button
					>
				{:else}
					<button
						type="button"
						onclick={() => (confirmEmpty = true)}
						class="rounded-full px-3 py-1 text-xs text-[var(--shard-text-muted)] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
						>Empty</button
					>
				{/if}
			{/if}
		</PageHeader>
	</div>

	{#if trashed.length === 0}
		<EmptyState
			icon={Trash2}
			description="Deleted notes stay here for 7 days before they are deleted forever."
		/>
	{:else}
		<NotesFeed notes={trashed} onOpen={openEditor}>
			{#snippet children(note)}
				<TrashCard {note} onOpen={openEditor} />
			{/snippet}
		</NotesFeed>
	{/if}
</div>
