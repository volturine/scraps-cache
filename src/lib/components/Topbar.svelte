<script lang="ts">
	import { uiStore } from '$lib/stores/ui.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { downloadJSON } from '$lib/utils';
	import { syncStore } from '$lib/stores/sync.svelte';
	import SyncModal from './SyncModal.svelte';
	import BackupPassphraseDialog from './BackupPassphraseDialog.svelte';
	import { useEditorActions } from '$lib/editorContext';
	import {
		decryptBackup,
		encryptBackup,
		isEncryptedShardBackup,
		type EncryptedShardBackup
	} from '$lib/backupCrypto';
	import {
		Cloud,
		Download,
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
	let pendingEncryptedBackup = $state<EncryptedShardBackup | null>(null);

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
					`shard-backup-${new Date().toISOString().slice(0, 10)}.shard-backup`
				);
				backupDialogMode = null;
				return;
			}
			if (backupDialogMode === 'import' && pendingEncryptedBackup) {
				importingBackup = true;
				const decrypted = await decryptBackup(pendingEncryptedBackup, passphrase);
				const result = await notesStore.importBackup(decrypted);
				if (!result.success) throw new Error(result.error || 'Could not restore that backup.');
				pendingEncryptedBackup = null;
				backupDialogMode = null;
				settingsOpen = false;
			}
		} catch (error) {
			backupImportError = error instanceof Error ? error.message : 'Backup operation failed.';
		} finally {
			backupBusy = false;
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
				if (isEncryptedShardBackup(data)) {
					pendingEncryptedBackup = data;
					backupDialogMode = 'import';
					settingsOpen = false;
				} else if (window.confirm('This is an older unencrypted backup. Restore it anyway?')) {
					const result = await notesStore.importBackup(data);
					if (result.success) settingsOpen = false;
					else backupImportError = result.error || 'Could not import that backup.';
				}
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
		// 'c' or Ctrl+/ focuses composer
		if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const target = e.target as HTMLElement;
			if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
			e.preventDefault();
			startNewNote();
		}
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
		class="flex h-10 flex-1 items-center gap-2 rounded-full border border-[var(--shard-border)] bg-[var(--shard-surface)] px-3"
	>
		<Search class="h-4 w-4 shrink-0 text-[var(--shard-text-muted)]" aria-hidden="true" />
		<input
			bind:value={uiStore.search}
			type="text"
			placeholder="Search"
			class="flex-1 bg-transparent text-sm text-[var(--shard-text)] focus:outline-none placeholder:text-[var(--shard-text-muted)]"
		/>
		{#if uiStore.search}
			<button
				class="icon-btn h-8 w-8 p-1.5 text-sm text-[var(--shard-text-muted)]"
				onclick={() => (uiStore.search = '')}
				aria-label="Clear search"
			>
				<X class="h-4 w-4" aria-hidden="true" />
			</button>
		{/if}
	</div>

	<button
		type="button"
		class="icon-btn h-10 w-10 p-2"
		title="Sync settings"
		onclick={() => {
			syncOpen = true;
		}}
		aria-label="Sync settings"
		data-shard-sync-control
	>
		<Cloud class="h-5 w-5" data-shard-sync-icon aria-hidden="true" />
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
				class="absolute right-0 top-12 z-30 w-48 rounded-lg border border-[var(--shard-border)] bg-[var(--shard-surface)] py-1 shadow-lg"
			>
				{#if importingBackup}
					{@const progress = notesStore.backupImportProgress}
					<div
						class="space-y-2 px-3 py-2 text-xs text-[var(--shard-text-muted)]"
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
						class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--shard-text)] hover:bg-black/5 dark:hover:bg-white/10"
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
						class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--shard-text)] hover:bg-black/5 dark:hover:bg-white/10"
					>
						<Download class="h-4 w-4 shrink-0" aria-hidden="true" />
						Export backup
					</button>
					<button
						type="button"
						onclick={() => fileInputEl?.click()}
						class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--shard-text)] hover:bg-black/5 dark:hover:bg-white/10"
					>
						<Upload class="h-4 w-4 shrink-0" aria-hidden="true" />
						Import backup
					</button>
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
			accept=".shard-backup,application/json"
			onchange={importBackup}
			class="hidden"
		/>
	</div>

	<div
		class="hidden h-9 w-9 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 items-center justify-center text-sm font-bold text-white sm:flex"
		title="You"
	>
		K
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
