<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { syncStore } from '$lib/stores/sync.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Topbar from '$lib/components/Topbar.svelte';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import BottomNav from '$lib/components/BottomNav.svelte';
	import { provideEditorActions } from '$lib/editorContext';
	import { fade, fly } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { attachSyncCloudIndicator } from '$lib/syncCloudIndicator';
	import { attachAppViewport } from '$lib/appViewport';

	let { children } = $props();
	const mobile = new MediaQuery('max-width: 767px');

	onMount(() => {
		attachSyncCloudIndicator(syncStore);
		if (mobile.current) uiStore.sidebarOpen = false;
		void notesStore.init().then(() => {
			if (syncStore.isLoggedIn) setTimeout(() => notesStore.syncWithCloud(), 3000);
		});
		if ('serviceWorker' in navigator) {
			if (import.meta.env.PROD) {
				// Version query forces browsers to re-fetch sw.js after deploys.
				void navigator.serviceWorker
					.register('/sw.js?v=2')
					.then((reg) => reg.update())
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
	});

	let editingId = $state<string | null>(null);
	let editorDismissTick = $state(0);
	let editorFocusOnOpen = $state(false);

	$effect(() => {
		const dark = uiStore.effectiveDark;
		const bg = dark ? '#1a1a1a' : '#ffffff';
		document.documentElement.classList.toggle('dark', dark);
		// Document canvas, not the note overlay. Safari paints overscroll /
		// toolbar gutters from this color; without it light mode shows black strips.
		document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
		document.documentElement.style.backgroundColor = bg;
		document.body.style.backgroundColor = bg;
	});

	function openEditor(id: string) {
		editorFocusOnOpen = false;
		editingId = id;
	}

	function startNewNote() {
		const routeLabelId = page.params.label;
		const labels =
			typeof routeLabelId === 'string' &&
			notesStore.labels.some((label) => label.id === routeLabelId)
				? [routeLabelId]
				: [];
		const n = notesStore.createNote({
			title: '',
			body: '',
			labels
		});
		editorFocusOnOpen = true;
		editingId = n.id;
	}

	function requestCloseEditor() {
		if (editingId === null) return;
		editorDismissTick += 1;
	}

	provideEditorActions({ openNote: openEditor, startNewNote, closeNote: requestCloseEditor });

	// Toggle editor-open class on <html> for compositing isolation.
	$effect(() => {
		document.documentElement.classList.toggle('editor-open', editingId !== null);
	});

	function closeEditor() {
		editingId = null;
	}

	function closeMobileSidebar() {
		uiStore.sidebarOpen = false;
	}
</script>

<svelte:head>
	<title>Shard</title>
	<meta name="theme-color" content={uiStore.effectiveDark ? '#1a1a1a' : '#ffffff'} />
</svelte:head>

<div class="app-viewport" {@attach attachAppViewport}>
	<div
		class="app-shell flex h-full w-full overflow-hidden bg-[var(--shard-bg)] text-[var(--shard-text)]"
	>
		{#if mobile.current}
			{#if uiStore.sidebarOpen}
				<button
					type="button"
					aria-label="Close sidebar"
					class="fixed inset-0 z-20 bg-black/30"
					onclick={() => {
						uiStore.sidebarOpen = false;
					}}
					transition:fade={{ duration: 150 }}
				></button>
				<div
					class="fixed left-0 top-0 z-30 h-full w-72 border-r border-[var(--shard-border)] bg-[var(--shard-surface)]"
					transition:fly={{ x: -288, duration: 200 }}
					role="navigation"
					aria-label="Sidebar"
				>
					<Sidebar onNavigate={closeMobileSidebar} />
				</div>
			{/if}
		{:else}
			{#if uiStore.sidebarOpen}
				<div class="w-64 shrink-0 border-r border-[var(--shard-border)]">
					<Sidebar />
				</div>
			{/if}
		{/if}

		<div class="flex min-h-0 min-w-0 flex-1 flex-col">
			<Topbar />
			<div class="app-canvas relative min-h-0 min-w-0 flex-1">
				<main
					class="scrollable h-full min-h-0 overflow-y-auto overflow-x-hidden px-4 pb-20 md:pb-6"
				>
					{@render children()}
				</main>
				<div class="app-float" data-app-float>
					<BottomNav />
					<NoteEditor
						noteId={editingId}
						dismissTick={editorDismissTick}
						focusOnOpen={editorFocusOnOpen}
						onClose={closeEditor}
					/>
				</div>
			</div>
		</div>
	</div>
	<div class="app-overlay" data-app-overlay></div>
</div>
