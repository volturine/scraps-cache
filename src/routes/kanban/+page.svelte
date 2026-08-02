<script lang="ts">
	import KanbanCard from '$lib/components/KanbanCard.svelte';
	import {
		columnNotes,
		defaultBacklogFilter,
		moveNoteLabels,
		type BacklogFilter,
		type KanbanColumn
	} from '$lib/kanban';
	import { useEditorActions } from '$lib/editorContext';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { kanbanStore } from '$lib/stores/kanban.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';

	const { openNote } = useEditorActions();
	const board = $derived(kanbanStore.activeBoard);
	const visibleNotes = $derived(
		uiStore.search ? notesStore.search(uiStore.search, notesStore.activeNotes) : notesStore.activeNotes
	);
	const unusedTags = $derived(
		notesStore.labels.filter((label) => !board.columns.some((column) => column.labelId === label.id))
	);
	/** Tags that can be used in the backlog filter (not already a column). */
	const backlogFilterTags = $derived(unusedTags);
	const backlogFilter = $derived(board.backlogFilter ?? defaultBacklogFilter());
	const backlogFilterActive = $derived(backlogFilter.mode === 'custom');

	let renamingBoard = $state(false);
	let boardName = $state('');
	let boardNameId = '';
	let backlogFilterOpen = $state(false);

	$effect(() => {
		if (board.id !== boardNameId) {
			boardNameId = board.id;
			boardName = board.name;
			backlogFilterOpen = false;
		}
	});

	function commitBoardName() {
		const next = boardName.trim();
		if (!next) {
			boardName = board.name;
			return;
		}
		kanbanStore.renameBoard(board.id, next);
		renamingBoard = false;
	}

	function deleteActiveBoard() {
		const name = board.name.trim() || 'Untitled board';
		const message =
			kanbanStore.boards.length === 1
				? `Delete board “${name}”? A new empty board will be created.`
				: `Delete board “${name}”? This cannot be undone.`;
		if (!window.confirm(message)) return;
		renamingBoard = false;
		backlogFilterOpen = false;
		kanbanStore.deleteBoard(board.id);
	}

	function columnName(column: KanbanColumn): string {
		if (column.labelId === null) return 'Backlog';
		return notesStore.labels.find((label) => label.id === column.labelId)?.name ?? 'Deleted tag';
	}

	function addTagColumn(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const labelId = select.value;
		if (!labelId) return;
		kanbanStore.addTagColumn(board.id, labelId);
		select.value = '';
	}

	function setBacklogMode(mode: BacklogFilter['mode']) {
		if (mode === 'all-non-column') {
			kanbanStore.setBacklogFilter(board.id, defaultBacklogFilter());
			return;
		}
		kanbanStore.setBacklogFilter(board.id, {
			mode: 'custom',
			includeUntagged: backlogFilter.includeUntagged,
			labelIds: [...backlogFilter.labelIds]
		});
	}

	function toggleBacklogUntagged() {
		kanbanStore.setBacklogFilter(board.id, {
			mode: 'custom',
			includeUntagged: !backlogFilter.includeUntagged,
			labelIds: [...backlogFilter.labelIds]
		});
	}

	function toggleBacklogLabel(labelId: string) {
		const has = backlogFilter.labelIds.includes(labelId);
		const labelIds = has
			? backlogFilter.labelIds.filter((id) => id !== labelId)
			: [...backlogFilter.labelIds, labelId];
		kanbanStore.setBacklogFilter(board.id, {
			mode: 'custom',
			includeUntagged: backlogFilter.includeUntagged,
			labelIds
		});
	}

	function backlogFilterSummary(): string {
		if (backlogFilter.mode !== 'custom') return 'All non-column notes';
		const parts: string[] = [];
		if (backlogFilter.includeUntagged) parts.push('No tags');
		for (const id of backlogFilter.labelIds) {
			parts.push(notesStore.labels.find((label) => label.id === id)?.name ?? 'Deleted tag');
		}
		return parts.length ? parts.join(', ') : 'Nothing selected';
	}

	function moveNote(noteId: string, sourceColumnId: string, destinationColumnId: string) {
		if (sourceColumnId === destinationColumnId) return;
		const source = board.columns.find((column) => column.id === sourceColumnId);
		const destination = board.columns.find((column) => column.id === destinationColumnId);
		const note = notesStore.notes.find((candidate) => candidate.id === noteId);
		if (!source || !destination || !note) return;
		notesStore.updateNote(note.id, {
			labels: moveNoteLabels(note.labels, source.labelId, destination.labelId)
		});
	}

	function nativeDrop(event: DragEvent, destinationColumnId: string) {
		event.preventDefault();
		try {
			const raw = event.dataTransfer?.getData('application/x-shard-kanban');
			const payload = raw ? (JSON.parse(raw) as { noteId?: unknown; sourceColumnId?: unknown }) : null;
			if (typeof payload?.noteId === 'string' && typeof payload.sourceColumnId === 'string') {
				moveNote(payload.noteId, payload.sourceColumnId, destinationColumnId);
			}
		} catch {
			// Ignore drops that did not come from a Shard Kanban card.
		}
	}
