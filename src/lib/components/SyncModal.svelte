<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { formatPairingCode, normalizePairingCode } from '$lib/syncPairing';
	import { syncStore, type StartedDeviceLink } from '$lib/stores/sync.svelte';
	import { profileCoordinator } from '$lib/stores/profiles.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { buildProfileNotesExport } from '$lib/profiles';
	import { estimateProfileBytes, pruneOrphanImageBlobs } from '$lib/db/idb';
	import { unregisterReminderDevice } from '$lib/reminderWake';
	import { downloadJSON } from '$lib/utils';
	import { Cloud, Download, Pencil, Trash2, X } from '@lucide/svelte';
	import { portalToAppFloat } from '$lib/appViewport';

	let { onClose }: { onClose: () => void } = $props();
	let mode = $state<'menu' | 'register' | 'link' | 'waiting' | 'choice' | 'linked'>(
		syncStore.isLoggedIn ? 'linked' : 'menu'
	);
	let code = $state('');
	let error = $state('');
	let info = $state('');
	let loading = $state(false);
	let syncing = $state(false);
	let copyFlash = $state(false);
	let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;
	let waiting = $state<StartedDeviceLink | null>(null);
	let now = $state(Date.now());
	let timer: ReturnType<typeof setInterval> | null = null;
	let deleteConfirm = $state(false);
	let newName = $state('');
	let editingId = $state<string | null>(null);
	let editName = $state('');
	let removingId = $state<string | null>(null);
	let forceResyncConfirm = $state(false);

	// A running sync must finish before a dataset handover can start.
	const handoverBlocked = $derived(notesStore.syncing || profileCoordinator.switching);

	// Approximate on-device footprint per saved key. Recomputed after each
	// completed sync so the number never goes stale mid-session.
	let sizes = $state<Record<string, number>>({});
	$effect(() => {
		void syncStore.lastSync;
		const ids = syncStore.profiles.map((profile) => profile.id);
		void Promise.all(
			ids.map(async (id) => {
				await pruneOrphanImageBlobs(id).catch(() => undefined);
				return [id, await estimateProfileBytes(id).catch(() => 0)] as const;
			})
		).then((entries) => {
			sizes = Object.fromEntries(entries);
		});
	});

	async function exportProfile(id: string) {
		error = '';
		try {
			const name = syncStore.profiles.find((profile) => profile.id === id)?.name ?? 'profile';
			const backup = await buildProfileNotesExport(id);
			if (!backup) {
				info = 'That sync key has no notes stored on this device yet.';
				return;
			}
			downloadJSON(
				backup,
				`scraps-cache-${name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}-${new Date()
					.toISOString()
					.slice(0, 10)}.scraps-cache-backup`
			);
		} catch {
			error = 'Could not export that sync key\u2019s notes.';
		}
	}

	function sizeLabel(id: string): string {
		const bytes = sizes[id];
		if (!bytes) return '';
		return bytes < 1024 * 1024
			? `${Math.max(1, Math.round(bytes / 1024))} KB`
			: `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function stopWaiting() {
		if (timer) clearInterval(timer);
		timer = null;
	}
	onDestroy(() => {
		stopWaiting();
		if (copyFlashTimer !== null) clearTimeout(copyFlashTimer);
	});

	function friendlyError(raw: string | null | undefined, fallback: string): string {
		const text = (raw || '').trim();
		if (!text) return fallback;
		const lower = text.toLowerCase();
		if (lower.includes('expired') || lower.includes('60 second'))
			return 'Connection timed out. Try again on both devices.';
		if (lower.includes('network') || lower.includes('fetch'))
			return 'Network issue. Check the connection and try again.';
		if (lower.includes('invalid sync') || lower.includes('credentials'))
			return 'Could not verify this sync key.';
		if (lower.includes('could not start')) return 'Could not start the connection. Try again.';
		if (lower.includes('encrypted sync failed')) return 'Sync hit a snag. Try again in a moment.';
		if (text.length > 90) return fallback;
		return text;
	}

	async function create() {
		loading = true;
		error = '';
		info = '';
		const name = newName;
		newName = '';
		const result = await profileCoordinator.create(name);
		loading = false;
		if (!result.success) {
			error = friendlyError(result.error, 'Could not create sync');
			return;
		}
		mode = 'linked';
		syncing = true;
		const ok = await notesStore.syncWithCloudManual();
		syncing = false;
		if (!ok)
			error = friendlyError(syncStore.lastError, 'Created, but the first sync did not finish');
	}

	async function beginLink() {
		const normalized = normalizePairingCode(code);
		if (!normalized) {
			error = 'Enter the full one-time code';
			return;
		}
		loading = true;
		error = '';
		info = '';
		const result = await syncStore.startDeviceLink(normalized);
		loading = false;
		if (!result.success || !result.link) {
			error = friendlyError(result.error, 'Could not start connection');
			return;
		}
		waiting = result.link;
		now = Date.now();
		mode = 'waiting';
		stopWaiting();
		timer = setInterval(() => {
			void pollLink();
		}, 1500);
		void pollLink();
	}

	async function pollLink() {
		if (!waiting) return;
		now = Date.now();
		const active = waiting;
		const result = await syncStore.pollDeviceLink(active);
		if (waiting !== active) return;
		if (result.linked) {
			const wasExisting = active.role === 'existing';
			stopWaiting();
			waiting = null;
			if (wasExisting) {
				mode = 'linked';
				info = 'Key sent. This device can go offline.';
				error = '';
				return;
			}
			loading = true;
			const adopted = await profileCoordinator.receiveLinkedKey(result.receivedSyncKey ?? '');
			loading = false;
			if (adopted.error || !result.receivedSyncKey) {
				mode = 'link';
				error = friendlyError(
					adopted.error ?? 'Invalid encrypted sync key',
					'Could not set up the received sync key'
				);
				return;
			}
			if (adopted.outcome === 'choice') {
				mode = 'choice';
				error = '';
				info = '';
			} else {
				mode = 'linked';
				info = 'Paired. Downloading synced notes…';
				error = '';
			}
			return;
		}
		if (result.expired || !result.success) {
			stopWaiting();
			waiting = null;
			mode = active.role === 'existing' ? 'linked' : 'link';
			error = friendlyError(result.error, 'Connection timed out. Try again on both devices.');
		}
	}

	async function startExistingConnection() {
		loading = true;
		error = '';
		info = '';
		const result = await syncStore.startExistingDeviceLink();
		loading = false;
		if (!result.success || !result.link) {
			error = friendlyError(result.error, 'Could not start connection');
			return;
		}
		waiting = result.link;
		now = Date.now();
		mode = 'waiting';
		stopWaiting();
		timer = setInterval(() => {
			void pollLink();
		}, 1500);
		void pollLink();
	}

	async function choose(merge: boolean) {
		if (loading || syncing) return;
		loading = true;
		syncing = true;
		error = '';
		info = merge ? 'Merging notes…' : 'Downloading synced notes…';
		try {
			const success = merge
				? await notesStore.mergeWithCloudManual()
				: await notesStore.replaceWithCloudManual();
			if (success) {
				mode = 'linked';
				info = merge ? 'Notes merged.' : 'Notes replaced from sync.';
				error = '';
				return;
			}
			await syncStore.logout();
			error = friendlyError(
				syncStore.lastError || notesStore.lastPersistError,
				'Could not finish setup'
			);
			info = '';
			// Stay on choice so the user can retry without re-linking.
			if (!merge && !syncStore.isLoggedIn) mode = 'link';
		} finally {
			loading = false;
			syncing = false;
		}
	}

	function startRename(id: string, current: string) {
		editingId = id;
		editName = current;
		removingId = null;
	}

	function cancelEdit() {
		editingId = null;
		editName = '';
	}

	async function saveRename() {
		const id = editingId;
		if (!id || !editName.trim()) return;
		await syncStore.renameProfile(id, editName);
		cancelEdit();
	}

	async function switchProfile(id: string) {
		if (profileCoordinator.switching) return;
		error = '';
		info = '';
		loading = true;
		const result = await profileCoordinator.switchTo(id);
		loading = false;
		if (!result.success) {
			error = friendlyError(result.error, 'Could not switch sync key');
			return;
		}
		mode = 'linked';
		const name = syncStore.activeProfile?.name ?? 'sync key';
		info = `Switched to ${name}. Syncing…`;
	}

	async function removeProfile(id: string) {
		if (profileCoordinator.switching) return;
		error = '';
		const removed = await syncStore.removeProfile(id);
		if (!removed) error = 'Could not remove that sync key.';
	}

	function formatBytes(bytes: number): string {
		return bytes < 1024 * 1024
			? `${Math.round(bytes / 1024)} KB`
			: `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function progressPercent(loaded: number, total: number | null): number {
		return total && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
	}

	async function syncNow() {
		if (syncing) return;
		syncing = true;
		error = '';
		info = '';
		const success = await notesStore.syncWithCloudManual();
		syncing = false;
		if (!success) error = friendlyError(syncStore.lastError, 'Sync failed');
	}

	function unlinkDevice() {
		const account = syncStore.account;
		void syncStore.logout();
		mode = 'menu';
		error = '';
		info = '';
		// Sign-out is local and immediate; a failed server-side unsubscribe must
		// stay visible so the user knows this browser lingers in wake delivery.
		unregisterReminderDevice(account).catch(() => {
			error =
				'Signed out, but the relay could not remove this device from reminder push. It will age out of delivery on its own.';
		});
	}

	async function copyCode() {
		const text = formatPairingCode(waiting?.syncCode ?? '');
		if (!text) return;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
			} else {
				throw new Error('clipboard API unavailable');
			}
		} catch {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.setAttribute('readonly', '');
			ta.style.position = 'fixed';
			ta.style.left = '-9999px';
			document.body.appendChild(ta);
			ta.select();
			try {
				document.execCommand('copy');
			} catch {
				/* best effort */
			}
			document.body.removeChild(ta);
		}
		copyFlash = true;
		if (copyFlashTimer !== null) clearTimeout(copyFlashTimer);
		copyFlashTimer = setTimeout(() => {
			copyFlash = false;
			copyFlashTimer = null;
		}, 1500);
	}

	async function forceFullResync() {
		if (loading) return;
		loading = true;
		error = '';
		forceResyncConfirm = false;
		try {
			if (!(await syncStore.resetSyncControlPlane())) throw new Error('not linked');
			info = 'Rebuilding the relay copy…';
			const ok = await notesStore.syncWithCloudManual();
			info = ok ? 'Relay copy rebuilt.' : '';
			if (!ok) error = friendlyError(syncStore.lastError, 'Full resync did not finish');
		} catch {
			error = 'Could not start a full resync.';
		} finally {
			loading = false;
		}
	}

	async function deleteCloudData() {
		if (!deleteConfirm || loading) return;
		loading = true;
		error = '';
		const result = await syncStore.deleteCloudAccount();
		loading = false;
		if (!result.success) {
			error = friendlyError(result.error, 'Could not delete synced data');
			return;
		}
		deleteConfirm = false;
		mode = 'menu';
		info = 'Cloud data deleted. Notes on this device were kept.';
	}

	function secondsLeft() {
		return waiting ? Math.max(0, Math.ceil((waiting.expiresAt - now) / 1000)) : 0;
	}
	function pairingGroups(value: string): string[] {
		const formatted = formatPairingCode(value);
		const parts = formatted.split('-').filter(Boolean);
		return parts.length ? parts : [formatted];
	}
	function expiryRatio(): number {
		return Math.max(0, Math.min(1, secondsLeft() / 60));
	}
	function formatInput(event: Event) {
		code = formatPairingCode((event.currentTarget as HTMLInputElement).value);
	}
	function close() {
		stopWaiting();
		onClose();
	}
