import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as idb from '$lib/db/idb';
import { createSyncIdentity, identityFromSyncKey, decryptSyncPayload } from '$lib/syncPairing';
import {
	getAllLabels,
	getAllNotesMetadata,
	getSyncOutboxKeys,
	markSyncOutbox,
	putLabel,
	putNote
} from '$lib/db/idb';
import { loadProfiles, saveProfile } from '$lib/profiles';
import type { StoredProfile } from '$lib/profiles';
import type { Note } from '$lib/types';
import { syncStore, SyncStore } from './sync.svelte';
import { notesStore, SYNC_LOCK } from './notes.svelte';
import { profileCoordinator } from './profiles.svelte';

function keyringEntry(syncKey: string, name: string, createdAt: number): StoredProfile {
	return { id: `profile-${name.toLowerCase()}`, name, syncKey, createdAt };
}

function note(id: string): Note {
	return {
		id,
		title: `title-${id}`,
		body: '',
		color: 'default',
		pinned: false,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 1,
		updatedAt: 1,
		reminder: null,
		labels: [],
		images: []
	};
}

describe('sync key keyring', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		syncStore.account = null;
		syncStore.profiles = [];
	});

	it('adopts an install that predates profiles as its first entry', async () => {
		const identity = createSyncIdentity();
		localStorage.setItem(
			'gkc-sync-account',
			JSON.stringify({ syncKey: identity.syncKey, pairingCode: '' })
		);

		const store = new SyncStore();
		await store.ensureProfilesLoaded();

		expect(store.profiles).toHaveLength(1);
		expect(store.profiles[0].syncKey).toBe(identity.syncKey);
		expect(store.activeProfile?.id).toBe(store.profiles[0].id);
		expect(store.activePid).toBe(store.profiles[0].id);
	});

	it('registers a new key as a saved profile without switching the active account', async () => {
		const identity = createSyncIdentity();
		const main = keyringEntry(identity.syncKey, 'Main', 1);
		await saveProfile(main);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({}) }))
		);

		const store = new SyncStore();
		await store.ensureProfilesLoaded();
		const result = await store.register('Work');

		expect(result.success).toBe(true);
		expect(result.profile?.name).toBe('Work');
		expect((await loadProfiles()).map(({ name }) => name).sort()).toEqual(['Main', 'Work']);
		expect(store.account?.syncKey).toBe(identity.syncKey);
	});

	it('activates a profile by pointing the window at its namespace', async () => {
		const store = new SyncStore();
		await store.ensureProfilesLoaded();
		const profile = keyringEntry(createSyncIdentity().syncKey, 'Side', 2);
		await store.addKeyringEntry(profile);

		store.activateProfile(profile);

		expect(store.account?.syncKey).toBe(profile.syncKey);
		expect(store.activeProfile?.id).toBe(profile.id);
		expect(store.activePid).toBe(profile.id);
		expect(localStorage.getItem('gkc-last-active-profile')).toBe(profile.id);
	});

	it('rescues notes stranded in the local namespace by a pre-namespacing upgrade', async () => {
		const stranded = keyringEntry(createSyncIdentity().syncKey, 'Upgraded', 1);
		await saveProfile(stranded);
		localStorage.setItem('gkc-last-active-profile', stranded.id);
		await putNote('device-local', note('pre-upgrade-note'));

		const store = new SyncStore();
		await store.ensureProfilesLoaded();

		expect(store.activeProfile?.id).toBe(stranded.id);
		expect((await getAllNotesMetadata(stranded.id)).map(({ id }) => id)).toEqual([
			'pre-upgrade-note'
		]);
	});

	it('logout keeps the signed-out profile\u2019s notes under the local namespace', async () => {
		const active = keyringEntry(createSyncIdentity().syncKey, 'Main', 1);
		await saveProfile(active);
		const store = new SyncStore();
		await store.ensureProfilesLoaded();
		store.profiles = [active];
		store.account = identityFromSyncKey(active.syncKey);
		await putNote(active.id, note('kept-after-unlink'));

		await store.logout();

		expect(store.account).toBeNull();
		expect((await getAllNotesMetadata('device-local')).map(({ id }) => id)).toEqual([
			'kept-after-unlink'
		]);
	});

	it('keeps the active profile and key retryable when unlink storage fails', async () => {
		const active = keyringEntry(createSyncIdentity().syncKey, 'Main', 1);
		await saveProfile(active);
		const store = new SyncStore();
		await store.ensureProfilesLoaded();
		store.profiles = [active];
		store.account = identityFromSyncKey(active.syncKey);
		await putNote(active.id, note('must-survive'));
		vi.spyOn(idb, 'unlinkProfileToNamespace').mockRejectedValueOnce(
			new Error('IndexedDB transaction aborted')
		);

		const result = await store.logout();

		expect(result).toMatchObject({ success: false });
		expect(store.account?.syncKey).toBe(active.syncKey);
		expect((await loadProfiles()).map(({ id }) => id)).toContain(active.id);
		expect((await getAllNotesMetadata(active.id)).map(({ id }) => id)).toEqual(['must-survive']);
	});

	it('rescues label-only pre-upgrade installs, not just notes', async () => {
		const stranded = keyringEntry(createSyncIdentity().syncKey, 'Upgraded', 1);
		await saveProfile(stranded);
		localStorage.setItem('gkc-last-active-profile', stranded.id);
		await putLabel('device-local', {
			id: 'label-1',
			name: 'Work',
			createdAt: 1,
			updatedAt: 1
		});

		const store = new SyncStore();
		await store.ensureProfilesLoaded();

		expect((await getAllLabels(stranded.id)).map(({ name }) => name)).toEqual(['Work']);
	});

	it('pairing an already-saved key never replaces its namespace from the relay', async () => {
		vi.spyOn(notesStore, 'replaceWithCloudManual').mockResolvedValue(true);
		vi.spyOn(notesStore, 'syncWithCloudManual').mockResolvedValue(true);
		const first = keyringEntry(createSyncIdentity().syncKey, 'First', 1);
		const second = keyringEntry(createSyncIdentity().syncKey, 'Second', 2);
		syncStore.profiles = [first, second];
		syncStore.account = identityFromSyncKey(first.syncKey);
		await putNote(second.id, note('offline-edit'));

		const adopted = await profileCoordinator.receiveLinkedKey(second.syncKey);
		expect(adopted.outcome).toBe('linked');
		// Offline changes survive; incremental sync runs, replacement does not.
		expect((await getAllNotesMetadata(second.id)).map(({ id }) => id)).toEqual(['offline-edit']);
		expect(notesStore.replaceWithCloudManual).not.toHaveBeenCalled();
		expect(notesStore.syncWithCloudManual).toHaveBeenCalled();
	});

	it('reports a failed normal sync while pairing an already-saved key', async () => {
		vi.spyOn(notesStore, 'replaceWithCloudManual').mockResolvedValue(true);
		vi.spyOn(notesStore, 'syncWithCloudManual').mockImplementation(async () => {
			syncStore.lastError = 'Relay unavailable';
			return false;
		});
		const first = keyringEntry(createSyncIdentity().syncKey, 'First', 1);
		const second = keyringEntry(createSyncIdentity().syncKey, 'Second', 2);
		syncStore.profiles = [first, second];
		syncStore.account = identityFromSyncKey(first.syncKey);

		const adopted = await profileCoordinator.receiveLinkedKey(second.syncKey);

		expect(adopted).toMatchObject({ outcome: 'choice', error: 'Relay unavailable' });
		expect(notesStore.replaceWithCloudManual).not.toHaveBeenCalled();
	});

	it('renaming an inactive profile queues its encrypted name record for next activation', async () => {
		const inactive = keyringEntry(createSyncIdentity().syncKey, 'Inactive', 2);
		syncStore.profiles = [keyringEntry(createSyncIdentity().syncKey, 'Main', 1), inactive];
		syncStore.account = identityFromSyncKey(
			keyringEntry(createSyncIdentity().syncKey, 'Main', 1).syncKey
		);

		await syncStore.renameProfile(inactive.id, 'Renamed');
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(await getSyncOutboxKeys(inactive.id)).toContain('profile-meta');
	});

	it('logout removes the keyring entry of the signed-out key', async () => {
		const active = keyringEntry(createSyncIdentity().syncKey, 'Main', 1);
		const kept = keyringEntry(createSyncIdentity().syncKey, 'Kept', 2);
		await saveProfile(active);
		await saveProfile(kept);
		const store = new SyncStore();
		await store.ensureProfilesLoaded();
		store.profiles = [active, kept];
		store.account = identityFromSyncKey(active.syncKey);

		await store.logout();

		expect(store.account).toBeNull();
		expect((await loadProfiles()).map(({ id }) => id)).toEqual([kept.id]);
	});
});

