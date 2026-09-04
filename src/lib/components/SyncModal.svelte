<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { formatPairingCode, normalizePairingCode } from '$lib/syncPairing';
	import { syncStore, type StartedDeviceLink } from '$lib/stores/sync.svelte';
	import { notesStore } from '$lib/stores/notes.svelte';
	import { unregisterReminderDevice } from '$lib/reminderWake';
	import { Cloud, X, Sparkles, Copy, Check } from '@lucide/svelte';
	import { portalToAppFloat } from '$lib/appViewport';
	import { PairingRole } from '$lib/pairingProtocol';
	import { resolveSyncStatus, SyncStatus } from '$lib/syncStatus';
	import { createMcpToken, verifyMcpToken } from '$lib/mcp/token';

	const SyncModalMode = {
		Menu: 'menu',
		Register: 'register',
		Link: 'link',
		Waiting: 'waiting',
		Linked: 'linked'
	} as const;
	type SyncModalMode = (typeof SyncModalMode)[keyof typeof SyncModalMode];

	const SYNC_STATUS_CLASS: Record<SyncStatus, string> = {
		[SyncStatus.Normal]:
			'border border-[var(--scrapscache-border)] text-[var(--scrapscache-text-muted)]',
		[SyncStatus.Warning]: 'scrapscache-status-warning',
		[SyncStatus.Danger]: 'scrapscache-status-danger'
	};

	let { onClose }: { onClose: () => void } = $props();
	let mode = $state<SyncModalMode>(
		syncStore.isLoggedIn ? SyncModalMode.Linked : SyncModalMode.Menu
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
	let syncError = $derived(syncStore.lastError ?? '');
	let quotaStatus = $derived(resolveSyncStatus(syncError, syncStore.usage));

	const LS_MCP_TOKEN_PREFIX = 'scrapscache_mcp_token_';
	let mcpOpen = $state(false);
	let mcpToken = $state('');
	let mcpCopiedUrl = $state(false);
	let mcpCopiedToken = $state(false);
	let mcpCopiedFullUrl = $state(false);
	let mcpRevoking = $state(false);

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		const accountId = syncStore.account?.accountId;
		if (!accountId) {
			mcpToken = '';
			return;
		}
		if (!mcpToken) {
			const saved = localStorage.getItem(`${LS_MCP_TOKEN_PREFIX}${accountId}`);
			if (saved) {
				const verified = verifyMcpToken(saved);
				if (verified.valid && verified.accountId === accountId) {
					mcpToken = saved;
					mcpOpen = true;
				} else {
					localStorage.removeItem(`${LS_MCP_TOKEN_PREFIX}${accountId}`);
				}
			}
		}
	});

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
		mode = SyncModalMode.Linked;
		syncing = true;
		const ok = await notesStore.replaceWithCloudManual();
		syncing = false;
		if (!ok)
			error = friendlyError(
				syncStore.lastError || notesStore.lastPersistError,
				'Created, but the first sync did not finish'
			);
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
		mode = SyncModalMode.Waiting;
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
			const wasExisting = active.role === PairingRole.Existing;
			stopWaiting();
			waiting = null;
			if (wasExisting) {
				mode = SyncModalMode.Linked;
				info = 'Key sent. This device can go offline.';
				error = '';
			} else {
				mode = SyncModalMode.Linked;
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
					mode = SyncModalMode.Link;
				}
			}
			return;
		}
		if (result.expired || !result.success) {
			stopWaiting();
			waiting = null;
			mode = active.role === PairingRole.Existing ? SyncModalMode.Linked : SyncModalMode.Link;
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
		mode = SyncModalMode.Waiting;
		stopWaiting();
		timer = setInterval(() => {
			void pollLink();
		}, 1500);
		void pollLink();
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
		if (account?.accountId && typeof localStorage !== 'undefined') {
			localStorage.removeItem(`${LS_MCP_TOKEN_PREFIX}${account.accountId}`);
		}
		mcpToken = '';
		mcpOpen = false;
		syncStore.logout();
		mode = SyncModalMode.Menu;
		error = '';
		info = '';
		unregisterReminderDevice(account).catch(() => {
			error =
				'Signed out, but the relay could not remove this device from reminder push. It will age out of delivery on its own.';
		});
	}

	async function copyCode() {
		const text = formatPairingCode(waiting?.syncCode ?? '');
		if (!text) return;
		let copied = false;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				copied = true;
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
				copied = document.execCommand('copy');
			} catch {
				/* best effort */
			}
			document.body.removeChild(ta);
		}
		if (!copied) return;
		copyFlash = true;
		if (copyFlashTimer !== null) clearTimeout(copyFlashTimer);
		copyFlashTimer = setTimeout(() => {
			copyFlash = false;
			copyFlashTimer = null;
		}, 1500);
	}

	async function deleteCloudData() {
		if (!deleteConfirm || loading) return;
		const account = syncStore.account;
		loading = true;
		error = '';
		const result = await syncStore.deleteCloudAccount();
		loading = false;
		if (!result.success) {
			error = friendlyError(result.error, 'Could not delete synced data');
			return;
		}
		if (account?.accountId && typeof localStorage !== 'undefined') {
			localStorage.removeItem(`${LS_MCP_TOKEN_PREFIX}${account.accountId}`);
		}
		mcpToken = '';
		mcpOpen = false;
		deleteConfirm = false;
		mode = SyncModalMode.Menu;
		info = 'Cloud data deleted. Notes on this device were kept.';
	}

	function generateMcpToken() {
		if (!syncStore.account?.syncKey || !syncStore.account?.accountId) return;
		mcpToken = createMcpToken(syncStore.account.syncKey);
		mcpOpen = true;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(`${LS_MCP_TOKEN_PREFIX}${syncStore.account.accountId}`, mcpToken);
		}
	}

	async function copyMcpText(text: string, which: 'url' | 'token' | 'full') {
		let copied = false;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				copied = true;
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
				copied = document.execCommand('copy');
			} catch {
				/* best effort */
			}
			document.body.removeChild(ta);
		}
		if (!copied) return;
		if (which === 'url') {
			mcpCopiedUrl = true;
			setTimeout(() => (mcpCopiedUrl = false), 1500);
		} else if (which === 'token') {
			mcpCopiedToken = true;
			setTimeout(() => (mcpCopiedToken = false), 1500);
		} else {
			mcpCopiedFullUrl = true;
			setTimeout(() => (mcpCopiedFullUrl = false), 1500);
		}
	}

	async function revokeMcpAccess() {
		if (mcpRevoking) return;
		mcpRevoking = true;
		try {
			const res = await fetch('/api/mcp/revoke', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: mcpToken || undefined })
			});
			if (!res.ok) throw new Error('Revoke failed');
			if (typeof localStorage !== 'undefined' && syncStore.account?.accountId) {
				localStorage.removeItem(`${LS_MCP_TOKEN_PREFIX}${syncStore.account.accountId}`);
			}
			mcpToken = '';
			mcpOpen = false;
			info = 'Mobile AI (MCP) access revoked successfully.';
		} catch {
			error = 'Failed to revoke Mobile AI access.';
		} finally {
			mcpRevoking = false;
		}
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
	function progressPercent(loaded: number, total: number | null) {
		if (!total || total <= 0) return 100;
		return Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
	}
	function formatBytes(bytes: number): string {
		if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
		const megabytes = bytes / 1_000_000;
		return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
	}
	function formatLimit(bytes: number): string {
		return formatBytes(bytes);
	}
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			close();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

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

		{#if mode === SyncModalMode.Linked && syncStore.account}
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
				{#if error}
					<p class="text-sm text-[var(--scrapscache-danger)]" role="alert">{error}</p>
				{:else if syncError}
					<p class="text-sm text-[var(--scrapscache-danger)]" role="alert">{syncError}</p>
				{/if}
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
					<div
						aria-label="Sync storage usage"
						class={[
							'rounded-[var(--scrapscache-radius-md)] p-3 text-xs',
							SYNC_STATUS_CLASS[quotaStatus]
						]}
					>
						<div class="flex items-center justify-between gap-3">
							<span class="font-medium">Sync storage</span>
							<span>
								{formatBytes(syncStore.usage.storageBytes)} of
								{formatLimit(syncStore.usage.maxBytes)}
							</span>
						</div>
					</div>
				{/if}

				<!-- Mobile & AI Access (MCP) Section -->
				<div
					class="rounded-[var(--scrapscache-radius-md)] border border-[var(--scrapscache-border)] bg-[var(--scrapscache-interactive-hover)] p-3 text-xs space-y-2.5"
				>
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-1.5 font-medium text-[var(--scrapscache-text)]">
							<Sparkles class="h-3.5 w-3.5 text-amber-500" />
							<span>Mobile & AI Access (MCP)</span>
							{#if mcpToken}
								<span
									class="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded"
								>
									<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
									Enabled
								</span>
							{/if}
						</div>
						{#if mcpToken}
							<button
								type="button"
								onclick={() => (mcpOpen = !mcpOpen)}
								class="text-[var(--scrapscache-text-muted)] hover:text-[var(--scrapscache-text)] text-[11px] underline"
							>
								{mcpOpen ? 'Hide' : 'Show details'}
							</button>
						{/if}
					</div>

					<p class="text-[var(--scrapscache-text-muted)] leading-relaxed">
						Connect AI assistants (Grok, Perplexity, Claude, Cursor) to your notes via Model Context
						Protocol. Notes are decrypted in ephemeral memory only when connected.
					</p>

					{#if !mcpToken}
						<button
							type="button"
							onclick={generateMcpToken}
							class="scrapscache-button scrapscache-button-secondary w-full px-2 py-2 text-xs font-medium"
						>
							✨ Enable Mobile AI Access
						</button>
					{:else if mcpOpen}
						<div class="space-y-3 pt-1 border-t border-[var(--scrapscache-border)]">
							<div>
								<div
									class="flex items-center justify-between text-[11px] text-[var(--scrapscache-text-muted)] mb-1"
								>
									<span class="font-medium text-[var(--scrapscache-text)]"
										>Connector URL (Grok / Perplexity)</span
									>
									<button
										type="button"
										onclick={() =>
											copyMcpText(
												`${window.location.origin}/api/mcp/sse?token=${mcpToken}`,
												'full'
											)}
										class="flex items-center gap-1 text-[var(--scrapscache-accent)] hover:underline font-medium"
									>
										{#if mcpCopiedFullUrl}
											<Check class="h-3 w-3" /> Copied
										{:else}
											<Copy class="h-3 w-3" /> Copy Connector URL
										{/if}
									</button>
								</div>
								<div
									class="truncate font-mono rounded bg-[var(--scrapscache-bg)] p-1.5 border border-[var(--scrapscache-border)] text-[11px] select-all"
								>
									{typeof window !== 'undefined'
										? `${window.location.origin}/api/mcp/sse?token=${mcpToken}`
										: `/api/mcp/sse?token=${mcpToken}`}
								</div>
								<p class="text-[10px] text-[var(--scrapscache-text-muted)] mt-1">
									Paste into Grok or Perplexity <b>Server URL</b> field. No OAuth setup needed.
								</p>
							</div>

							<details class="text-[11px] text-[var(--scrapscache-text-muted)]">
								<summary
									class="cursor-pointer hover:text-[var(--scrapscache-text)] text-[10px] font-medium select-none"
								>
									Advanced (Separate URL & Bearer Token)
								</summary>
								<div class="space-y-2 mt-2 pt-2 border-t border-[var(--scrapscache-border)]/50">
									<div>
										<div class="flex items-center justify-between text-[10px] mb-1">
											<span>Base Server URL</span>
											<button
												type="button"
												onclick={() => copyMcpText(`${window.location.origin}/api/mcp/sse`, 'url')}
												class="flex items-center gap-1 text-[var(--scrapscache-accent)] hover:underline"
											>
												{#if mcpCopiedUrl}
													<Check class="h-3 w-3" /> Copied
												{:else}
													<Copy class="h-3 w-3" /> Copy URL
												{/if}
											</button>
										</div>
										<div
											class="truncate font-mono rounded bg-[var(--scrapscache-bg)] p-1.5 border border-[var(--scrapscache-border)] text-[10px] select-all"
										>
											{typeof window !== 'undefined'
												? `${window.location.origin}/api/mcp/sse`
												: '/api/mcp/sse'}
										</div>
									</div>

									<div>
										<div class="flex items-center justify-between text-[10px] mb-1">
											<span>Bearer Token</span>
											<button
												type="button"
												onclick={() => copyMcpText(mcpToken, 'token')}
												class="flex items-center gap-1 text-[var(--scrapscache-accent)] hover:underline"
											>
												{#if mcpCopiedToken}
													<Check class="h-3 w-3" /> Copied
												{:else}
													<Copy class="h-3 w-3" /> Copy Token
												{/if}
											</button>
										</div>
										<div
											class="truncate font-mono rounded bg-[var(--scrapscache-bg)] p-1.5 border border-[var(--scrapscache-border)] text-[10px] select-all"
										>
											{mcpToken}
										</div>
									</div>
								</div>
							</details>

							<div
								class="flex items-center justify-between pt-1 border-t border-[var(--scrapscache-border)]/50"
							>
								<button
									type="button"
									onclick={generateMcpToken}
									class="text-[10px] text-[var(--scrapscache-text-muted)] hover:text-[var(--scrapscache-text)] underline"
								>
									Regenerate token
								</button>
								<button
									type="button"
									onclick={() => void revokeMcpAccess()}
									disabled={mcpRevoking}
									class="text-[11px] text-[var(--scrapscache-danger)] hover:underline"
								>
									{mcpRevoking ? 'Revoking…' : 'Revoke Access'}
								</button>
							</div>
						</div>
					{/if}
				</div>

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
		{:else if mode === SyncModalMode.Menu}
			<div class="space-y-3">
				<p class="text-sm text-[var(--scrapscache-text-muted)]">
					Create one private sync key, then connect your own devices by starting the connection on
					both within 60 seconds.
				</p>
				<button
					type="button"
					onclick={() => {
						mode = SyncModalMode.Register;
						error = '';
						info = '';
					}}
					class="scrapscache-button scrapscache-button-primary w-full px-3 py-3 text-sm font-medium"
					>Create sync key</button
				><button
					type="button"
					onclick={() => {
						mode = SyncModalMode.Link;
						error = '';
						info = '';
					}}
					class="w-full rounded-lg border border-[var(--scrapscache-border)] px-3 py-3 text-sm touch-manipulation"
					>Connect to an existing sync</button
				>
				{#if error}<p class="text-sm text-[var(--scrapscache-danger)]">{error}</p>{/if}
			</div>
		{:else if mode === SyncModalMode.Register}
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
					onclick={() => (mode = SyncModalMode.Menu)}
					class="w-full text-xs text-[var(--scrapscache-text-muted)] touch-manipulation"
					>← Back</button
				>
			</div>
		{:else if mode === SyncModalMode.Link}
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
					onclick={() => (mode = SyncModalMode.Menu)}
					class="w-full text-xs text-[var(--scrapscache-text-muted)] touch-manipulation"
					>← Back</button
				>
			</div>
		{:else if mode === SyncModalMode.Waiting}
			<div class="space-y-5">
				{#if waiting?.role === PairingRole.Existing}
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
