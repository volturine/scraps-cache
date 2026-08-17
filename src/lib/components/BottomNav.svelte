<script lang="ts">
	import { useEditorActions } from '$lib/editorContext';
	import { Plus } from '@lucide/svelte';

	const { startNewNote } = useEditorActions();
</script>

<!-- Floating + button — bottom right on every device -->
<div class="new-note-fab fixed z-[60] bottom-[var(--app-fab-bottom)] right-6">
	<button
		type="button"
		onclick={startNewNote}
		class="flex h-[var(--app-fab-size)] w-[var(--app-fab-size)] items-center justify-center rounded-full border border-[var(--scraps-cache-border)] bg-[var(--scraps-cache-surface)] shadow-lg"
		aria-label="New note"
		title="New note"
	>
		<Plus class="h-6 w-6" strokeWidth={2.5} aria-hidden="true" />
	</button>
</div>
