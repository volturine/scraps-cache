import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { createSyncIdentity } from '$lib/syncPairing';
import { syncStore } from '$lib/stores/sync.svelte';
import { notesStore } from '$lib/stores/notes.svelte';
import SyncModal from './SyncModal.svelte';
import { createMcpTokenGrant, MCP_TOKEN_STORAGE_PREFIX } from '$lib/mcp/token';

const MB = 1_000_000;

beforeEach(() => {
	Object.defineProperty(Element.prototype, 'animate', {
		configurable: true,
		value: vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }))
	});
});

function renderUsage(ciphertextBytes: number, maxBytes = 10 * MB): HTMLElement {
	syncStore.account = createSyncIdentity();
	syncStore.usage = {
		ciphertextBytes,
		storageBytes: ciphertextBytes,
		envelopeCount: 1,
		maxBytes
	};
	render(SyncModal, { props: { onClose: vi.fn() } });
	return screen.getByLabelText('Sync storage usage');
}

afterEach(() => {
	vi.restoreAllMocks();
	delete (Element.prototype as Partial<Element>).animate;
	syncStore.account = null;
	syncStore.usage = null;
	syncStore.lastError = null;
});

describe('SyncModal storage usage', () => {
	it('discloses the separate MCP trust path', () => {
		renderUsage(5 * MB);

		expect(screen.getByText(/MCP is not end-to-end encrypted/).textContent).toMatch(
			/this server decrypts requested notes.*AI provider can read and change them/s
		);
	});

	it('opens connection details above the canvas without displaying the bearer token', async () => {
		const host = document.createElement('div');
		host.setAttribute('data-app-overlay', '');
		document.body.appendChild(host);
		const identity = createSyncIdentity();
		const { token } = createMcpTokenGrant(identity.syncKey);
		const key = `${MCP_TOKEN_STORAGE_PREFIX}${identity.accountId}`;
		syncStore.account = identity;
		localStorage.setItem(key, token);
		vi.spyOn(syncStore, 'authorizedFetch').mockResolvedValue(Response.json({ enabled: true }));
		const component = render(SyncModal, { props: { onClose: vi.fn() } });
		try {
			const toggle = await screen.findByRole('button', { name: 'Show details' });
			expect(host.contains(screen.getByRole('dialog'))).toBe(true);
			await fireEvent.click(toggle);
			expect(toggle.getAttribute('aria-expanded')).toBe('true');
			expect(screen.getByText('Manual setup').closest('details')?.open).toBe(false);
			expect(host.textContent).not.toContain(token);
			await fireEvent.click(toggle);
			expect(toggle.getAttribute('aria-expanded')).toBe('false');
		} finally {
			component.unmount();
			host.remove();
			localStorage.removeItem(key);
		}
	});

	it('shows current storage usage without warning below 80 percent', () => {
		const usage = renderUsage(7 * MB);
		const text = usage.textContent?.replace(/\s+/g, ' ');

		expect(text).toContain('7 MB of 10 MB');
		expect(usage.classList.contains('scrapscache-status-warning')).toBe(false);
		expect(usage.classList.contains('scrapscache-status-danger')).toBe(false);
	});

	it('warns at 80 percent and shows danger at the limit', async () => {
		const warning = renderUsage(8 * MB);
		expect(warning.classList.contains('scrapscache-status-warning')).toBe(true);

		syncStore.usage = {
			...syncStore.usage!,
			ciphertextBytes: 10 * MB,
			storageBytes: 10 * MB
		};
		await tick();
		expect(warning.classList.contains('scrapscache-status-danger')).toBe(true);
	});

	it('shows a quota rejection as a persistent danger alert', async () => {
		const usage = renderUsage(MB);
		syncStore.lastError = 'Sync incomplete: account storage quota prevented some uploads';
		await tick();

		expect(usage.classList.contains('scrapscache-status-danger')).toBe(true);
		expect(screen.getByRole('alert').textContent).toMatch(/quota/);
	});

	it('displays the default 100 MB decimal-byte limit', () => {
		const usage = renderUsage(5_000, 100_000_000);
		expect(usage.textContent?.replace(/\s+/g, ' ')).toContain('5 KB of 100 MB');
	});

	it('uploads local notes after creating a new sync account instead of replacing them', async () => {
		const identity = createSyncIdentity();
		const register = vi.spyOn(syncStore, 'register').mockImplementation(async () => {
			syncStore.account = identity;
			return { success: true };
		});
		const sync = vi.spyOn(notesStore, 'syncWithCloudManual').mockResolvedValue(true);
		const replace = vi.spyOn(notesStore, 'replaceWithCloudManual').mockResolvedValue(true);
		vi.spyOn(syncStore, 'authorizedFetch').mockResolvedValue(
			new Response(JSON.stringify({ enabled: false }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		render(SyncModal, { props: { onClose: vi.fn() } });
		await fireEvent.click(screen.getByRole('button', { name: 'Create sync key' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Create my sync key' }));

		await waitFor(() => expect(sync).toHaveBeenCalledOnce());
		expect(register).toHaveBeenCalledOnce();
		expect(replace).not.toHaveBeenCalled();
	});
});