</script>

<div class="pt-4 pb-8">
	<div class="mb-4 flex flex-wrap items-center gap-2">
		<select
			aria-label="Kanban board"
			value={board.id}
			onchange={(event) => kanbanStore.selectBoard((event.currentTarget as HTMLSelectElement).value)}
			class="min-w-0 max-w-full rounded-xl border border-[var(--gkc-border)] bg-[var(--gkc-surface)] px-3 py-2 text-base font-semibold text-[var(--gkc-text)] outline-none"
		>
			{#each kanbanStore.boards as choice (choice.id)}
				<option value={choice.id}>{choice.name}</option>
			{/each}
		</select>
		<button
			type="button"
			class="rounded-xl px-3 py-2 text-sm font-medium text-[var(--gkc-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--gkc-text)] dark:hover:bg-white/10"
			onclick={() => {
				kanbanStore.createBoard();
				renamingBoard = true;
			}}
		>
			New board
		</button>
		<button
			type="button"
			class="rounded-xl px-3 py-2 text-sm font-medium text-[var(--gkc-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--gkc-text)] dark:hover:bg-white/10"
			onclick={() => {
				boardName = board.name;
				renamingBoard = !renamingBoard;
			}}
			aria-expanded={renamingBoard}
		>
			Rename
		</button>
		<button
			type="button"
			class="rounded-xl px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/15"
			onclick={deleteActiveBoard}
			aria-label={`Delete board ${board.name}`}
		>
			Delete
		</button>
	</div>

	{#if renamingBoard}
		<div class="mb-4 flex max-w-md gap-2">
			<input
				bind:value={boardName}
				aria-label="Board name"
				onkeydown={(event) => {
					if (event.key === 'Enter') commitBoardName();
					if (event.key === 'Escape') renamingBoard = false;
				}}
				class="min-w-0 flex-1 rounded-xl border border-[var(--gkc-border)] bg-[var(--gkc-surface)] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400/40"
			/>
			<button
				type="button"
				onclick={commitBoardName}
				class="rounded-xl bg-black/[0.06] px-3 py-2 text-sm font-medium text-[var(--gkc-text)] hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
			>
				Save
			</button>
		</div>
	{/if}

	<div class="kanban-columns -mx-4 overflow-x-auto px-4 pb-4">
		<div class="flex min-w-max items-start gap-3">
			{#each board.columns as column (column.id)}
				<section
					data-kanban-column={column.id}
					class="w-[min(19rem,calc(100vw-2rem))] shrink-0 rounded-2xl bg-black/[0.035] p-2 dark:bg-white/[0.055]"
					aria-label={`${columnName(column)} Kanban column`}
					ondragover={(event) => event.preventDefault()}
					ondrop={(event) => nativeDrop(event, column.id)}
				>
					<div class="mb-2 flex items-center gap-2 px-1 pt-1">
						<h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--gkc-text)]">
							{columnName(column)}
						</h2>
						{#if column.labelId === null}
							<button
								type="button"
								class="grid h-7 min-w-7 place-items-center rounded-lg px-1.5 text-xs font-medium transition-colors {backlogFilterActive
									? 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
									: 'text-[var(--gkc-text-muted)] hover:bg-black/5 hover:text-[var(--gkc-text)] dark:hover:bg-white/10'}"
								onclick={() => (backlogFilterOpen = !backlogFilterOpen)}
								aria-expanded={backlogFilterOpen}
								aria-label="Backlog filter"
								title="Backlog filter"
							>
								Filter
							</button>
						{:else}
							<button
								type="button"
								onclick={() => kanbanStore.removeTagColumn(board.id, column.id)}
								class="grid h-7 w-7 place-items-center rounded-lg text-[var(--gkc-text-muted)] hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
								aria-label={`Remove ${columnName(column)} column`}
								title="Remove column"
							>
								×
							</button>
						{/if}
					</div>

					{#if column.labelId === null && backlogFilterOpen}
						<div
							class="mb-2 space-y-2 rounded-xl border border-black/10 bg-[var(--gkc-surface)] p-2 text-xs dark:border-white/10"
							role="group"
							aria-label="Backlog filter options"
						>
							<p class="text-[11px] leading-snug text-[var(--gkc-text-muted)]">
								Choose which notes show in Backlog. Notes already in a tag column are never listed
								here.
							</p>
							<label class="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
								<input
									type="radio"
									name="backlog-mode-{board.id}"
									checked={backlogFilter.mode === 'all-non-column'}
									onchange={() => setBacklogMode('all-non-column')}
									class="mt-0.5"
								/>
								<span>
									<span class="font-medium text-[var(--gkc-text)]">All non-column notes</span>
									<span class="mt-0.5 block text-[var(--gkc-text-muted)]"
										>Default: everything not in a tag column</span
									>
								</span>
							</label>
							<label class="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
								<input
									type="radio"
									name="backlog-mode-{board.id}"
									checked={backlogFilter.mode === 'custom'}
									onchange={() => setBacklogMode('custom')}
									class="mt-0.5"
								/>
								<span class="font-medium text-[var(--gkc-text)]">Only selected…</span>
							</label>

							{#if backlogFilter.mode === 'custom'}
								<div class="ml-1 space-y-1 border-l-2 border-black/10 pl-2 dark:border-white/10">
									<label
										class="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
									>
										<input
											type="checkbox"
											checked={backlogFilter.includeUntagged}
											onchange={toggleBacklogUntagged}
										/>
										<span class="text-[var(--gkc-text)]">No tags</span>
									</label>
									{#each backlogFilterTags as label (label.id)}
										<label
											class="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
										>
											<input
												type="checkbox"
												checked={backlogFilter.labelIds.includes(label.id)}
												onchange={() => toggleBacklogLabel(label.id)}
											/>
											<span class="truncate text-[var(--gkc-text)]">{label.name}</span>
										</label>
									{/each}
									{#if backlogFilterTags.length === 0}
										<p class="px-1 py-1 text-[var(--gkc-text-muted)]">
											No other tags available. Create tags on notes, or remove a tag column first.
										</p>
									{/if}
								</div>
							{/if}

							<p class="truncate px-1 text-[10px] text-[var(--gkc-text-muted)]" title={backlogFilterSummary()}>
								Showing: {backlogFilterSummary()}
							</p>
						</div>
					{/if}

					<div class="flex flex-col gap-2" aria-live="polite">
						{#each columnNotes(board, column, visibleNotes) as note (note.id)}
							<KanbanCard {note} sourceColumnId={column.id} onOpen={openNote} onMove={moveNote} />
						{/each}
						{#if columnNotes(board, column, visibleNotes).length === 0}
							<div
								class="rounded-xl border border-dashed border-black/10 px-3 py-5 text-center text-xs text-[var(--gkc-text-muted)] dark:border-white/10"
							>
								Drop a note here
							</div>
						{/if}
					</div>
				</section>
			{/each}

			{#if unusedTags.length > 0}
				<div class="w-[min(19rem,calc(100vw-2rem))] shrink-0 pt-1">
					<select
						aria-label="Add a tag column"
						value=""
						onchange={addTagColumn}
						class="w-full rounded-xl border border-dashed border-[var(--gkc-border)] bg-transparent px-3 py-2.5 text-left text-sm font-medium text-[var(--gkc-text-muted)] outline-none hover:bg-black/[0.035] dark:hover:bg-white/[0.055]"
					>
						<option value="">+ Add tag column</option>
						{#each unusedTags as label (label.id)}
							<option value={label.id}>{label.name}</option>
						{/each}
					</select>
				</div>
			{/if}
		</div>
	</div>
</div>
