<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { formatPairingCode, normalizePairingCode } from '$lib/syncPairing';
	import { syncStore, type StartedDeviceLink } from '$lib/stores/sync.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { unregisterReminderDevice } from '$lib/reminderWake';
	import { Cloud, X } from '@lucide/svelte';
	import { portalToAppFloat } from '$lib/appViewport';

	let { onClose }: { onClose: () => void } = $props();
	let mode = $state<'menu' | 'register' | 'link' | 'waiting' | 'linked'>(
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
		const result = await syncStore.register();
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
			} else {
				mode = 'linked';
				error = '';
				info = '';
				syncing = true;
				const ok = await notesStore.replaceWithCloudManual();
				syncing = false;
				if (!ok) {
					error = friendlyError(
						syncStore.lastError || notesStore.lastPersistError,
						'Could not finish setup'
					);
					info = '';
					syncStore.logout();
					mode = 'link';
				}
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
		syncStore.logout();
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
		class="scrapscache-dialog relative w-full max-w-md p-6"
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-labelledby="sync-title"
		transition:fly={{ y: 20, duration: 200 }}
	>
		<div class="mb-4 flex items-center justify-between">
			<h2
				id="sync-title"
				class="flex items-center gap-2 text-lg font-medium text-[var(--scrapscache-text)]"
			>
				<Cloud class="h-5 w-5" aria-hidden="true" />
				Sync
			</h2>
			<button type="button" onclick={close} class="icon-btn h-8 w-8" aria-label="Close">
				<X class="h-4 w-4" aria-hidden="true" />
			</button>
		</div>

		{#if mode === 'linked' && syncStore.account}
			<div class="space-y-4">
				<p class="text-sm text-[var(--scrapscache-text-muted)]">
					This device is linked. Connect another device with a one-time code that expires in 60
					seconds.
				</p>
				{#if syncStore.progress}
					{@const progress = syncStore.progress}
					{@const percent = progressPercent(progress.loadedBytes, progress.totalBytes)}
					<div
						class="rounded-[var(--scrapscache-radius-md)] bg-[var(--scrapscache-interactive-hover)] p-3 text-sm"
					>
						<div class="mb-1 flex justify-between text-[var(--scrapscache-text-muted)]">
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
						<div class="scrapscache-progress-track h-2 overflow-hidden rounded-full">
							<div
								class="scrapscache-progress-value h-full rounded-full transition-[width] duration-150"
								style={`width: ${progress.totalBytes ? percent : 100}%`}
							></div>
						</div>
					</div>
				{:else if syncing}<p class="text-sm text-[var(--scrapscache-text-muted)]">Syncing…</p>{/if}
				{#if info}<p class="text-sm text-[var(--scrapscache-text-muted)]">{info}</p>{/if}
				{#if error}<p class="text-sm text-[var(--scrapscache-danger)]">{error}</p>{/if}
				<button
					type="button"
					onclick={() => void syncNow()}
					disabled={loading || syncing}
					class="scrapscache-button scrapscache-button-primary w-full px-3 py-2.5 text-sm font-medium"
					>{syncing ? 'Syncing…' : '🔄 Sync now'}</button
				>
				<button
					type="button"
					onclick={() => void startExistingConnection()}
					disabled={loading || syncing}
					class="scrapscache-button scrapscache-button-secondary w-full px-3 py-2.5 text-sm"
					>Connect another device</button
				>
				{#if syncStore.usage}
					<div class="text-center text-xs text-[var(--scrapscache-text-muted)]">
						{formatBytes(syncStore.usage.ciphertextBytes)} stored for this account
					</div>
				{/if}
				<button
					type="button"
					onclick={unlinkDevice}
					class="scrapscache-button scrapscache-button-destructive w-full text-sm"
					>Unlink this device</button
				>
				{#if deleteConfirm}
					<div class="scrapscache-status-danger rounded-[var(--scrapscache-radius-md)] p-3">
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
								class="flex-1 rounded border border-[var(--scrapscache-border)] px-2 py-1.5 text-xs"
								>Cancel</button
							>
							<button
								type="button"
								onclick={() => void deleteCloudData()}
								disabled={loading}
								class="scrapscache-button scrapscache-button-destructive-solid flex-1 px-2 py-1.5 text-xs font-medium"
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
						class="scrapscache-button scrapscache-button-destructive w-full text-xs"
						>Delete cloud data</button
					>
				{/if}
			</div>
		{:else if mode === 'menu'}
			<div class="space-y-3">
				<p class="text-sm text-[var(--scrapscache-text-muted)]">
					Create one private sync key, then connect your own devices by starting the connection on
					both within 60 seconds.
				</p>
				<button
					type="button"
					onclick={() => {
						mode = 'register';
						error = '';
						info = '';
					}}
					class="scrapscache-button scrapscache-button-primary w-full px-3 py-3 text-sm font-medium"
					>Create sync key</button
				><button
					type="button"
					onclick={() => {
						mode = 'link';
						error = '';
						info = '';
					}}
					class="w-full rounded-lg border border-[var(--scrapscache-border)] px-3 py-3 text-sm touch-manipulation"
					>Connect to an existing sync</button
				>
				{#if error}<p class="text-sm text-[var(--scrapscache-danger)]">{error}</p>{/if}
			</div>
		{:else if mode === 'register'}
			<div class="space-y-3">
				<p class="text-sm text-[var(--scrapscache-text-muted)]">
					Creates a private account on this device. Other devices join with a one-time code, not a
					lifetime password.
				</p>
				{#if error}<p class="text-sm text-[var(--scrapscache-danger)]">{error}</p>{/if}<button
					type="button"
					onclick={() => void create()}
					disabled={loading}
					class="scrapscache-button scrapscache-button-primary w-full px-3 py-2 text-sm font-medium"
					>{loading ? 'Creating…' : 'Create my sync key'}</button
				><button
					type="button"
					onclick={() => (mode = 'menu')}
					class="w-full text-xs text-[var(--scrapscache-text-muted)] touch-manipulation"
					>← Back</button
				>
			</div>
		{:else if mode === 'link'}
			<div class="space-y-3">
				<p class="text-sm text-[var(--scrapscache-text-muted)]">
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
					class="scrapscache-input w-full px-3 py-2 text-center text-lg font-bold tracking-wider"
					onkeydown={(event) => event.key === 'Enter' && void beginLink()}
				/>{#if error}<p class="text-sm text-[var(--scrapscache-danger)]">{error}</p>{/if}<button
					type="button"
					onclick={() => void beginLink()}
					disabled={loading}
					class="scrapscache-button scrapscache-button-primary w-full px-3 py-2 text-sm font-medium"
					>{loading ? 'Starting…' : 'Start connection'}</button
				><button
					type="button"
					onclick={() => (mode = 'menu')}
					class="w-full text-xs text-[var(--scrapscache-text-muted)] touch-manipulation"
					>← Back</button
				>
			</div>
		{:else if mode === 'waiting'}
			<div class="space-y-5">
				{#if waiting?.role === 'existing'}
					<div>
						<p class="text-xs font-medium tracking-wide text-[var(--scrapscache-text-muted)]">
							On the new device
						</p>
						<p class="mt-1 text-sm text-[var(--scrapscache-text)]">Open Sync and type this code</p>
					</div>
					<div
						class="rounded-xl border border-[var(--scrapscache-border)] bg-[var(--scrapscache-bg)] px-2 py-5"
						aria-label="One-time pairing code"
					>
						<div class="flex items-center justify-center gap-1">
							{#each pairingGroups(waiting.syncCode) as group, index (index)}
								{#if index > 0}
									<span class="px-0.5 text-[var(--scrapscache-text-muted)]" aria-hidden="true"
										>·</span
									>
								{/if}
								<span
									class="font-mono text-[1.35rem] font-semibold tracking-[0.14em] text-[var(--scrapscache-text)]"
									>{group}</span
								>
							{/each}
						</div>
					</div>
					<button
						type="button"
						onclick={() => void copyCode()}
						class="scrapscache-button w-full px-3 py-2.5 text-sm font-medium {copyFlash
							? 'border-[var(--scrapscache-success)] bg-[var(--scrapscache-success)] text-[var(--scrapscache-success-foreground)]'
							: 'scrapscache-button-secondary'}">{copyFlash ? 'Copied' : 'Copy code'}</button
					>
				{:else}
					<div>
						<p class="text-xs font-medium tracking-wide text-[var(--scrapscache-text-muted)]">
							On the other device
						</p>
						<p class="mt-1 text-sm text-[var(--scrapscache-text)]">
							Open Sync and choose Connect another device
						</p>
					</div>
				{/if}
				<div class="space-y-1.5">
					<div
						class="flex items-center justify-between text-xs text-[var(--scrapscache-text-muted)]"
					>
						<span>Expires in</span>
						<span class="tabular-nums text-[var(--scrapscache-text)]">{secondsLeft()}s</span>
					</div>
					<div class="scrapscache-progress-track h-1 overflow-hidden rounded-full">
						<div
							class="scrapscache-progress-value h-full rounded-full transition-[width] duration-1000 ease-linear"
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
					class="w-full text-sm text-[var(--scrapscache-text-muted)] touch-manipulation"
					>Cancel</button
				>
			</div>
		{/if}
	</div>
</div>
