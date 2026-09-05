<script lang="ts">
	import { onMount } from 'svelte';
	import { Check, Copy, Sparkles } from '@lucide/svelte';
	import { mcpGrantName } from '$lib/mcp/oauth';
	import { createMcpTokenGrant, isMcpToken, MCP_TOKEN_STORAGE_PREFIX } from '$lib/mcp/token';
	import { syncStore } from '$lib/stores/sync.svelte';

	type McpGrant = { clientId: string; createdAt: number; expiresAt: number };

	let detailsOpen = $state(false);
	let manualToken = $state('');
	let copiedUrl = $state(false);
	let copiedToken = $state(false);
	let issuing = $state(false);
	let revoking = $state(false);
	let entitled = $state<boolean | null>(null);
	let grants = $state.raw<McpGrant[]>([]);
	let error = $state('');
	let info = $state('');

	let connected = $derived(entitled === true && (grants.length > 0 || Boolean(manualToken)));

	onMount(() => {
		const accountId = syncStore.account?.accountId;
		if (accountId && typeof localStorage !== 'undefined') {
			const saved = localStorage.getItem(`${MCP_TOKEN_STORAGE_PREFIX}${accountId}`);
			if (saved && isMcpToken(saved)) manualToken = saved;
			else if (saved) localStorage.removeItem(`${MCP_TOKEN_STORAGE_PREFIX}${accountId}`);
		}
		void refreshAccess();
	});

	async function refreshAccess() {
		const account = syncStore.account;
		if (!account) {
			entitled = null;
			grants = [];
			return;
		}
		try {
			const response = await syncStore.authorizedFetch('/api/mcp/access');
			if (!response.ok) throw new Error('Could not check MCP access');
			const result = (await response.json()) as {
				enabled?: unknown;
				grants?: unknown;
			};
			entitled = result.enabled === true;
			grants = Array.isArray(result.grants)
				? result.grants.flatMap((grant) => {
						if (!grant || typeof grant !== 'object') return [];
						const clientId = (grant as { clientId?: unknown }).clientId;
						const createdAt = Number((grant as { createdAt?: unknown }).createdAt);
						const expiresAt = Number((grant as { expiresAt?: unknown }).expiresAt);
						return typeof clientId === 'string' && Number.isFinite(createdAt)
							? [{ clientId, createdAt, expiresAt }]
							: [];
					})
				: [];
			if (!entitled && typeof localStorage !== 'undefined') {
				localStorage.removeItem(`${MCP_TOKEN_STORAGE_PREFIX}${account.accountId}`);
				manualToken = '';
				detailsOpen = false;
			}
		} catch {
			entitled = null;
		}
	}

	async function generateManualToken() {
		const account = syncStore.account;
		if (!account?.syncKey || entitled !== true || issuing || revoking) return;
		issuing = true;
		error = '';
		info = '';
		try {
			const grant = createMcpTokenGrant(account.syncKey);
			const response = await syncStore.authorizedFetch('/api/mcp/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: grant.token, wrappedSyncKey: grant.wrappedSyncKey })
			});
			if (!response.ok) {
				if (response.status === 403) entitled = false;
				throw new Error('Issue failed');
			}
			manualToken = grant.token;
			detailsOpen = true;
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem(`${MCP_TOKEN_STORAGE_PREFIX}${account.accountId}`, grant.token);
			}
			await refreshAccess();
		} catch {
			error = 'Failed to enable Mobile AI access.';
		} finally {
			issuing = false;
		}
	}

	async function copyText(text: string, which: 'url' | 'token') {
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
			copiedUrl = true;
			setTimeout(() => (copiedUrl = false), 1500);
		} else {
			copiedToken = true;
			setTimeout(() => (copiedToken = false), 1500);
		}
	}

	async function revokeAccess() {
		if (revoking || issuing) return;
		revoking = true;
		error = '';
		try {
			const res = await syncStore.authorizedFetch('/api/mcp/revoke', { method: 'POST' });
			if (!res.ok) throw new Error('Revoke failed');
			if (typeof localStorage !== 'undefined' && syncStore.account?.accountId) {
				localStorage.removeItem(`${MCP_TOKEN_STORAGE_PREFIX}${syncStore.account.accountId}`);
			}
			manualToken = '';
			detailsOpen = false;
			grants = [];
			info = 'Mobile AI (MCP) access revoked successfully.';
		} catch {
			error = 'Failed to revoke Mobile AI access.';
		} finally {
			revoking = false;
		}
	}
</script>

