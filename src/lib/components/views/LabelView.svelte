<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { Tag } from '@lucide/svelte';

	const { openNote: openEditor } = useEditorActions();

	const labelId = $derived(uiStore.activeLabelId);
	const label = $derived(labelId ? notesStore.labelsById.get(labelId) : undefined);
	const notes = $derived(
		label ? notesStore.activeNotes.filter((n) => n.labels.includes(label.id)) : []
	);
	const pinned = $derived(notes.filter((n) => n.pinned));
	const others = $derived(notes.filter((n) => !n.pinned));
	const shell = $derived(notesShellClass());
</script>

<div class="pt-4 pb-8">
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
		/>
	{:else}
		<div class={shell}>
			<h1 class="mb-4 px-2 text-xl font-medium text-[var(--scrapscache-text)]">{label.name}</h1>
		</div>

		{#if pinned.length > 0}
			<div class={shell}>
				<h2
					class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--scrapscache-text-muted)]"
				>
					Pinned
				</h2>
			</div>
			<NotesFeed notes={pinned} onOpen={openEditor} class="mb-6" />
		{/if}

		{#if pinned.length > 0 && others.length > 0}
			<div class={shell}>
				<h2
					class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--scrapscache-text-muted)]"
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
