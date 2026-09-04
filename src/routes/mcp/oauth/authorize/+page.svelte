<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { ArrowLeft, ShieldCheck } from '@lucide/svelte';
	import {
		GROK_OAUTH_REDIRECT_URI,
		MCP_OAUTH_CLIENT_ID,
		MCP_OAUTH_SCOPE,
		isPkceChallenge,
		mcpResource
	} from '$lib/mcp/oauth';
	import { createMcpTokenGrant } from '$lib/mcp/token';
	import { syncStore } from '$lib/stores/sync.svelte';

	type OAuthRequest = {
		valid: boolean;
		state: string | null;
		codeChallenge: string;
		resource: string;
	};

	function parseRequest(url: URL): OAuthRequest {
		const params = url.searchParams;
		const state = params.get('state');
		const codeChallenge = params.get('code_challenge') ?? '';
		const resource = params.get('resource') ?? mcpResource(url.origin);
		return {
			valid:
				params.get('response_type') === 'code' &&
				params.get('client_id') === MCP_OAUTH_CLIENT_ID &&
				params.get('redirect_uri') === GROK_OAUTH_REDIRECT_URI &&
				params.get('scope') === MCP_OAUTH_SCOPE &&
				params.get('code_challenge_method') === 'S256' &&
				isPkceChallenge(codeChallenge) &&
				resource === mcpResource(url.origin) &&
				(state === null || state.length <= 512),
			state,
			codeChallenge,
			resource
		};
	}

	let oauthRequest = $derived(parseRequest(page.url));
	let busy = $state(false);
	let error = $state('');
	let mcpEntitled = $state<boolean | null>(null);

	onMount(() => {
		if (!syncStore.account) return;
		void syncStore
			.authorizedFetch('/api/mcp/access')
			.then(async (response) => {
				if (!response.ok) throw new Error('Could not check MCP access');
				const result = (await response.json()) as { enabled?: unknown };
				mcpEntitled = result.enabled === true;
			})
			.catch(() => {
				mcpEntitled = null;
			});
	});

	async function approve() {
		const account = syncStore.account;
		if (!oauthRequest.valid || !account?.syncKey || mcpEntitled !== true || busy) return;
		busy = true;
		error = '';
		try {
			const grant = createMcpTokenGrant(account.syncKey);
			const response = await syncStore.authorizedFetch('/api/mcp/oauth/authorize', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					responseType: 'code',
					clientId: MCP_OAUTH_CLIENT_ID,
					redirectUri: GROK_OAUTH_REDIRECT_URI,
					scope: MCP_OAUTH_SCOPE,
					state: oauthRequest.state ?? undefined,
					codeChallenge: oauthRequest.codeChallenge,
					codeChallengeMethod: 'S256',
					resource: oauthRequest.resource,
					code: grant.token,
					wrappedSyncKey: grant.wrappedSyncKey
				})
			});
			if (!response.ok) throw new Error('Authorization failed');
			const result = (await response.json()) as { redirectTo?: unknown };
			if (typeof result.redirectTo !== 'string') throw new Error('Invalid authorization response');
			const redirect = new URL(result.redirectTo);
			if (`${redirect.origin}${redirect.pathname}` !== GROK_OAUTH_REDIRECT_URI) {
				throw new Error('Invalid authorization redirect');
			}
			window.location.replace(redirect.href);
		} catch {
			error = 'Could not authorize Grok. Please try again.';
			busy = false;
		}
	}

	function deny() {
		if (!oauthRequest.valid || busy) {
			window.location.assign('/');
			return;
		}
		const redirect = new URL(GROK_OAUTH_REDIRECT_URI);
		redirect.searchParams.set('error', 'access_denied');
		redirect.searchParams.set('error_description', 'The user denied the authorization request');
		if (oauthRequest.state !== null) redirect.searchParams.set('state', oauthRequest.state);
		window.location.replace(redirect.href);
	}
</script>

<svelte:head>
	<title>Authorize Grok · Scraps Cache</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div
	class="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-[var(--scrapscache-bg)] px-4 py-10 text-[var(--scrapscache-text)]"
>
	<div class="w-full max-w-md">
		<a
			href={resolve('/')}
			data-sveltekit-reload
			class="mb-6 inline-flex items-center gap-2 text-sm text-[var(--scrapscache-text-muted)] hover:text-[var(--scrapscache-text)]"
		>
			<ArrowLeft class="h-4 w-4" />
			Back to Scraps Cache
		</a>

		<section
			class="overflow-hidden rounded-2xl border border-[var(--scrapscache-border)] bg-[var(--scrapscache-surface)] shadow-xl"
		>
			<div class="border-b border-[var(--scrapscache-border)] px-6 py-6">
				<div
					class="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white"
				>
					<ShieldCheck class="h-6 w-6" />
				</div>
				<p class="mb-1 text-xs font-semibold uppercase tracking-wider text-blue-600">
					Authorization
				</p>
				<h1 class="text-2xl font-semibold tracking-tight">Connect Grok to your notes?</h1>
			</div>

			<div class="space-y-5 px-6 py-6">
				{#if !oauthRequest.valid}
					<div class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
						This authorization request is invalid. No access was granted.
					</div>
				{:else if !syncStore.account?.syncKey}
					<div class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
						Set up encrypted sync on this device before connecting Grok.
					</div>
				{:else if mcpEntitled === false}
					<div class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
						Hosted MCP is not enabled for this sync account.
					</div>
				{:else if mcpEntitled === null}
					<div class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
						Checking whether this account can use hosted MCP…
					</div>
				{:else}
					<div class="space-y-3 text-sm leading-relaxed text-[var(--scrapscache-text-muted)]">
						<p>Grok will be able to search, read, create, update, and delete your notes.</p>
						<p>
							Your normal device sync remains end-to-end encrypted. MCP is a separate access path
							and is not end-to-end encrypted: while access is enabled, this server decrypts
							requested note data in ephemeral memory, and Grok/xAI can see the note contents
							returned. Revoke access at any time in Sync.
						</p>
					</div>
				{/if}

				{#if error}
					<div class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
						{error}
					</div>
				{/if}

				<div class="flex gap-3">
					<button
						type="button"
						onclick={deny}
						disabled={busy}
						class="flex-1 rounded-lg border border-[var(--scrapscache-border)] px-4 py-2.5 text-sm font-medium hover:bg-[var(--scrapscache-interactive-hover)] disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={approve}
						disabled={busy ||
							!oauthRequest.valid ||
							!syncStore.account?.syncKey ||
							mcpEntitled !== true}
						class="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{busy ? 'Connecting…' : 'Allow access'}
					</button>
				</div>
			</div>
		</section>
	</div>
</div>
