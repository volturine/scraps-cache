<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { page } from '$app/state';
	import { Tag } from '@lucide/svelte';

	const { openNote: openEditor, startNewNote } = useEditorActions();

	const labelId = $derived(page.params.label);
	const label = $derived(notesStore.labels.find((l) => l.id === labelId));
	const notes = $derived(
		label ? notesStore.activeNotes.filter((n) => n.labels.includes(label.id)) : []
	);
	const pinned = $derived(notes.filter((n) => n.pinned));
	const others = $derived(notes.filter((n) => !n.pinned));
	const shell = $derived(notesShellClass());
</script>

{#key labelId}
	<div class="pt-4 pb-8">
		<div class={shell}>
			<PageHeader title={label?.name ?? 'Label'} count={label ? notes.length : undefined} />
		</div>

		{#if !label}
			<EmptyState
				icon={Tag}
				description="This label no longer exists."
				actionLabel="Go to Notes"
				href="/"
			/>
		{:else if notes.length === 0}
			<EmptyState
				icon={Tag}
				description="Create a note to start collecting ideas under this label."
				actionLabel="Create note"
				onAction={startNewNote}
			/>
		{:else}
			{#if pinned.length > 0}
				<div class={shell}>
					<h2
						class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--shard-text-muted)]"
					>
						Pinned
					</h2>
				</div>
				<NotesFeed notes={pinned} onOpen={openEditor} class="mb-6" />
			{/if}

			{#if pinned.length > 0 && others.length > 0}
				<div class={shell}>
					<h2
						class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--shard-text-muted)]"
					>
						Others
					</h2>
				</div>
			{/if}

			{#if others.length > 0}
				<NotesFeed notes={others} onOpen={openEditor} />
			{/if}
		{/if}
	</div>
{/key}