</script>

<div
	{@attach portalToAppFloat}
	class="fixed inset-0 z-50 flex items-center justify-center p-4"
	transition:fade={{ duration: 150 }}
>
	<button
		type="button"
		class="absolute inset-0 bg-black/40"
		onclick={close}
		aria-label="Close sync dialog"
	></button>
	<div
		class="scraps-cache-dialog relative w-full max-w-md p-6"
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-labelledby="sync-title"
		transition:fly={{ y: 20, duration: 200 }}
	>
		<div class="mb-4 flex items-center justify-between">
			<h2
				id="sync-title"
				class="flex items-center gap-2 text-lg font-medium text-[var(--scraps-cache-text)]"
			>
				<Cloud class="h-5 w-5" aria-hidden="true" />
				{#if syncStore.isLoggedIn && syncStore.activeProfile}
					<span class="max-w-[16rem] truncate">{syncStore.activeProfile.name}</span>
				{:else}
					Sync
				{/if}
			</h2>
			<button type="button" onclick={close} class="icon-btn h-8 w-8" aria-label="Close">
				<X class="h-4 w-4" aria-hidden="true" />
			</button>
		</div>

		{#if mode === 'linked' && syncStore.account}
			<div class="space-y-4">
				<p class="text-sm text-[var(--scraps-cache-text-muted)]">
					This device is linked. Connect another device with a one-time code that expires in 60
					seconds.
				</p>
				{#if syncStore.progress}
					{@const progress = syncStore.progress}
					{@const percent = progressPercent(progress.loadedBytes, progress.totalBytes)}
					<div
						class="rounded-[var(--scraps-cache-radius-md)] bg-[var(--scraps-cache-interactive-hover)] p-3 text-sm"
					>
						<div class="mb-1 flex justify-between text-[var(--scraps-cache-text-muted)]">
							<span
								>{progress.phase === 'upload'
									? 'Encrypting & uploading'
									: 'Downloading encrypted sync'}</span
							><span
								>{formatBytes(progress.loadedBytes)}{progress.totalBytes
									? ` / ${formatBytes(progress.totalBytes)} (${percent}%)`
									: ''}</span
							>
						</div>
						<div class="scraps-cache-progress-track h-2 overflow-hidden rounded-full">
							<div
								class="scraps-cache-progress-value h-full rounded-full transition-[width] duration-150"
								style={`width: ${progress.totalBytes ? percent : 100}%`}
							></div>
						</div>
					</div>
				{:else if syncing}<p class="text-sm text-[var(--scraps-cache-text-muted)]">Syncing…</p>{/if}
				{#if info}<p class="text-sm text-[var(--scraps-cache-text-muted)]">{info}</p>{/if}
				{#if error}<p class="text-sm text-[var(--scraps-cache-danger)]">{error}</p>{/if}
				<button
					type="button"
					onclick={() => void syncNow()}
					disabled={loading || syncing}
					class="scraps-cache-button scraps-cache-button-primary w-full px-3 py-2.5 text-sm font-medium"
					>{syncing ? 'Syncing…' : '🔄 Sync now'}</button
				>
				<button
					type="button"
					onclick={() => void startExistingConnection()}
					disabled={loading || syncing}
					class="scraps-cache-button scraps-cache-button-secondary w-full px-3 py-2.5 text-sm"
					>Connect another device</button
				>
				<button
					type="button"
					onclick={() => {
						error = '';
						info = '';
						mode = 'menu';
					}}
					class="w-full rounded-lg border border-[var(--scraps-cache-border)] px-3 py-2.5 text-sm touch-manipulation"
					>Switch sync key</button
				>
				{#if syncStore.usage}
					<div class="text-center text-xs text-[var(--scraps-cache-text-muted)]">
						{formatBytes(syncStore.usage.ciphertextBytes)} encrypted on the relay
					</div>
				{/if}
				<button
					type="button"
					onclick={unlinkDevice}
					class="scraps-cache-button scraps-cache-button-destructive w-full text-sm"
					>Unlink this device</button
				>
				{#if deleteConfirm}
					<div class="scraps-cache-status-danger rounded-[var(--scraps-cache-radius-md)] p-3">
						<p class="text-xs leading-relaxed">
							Delete all encrypted cloud records? Notes stored on this device will remain.
						</p>
						<div class="mt-2 flex gap-2">
							<button
								type="button"
								onclick={() => {
									deleteConfirm = false;
								}}
								disabled={loading}
								class="flex-1 rounded border border-[var(--scraps-cache-border)] px-2 py-1.5 text-xs"
								>Cancel</button
							>
							<button
								type="button"
								onclick={() => void deleteCloudData()}
								disabled={loading}
								class="scraps-cache-button scraps-cache-button-destructive-solid flex-1 px-2 py-1.5 text-xs font-medium"
								>{loading ? 'Deleting…' : 'Delete cloud data'}</button
							>
						</div>
					</div>
				{:else}
					<button
						type="button"
						onclick={() => {
							deleteConfirm = true;
						}}
						class="scraps-cache-button scraps-cache-button-destructive w-full text-xs"
						>Delete cloud data</button
					>
				{/if}
				{#if forceResyncConfirm}
					<div
						class="rounded-[var(--scraps-cache-radius-md)] border border-[var(--scraps-cache-border)] p-3"
					>
						<p class="text-xs leading-relaxed text-[var(--scraps-cache-text-muted)]">
							Re-upload every record and re-download from scratch? Use this if the relay copy looks
							incomplete. Notes on this device are not touched.
						</p>
						<div class="mt-2 flex gap-2">
							<button
								type="button"
								onclick={() => {
									forceResyncConfirm = false;
								}}
								disabled={loading}
								class="flex-1 rounded border border-[var(--scraps-cache-border)] px-2 py-1.5 text-xs"
								>Cancel</button
							>
							<button
								type="button"
								onclick={() => void forceFullResync()}
								disabled={loading}
								class="flex-1 rounded border border-[var(--scraps-cache-border)] px-2 py-1.5 text-xs font-medium"
								>{loading ? 'Working…' : 'Full resync'}</button
							>
						</div>
					</div>
				{:else}
					<button
						type="button"
						onclick={() => {
							forceResyncConfirm = true;
						}}
						class="w-full text-xs text-[var(--scraps-cache-text-muted)] touch-manipulation"
						>Force full resync</button
					>
				{/if}
			</div>
		{:else if mode === 'menu'}
			<div class="space-y-3">
				{#if syncStore.profiles.length}
					<p class="text-xs font-medium tracking-wide text-[var(--scraps-cache-text-muted)]">
						Saved sync keys on this device
					</p>
					<div class="space-y-1.5">
						{#each syncStore.profiles as profile (profile.id)}
							{#if editingId === profile.id}
								<div
									class="flex items-center gap-2 rounded-lg border border-[var(--scraps-cache-border)] px-2 py-1.5"
								>
									<input
										class="scraps-cache-input min-w-0 flex-1 px-2 py-1 text-sm"
										bind:value={editName}
										maxlength="60"
										aria-label="Sync key name"
										onkeydown={(event) => {
											if (event.key === 'Enter') void saveRename();
											if (event.key === 'Escape') cancelEdit();
										}}
									/>
									<button
										type="button"
										onclick={() => void saveRename()}
										class="shrink-0 text-xs font-medium text-[var(--scraps-cache-primary)]"
										>Save</button
									>
									<button
										type="button"
										onclick={cancelEdit}
										class="shrink-0 text-xs text-[var(--scraps-cache-text-muted)]">Cancel</button
									>
								</div>
							{:else if removingId === profile.id}
								<div
									class="scraps-cache-status-danger rounded-lg border border-[var(--scraps-cache-danger)] px-3 py-2"
								>
									<p class="text-xs leading-relaxed">
										Remove “{profile.name}” and its stashed notes from this device? Its synced cloud
										data stays.
									</p>
									<div class="mt-2 flex gap-2">
										<button
											type="button"
											onclick={() => {
												removingId = null;
											}}
											class="flex-1 rounded border border-[var(--scraps-cache-border)] px-2 py-1 text-xs"
											>Keep</button
										>
										<button
											type="button"
											onclick={() => {
												removingId = null;
												void removeProfile(profile.id);
											}}
											class="scraps-cache-button scraps-cache-button-destructive-solid flex-1 px-2 py-1 text-xs font-medium"
											>Remove</button
										>
									</div>
								</div>
							{:else}
								<div
									class="flex items-center gap-2 rounded-lg border border-[var(--scraps-cache-border)] px-3 py-2"
								>
									{#if profile.id === syncStore.activeProfile?.id}
										<button
											type="button"
											class="min-w-0 flex-1 text-left"
											onclick={() => {
												mode = 'linked';
												error = '';
												info = '';
											}}
										>
											<span class="block truncate text-sm">{profile.name}</span>
											{#if sizeLabel(profile.id)}
												<span class="block text-xs text-[var(--scraps-cache-text-muted)]"
													>>{sizeLabel(profile.id)} stored locally</span
												>
												>
											{/if}
											<span class="block text-xs font-medium text-[var(--scraps-cache-success)]"
												>Active — tap to manage</span
											>
										</button>
									{:else}
										<span class="min-w-0 flex-1">
											<span class="block truncate text-sm">{profile.name}</span>
											{#if sizeLabel(profile.id)}
												<span class="block text-xs text-[var(--scraps-cache-text-muted)]"
													>>{sizeLabel(profile.id)} stored locally</span
												>
												>
											{/if}
										</span>
										<button
											type="button"
											onclick={() => void switchProfile(profile.id)}
											disabled={handoverBlocked}
											title={notesStore.syncing ? 'Wait for the current sync to finish' : undefined}
											class="shrink-0 rounded-md border border-[var(--scraps-cache-border)] px-2 py-1 text-xs font-medium touch-manipulation"
										>
											{profileCoordinator.switching ? '…' : 'Switch'}
										</button>
									{/if}
									<button
										type="button"
										onclick={() => void exportProfile(profile.id)}
										class="icon-btn h-7 w-7 shrink-0"
										aria-label="Export notes of {profile.name}"
									>
										<Download class="h-3.5 w-3.5" aria-hidden="true" />
									</button>
									<button
										type="button"
										onclick={() => startRename(profile.id, profile.name)}
										class="icon-btn h-7 w-7 shrink-0"
										aria-label="Rename {profile.name}"
									>
										<Pencil class="h-3.5 w-3.5" aria-hidden="true" />
									</button>
									{#if profile.id !== syncStore.activeProfile?.id}
										<button
											type="button"
											onclick={() => {
												removingId = profile.id;
												cancelEdit();
											}}
											class="icon-btn h-7 w-7 shrink-0"
											aria-label="Remove {profile.name}"
										>
											<Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
										</button>
									{/if}
								</div>
							{/if}
						{/each}
					</div>
				{/if}
				<p class="text-sm text-[var(--scraps-cache-text-muted)]">
					Create one private sync key, then connect your own devices by starting the connection on
					both within 60 seconds. Each key keeps its own notes on this device.
					{#if handoverBlocked}<span class="block">
							Switching sync keys is paused until the current sync finishes.</span
						>{/if}
				</p>
				<button
					type="button"
					disabled={handoverBlocked}
					onclick={() => {
						mode = 'register';
						error = '';
						info = '';
					}}
					class="scraps-cache-button scraps-cache-button-primary w-full px-3 py-3 text-sm font-medium"
					>Create sync key</button
				><button
					type="button"
					onclick={() => {
						mode = 'link';
						error = '';
						info = '';
					}}
					class="w-full rounded-lg border border-[var(--scraps-cache-border)] px-3 py-3 text-sm touch-manipulation"
					>Connect to an existing sync</button
				>
				{#if error}<p class="text-sm text-[var(--scraps-cache-danger)]">{error}</p>{/if}
			</div>
		{:else if mode === 'register'}
			<div class="space-y-3">
				<p class="text-sm text-[var(--scraps-cache-text-muted)]">
					Creates a private account on this device. Other devices join with a one-time code, not a
					lifetime password.
				</p>
				<input
					bind:value={newName}
					placeholder="Name this sync key (optional)"
					maxlength="60"
					class="scraps-cache-input w-full px-3 py-2 text-sm"
					aria-label="Sync key name"
					onkeydown={(event) => event.key === 'Enter' && void create()}
				/>
				{#if error}<p class="text-sm text-[var(--scraps-cache-danger)]">{error}</p>{/if}<button
					type="button"
					onclick={() => void create()}
					disabled={loading}
					class="scraps-cache-button scraps-cache-button-primary w-full px-3 py-2 text-sm font-medium"
					>{loading ? 'Creating…' : 'Create my sync key'}</button
				><button
					type="button"
					onclick={() => (mode = 'menu')}
					class="w-full text-xs text-[var(--scraps-cache-text-muted)] touch-manipulation"
					>← Back</button
				>
			</div>
		{:else if mode === 'link'}
			<div class="space-y-3">
				<p class="text-sm text-[var(--scraps-cache-text-muted)]">
					On your other device open Sync and choose Connect another device. Enter the one-time code
					shown there.
				</p>
				<input
					value={code}
					oninput={formatInput}
					autocomplete="one-time-code"
					placeholder="XXXX-XXXX-XXXX-XXXX"
					maxlength="19"
					spellcheck="false"
					class="scraps-cache-input w-full px-3 py-2 text-center text-lg font-bold tracking-wider"
					onkeydown={(event) => event.key === 'Enter' && void beginLink()}
				/>{#if error}<p class="text-sm text-[var(--scraps-cache-danger)]">{error}</p>{/if}<button
					type="button"
					onclick={() => void beginLink()}
					disabled={loading}
					class="scraps-cache-button scraps-cache-button-primary w-full px-3 py-2 text-sm font-medium"
					>{loading ? 'Starting…' : 'Start connection'}</button
				><button
					type="button"
					onclick={() => (mode = 'menu')}
					class="w-full text-xs text-[var(--scraps-cache-text-muted)] touch-manipulation"
					>← Back</button
				>
			</div>
		{:else if mode === 'waiting'}
			<div class="space-y-5">
				{#if waiting?.role === 'existing'}
					<div>
						<p class="text-xs font-medium tracking-wide text-[var(--scraps-cache-text-muted)]">
							On the new device
						</p>
						<p class="mt-1 text-sm text-[var(--scraps-cache-text)]">Open Sync and type this code</p>
					</div>
					<div
						class="rounded-xl border border-[var(--scraps-cache-border)] bg-[var(--scraps-cache-bg)] px-2 py-5"
						aria-label="One-time pairing code"
					>
						<div class="flex items-center justify-center gap-1">
							{#each pairingGroups(waiting.syncCode) as group, index (index)}
								{#if index > 0}
									<span class="px-0.5 text-[var(--scraps-cache-text-muted)]" aria-hidden="true"
										>·</span
									>
								{/if}
								<span
									class="font-mono text-[1.35rem] font-semibold tracking-[0.14em] text-[var(--scraps-cache-text)]"
									>{group}</span
								>
							{/each}
						</div>
					</div>
					<button
						type="button"
						onclick={() => void copyCode()}
						class="scraps-cache-button w-full px-3 py-2.5 text-sm font-medium {copyFlash
							? 'border-[var(--scraps-cache-success)] bg-[var(--scraps-cache-success)] text-[var(--scraps-cache-success-foreground)]'
							: 'scraps-cache-button-secondary'}">{copyFlash ? 'Copied' : 'Copy code'}</button
					>
				{:else}
					<div>
						<p class="text-xs font-medium tracking-wide text-[var(--scraps-cache-text-muted)]">
							On the other device
						</p>
						<p class="mt-1 text-sm text-[var(--scraps-cache-text)]">
							Open Sync and choose Connect another device
						</p>
					</div>
				{/if}
				<div class="space-y-1.5">
					<div
						class="flex items-center justify-between text-xs text-[var(--scraps-cache-text-muted)]"
					>
						<span>Expires in</span>
						<span class="tabular-nums text-[var(--scraps-cache-text)]">{secondsLeft()}s</span>
					</div>
					<div class="scraps-cache-progress-track h-1 overflow-hidden rounded-full">
						<div
							class="scraps-cache-progress-value h-full rounded-full transition-[width] duration-1000 ease-linear"
							style={`width: ${expiryRatio() * 100}%`}
						></div>
					</div>
				</div>
				<button
					type="button"
					onclick={() => {
						stopWaiting();
						waiting = null;
						mode = syncStore.isLoggedIn ? 'linked' : 'link';
					}}
					class="w-full text-sm text-[var(--scraps-cache-text-muted)] touch-manipulation"
					>Cancel</button
				>
			</div>
		{:else if mode === 'choice'}
			<div class="space-y-3">
				<h3 class="font-medium">Use this device’s existing notes?</h3>
				{#if syncStore.progress}
					{@const progress = syncStore.progress}
					{@const percent = progressPercent(progress.loadedBytes, progress.totalBytes)}
					<div
						class="rounded-[var(--scraps-cache-radius-md)] bg-[var(--scraps-cache-interactive-hover)] p-3 text-sm"
					>
						<div class="mb-1 flex justify-between text-[var(--scraps-cache-text-muted)]">
							<span>{progress.phase === 'upload' ? 'Uploading' : 'Downloading'}</span><span
								>{formatBytes(progress.loadedBytes)}{progress.totalBytes
									? ` / ${formatBytes(progress.totalBytes)} (${percent}%)`
									: ''}</span
							>
						</div>
						<div class="scraps-cache-progress-track h-2 overflow-hidden rounded-full">
							<div
								class="scraps-cache-progress-value h-full rounded-full transition-[width] duration-150"
								style={`width: ${progress.totalBytes ? percent : 100}%`}
							></div>
						</div>
					</div>
				{:else if syncing || loading}
					<p class="text-sm text-[var(--scraps-cache-text-muted)]">{info || 'Working…'}</p>
				{/if}
				<button
					type="button"
					onclick={() => void choose(true)}
					disabled={loading || syncing}
					class="scraps-cache-button scraps-cache-button-primary w-full px-3 py-3 text-left text-sm font-medium"
					>Keep and merge local notes</button
				>
				<button
					type="button"
					onclick={() => void choose(false)}
					disabled={loading || syncing}
					class="scraps-cache-button scraps-cache-button-destructive w-full border border-[var(--scraps-cache-danger)] px-3 py-3 text-left text-sm font-medium"
					>Discard local notes and download synced notes</button
				>
				{#if error}<p class="text-sm text-[var(--scraps-cache-danger)]">{error}</p>{/if}
			</div>
		{/if}
	</div>
</div>
