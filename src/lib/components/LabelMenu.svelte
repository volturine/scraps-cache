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
	let newNameInput = $state<HTMLInputElement | null>(null);

	const note = $derived(notesStore.notes.find((n) => n.id === noteId));

	function toggle(id: string) {
		if (!note) return;
		notesStore.toggleLabel(noteId, id);
	}

	function createAndAssign() {
		// Read the input directly as well as the bound state. On mobile, a very
		// quick first tap can arrive before the reactive binding settles.
		const name = (newNameInput?.value ?? newName).trim();
		if (!name) return;
		const label = notesStore.createLabel(name);
		newName = '';
		if (label && note) notesStore.toggleLabel(noteId, label.id);
	}

	function keepKeyboardOpen(event: PointerEvent) {
		if (event.pointerType !== 'touch') return;
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest('button')) event.preventDefault();
	}

	function labelMenuInteractions(node: HTMLElement) {
		node.addEventListener('pointerdown', keepKeyboardOpen);
		return {
			destroy() {
				node.removeEventListener('pointerdown', keepKeyboardOpen);
			}
		};
	}
</script>

<div use:labelMenuInteractions class="scrapscache-popover w-80 p-4">
	<div class="mb-3 text-sm font-medium text-[var(--scrapscache-text)]">Label as</div>

	<!-- Create new label -->
	<div class="mb-3 flex gap-2">
		<input
			bind:this={newNameInput}
			type="text"
			bind:value={newName}
			placeholder="Create new label…"
			onkeydown={(e) => e.key === 'Enter' && createAndAssign()}
			class="scrapscache-input w-full rounded-full px-3 py-2 text-sm"
		/>
		<button
			type="button"
			onclick={createAndAssign}
			aria-disabled={!newName.trim()}
			class="scrapscache-button scrapscache-button-secondary grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--scrapscache-text-muted)]"
			aria-label="Create label"
			title="Create label"
		>
			<Plus class="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
		</button>
	</div>

	<!-- Label list with checkboxes -->
	<div class="flex max-h-60 flex-col gap-1 overflow-y-auto sidebar-scroll">
		{#if notesStore.labels.length === 0}
			<div class="py-3 text-center text-xs text-[var(--scrapscache-text-muted)]">
				No labels yet. Create one above.
			</div>
		{:else}
			{#each notesStore.labels as label (label.id)}
				{#if note}
					<button
						type="button"
						onclick={() => toggle(label.id)}
						class="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-[var(--scrapscache-text)] hover:bg-black/5 dark:hover:bg-white/10"
					>
						<span
							class="h-5 w-5 shrink-0 rounded border-2 border-black/30 dark:border-white/30 flex items-center justify-center text-xs {note.labels.includes(
								label.id
							)
								? 'border-[var(--scrapscache-accent)] bg-[var(--scrapscache-accent)] text-[var(--scrapscache-accent-foreground)]'
								: ''}"
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
