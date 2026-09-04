import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairingRole } from '$lib/pairingProtocol';
import { createSyncIdentity } from '$lib/syncPairing';
import { notesStore } from '$lib/stores/notes.svelte';
import { syncStore } from '$lib/stores/sync.svelte';
import SyncModal from './SyncModal.svelte';

beforeEach(() => {
	Object.defineProperty(Element.prototype, 'animate', {
		configurable: true,
		value: vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }))
	});
	syncStore.account = null;
	syncStore.lastError = null;
});

afterEach(() => {
	delete (Element.prototype as Partial<Element>).animate;
	syncStore.account = null;
	syncStore.lastError = null;
	vi.restoreAllMocks();
});

describe('SyncModal create vs onboard', () => {
	it('uploads existing notes when creating a sync key instead of replacing this device', async () => {
		const sync = vi.spyOn(notesStore, 'syncWithCloudManual').mockResolvedValue(true);
		const replace = vi.spyOn(notesStore, 'replaceWithCloudManual').mockResolvedValue(true);
		vi.spyOn(syncStore, 'register').mockImplementation(async () => {
			syncStore.account = createSyncIdentity();
			return { success: true };
		});

		render(SyncModal, { props: { onClose: vi.fn() } });
		await fireEvent.click(screen.getByRole('button', { name: 'Create sync key' }));
		expect(screen.getByText(/notes already here stay and upload/i)).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Create my sync key' }));

		expect(sync).toHaveBeenCalledOnce();
		expect(replace).not.toHaveBeenCalled();
	});

	it('replaces this device when joining an existing sync key', async () => {
		const sync = vi.spyOn(notesStore, 'syncWithCloudManual').mockResolvedValue(true);
		const replace = vi.spyOn(notesStore, 'replaceWithCloudManual').mockResolvedValue(true);
		vi.spyOn(syncStore, 'startDeviceLink').mockResolvedValue({
			success: true,
			link: {
				id: 'session-1',
				expiresAt: Date.now() + 60_000,
				role: PairingRole.New,
				syncCode: 'AAAAAAAABBBBCCCC',
				pake: { ephemeralSecret: 'secret', share: 'share' }
			}
		});
		vi.spyOn(syncStore, 'pollDeviceLink').mockResolvedValue({ success: true, linked: true });

		render(SyncModal, { props: { onClose: vi.fn() } });
		await fireEvent.click(screen.getByRole('button', { name: 'Connect to an existing sync' }));
		expect(screen.getByText(/notes on this device will be replaced/i)).toBeTruthy();
		await fireEvent.input(screen.getByPlaceholderText('XXXX-XXXX-XXXX-XXXX'), {
			target: { value: 'AAAA-AAAA-BBBB-CCCC' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Start connection' }));
		await tick();

		expect(replace).toHaveBeenCalledOnce();
		expect(sync).not.toHaveBeenCalled();
	});
});
