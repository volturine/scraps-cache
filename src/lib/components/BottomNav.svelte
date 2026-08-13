<script lang="ts">
	import { useEditorActions } from '$lib/editorContext';

	const { startNewNote } = useEditorActions();
</script>

<!-- Floating + button — bottom right on every device -->
<div class="new-note-fab fixed bottom-8 right-6 z-10">
	<button
		type="button"
		onclick={startNewNote}
		class="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--gkc-border)] bg-[var(--gkc-surface)] shadow-lg"
		aria-label="New note"
		title="New note"
	>
		<svg viewBox="0 0 24 24" class="h-6 w-6">
			<line x1="12" y1="5" x2="12" y2="19" stroke="#4285F4" stroke-width="3" stroke-linecap="round"/>
			<line x1="5" y1="12" x2="19" y2="12" stroke="#EA4335" stroke-width="3" stroke-linecap="round"/>
		</svg>
	</button>
</div>
