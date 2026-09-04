<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Activity,
		Database,
		Gauge,
		KeyRound,
		RefreshCw,
		Search,
		ShieldCheck,
		UsersRound
	} from '@lucide/svelte';

	type OperatorSnapshot = {
		generatedAt: number;
		storage: {
			ciphertextBytes: number;
			storageBytes: number;
			gigabytes: number;
			envelopes: number;
		};
		accounts: { total: number; active: Record<string, number>; staleForRetention: number | null };
		activity: {
			syncRequests: number;
			syncUploadEnvelopes: number;
			syncDeleteSlots: number;
			rateLimited: number;
			sqliteBusy: number;
			reminderWakesSent: number;
			reminderWakesGone: number;
			reminderWakesFailed: number;
		};
		retention: {
			enabled: boolean;
			inactiveDays: number;
			lastRunAt: number;
			lastDeletedAccounts: number;
			deletedAccountsTotal: number;
			lastPurgedSlots: number;
			failures: number;
			lastError: string | null;
		};
		quotas: { maxAccountBytes: number };
		features: { mcpEnabledAccounts: number };
	};

	type ManagedAccount = {
		usage: {
			envelopeCount: number;
			ciphertextBytes: number;
			storageBytes: number;
			maxBytes: number;
			overridden: boolean;
		};
		mcp: { enabled: boolean; enabledAt: number | null; updatedAt: number | null };
	};

	let snapshot = $state.raw<OperatorSnapshot | null>(null);
	let account = $state.raw<ManagedAccount | null>(null);
	let accountId = $state('');
	let quotaMb = $state('');
	let loading = $state(false);
	let accountLoading = $state(false);
	let error = $state('');
	let notice = $state('');

	async function api<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(path, init);
		const body = (await response.json().catch(() => ({}))) as { error?: unknown } & T;
		if (!response.ok) {
			throw new Error(typeof body.error === 'string' ? body.error : 'Request failed');
		}
		return body;
	}

	function jsonRequest(method: string, body: unknown): RequestInit {
		return {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		};
	}

	async function refreshStatus() {
		loading = true;
		error = '';
		try {
			snapshot = await api<OperatorSnapshot>('/admin/api/status');
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not load operator status';
		} finally {
			loading = false;
		}
	}

	async function findAccount() {
		if (!accountId.trim() || accountLoading) return;
		accountLoading = true;
		error = '';
		notice = '';
		account = null;
		try {
			account = await api<ManagedAccount>(
				'/admin/api/account',
				jsonRequest('POST', { accountId: accountId.trim() })
			);
			quotaMb = String(account.usage.maxBytes / 1_000_000);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not find account';
		} finally {
			accountLoading = false;
		}
	}

	async function updateQuota(reset: boolean) {
		if (!account || accountLoading) return;
		const maxBytes = Math.round(Number(quotaMb) * 1_000_000);
		if (!reset && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
			error = 'Enter a positive storage limit in MB.';
			return;
		}
		accountLoading = true;
		error = '';
		notice = '';
		try {
			account = await api<ManagedAccount>(
				'/admin/api/account',
				jsonRequest(reset ? 'DELETE' : 'PUT', {
					accountId: accountId.trim(),
					...(reset ? {} : { maxBytes })
				})
			);
			quotaMb = String(account.usage.maxBytes / 1_000_000);
			notice = reset ? 'Account restored to the default storage limit.' : 'Storage limit updated.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not update storage limit';
		} finally {
			accountLoading = false;
		}
	}

	async function setMcp(enabled: boolean) {
		if (!account || accountLoading) return;
		accountLoading = true;
		error = '';
		notice = '';
		try {
			account = await api<ManagedAccount>(
				'/admin/api/account-mcp',
				jsonRequest(enabled ? 'PUT' : 'DELETE', { accountId: accountId.trim() })
			);
			notice = enabled
				? 'Hosted MCP enabled for this account.'
				: 'Hosted MCP disabled; credentials and live sessions were revoked.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not update MCP access';
		} finally {
			accountLoading = false;
		}
	}

	function bytes(value: number): string {
		if (value < 1_000) return `${value} B`;
		if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
		if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
		return `${(value / 1_000_000_000).toFixed(2)} GB`;
	}

	function date(value: number | null): string {
		return value ? new Date(value).toLocaleString() : 'Never';
	}

	onMount(() => {
		void refreshStatus();
	});
