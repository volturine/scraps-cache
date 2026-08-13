<script lang="ts">
	import { notesStore } from '$lib/stores/notes.svelte';
	import { Plus } from '@lucide/svelte';

	let {
		noteId,
		onClose
	}: {
		noteId: string;
		onClose: () => void;
	} = $props();

	let newName = $state('');

	const note = $derived(notesStore.notes.find((n) => n.id === noteId));

	function toggle(id: string) {
		if (!note) return;
		notesStore.toggleLabel(noteId, id);
	}

	function createAndAssign() {
		const name = newName.trim();
		if (!name) return;
		const label = notesStore.createLabel(name);
		newName = '';
		if (label && note) notesStore.toggleLabel(noteId, label.id);
	}
</script>

<div class="w-80 rounded-xl border border-[var(--gkc-border)] bg-[var(--gkc-surface)] p-4 shadow-2xl">
	<div class="mb-3 text-sm font-medium text-[var(--gkc-text)]">Label as</div>

	<!-- Create new label -->
	<div class="mb-3 flex gap-2">
		<input
			type="text"
			bind:value={newName}
			placeholder="Create new label…"
			onkeydown={(e) => e.key === 'Enter' && createAndAssign()}
			class="w-full rounded-full border border-[var(--gkc-border)] bg-[var(--gkc-bg)] px-3 py-2 text-sm text-[var(--gkc-text)] focus:outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/15"
		/>
		<button
			type="button"
			onclick={createAndAssign}
			disabled={!newName.trim()}
			class="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[var(--gkc-border)] text-[var(--gkc-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--gkc-text)] disabled:opacity-40 dark:hover:bg-white/10"
			aria-label="Create label"
			title="Create label"
		>
			<Plus class="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
		</button>
	</div>

	<!-- Label list with checkboxes -->
	<div class="flex max-h-60 flex-col gap-1 overflow-y-auto sidebar-scroll">
		{#if notesStore.labels.length === 0}
			<div class="py-3 text-center text-xs text-[var(--gkc-text-muted)]">
				No labels yet. Create one above.
			</div>
		{:else}
			{#each notesStore.labels as label (label.id)}
				{#if note}
					<button
						type="button"
						onclick={() => toggle(label.id)}
						class="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-[var(--gkc-text)] hover:bg-black/5 dark:hover:bg-white/10"
					>
						<span
							class="h-5 w-5 shrink-0 rounded border-2 border-black/30 dark:border-white/30 flex items-center justify-center text-xs {note.labels.includes(label.id) ? 'bg-blue-500 border-blue-500 text-white' : ''}"
						>
							{#if note.labels.includes(label.id)}✓{/if}
						</span>
						<span class="truncate">{label.name}</span>
					</button>
				{/if}
			{/each}
		{/if}
	</div>
</div>
