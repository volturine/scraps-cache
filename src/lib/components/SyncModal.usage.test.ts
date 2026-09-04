import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { createSyncIdentity } from '$lib/syncPairing';
import { syncStore } from '$lib/stores/sync.svelte';
import SyncModal from './SyncModal.svelte';

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
	delete (Element.prototype as Partial<Element>).animate;
	syncStore.account = null;
	syncStore.usage = null;
	syncStore.lastError = null;
});

describe('SyncModal storage usage', () => {
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
});
