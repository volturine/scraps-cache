<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';
	import { uiStore, type View } from '$lib/stores/ui.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { syncStore } from '$lib/stores/sync.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Topbar from '$lib/components/Topbar.svelte';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import ReminderAlert from '$lib/components/ReminderAlert.svelte';
	import BottomNav from '$lib/components/BottomNav.svelte';
	import AppViews from '$lib/components/AppViews.svelte';
	import { reminderStore } from '$lib/stores/reminders.svelte';
	import { preloadVapidPublicKey } from '$lib/reminderWake';
	import { provideEditorActions } from '$lib/editorContext';
	import { fade, fly } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { attachSyncCloudIndicator } from '$lib/syncCloudIndicator';
	import { attachAppViewport } from '$lib/appViewport';
	import { attachSidebarSwipe } from '$lib/sidebarSwipe';
	import { dayKey, reminderTimeForDay } from '$lib/utils';

	let { children }: LayoutProps = $props();
	let oauthAuthorization = $derived(page.url.pathname === '/mcp/oauth/authorize');

	const mobile = new MediaQuery('max-width: 767px');
	let editingId = $state<string | null>(null);
	let closeOpenNote: (() => void) | null = null;

	function applyEditorOpen(open: boolean) {
		document.documentElement.classList.toggle('editor-open', open);
	}

	function openEditor(id: string) {
		editingId = id;
		applyEditorOpen(true);
		if (syncStore.isLoggedIn) void notesStore.syncWithCloud();
	}

	function openNoteFromQuery() {
		const noteId = new URL(window.location.href).searchParams.get('note');
		if (!noteId || !notesStore.notes.some((note) => note.id === noteId)) return;
		editingId = noteId;
		applyEditorOpen(true);
		const next = new URL(window.location.href);
		next.searchParams.delete('note');
		history.replaceState(history.state, '', `${next.pathname}${next.search}${next.hash}`);
	}

	onMount(() => {
		if (oauthAuthorization) return;
		applyEditorOpen(editingId !== null);
		const stopViewport = attachAppViewport(document.documentElement);
		uiStore.viewChangeHandler = restoreFeedScroll;
		attachSyncCloudIndicator(syncStore);
		notesStore.onAfterSync = () => reminderStore.publish(notesStore.notes);
		if (mobile.current) uiStore.sidebarOpen = false;
		void notesStore.init().then(async () => {
			if (syncStore.isLoggedIn) await notesStore.syncWithCloud();
			openNoteFromQuery();
			reminderStore.sync(notesStore.notes);
		});
		const onForeground = () => {
			if (document.visibilityState === 'hidden') return;
			if (syncStore.isLoggedIn) void notesStore.syncWithCloud();
		};
		document.addEventListener('visibilitychange', onForeground);
		const stopReminders = reminderStore.attach(openEditor);
		void preloadVapidPublicKey();
		if ('serviceWorker' in navigator) {
			if (import.meta.env.PROD) {
				// Version query forces browsers to re-fetch sw.js after deploys.
				void navigator.serviceWorker
					.register('/sw.js', { updateViaCache: 'none' })
					.then((reg) => reg.update())
					.then(() => reminderStore.sync(notesStore.notes))
					.catch(() => undefined);
			} else {
				void navigator.serviceWorker
					.getRegistrations()
					.then((registrations) => {
						for (const registration of registrations) void registration.unregister();
					})
					.catch(() => undefined);
			}
		}
		return () => {
			uiStore.viewChangeHandler = null;
			stopViewport();
			applyEditorOpen(false);
			document.removeEventListener('visibilitychange', onForeground);
			stopReminders();
		};
	});

	function startNewNote() {
		const labels =
			uiStore.view === 'label' &&
			uiStore.activeLabelId &&
			notesStore.labels.some((label) => label.id === uiStore.activeLabelId)
				? [uiStore.activeLabelId]
				: [];
		const n = notesStore.createNote({
			title: '',
			body: '',
			labels,
			reminder:
				uiStore.view === 'reminders'
					? reminderTimeForDay(uiStore.reminderFilter?.from ?? dayKey(Date.now()))
					: null
		});
		editingId = n.id;
		applyEditorOpen(true);
	}

	function requestCloseEditor() {
		closeOpenNote?.();
	}

	provideEditorActions({ openNote: openEditor, startNewNote, closeNote: requestCloseEditor });

	let feedEl: HTMLElement | null = $state(null);

	// Preserve each view's scroll offset across switches; display:none panes
	// would otherwise lose it. Save on scroll so restore does not need to
	// read scrollTop after the outgoing pane is already hidden.
	const scrollTops = new Map<string, number>();

	function viewKey(view: View, labelId: string | null): string {
		return labelId ? `${view}:${labelId}` : view;
	}

	function rememberFeedScroll() {
		if (!feedEl) return;
		scrollTops.set(viewKey(uiStore.view, uiStore.activeLabelId), feedEl.scrollTop);
	}

	function restoreFeedScroll() {
		if (!feedEl) return;
		const key = viewKey(uiStore.view, uiStore.activeLabelId);
		const target = scrollTops.get(key) ?? 0;
		queueMicrotask(() => {
			if (feedEl && viewKey(uiStore.view, uiStore.activeLabelId) === key) {
				feedEl.scrollTop = target;
			}
		});
	}

	function closeEditor() {
		editingId = null;
		applyEditorOpen(false);
	}

	function closeMobileSidebar() {
		uiStore.sidebarOpen = false;
	}
