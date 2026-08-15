<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { fly } from 'svelte/transition';
	import { flushSync } from 'svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { uiStore, type View } from '$lib/stores/ui.svelte';
	import type { Label } from '$lib/types';
	import {
		AlarmClock,
		Archive,
		Kanban,
		Pencil,
		Plus,
		StickyNote,
		Tag,
		Trash2,
		X,
		type LucideIcon
	} from '@lucide/svelte';
	import { portalToAppOverlay } from '$lib/appViewport';
	import { useEditorActions } from '$lib/editorContext';

	const { closeNote } = useEditorActions();

	let { onNavigate }: { onNavigate?: () => void } = $props();
	let labelsEditMode = $state(false);
	let creatingLabel = $state(false);
	let newLabelName = $state('');
	let renamingId = $state<string | null>(null);
	let renamingName = $state('');
	let pendingDelete: Label | null = $state(null);
	let newLabelInput: HTMLInputElement | null = $state(null);
	let renameInput: HTMLInputElement | null = $state(null);
	let navigationFrame: number | null = null;
	let navigationTimer: ReturnType<typeof setTimeout> | null = null;

	const navItems: { view: View; label: string; icon: LucideIcon }[] = [
		{ view: 'notes', label: 'Notes', icon: StickyNote },
		{ view: 'kanban', label: 'Kanban', icon: Kanban },
		{ view: 'reminders', label: 'Reminders', icon: AlarmClock },
		{ view: 'archive', label: 'Archive', icon: Archive },
		{ view: 'trash', label: 'Trash', icon: Trash2 }
	];

	const reminderCount = $derived(notesStore.notesWithReminders.length);
	const trashCount = $derived(notesStore.trashedNotes.length);
	const labelCounts = $derived(
		new Map(notesStore.labels.map((label) => [label.id, notesStore.notesForLabel(label.id).length]))
	);

	type Destination = '/' | '/kanban' | '/reminders' | '/archive' | '/trash' | `/label/${string}`;

	function destination(view: View, labelId: string | null = null): Destination | null {
		if (view === 'notes') return '/';
		if (view === 'kanban') return '/kanban';
		if (view === 'reminders') return '/reminders';
		if (view === 'archive') return '/archive';
		if (view === 'trash') return '/trash';
		return view === 'label' && labelId ? `/label/${labelId}` : null;
	}

	function navigate(view: View, labelId: string | null = null) {
		const target = destination(view, labelId);
		if (!target) return;
		closeNote();
		uiStore.setView(view, labelId);
		onNavigate?.();
		if (target === page.url.pathname) return;

		// The iPad trace showed that route work could run for ~300 ms before its
		// first animation frame. Commit the selection, then begin navigation from a
		// timer scheduled *after* the next rendering update. This is an actual paint
		// boundary rather than merely queueing goto() beside the state change.
		flushSync(() => {
			uiStore.pendingPath = target;
		});
		if (navigationFrame !== null) cancelAnimationFrame(navigationFrame);
		if (navigationTimer !== null) clearTimeout(navigationTimer);
		navigationFrame = requestAnimationFrame(() => {
			navigationFrame = null;
			navigationTimer = setTimeout(() => {
				navigationTimer = null;
				void goto(resolve(target)).finally(() => {
					if (uiStore.pendingPath === target) uiStore.pendingPath = null;
				});
			}, 0);
		});
	}

	function isActive(view: View, labelId: string | null = null): boolean {
		const target = destination(view, labelId);
		if (!target) return false;
		return uiStore.pendingPath ? uiStore.pendingPath === target : page.url.pathname === target;
	}

	function enterEditMode() {
		labelsEditMode = true;
		renamingId = null;
		newLabelName = '';
		pendingDelete = null;
	}

	function exitEditMode() {
		labelsEditMode = false;
		creatingLabel = false;
		renamingId = null;
		newLabelName = '';
		pendingDelete = null;
	}

	function startCreateLabel() {
		labelsEditMode = true;
		creatingLabel = true;
		renamingId = null;
		newLabelName = '';
		queueMicrotask(() => newLabelInput?.focus());
	}

	function finishCreateLabel() {
		notesStore.createLabel(newLabelName);
		newLabelName = '';
		creatingLabel = false;
	}

	function cancelCreateLabel() {
		newLabelName = '';
		creatingLabel = false;
	}

	function startRename(label: Label) {
		if (!labelsEditMode) return;
		pendingDelete = null;
		renamingId = label.id;
		renamingName = label.name;
		queueMicrotask(() => {
			renameInput?.focus();
			renameInput?.select();
		});
	}

	function saveRename(label: Label) {
		if (renamingId !== label.id) return;
		const name = renamingName.trim();
		if (name && name !== label.name) notesStore.renameLabel(label.id, name);
		renamingId = null;
	}

	function cancelRename() {
		renamingId = null;
	}

	function requestDelete(label: Label) {
		renamingId = null;
		pendingDelete = label;
	}

	function confirmDeleteLabelOnly() {
		const label = pendingDelete;
		if (!label) return;
		const id = label.id;
		pendingDelete = null;
		notesStore.removeLabel(id, { deleteNotes: false });
		if (isActive('label', id)) navigate('notes');
	}

	function confirmDeleteLabelAndNotes() {
		const label = pendingDelete;
		if (!label) return;
		const id = label.id;
		pendingDelete = null;
		notesStore.removeLabel(id, { deleteNotes: true });
		if (isActive('label', id)) navigate('notes');
	}

	function cancelDelete() {
		pendingDelete = null;
	}
