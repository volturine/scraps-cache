<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { uiStore, type View } from '$lib/stores/ui.svelte';
	import { viewForPath } from '$lib/viewRoutes';
	import NotesHomeView from '$lib/components/views/NotesHomeView.svelte';
	import LabelView from '$lib/components/views/LabelView.svelte';
	import ArchiveView from '$lib/components/views/ArchiveView.svelte';
	import TrashView from '$lib/components/views/TrashView.svelte';
	import RemindersView from '$lib/components/views/RemindersView.svelte';
	import KanbanView from '$lib/components/views/KanbanView.svelte';

	// URL is the source of truth for back/forward and deep links. Only the
	// pathname is a dependency: reading uiStore.view here would re-run this
	// effect on every optimistic setView (URL still stale) and yank the view
	// back, fighting Sidebar's navigation.
	$effect(() => {
		const pathname = page.url.pathname;
		untrack(() => {
			const target = viewForPath(pathname);
			if (target.view !== uiStore.view || target.labelId !== uiStore.activeLabelId) {
				uiStore.setView(target.view, target.labelId);
			}
		});
	});

	/**
	 * Keep-alive: every view mounts on first visit and stays alive (hidden via
	 * display:none) so switching views never tears down or rebuilds card trees.
	 */
	let visited = $state<Record<View, boolean>>({
		notes: false,
		label: false,
		archive: false,
		trash: false,
		reminders: false,
		kanban: false
	});
	$effect.pre(() => {
		visited[uiStore.view] = true;
	});
</script>

{#if visited.notes}
	<div class:hidden={uiStore.view !== 'notes'}>
		<NotesHomeView />
	</div>
{/if}
{#if visited.label}
	<div class:hidden={uiStore.view !== 'label'}>
		<LabelView />
	</div>
{/if}
{#if visited.archive}
	<div class:hidden={uiStore.view !== 'archive'}>
		<ArchiveView />
	</div>
{/if}
{#if visited.trash}
	<div class:hidden={uiStore.view !== 'trash'}>
		<TrashView />
	</div>
{/if}
{#if visited.reminders}
	<div class:hidden={uiStore.view !== 'reminders'}>
		<RemindersView />
	</div>
{/if}
{#if visited.kanban}
	<div class:hidden={uiStore.view !== 'kanban'}>
		<KanbanView />
	</div>
{/if}