</script>

<svelte:head>
	<title>Scraps Cache</title>
	<meta name="theme-color" content={uiStore.effectiveDark ? '#1a1a1a' : '#ffffff'} />
</svelte:head>

{#if oauthAuthorization}
	{@render children()}
{:else}
	<div class="app-viewport">
		<div
			class="app-shell flex h-full w-full overflow-hidden bg-[var(--scrapscache-bg)] text-[var(--scrapscache-text)]"
			{@attach mobile.current &&
				attachSidebarSwipe({
					getOpen: () => uiStore.sidebarOpen,
					open: () => {
						uiStore.sidebarOpen = true;
					},
					close: () => {
						uiStore.sidebarOpen = false;
					}
				})}
		>
			{#if mobile.current}
				{#if uiStore.sidebarOpen}
					<button
						type="button"
						aria-label="Close sidebar"
						data-sidebar-backdrop
						class="fixed inset-0 z-20 bg-black/30"
						onclick={() => {
							uiStore.sidebarOpen = false;
						}}
						transition:fade={{ duration: 150 }}
					></button>
					<div
						class="fixed left-0 top-0 z-30 h-full w-72 border-r border-[var(--scrapscache-border)] bg-[var(--scrapscache-surface)]"
						transition:fly={{ x: -288, duration: 200 }}
						role="navigation"
						aria-label="Sidebar"
						data-sidebar-drawer
					>
						<Sidebar onNavigate={closeMobileSidebar} />
					</div>
				{/if}
			{:else}
				{#if uiStore.sidebarOpen}
					<div class="w-64 shrink-0 border-r border-[var(--scrapscache-border)]">
						<Sidebar />
					</div>
				{/if}
			{/if}

			<div class="flex min-h-0 min-w-0 flex-1 flex-col">
				<Topbar />
				<div class="app-canvas relative min-h-0 min-w-0 flex-1">
					<main
						bind:this={feedEl}
						class="app-feed scrollable h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 pb-20 md:pb-6"
						onscroll={rememberFeedScroll}
					>
						{@render children()}
						<AppViews />
					</main>
					<div class="app-float" data-app-float>
						<BottomNav />
						<ReminderAlert />
						{#key editingId}
							<NoteEditor
								noteId={editingId}
								onClose={closeEditor}
								registerClose={(fn) => {
									closeOpenNote = fn;
								}}
							/>
						{/key}
					</div>
				</div>
			</div>
		</div>
	</div>
	<div class="app-overlay" data-app-overlay></div>
{/if}