</script>

<aside
	class="scrollable flex h-full flex-col gap-0.5 overflow-y-auto sidebar-scroll px-2 pb-4 pt-2"
	transition:fly={{ x: -20, duration: 120 }}
>
	{#each navItems as item (item.view)}
		{@const NavIcon = item.icon}
		<button
			type="button"
			onclick={() => navigate(item.view)}
			class="flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/10 {isActive(
				item.view
			)
				? 'nav-active'
				: 'text-[var(--shard-text-muted)]'}"
		>
			<span
				class="grid h-7 w-7 shrink-0 place-items-center text-[var(--shard-text)]"
				aria-hidden="true"
			>
				<NavIcon class="h-[18px] w-[18px]" strokeWidth={1.75} />
			</span>
			<span class="min-w-0 flex-1 truncate text-left">{item.label}</span>
			{#if item.view === 'reminders' && reminderCount > 0}
				<span class="shrink-0 text-xs tabular-nums opacity-70">{reminderCount}</span>
			{:else if item.view === 'trash' && trashCount > 0}
				<span class="shrink-0 text-xs tabular-nums opacity-70">{trashCount}</span>
			{/if}
		</button>
	{/each}

	<section class="mt-5" data-labels-edit aria-label="Labels">
		<div class="mb-1 flex h-8 items-center gap-2 pl-4 pr-2">
			<span
				class="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--shard-text-muted)]"
				>Labels</span
			>
			{#if labelsEditMode}
				<button
					type="button"
					onclick={exitEditMode}
					data-sidebar-stay-open
					class="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-[var(--shard-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--shard-text)] dark:hover:bg-white/10"
				>
					Done
				</button>
			{:else}
				<button
					type="button"
					onclick={enterEditMode}
					data-sidebar-stay-open
					class="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--shard-text-muted)] transition-colors hover:bg-black/8 hover:text-[var(--shard-text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-black/10 dark:hover:bg-white/10 dark:focus-visible:ring-white/15"
					aria-label="Edit labels"
					title="Edit labels"
				>
					<Pencil class="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
				</button>
			{/if}
		</div>

		{#if labelsEditMode && creatingLabel}
			<div class="mb-1 flex items-center gap-3 rounded-xl px-4 py-2" data-sidebar-stay-open>
				<span
					class="grid h-7 w-7 shrink-0 place-items-center text-[var(--shard-text-muted)]"
					aria-hidden="true"
				>
					<Tag class="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
				</span>
				<input
					bind:this={newLabelInput}
					bind:value={newLabelName}
					type="text"
					placeholder="New label"
					class="min-w-0 flex-1 bg-transparent text-sm text-[var(--shard-text)] outline-none placeholder:text-[var(--shard-text-muted)]"
					onblur={finishCreateLabel}
					onkeydown={(event) => {
						if (event.key === 'Enter') finishCreateLabel();
						if (event.key === 'Escape') cancelCreateLabel();
					}}
				/>
			</div>
		{:else if labelsEditMode}
			<button
				type="button"
				onclick={startCreateLabel}
				data-sidebar-stay-open
				class="mb-1 flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left text-sm text-[var(--shard-text-muted)] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
			>
				<span class="grid h-7 w-7 shrink-0 place-items-center" aria-hidden="true">
					<Plus class="h-4 w-4" strokeWidth={1.75} />
				</span>
				<span>New label</span>
			</button>
		{/if}

		{#if notesStore.labels.length === 0 && !labelsEditMode}
			<button
				type="button"
				onclick={startCreateLabel}
				class="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left text-sm text-[var(--shard-text-muted)] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
			>
				<span class="grid h-7 w-7 shrink-0 place-items-center" aria-hidden="true">
					<Plus class="h-4 w-4" strokeWidth={1.75} />
				</span>
				<span>New label</span>
			</button>
		{:else}
			<div class="flex flex-col gap-0.5">
				{#each notesStore.labels as label (label.id)}
					{#if labelsEditMode && renamingId === label.id}
						<div
							class="flex items-center gap-3 rounded-xl px-4 py-2 dark:bg-white/[0.04]"
							data-sidebar-stay-open
						>
							<span
								class="grid h-7 w-7 shrink-0 place-items-center text-[var(--shard-text-muted)]"
								aria-hidden="true"
							>
								<Tag class="h-4 w-4" strokeWidth={1.75} />
							</span>
							<input
								bind:this={renameInput}
								bind:value={renamingName}
								type="text"
								class="min-w-0 flex-1 bg-transparent text-sm font-medium text-[var(--shard-text)] outline-none"
								onblur={() => saveRename(label)}
								onkeydown={(event) => {
									if (event.key === 'Enter') saveRename(label);
									if (event.key === 'Escape') cancelRename();
								}}
							/>
						</div>
					{:else if labelsEditMode}
						<div class="flex items-center gap-3 rounded-xl py-2.5 pl-4 pr-2">
							<span
								class="grid h-7 w-7 shrink-0 place-items-center text-[var(--shard-text-muted)]"
								aria-hidden="true"
							>
								<Tag class="h-4 w-4" strokeWidth={1.75} />
							</span>
							<button
								type="button"
								onclick={() => startRename(label)}
								data-sidebar-stay-open
								class="min-w-0 flex-1 truncate text-left text-sm font-medium text-[var(--shard-text)]"
								title="Rename"
							>
								{label.name}
							</button>
							<button
								type="button"
								onclick={() => requestDelete(label)}
								data-sidebar-stay-open
								class="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--shard-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
								aria-label={`Delete ${label.name}`}
								title="Delete"
							>
								<X class="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
							</button>
						</div>
					{:else}
						<button
							type="button"
							onclick={() => navigate('label', label.id)}
							class="flex w-full items-center gap-3 rounded-xl py-2.5 pl-4 pr-2 text-left text-sm font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/10 {isActive(
								'label',
								label.id
							)
								? 'nav-active'
								: 'text-[var(--shard-text-muted)]'}"
						>
							<span class="grid h-7 w-7 shrink-0 place-items-center" aria-hidden="true">
								<Tag class="h-4 w-4" strokeWidth={1.75} />
							</span>
							<span class="min-w-0 flex-1 truncate">{label.name}</span>
							{#if (labelCounts.get(label.id) ?? 0) > 0}
								<span class="shrink-0 text-xs tabular-nums opacity-70"
									>{labelCounts.get(label.id)}</span
								>
							{/if}
						</button>
					{/if}
				{/each}
			</div>
		{/if}
	</section>
</aside>

{#if pendingDelete}
	<div
		{@attach portalToAppOverlay}
		class="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 p-4 sm:items-center"
		role="presentation"
		data-sidebar-stay-open
		onclick={(event) => {
			if (event.target === event.currentTarget) cancelDelete();
		}}
	>
		<div
			class="w-full max-w-sm rounded-2xl border border-[var(--shard-border)] bg-[var(--shard-surface)] p-4 shadow-2xl"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="label-delete-title"
			data-sidebar-stay-open
		>
			<h2 id="label-delete-title" class="text-base font-semibold text-[var(--shard-text)]">
				Delete “{pendingDelete.name}”?
			</h2>
			<p class="mt-1.5 text-sm leading-snug text-[var(--shard-text-muted)]">
				{#if (labelCounts.get(pendingDelete.id) ?? 0) > 0}
					This label is on {labelCounts.get(pendingDelete.id)} note{(labelCounts.get(
						pendingDelete.id
					) ?? 0) === 1
						? ''
						: 's'}.
				{:else}
					No notes currently use this label.
				{/if}
			</p>
			<div class="mt-4 flex flex-col gap-2">
				<button
					type="button"
					onclick={confirmDeleteLabelOnly}
					class="rounded-xl bg-black/[0.06] px-3 py-2.5 text-sm font-medium text-[var(--shard-text)] transition-colors hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
				>
					Delete label only
				</button>
				<button
					type="button"
					onclick={confirmDeleteLabelAndNotes}
					class="rounded-xl bg-red-600/90 px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-600"
				>
					Delete label and its notes
				</button>
				<button
					type="button"
					onclick={cancelDelete}
					class="rounded-xl px-3 py-2.5 text-sm font-medium text-[var(--shard-text-muted)] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}
