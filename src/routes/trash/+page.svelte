<script lang="ts">
	import TrashCard from '$lib/components/TrashCard.svelte';
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
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
	{#if trashed.length === 0}
		<div
			class="notes-content mt-16 flex flex-col items-center justify-center text-[var(--shard-text-muted)]"
		>
			<Trash2 class="mb-2 h-12 w-12" strokeWidth={1.5} aria-hidden="true" />
			<div class="text-sm">No notes in trash. Notes here are deleted forever after 7 days.</div>
		</div>
	{:else}
		<div class={shell}>
			<div class="mb-3 flex items-center gap-3 px-2">
				<h2 class="text-xs font-semibold uppercase tracking-wide text-[var(--shard-text-muted)]">
					Trash
				</h2>
				<span class="text-xs text-[var(--shard-text-muted)] opacity-60">{trashed.length}</span>
				<div class="flex-1"></div>
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
			</div>
		</div>

		<NotesFeed notes={trashed} onOpen={openEditor}>
			{#snippet children(note)}
				<TrashCard {note} onOpen={openEditor} />
			{/snippet}
		</NotesFeed>
	{/if}
</div>
