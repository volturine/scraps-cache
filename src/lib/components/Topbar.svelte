<script lang="ts">
	import { uiStore } from '$lib/stores/ui.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { downloadJSON } from '$lib/utils';
	import { syncStore } from '$lib/stores/sync.svelte';
	import SyncModal from './SyncModal.svelte';
	import ReminderNotificationSettings from './ReminderNotificationSettings.svelte';
	import BackupPassphraseDialog from './BackupPassphraseDialog.svelte';
	import BackupImportModeDialog from './BackupImportModeDialog.svelte';
	import type { BackupImportMode } from '$lib/backup';
	import { useEditorActions } from '$lib/editorContext';
	import {
		decryptBackup,
		encryptBackup,
		isEncryptedScrapsCacheBackup,
		type EncryptedScrapsCacheBackup
	} from '$lib/backupCrypto';
	import {
		Cloud,
		Download,
		ExternalLink,
		LayoutGrid,
		List,
		Menu,
		Moon,
		Search,
		Settings,
		Sun,
		Upload,
		X
	} from '@lucide/svelte';

	const { startNewNote, closeNote } = useEditorActions();

	let fileInputEl: HTMLInputElement | null = $state(null);
	let settingsOpen = $state(false);
	let syncOpen = $state(false);
	let importingBackup = $state(false);
	let backupImportError = $state('');
	let backupDialogMode = $state<'export' | 'import' | null>(null);
	let backupBusy = $state(false);
	let pendingEncryptedBackup = $state<EncryptedScrapsCacheBackup | null>(null);
	let pendingImportData = $state.raw<unknown>(null);
	let choosingImportMode = $state(false);
	let syncStatus = $derived.by(() => {
		if (syncStore.lastError) return 'danger';
		if (!syncStore.usage) return 'normal';
		const ratio = syncStore.usage.storageBytes / syncStore.usage.maxBytes;
		return ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warning' : 'normal';
	});
	let syncControlLabel = $derived(
		syncStatus === 'danger'
			? 'Sync settings, sync needs attention'
			: syncStatus === 'warning'
				? 'Sync settings, storage nearly full'
				: 'Sync settings'
	);

	function startBackupExport() {
		settingsOpen = false;
		backupImportError = '';
		backupDialogMode = 'export';
	}

	async function submitBackupPassphrase(passphrase: string) {
		backupBusy = true;
		backupImportError = '';
		try {
			if (backupDialogMode === 'export') {
				const data = await notesStore.exportBackup();
				const encrypted = await encryptBackup(data, passphrase);
				downloadJSON(
					encrypted,
					`scrapscache-backup-${new Date().toISOString().slice(0, 10)}.scraps-cache-backup`
				);
				backupDialogMode = null;
				return;
			}
			if (backupDialogMode === 'import' && pendingEncryptedBackup) {
				const decrypted = await decryptBackup(pendingEncryptedBackup, passphrase);
				pendingImportData = decrypted;
				pendingEncryptedBackup = null;
				backupDialogMode = null;
				settingsOpen = false;
				choosingImportMode = true;
			}
		} catch (error) {
			backupImportError = error instanceof Error ? error.message : 'Backup operation failed.';
		} finally {
			backupBusy = false;
			importingBackup = false;
		}
	}

	async function selectImportMode(mode: BackupImportMode) {
		if (!pendingImportData) return;
		choosingImportMode = false;
		importingBackup = true;
		settingsOpen = true;
		backupImportError = '';
		try {
			const result = await notesStore.importBackup(pendingImportData, mode);
			if (!result.success) throw new Error(result.error || 'Could not import that backup.');
			pendingImportData = null;
			settingsOpen = false;
		} catch (error) {
			backupImportError = error instanceof Error ? error.message : 'Backup operation failed.';
			choosingImportMode = true;
			settingsOpen = false;
		} finally {
			importingBackup = false;
		}
	}

	function importBackup(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (importingBackup) return;
		importingBackup = true;
		backupImportError = '';
		const reader = new FileReader();
		reader.onload = async () => {
			try {
				const data = JSON.parse(String(reader.result));
				if (!isEncryptedScrapsCacheBackup(data))
					throw new Error('This is not a current encrypted Scraps Cache backup.');
				pendingEncryptedBackup = data;
				backupDialogMode = 'import';
				settingsOpen = false;
			} catch (err) {
				backupImportError = err instanceof Error ? err.message : 'Could not read that backup file.';
			} finally {
				importingBackup = false;
				input.value = '';
			}
		};
		reader.onerror = () => {
			importingBackup = false;
			backupImportError = 'Could not read that backup file.';
			input.value = '';
		};
		reader.readAsText(file);
	}

	function handleKeydown(e: KeyboardEvent) {
		// Ctrl+/ focuses composer.
		if ((e.ctrlKey || e.metaKey) && e.key === '/') {
			e.preventDefault();
			startNewNote();
		}
		// Escape closes settings
		if (e.key === 'Escape') {
			if (importingBackup) return;
			settingsOpen = false;
		}
	}

	// Close settings when clicking outside the settings dropdown.
	let settingsContainer: HTMLElement | null = $state(null);

	function handleWindowClick(e: MouseEvent) {
		if (!settingsOpen || importingBackup) return;
		const target = e.target as HTMLElement;
		if (settingsContainer && !settingsContainer.contains(target)) {
			settingsOpen = false;
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<header
	class="relative z-20 flex h-[var(--app-topbar-height)] shrink-0 items-center gap-1 px-2 sm:gap-2 sm:px-3"
	onpointerdown={closeNote}
>
	<button
		class="icon-btn h-10 w-10 p-2"
		title="Toggle sidebar"
		onclick={() => uiStore.toggleSidebar()}
		aria-label="Toggle sidebar"
	>
		<Menu class="h-5 w-5" aria-hidden="true" />
	</button>

	<div
		class="flex h-10 min-h-10 max-h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-[var(--scrapscache-border)] bg-[var(--scrapscache-surface)] px-3"
	>
		<Search class="h-4 w-4 shrink-0 text-[var(--scrapscache-text-muted)]" aria-hidden="true" />
		<input
			value={uiStore.searchInput}
			oninput={(event) => uiStore.setSearchInput(event.currentTarget.value)}
			type="text"
			placeholder="Search"
			class="h-full min-w-0 flex-1 appearance-none bg-transparent text-sm text-[var(--scrapscache-text)] focus:outline-none placeholder:text-[var(--scrapscache-text-muted)]"
		/>
		{#if uiStore.searchInput}
			<button
				type="button"
				class="icon-btn h-6 w-6 min-h-0 shrink-0 appearance-none p-0 text-[var(--scrapscache-text-muted)]"
				onclick={() => uiStore.clearSearch()}
				aria-label="Clear search"
			>
				<X class="h-4 w-4" aria-hidden="true" />
			</button>
		{/if}
	</div>

	<button
		type="button"
		class="icon-btn h-10 w-10 p-2"
		title={syncControlLabel}
		onclick={() => {
			syncOpen = true;
		}}
		aria-label={syncControlLabel}
		data-scrapscache-sync-control
	>
		<Cloud
			class={[
				'h-5 w-5',
				syncStatus === 'danger'
					? 'text-[var(--scrapscache-danger)]'
					: syncStatus === 'warning'
						? 'text-[var(--scrapscache-warning)]'
						: ''
			]}
			data-scrapscache-sync-icon
			aria-hidden="true"
		/>
	</button>

	<button
		class="icon-btn h-10 w-10 p-2"
		title="Toggle layout"
		onclick={() => uiStore.toggleLayout()}
		aria-label="Toggle layout"
	>
		{#if uiStore.layout === 'grid'}
			<List class="h-5 w-5" aria-hidden="true" />
		{:else}
			<LayoutGrid class="h-5 w-5" aria-hidden="true" />
		{/if}
	</button>

	<div class="relative" bind:this={settingsContainer}>
		<button
			class="icon-btn h-10 w-10 p-2"
			title="Settings"
			onclick={() => (settingsOpen = !settingsOpen)}
			aria-label="Settings"
		>
			<Settings class="h-5 w-5" aria-hidden="true" />
		</button>
		{#if settingsOpen}
			<div
				class="absolute right-0 top-12 z-30 w-64 overflow-hidden rounded-lg border border-[var(--scrapscache-border)] bg-[var(--scrapscache-surface)] pt-1 shadow-lg"
			>
				{#if importingBackup}
					{@const progress = notesStore.backupImportProgress}
					<div
						class="space-y-2 px-3 py-2 text-xs text-[var(--scrapscache-text-muted)]"
						role="status"
						aria-live="polite"
					>
						<div class="flex justify-between gap-2">
							<span
								>{progress?.phase === 'finishing'
									? 'Finishing backup…'
									: progress
										? 'Importing backup…'
										: 'Reading backup…'}</span
							>{#if progress}<span>{progress.completed}/{progress.total}</span>{/if}
						</div>
						<div class="h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
							<div
								class="h-full bg-blue-600 transition-[width]"
								style={`width: ${progress && progress.total ? Math.round((progress.completed / progress.total) * 100) : 8}%`}
							></div>
						</div>
					</div>
				{:else}
					<button
						type="button"
						onclick={() => {
							uiStore.toggleDark();
						}}
						class="flex h-8 w-full items-center gap-2 px-3 text-left text-sm text-[var(--scrapscache-text)] hover:bg-black/5 dark:hover:bg-white/10"
					>
						{#if uiStore.effectiveDark}
							<Sun class="h-4 w-4 shrink-0" aria-hidden="true" />
							Light mode
						{:else}
							<Moon class="h-4 w-4 shrink-0" aria-hidden="true" />
							Dark mode
						{/if}
					</button>
					<button
						type="button"
						onclick={startBackupExport}
						class="flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left text-sm text-[var(--scrapscache-text)] hover:bg-black/5 dark:hover:bg-white/10"
					>
						<Download class="h-4 w-4 shrink-0" aria-hidden="true" />
						Export backup
					</button>
					<button
						type="button"
						onclick={() => fileInputEl?.click()}
						class="flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left text-sm text-[var(--scrapscache-text)] hover:bg-black/5 dark:hover:bg-white/10"
					>
						<Upload class="h-4 w-4 shrink-0" aria-hidden="true" />
						Import backup
					</button>
					<ReminderNotificationSettings />
					<div class="border-t border-[var(--scrapscache-border)]"></div>
					<a
						href="https://github.com/volturine/scrapscache/issues/new/choose"
						target="_blank"
						rel="noreferrer"
						class="flex h-8 w-full items-center gap-2 px-3 text-left text-sm text-[var(--scrapscache-text)] hover:bg-black/5 dark:hover:bg-white/10"
					>
						<ExternalLink class="h-4 w-4 shrink-0" aria-hidden="true" />
						Report an issue
					</a>
				{/if}
				{#if backupImportError}<p class="px-3 pb-2 text-xs text-red-600" role="alert">
						{backupImportError}
					</p>{/if}
			</div>
		{/if}
		<!-- Keep the real input inside settingsContainer: its programmatic click must not
		     be mistaken for an outside click that hides the import progress UI. -->
		<input
			bind:this={fileInputEl}
			type="file"
			accept=".scraps-cache-backup,application/json"
			onchange={importBackup}
			class="hidden"
		/>
	</div>
</header>

<svelte:window onkeydown={handleKeydown} onclick={handleWindowClick} />

{#if syncOpen}
	<SyncModal
		onClose={() => {
			syncOpen = false;
		}}
	/>
{/if}

{#if choosingImportMode}
	<BackupImportModeDialog
		busy={importingBackup}
		error={backupImportError}
		onSelect={selectImportMode}
		onClose={() => {
			if (importingBackup) return;
			choosingImportMode = false;
			pendingImportData = null;
			backupImportError = '';
		}}
	/>
{/if}

{#if backupDialogMode}
	<BackupPassphraseDialog
		mode={backupDialogMode}
		busy={backupBusy}
		error={backupImportError}
		onSubmit={submitBackupPassphrase}
		onClose={() => {
			if (backupBusy) return;
			backupDialogMode = null;
			pendingEncryptedBackup = null;
			backupImportError = '';
		}}
	/>
{/if}