describe('profile switching (namespaced)', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
		vi.spyOn(notesStore, 'syncWithCloudManual').mockResolvedValue(true);
		syncStore.account = null;
		syncStore.profiles = [];
	});

	it('swaps namespaces without copying data and keeps both datasets intact', async () => {
		const first = keyringEntry(createSyncIdentity().syncKey, 'First', 1);
		const second = keyringEntry(createSyncIdentity().syncKey, 'Second', 2);
		syncStore.profiles = [first, second];
		syncStore.account = identityFromSyncKey(first.syncKey);
		await putNote(first.id, note('first-note'));
		await putNote(second.id, note('second-note'));

		const switched = await profileCoordinator.switchTo(second.id);
		expect(switched.success, switched.error).toBe(true);
		expect(syncStore.activeProfile?.id).toBe(second.id);
		expect((await getAllNotesMetadata(second.id)).map(({ id }) => id)).toEqual(['second-note']);
		expect((await getAllNotesMetadata(first.id)).map(({ id }) => id)).toEqual(['first-note']);

		const back = await profileCoordinator.switchTo(first.id);
		expect(back.success, back.error).toBe(true);
		expect(notesStore.notes.map(({ id }) => id)).toEqual(['first-note']);
	});

	it('pending uploads stay parked in their own namespace until that profile returns', async () => {
		const first = keyringEntry(createSyncIdentity().syncKey, 'First', 1);
		const second = keyringEntry(createSyncIdentity().syncKey, 'Second', 2);
		syncStore.profiles = [first, second];
		syncStore.account = identityFromSyncKey(first.syncKey);
		await markSyncOutbox(first.id, ['note:first-note']);

		await profileCoordinator.switchTo(second.id);
		await new Promise((resolve) => setTimeout(resolve, 0)); // let queued writes land
		// Activation queues the encrypted profile-name record; hydration of the
		// default board may also mark itself dirty.
		expect(await getSyncOutboxKeys(second.id)).toContain('profile-meta');

		await profileCoordinator.switchTo(first.id);
		expect(await getSyncOutboxKeys(first.id)).toContain('note:first-note');
	});

	it('refuses to switch while a sync flight is running and allows it once finished', async () => {
		const first = keyringEntry(createSyncIdentity().syncKey, 'First', 1);
		const second = keyringEntry(createSyncIdentity().syncKey, 'Second', 2);
		syncStore.profiles = [first, second];
		syncStore.account = identityFromSyncKey(first.syncKey);
		await putNote(first.id, note('first-note'));

		const fakeFlight = Promise.resolve(true);
		(notesStore as unknown as { syncFlight: Promise<boolean> | null }).syncFlight = fakeFlight;
		expect(notesStore.syncing).toBe(true);
		const blocked = await profileCoordinator.switchTo(second.id);
		expect(blocked.success).toBe(false);
		expect(blocked.error).toMatch(/sync/i);

		(notesStore as unknown as { syncFlight: Promise<boolean> | null }).syncFlight = null;
		const switched = await profileCoordinator.switchTo(second.id);
		expect(switched.success, switched.error).toBe(true);
		expect(syncStore.activeProfile?.id).toBe(second.id);
	});

	it('releases the web lock before syncing the activated profile', async () => {
		const first = keyringEntry(createSyncIdentity().syncKey, 'First', 1);
		const second = keyringEntry(createSyncIdentity().syncKey, 'Second', 2);
		syncStore.profiles = [first, second];
		syncStore.account = identityFromSyncKey(first.syncKey);
		let held = false;
		const request = vi.fn(async (_name: string, run: () => Promise<unknown>) => {
			if (held) throw new Error('Web Lock requested recursively');
			held = true;
			try {
				return await run();
			} finally {
				held = false;
			}
		});
		Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
		vi.spyOn(notesStore, 'syncWithCloudManual').mockImplementation(() =>
			navigator.locks.request(SYNC_LOCK, async () => true)
		);

		try {
			const switched = await profileCoordinator.switchTo(second.id);

			expect(switched.success, switched.error).toBe(true);
			expect(syncStore.activeProfile?.id).toBe(second.id);
			expect(profileCoordinator.switching).toBe(false);

			const switchedBack = await profileCoordinator.switchTo(first.id);
			expect(switchedBack.success, switchedBack.error).toBe(true);
			expect(syncStore.activeProfile?.id).toBe(first.id);
			expect(profileCoordinator.switching).toBe(false);
			expect(request).toHaveBeenCalledTimes(4);
		} finally {
			Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
		}
	});

	it('starts a freshly created key with no notes while the previous dataset stays in place', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({}) }))
		);
		const existing = keyringEntry(createSyncIdentity().syncKey, 'First', 1);
		syncStore.profiles = [existing];
		syncStore.account = identityFromSyncKey(existing.syncKey);
		await putNote(existing.id, note('kept-note'));

		const result = await profileCoordinator.create('Fresh');
		expect(result.success, result.error).toBe(true);
		expect(syncStore.activeProfile?.name).toBe('Fresh');
		expect(await getAllNotesMetadata(syncStore.activePid)).toEqual([]);
		expect((await getAllNotesMetadata(existing.id)).map(({ id }) => id)).toEqual(['kept-note']);
	});

	it('keeps local notes when creating the very first key so they upload to it', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({}) }))
		);
		localStorage.clear();
		await putNote('device-local', note('existing-note'));

		const result = await profileCoordinator.create('Main');
		expect(result.success, result.error).toBe(true);
		expect(syncStore.activeProfile?.name).toBe('Main');
		expect((await getAllNotesMetadata(syncStore.activePid)).map(({ id }) => id)).toEqual([
			'existing-note'
		]);
	});
});

