<script lang="ts">
	import { useEditorActions } from '$lib/editorContext';
	import { Plus } from '@lucide/svelte';

	const { startNewNote } = useEditorActions();
</script>

<!-- Floating + button — bottom right on every device -->
<div class="fixed z-10 bottom-8 right-6">
	<button
		type="button"
		onclick={startNewNote}
		class="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--gkc-border)] bg-[var(--gkc-surface)] shadow-lg"
		aria-label="New note"
		title="New note"
	>
		<Plus class="h-6 w-6" strokeWidth={2.5} aria-hidden="true" />
	</button>
</div>
