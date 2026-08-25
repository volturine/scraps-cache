import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncIdentity, identityFromSyncKey } from '$lib/syncPairing';
import type { StoredProfile } from '$lib/profiles';
import { notesStore } from '$lib/stores/notes.svelte';
import { profileCoordinator } from '$lib/stores/profiles.svelte';
import { syncStore, type StartedDeviceLink } from '$lib/stores/sync.svelte';
import SyncModal from './SyncModal.svelte';

function profile(id: string, name: string, createdAt: number): StoredProfile {
	return { id, name, createdAt, syncKey: createSyncIdentity().syncKey };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe('SyncModal profile interactions', () => {
	let main: StoredProfile;
	let side: StoredProfile;

	beforeEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
		main = profile('profile-main', 'Main', 1);
		side = profile('profile-side', 'Side', 2);
		syncStore.profiles = [main, side];
		syncStore.account = identityFromSyncKey(main.syncKey);
		syncStore.lastError = null;
		syncStore.progress = null;
		syncStore.usage = null;
		profileCoordinator.switching = false;
		(notesStore as unknown as { syncFlight: Promise<boolean> | null }).syncFlight = null;
	});

	it('finishes a switch without leaving either profile stuck', async () => {
		const handover = deferred<{ success: boolean }>();
		vi.spyOn(profileCoordinator, 'switchTo').mockImplementation(async () => {
			const result = await handover.promise;
			syncStore.activateProfile(side);
			return result;
		});
		render(SyncModal, { props: { onClose: vi.fn() } });

		await fireEvent.click(screen.getByRole('button', { name: 'Switch sync key' }));
		const target = screen.getByRole('button', { name: 'Switch to Side' }) as HTMLButtonElement;
		await fireEvent.click(target);
		expect(target.disabled).toBe(true);
		expect((screen.getByLabelText('Close') as HTMLButtonElement).disabled).toBe(true);

		handover.resolve({ success: true });
		await waitFor(() => expect(screen.getByText('Switched to Side.')).toBeTruthy());
		expect((screen.getByLabelText('Close') as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.click(screen.getByRole('button', { name: 'Switch sync key' }));
		expect(
			(screen.getByRole('button', { name: 'Switch to Main' }) as HTMLButtonElement).disabled
		).toBe(false);
	});

	it('releases the UI after an unexpected sync rejection', async () => {
		vi.spyOn(notesStore, 'syncWithCloudManual').mockRejectedValueOnce(new Error('relay failed'));
		render(SyncModal, { props: { onClose: vi.fn() } });

		const button = screen.getByRole('button', { name: '🔄 Sync now' }) as HTMLButtonElement;
		await fireEvent.click(button);

		await waitFor(() => expect(screen.getByText('relay failed')).toBeTruthy());
		expect(button.disabled).toBe(false);
		expect(button.textContent).toContain('Sync now');
	});

	it('shows syncing only for a sync started from the modal', async () => {
		const manualSync = deferred<boolean>();
		vi.spyOn(notesStore, 'syncWithCloudManual').mockReturnValueOnce(manualSync.promise);
		render(SyncModal, { props: { onClose: vi.fn() } });

		await fireEvent.click(screen.getByRole('button', { name: '🔄 Sync now' }));
		expect(screen.getByRole('button', { name: 'Syncing…' })).toBeTruthy();
		expect(screen.getByText('Syncing…', { selector: 'p' })).toBeTruthy();

		manualSync.resolve(true);
		await waitFor(() => expect(screen.getByRole('button', { name: '🔄 Sync now' })).toBeTruthy());
	});

	it('reacts when a store-owned sync starts and ends', async () => {
		render(SyncModal, { props: { onClose: vi.fn() } });
		const syncNow = screen.getByRole('button', { name: '🔄 Sync now' }) as HTMLButtonElement;

		(notesStore as unknown as { syncFlight: Promise<boolean> | null }).syncFlight = new Promise(
			() => undefined
		);
		await tick();
		expect(syncNow.disabled).toBe(true);
		expect(syncNow.textContent).toContain('Sync now');
		expect(screen.queryByText('Syncing…')).toBeNull();

		(notesStore as unknown as { syncFlight: Promise<boolean> | null }).syncFlight = null;
		await tick();
		await fireEvent.click(screen.getByRole('button', { name: 'Switch sync key' }));
		const target = screen.getByRole('button', { name: 'Switch to Side' }) as HTMLButtonElement;

		(notesStore as unknown as { syncFlight: Promise<boolean> | null }).syncFlight = new Promise(
			() => undefined
		);
		await tick();
		expect(target.disabled).toBe(true);
		expect(
			screen.getByText('Switching sync keys is paused until the current sync finishes.')
		).toBeTruthy();

		(notesStore as unknown as { syncFlight: Promise<boolean> | null }).syncFlight = null;
		await tick();
		expect(target.disabled).toBe(false);
	});

	it('never overlaps pairing polls', async () => {
		vi.useFakeTimers();
		const link: StartedDeviceLink = {
			id: 'link-1',
			expiresAt: Date.now() + 60_000,
			role: 'existing',
			syncCode: 'ABCD1234EFGH5678',
			pake: { ephemeralSecret: 'secret', share: 'share' }
		};
		const firstPoll = deferred<{
			success: boolean;
			linked: boolean;
			expired: boolean;
		}>();
		vi.spyOn(syncStore, 'startExistingDeviceLink').mockResolvedValue({ success: true, link });
		const poll = vi
			.spyOn(syncStore, 'pollDeviceLink')
			.mockImplementationOnce(() => firstPoll.promise)
			.mockResolvedValue({ success: true, linked: false, expired: false });
		render(SyncModal, { props: { onClose: vi.fn() } });

		await fireEvent.click(screen.getByRole('button', { name: 'Connect another device' }));
		expect(poll).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(poll).toHaveBeenCalledTimes(1);

		firstPoll.resolve({ success: true, linked: false, expired: false });
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(1_500);
		expect(poll).toHaveBeenCalledTimes(2);
	});
});