</script>

<svelte:head>
	<title>Operator console · Scraps Cache</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="console-shell">
	<header class="console-header">
		<div>
			<div class="eyebrow"><ShieldCheck size={14} /> Cloudflare Access protected</div>
			<h1>Operator console</h1>
			<p>Monitor the encrypted relay and manage account limits without exposing note contents.</p>
		</div>
		<button class="refresh" type="button" onclick={() => void refreshStatus()} disabled={loading}>
			<span class:spin={loading}><RefreshCw size={16} /></span>
			Refresh
		</button>
	</header>

	{#if error}<div class="message error" role="alert">{error}</div>{/if}
	{#if notice}<div class="message notice" role="status">{notice}</div>{/if}

	{#if snapshot}
		<section class="metrics" aria-label="Relay overview">
			<article class="metric">
				<div class="metric-icon"><UsersRound size={18} /></div>
				<span>Sync accounts</span>
				<strong>{snapshot.accounts.total}</strong>
				<small>{snapshot.accounts.active['30'] ?? 0} active in 30 days</small>
			</article>
			<article class="metric">
				<div class="metric-icon"><Database size={18} /></div>
				<span>Relay storage</span>
				<strong>{bytes(snapshot.storage.storageBytes)}</strong>
				<small>{snapshot.storage.envelopes.toLocaleString()} encrypted envelopes</small>
			</article>
			<article class="metric">
				<div class="metric-icon"><Activity size={18} /></div>
				<span>Sync requests</span>
				<strong>{snapshot.activity.syncRequests.toLocaleString()}</strong>
				<small>{snapshot.activity.rateLimited} rate limited this process</small>
			</article>
			<article class="metric">
				<div class="metric-icon"><Gauge size={18} /></div>
				<span>Default limit</span>
				<strong>{bytes(snapshot.quotas.maxAccountBytes)}</strong>
				<small>per sync account</small>
			</article>
		</section>

		<section class="details-grid">
			<article class="panel">
				<div class="panel-heading">
					<div>
						<p class="section-label">Activity windows</p>
						<h2>Account health</h2>
					</div>
					<span class="timestamp">{date(snapshot.generatedAt)}</span>
				</div>
				<div class="activity-row">
					{#each Object.entries(snapshot.accounts.active) as [days, count] (days)}
						<div><strong>{count}</strong><span>{days}d active</span></div>
					{/each}
					<div><strong>{snapshot.features.mcpEnabledAccounts}</strong><span>hosted MCP</span></div>
				</div>
				<div class="retention">
					<span class:healthy={!snapshot.retention.lastError}></span>
					<div>
						<strong>Retention {snapshot.retention.enabled ? 'enabled' : 'disabled'}</strong>
						<p>
							{snapshot.retention.enabled
								? `${snapshot.accounts.staleForRetention ?? 0} accounts currently eligible after ${snapshot.retention.inactiveDays} days.`
								: 'No inactive accounts are removed automatically.'}
						</p>
					</div>
				</div>
			</article>

			<article class="panel account-panel">
				<div class="panel-heading">
					<div>
						<p class="section-label">Account controls</p>
						<h2>Storage & hosted MCP</h2>
					</div>
					<span class="panel-icon"><KeyRound size={20} /></span>
				</div>

				<form
					class="account-search"
					onsubmit={(event) => {
						event.preventDefault();
						void findAccount();
					}}
				>
					<label for="account-id">Sync account ID</label>
					<div>
						<input id="account-id" bind:value={accountId} autocomplete="off" spellcheck="false" />
						<button type="submit" disabled={accountLoading || !accountId.trim()}>
							<Search size={16} /> Look up
						</button>
					</div>
				</form>

				{#if account}
					<div class="control-block">
						<div class="control-copy">
							<strong>Storage limit</strong>
							<span
								>{bytes(account.usage.storageBytes)} used · {account.usage.envelopeCount} envelopes</span
							>
						</div>
						<div class="quota-controls">
							<label><input type="number" min="1" step="1" bind:value={quotaMb} /> MB</label>
							<button
								type="button"
								onclick={() => void updateQuota(false)}
								disabled={accountLoading}>Save</button
							>
							<button
								class="quiet"
								type="button"
								onclick={() => void updateQuota(true)}
								disabled={accountLoading || !account.usage.overridden}>Use default</button
							>
						</div>
					</div>

					<div class="control-block mcp-control">
						<div class="control-copy">
							<div class="status-title">
								<strong>Premium hosted MCP</strong>
								<span class:enabled={account.mcp.enabled}
									>{account.mcp.enabled ? 'Enabled' : 'Disabled'}</span
								>
							</div>
							<small>
								{account.mcp.enabled
									? `Enabled ${date(account.mcp.enabledAt)}. The user can authorize an AI provider.`
									: 'The account cannot issue or use hosted MCP credentials.'}
							</small>
						</div>
						<button
							class:danger={account.mcp.enabled}
							type="button"
							onclick={() => account && void setMcp(!account.mcp.enabled)}
							disabled={accountLoading}
						>
							{account.mcp.enabled ? 'Disable & revoke' : 'Enable MCP'}
						</button>
					</div>
				{/if}
			</article>
		</section>
	{/if}
</div>

<style>
	:global(html) {
		background: #09110f;
	}
	:global(body) {
		margin: 0;
		background: #09110f;
	}
	.console-shell {
		min-height: 100vh;
		color: #e7f2ed;
		padding: clamp(1.25rem, 4vw, 4rem);
		font-family: ui-sans-serif, system-ui, sans-serif;
		background-color: #09110f;
		background-image:
			linear-gradient(rgba(157, 255, 206, 0.035) 1px, transparent 1px),
			linear-gradient(90deg, rgba(157, 255, 206, 0.035) 1px, transparent 1px);
		background-size: 32px 32px;
	}
	.console-header {
		max-width: 1180px;
		margin: 0 auto 2rem;
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 2rem;
	}
	.eyebrow,
	.section-label {
		margin: 0 0 0.65rem;
		color: #83e6b1;
		font:
			700 0.72rem/1.2 ui-monospace,
			monospace;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.eyebrow {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}
	h1 {
		margin: 0;
		font:
			650 clamp(2.3rem, 6vw, 4.8rem)/0.95 ui-serif,
			Georgia,
			serif;
		letter-spacing: -0.045em;
	}
	.console-header p:not(.eyebrow) {
		max-width: 650px;
		margin: 1rem 0 0;
		color: #94a9a0;
	}
	button,
	input {
		font: inherit;
	}
	button {
		cursor: pointer;
	}
	button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
	.refresh {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border: 1px solid #2c443a;
		border-radius: 999px;
		background: #101b17;
		color: #d9ebe3;
		padding: 0.7rem 1rem;
	}
	.spin {
		animation: spin 0.8s linear infinite;
	}
	.message {
		max-width: 1180px;
		margin: 0 auto 1rem;
		border-radius: 10px;
		padding: 0.8rem 1rem;
		font-size: 0.9rem;
	}
	.message.error {
		border: 1px solid #7c3636;
		background: #2a1515;
		color: #ffaaaa;
	}
	.message.notice {
		border: 1px solid #2d684a;
		background: #10251b;
		color: #a5f1c6;
	}
	.metrics {
		max-width: 1180px;
		margin: 0 auto;
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		border: 1px solid #233a31;
		border-radius: 16px;
		overflow: hidden;
		background: rgba(13, 25, 21, 0.92);
	}
	.metric {
		position: relative;
		min-height: 145px;
		padding: 1.35rem;
		border-right: 1px solid #233a31;
	}
	.metric:last-child {
		border-right: 0;
	}
	.metric-icon {
		position: absolute;
		right: 1.2rem;
		top: 1.2rem;
		color: #73d9a1;
	}
	.metric span,
	.metric small {
		display: block;
		color: #82978e;
	}
	.metric span {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.metric strong {
		display: block;
		margin: 1.2rem 0 0.25rem;
		font:
			600 1.7rem/1 ui-monospace,
			monospace;
	}
	.metric small {
		font-size: 0.75rem;
	}
	.details-grid {
		max-width: 1180px;
		margin: 1rem auto 0;
		display: grid;
		grid-template-columns: 0.85fr 1.45fr;
		gap: 1rem;
	}
	.panel {
		border: 1px solid #233a31;
		border-radius: 16px;
		background: rgba(13, 25, 21, 0.92);
		padding: 1.4rem;
	}
	.panel-heading {
		display: flex;
		justify-content: space-between;
		align-items: start;
		gap: 1rem;
		padding-bottom: 1.2rem;
		border-bottom: 1px solid #20352c;
	}
	.panel-heading h2 {
		margin: 0;
		font:
			600 1.25rem/1.2 ui-serif,
			Georgia,
			serif;
	}
	.panel-icon {
		color: #73d9a1;
	}
	.timestamp {
		color: #6f857b;
		font:
			0.68rem ui-monospace,
			monospace;
	}
	.activity-row {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.5rem;
		margin: 1rem 0;
	}
	.activity-row div {
		border-radius: 10px;
		background: #101e19;
		padding: 0.8rem;
	}
	.activity-row strong,
	.activity-row span {
		display: block;
	}
	.activity-row strong {
		font:
			600 1.25rem ui-monospace,
			monospace;
	}
	.activity-row span {
		margin-top: 0.2rem;
		color: #82978e;
		font-size: 0.7rem;
	}
	.retention {
		display: flex;
		gap: 0.8rem;
		align-items: start;
		padding-top: 0.8rem;
	}
	.retention > span {
		width: 8px;
		height: 8px;
		margin-top: 0.35rem;
		border-radius: 50%;
		background: #d66b5f;
		box-shadow: 0 0 0 4px rgba(214, 107, 95, 0.12);
	}
	.retention > span.healthy {
		background: #5bd292;
		box-shadow: 0 0 0 4px rgba(91, 210, 146, 0.12);
	}
	.retention p {
		margin: 0.25rem 0 0;
		color: #82978e;
		font-size: 0.78rem;
		line-height: 1.45;
	}
	.account-search {
		padding: 1.2rem 0;
	}
	.account-search > label {
		display: block;
		margin-bottom: 0.45rem;
		color: #82978e;
		font-size: 0.75rem;
	}
	.account-search > div {
		display: flex;
		gap: 0.55rem;
	}
	input {
		min-width: 0;
		border: 1px solid #2b493c;
		border-radius: 9px;
		outline: none;
		background: #08120e;
		color: #e7f2ed;
		padding: 0.7rem 0.8rem;
	}
	input:focus {
		border-color: #65d89a;
		box-shadow: 0 0 0 3px rgba(101, 216, 154, 0.12);
	}
	.account-search input {
		flex: 1;
		font-family: ui-monospace, monospace;
	}
	.account-search button,
	.quota-controls button,
	.mcp-control > button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		border: 1px solid #4b9f72;
		border-radius: 9px;
		background: #6fe0a3;
		color: #07130d;
		font-weight: 700;
		padding: 0.7rem 1rem;
	}
	.control-block {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		border-top: 1px solid #20352c;
		padding: 1.1rem 0 0.1rem;
	}
	.control-copy > span,
	.control-copy small {
		display: block;
		margin-top: 0.3rem;
		color: #82978e;
		font-size: 0.75rem;
	}
	.quota-controls {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}
	.quota-controls label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: #82978e;
		font-size: 0.75rem;
	}
	.quota-controls input {
		width: 6rem;
	}
	.quota-controls button {
		padding: 0.58rem 0.7rem;
	}
	.quota-controls button.quiet {
		border-color: #31493f;
		background: transparent;
		color: #b9cbc3;
	}
	.status-title {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.status-title span {
		border-radius: 999px;
		background: #33201b;
		color: #f2a98d;
		padding: 0.2rem 0.5rem;
		font:
			700 0.65rem ui-monospace,
			monospace;
		text-transform: uppercase;
	}
	.status-title span.enabled {
		background: #153525;
		color: #73e4a8;
	}
	.mcp-control > button.danger {
		border-color: #75463e;
		background: transparent;
		color: #ffb09d;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (max-width: 850px) {
		.metrics {
			grid-template-columns: repeat(2, 1fr);
		}
		.metric:nth-child(2) {
			border-right: 0;
		}
		.metric:nth-child(-n + 2) {
			border-bottom: 1px solid #233a31;
		}
		.details-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 580px) {
		.console-header {
			align-items: start;
			flex-direction: column;
		}
		.metrics {
			grid-template-columns: 1fr;
		}
		.metric {
			border-right: 0;
			border-bottom: 1px solid #233a31;
		}
		.metric:last-child {
			border-bottom: 0;
		}
		.control-block,
		.quota-controls {
			align-items: stretch;
			flex-direction: column;
		}
		.quota-controls input {
			width: 100%;
		}
		.account-search > div {
			flex-direction: column;
		}
	}
</style>
