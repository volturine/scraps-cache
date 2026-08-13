<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import { page } from '$app/state';
	import { Tag } from '@lucide/svelte';

	const { openNote: openEditor } = useEditorActions();

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
		{#if !label}
			<div
				class="notes-content mt-16 flex flex-col items-center justify-center text-[var(--gkc-text-muted)]"
			>
				<Tag class="mb-2 h-12 w-12" strokeWidth={1.5} aria-hidden="true" />
				<div class="text-sm">Label not found.</div>
			</div>
		{:else if notes.length === 0}
			<div
				class="notes-content mt-16 flex flex-col items-center justify-center text-[var(--gkc-text-muted)]"
			>
				<Tag class="mb-2 h-12 w-12" strokeWidth={1.5} aria-hidden="true" />
				<div class="text-sm">No notes with this label yet.</div>
			</div>
		{:else}
			<div class={shell}>
				<h1 class="mb-4 px-2 text-xl font-medium text-[var(--gkc-text)]">{label.name}</h1>
			</div>

			{#if pinned.length > 0}
				<div class={shell}>
					<h2
						class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--gkc-text-muted)]"
					>
						Pinned
					</h2>
				</div>
				<NotesFeed notes={pinned} onOpen={openEditor} class="mb-6" />
			{/if}

			{#if pinned.length > 0 && others.length > 0}
				<div class={shell}>
					<h2
						class="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--gkc-text-muted)]"
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