{#if entitled === true}
	<div
		class="rounded-[var(--scrapscache-radius-md)] border border-[var(--scrapscache-border)] bg-[var(--scrapscache-interactive-hover)] p-3 text-xs space-y-2.5"
	>
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="flex flex-wrap items-center gap-1.5 font-medium text-[var(--scrapscache-text)]">
				<Sparkles class="h-3.5 w-3.5 text-amber-500" />
				<span>AI access (MCP)</span>
				{#if connected}
					<span
						class="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded"
					>
						<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
						Enabled
					</span>
				{/if}
			</div>
			{#if connected}
				<button
					type="button"
					onclick={() => (detailsOpen = !detailsOpen)}
					aria-expanded={detailsOpen}
					class="text-[var(--scrapscache-text-muted)] hover:text-[var(--scrapscache-text)] text-[11px] underline"
				>
					{detailsOpen ? 'Hide' : 'Show details'}
				</button>
			{/if}
		</div>

		<p class="text-[var(--scrapscache-text-muted)] leading-relaxed">
			MCP is not end-to-end encrypted: until revoked, this server decrypts requested notes in memory
			and your AI provider can read and change them. Device sync remains encrypted.
		</p>

		{#if !connected}
			<button
				type="button"
				onclick={() => void generateManualToken()}
				disabled={issuing || revoking}
				class="scrapscache-button scrapscache-button-secondary w-full px-2 py-2 text-xs font-medium"
			>
				{issuing ? 'Enabling…' : 'Enable AI access'}
			</button>
		{:else if detailsOpen}
			<div class="space-y-3 pt-1 border-t border-[var(--scrapscache-border)]">
				{#if grants.length > 0}
					<div>
						<div class="mb-1 text-[11px] font-medium text-[var(--scrapscache-text)]">Connected</div>
						<ul class="space-y-0.5 text-[var(--scrapscache-text-muted)]">
							{#each grants as grant (grant.clientId)}
								<li>{mcpGrantName(grant.clientId)}</li>
							{/each}
						</ul>
					</div>
				{/if}
				<div>
					<div
						class="flex items-center justify-between text-[11px] text-[var(--scrapscache-text-muted)] mb-1"
					>
						<span class="font-medium text-[var(--scrapscache-text)]">Server URL</span>
						<button
							type="button"
							onclick={() => copyText(`${window.location.origin}/api/mcp`, 'url')}
							class="flex items-center gap-1 text-[var(--scrapscache-accent)] hover:underline font-medium"
						>
							{#if copiedUrl}
								<Check class="h-3 w-3" /> Copied
							{:else}
								<Copy class="h-3 w-3" /> Copy URL
							{/if}
						</button>
					</div>
					<div
						class="truncate font-mono rounded bg-[var(--scrapscache-bg)] p-1.5 border border-[var(--scrapscache-border)] text-[11px] select-all"
					>
						{typeof window !== 'undefined' ? `${window.location.origin}/api/mcp` : `/api/mcp`}
					</div>
				</div>

				<details>
					<summary class="cursor-pointer py-2 font-medium">Manual setup</summary>
					<p class="mb-2 text-[var(--scrapscache-text-muted)]">
						For clients that require an Authorization: Bearer token. Keep this token private.
					</p>
					{#if manualToken}
						<div class="flex items-center justify-between text-[10px] mb-1">
							<span>Bearer Token</span>
							<button
								type="button"
								onclick={() => copyText(manualToken, 'token')}
								class="flex items-center gap-1 text-[var(--scrapscache-accent)] hover:underline"
							>
								{#if copiedToken}
									<Check class="h-3 w-3" /> Copied
								{:else}
									<Copy class="h-3 w-3" /> Copy Token
								{/if}
							</button>
						</div>
						<div
							class="truncate font-mono rounded bg-[var(--scrapscache-bg)] p-1.5 border border-[var(--scrapscache-border)] text-[10px] select-all"
						>
							••••••••••••••••
						</div>
					{:else}
						<button
							type="button"
							onclick={() => void generateManualToken()}
							disabled={issuing || revoking}
							class="scrapscache-button scrapscache-button-secondary w-full px-2 py-1.5 text-xs"
						>
							{issuing ? 'Enabling…' : 'Create bearer token'}
						</button>
					{/if}
				</details>

				<div
					class="flex items-center justify-between pt-1 border-t border-[var(--scrapscache-border)]/50"
				>
					<button
						type="button"
						onclick={() => void generateManualToken()}
						disabled={issuing || revoking}
						class="text-[10px] text-[var(--scrapscache-text-muted)] hover:text-[var(--scrapscache-text)] underline"
					>
						{issuing ? 'Regenerating…' : 'Regenerate token'}
					</button>
					<button
						type="button"
						onclick={() => void revokeAccess()}
						disabled={revoking || issuing}
						class="text-[11px] text-[var(--scrapscache-danger)] hover:underline"
					>
						{revoking ? 'Revoking…' : 'Revoke Access'}
					</button>
				</div>
			</div>
		{/if}

		{#if error}
			<p class="text-[var(--scrapscache-danger)]">{error}</p>
		{/if}
		{#if info}
			<p class="text-[var(--scrapscache-text-muted)]">{info}</p>
		{/if}
	</div>
{/if}