describe('synced profile name', () => {
	it('uploads a renamed profile as an encrypted record and adopts incoming names', async () => {
		const identity = createSyncIdentity();
		const profile = keyringEntry(identity.syncKey, 'Original', 1);
		const store = new SyncStore();
		await store.ensureProfilesLoaded();
		await store.addKeyringEntry(profile);
		store.account = identityFromSyncKey(profile.syncKey);

		type Request = { envelopes: Array<{ ciphertext: string }> };
		const requests: Request[] = [];
		vi.spyOn(
			store as unknown as {
				sendSyncRequest(path: string, payload: string): Promise<unknown>;
			},
			'sendSyncRequest'
		).mockImplementation(async (_path, payload) => {
			requests.push(JSON.parse(payload) as Request);
			return {
				success: true,
				data: { cursor: requests.length, envelopes: [], hasMore: false, writesAccepted: true }
			};
		});

		await store.renameProfile(profile.id, 'Renamed locally');
		await store.waitForOutboxWrites();
		const uploaded = await store.sync(
			[],
			[],
			{},
			{},
			[],
			{},
			false,
			false,
			async (snapshot) => snapshot
		);
		expect(uploaded.success, uploaded.error).toBe(true);

		const metaEnvelope = requests
			.flatMap((request) => request.envelopes)
			.map(
				(envelope) =>
					decryptSyncPayload(identity.syncKey, envelope.ciphertext) as {
						kind?: string;
						value?: { name?: string };
					}
			)
			.find((payload) => payload.kind === 'profile-meta');
		expect(metaEnvelope?.value?.name).toBe('Renamed locally');

		// An incoming encrypted name record updates the local label.
		const peerKey = createSyncIdentity();
		void peerKey;
		const incomingName = 'Renamed elsewhere';
		const ciphertext = (await import('$lib/syncPairing')).encryptSyncPayload(identity.syncKey, {
			kind: 'profile-meta',
			value: { name: incomingName }
		});
		vi.spyOn(
			store as unknown as {
				sendSyncRequest(path: string, payload: string): Promise<unknown>;
			},
			'sendSyncRequest'
		).mockImplementation(async (_path, payload) => {
			const request = JSON.parse(payload) as { cursor: number };
			return {
				success: true,
				data: {
					cursor: request.cursor + 1,
					envelopes: [{ id: 'meta-1', slot: 's'.repeat(64), seq: 1, ciphertext }],
					hasMore: false,
					writesAccepted: true
				}
			};
		});
		const pulled = await store.sync(
			[],
			[],
			{},
			{},
			[],
			{},
			false,
			true,
			async (snapshot) => snapshot
		);
		expect(pulled.success, pulled.error).toBe(true);
		expect(store.profiles.find((entry) => entry.id === profile.id)?.name).toBe(incomingName);
	});
});
