<script lang="ts">
	import NotesFeed from '$lib/components/NotesFeed.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { notesShellClass } from '$lib/notesShell';
	import { useEditorActions } from '$lib/editorContext';
	import { AlarmClock } from '@lucide/svelte';

	const { openNote: openEditor } = useEditorActions();
	const reminders = $derived(notesStore.notesWithReminders);
	const shell = $derived(notesShellClass());
</script>

<div class="pt-4 pb-8">
	{#if reminders.length === 0}
		<div
			class="notes-content mt-16 flex flex-col items-center justify-center text-[var(--gkc-text-muted)]"
		>
			<AlarmClock class="mb-2 h-12 w-12" strokeWidth={1.5} aria-hidden="true" />
			<div class="text-sm">No reminders yet. Add one from a note.</div>
		</div>
	{:else}
		<div class={shell}>
			<h2
				class="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-[var(--gkc-text-muted)]"
			>
				Reminders
			</h2>
		</div>
		<NotesFeed notes={reminders} onOpen={openEditor} />
	{/if}
</div>
