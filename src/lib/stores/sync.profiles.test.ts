import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncIdentity, identityFromSyncKey } from '$lib/syncPairing';
import { getAllNotesMetadata, getStashedDataset, putNote, putStashedDataset } from '$lib/db/idb';
import { loadProfiles, saveProfile } from '$lib/profiles';
import type { StoredProfile } from '$lib/profiles';
import type { Note } from '$lib/types';
import { syncStore, SyncStore } from './sync.svelte';
import { notesStore } from './notes.svelte';
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
	});

	it('registers a new key as a saved profile without switching the active account', async () => {
		const identity = createSyncIdentity();
		localStorage.setItem(
			'gkc-sync-account',
			JSON.stringify({ syncKey: identity.syncKey, pairingCode: '' })
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({}) }))
		);

		const store = new SyncStore();
		await store.ensureProfilesLoaded();
		const result = await store.register('Work');

		expect(result.success).toBe(true);
		expect(result.profile?.name).toBe('Work');
		expect((await loadProfiles()).map(({ name }) => name).sort()).toEqual(['Sync key', 'Work']);
		expect(store.account?.syncKey).toBe(identity.syncKey);
	});

	it('activates a saved profile and mirrors it for fast boot', async () => {
		const store = new SyncStore();
		await store.ensureProfilesLoaded();
		const profile = keyringEntry(createSyncIdentity().syncKey, 'Side', 2);
		await store.addKeyringEntry(profile);

		store.activateProfile(profile);

		expect(store.account?.syncKey).toBe(profile.syncKey);
		expect(store.activeProfile?.id).toBe(profile.id);
		expect(JSON.parse(localStorage.getItem('gkc-sync-account') ?? '{}').syncKey).toBe(
			profile.syncKey
		);
	});

	it('renames a saved profile locally only', async () => {
		const store = new SyncStore();
		await store.ensureProfilesLoaded();
		const profile = keyringEntry(createSyncIdentity().syncKey, 'Side', 1);
		await store.addKeyringEntry(profile);

		const renamed = await store.renameProfile(profile.id, '  Personal  ');

		expect(renamed?.name).toBe('Personal');
		expect((await loadProfiles())[0]?.name).toBe('Personal');
	});

	it('refuses to remove the active profile but removes inactive ones with their stash', async () => {
		const active = keyringEntry(createSyncIdentity().syncKey, 'Main', 1);
		const other = keyringEntry(createSyncIdentity().syncKey, 'Other', 2);
		await saveProfile(active);
		await saveProfile(other);
		syncStore.profiles = [active, other];
		syncStore.account = identityFromSyncKey(active.syncKey);
		await putStashedDataset({
			pid: other.id,
			savedAt: 1,
			notes: [note('n')],
			labels: [],
			imageBlobs: [],
			noteTombstones: {},
			labelTombstones: {},
			boardTombstones: {},
			boards: [],
			firedReminderKeys: [],
			outboxKeys: []
		});

		expect(await syncStore.removeProfile(active.id)).toBe(false);
		expect(await syncStore.removeProfile(other.id)).toBe(true);
		expect(await getStashedDataset(other.id)).toBeNull();
		expect(await loadProfiles()).toEqual([active]);
	});

	it('logout removes the keyring entry of the signed-out key', async () => {
		const active = keyringEntry(createSyncIdentity().syncKey, 'Main', 1);
		const kept = keyringEntry(createSyncIdentity().syncKey, 'Kept', 2);
		await saveProfile(active);
		await saveProfile(kept);
		syncStore.profiles = [active, kept];
		syncStore.account = identityFromSyncKey(active.syncKey);

		await syncStore.logout();

		expect(syncStore.account).toBeNull();
		expect((await loadProfiles()).map(({ id }) => id)).toEqual([kept.id]);
	});
});

describe('profile switching', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
		vi.spyOn(notesStore, 'syncWithCloudManual').mockResolvedValue(true);
		syncStore.account = null;
		syncStore.profiles = [];
	});

	it('stashes the outgoing dataset, reinstates the target one, and switches back intact', async () => {
		const first = keyringEntry(createSyncIdentity().syncKey, 'First', 1);
		const second = keyringEntry(createSyncIdentity().syncKey, 'Second', 2);
		syncStore.profiles = [first, second];
		syncStore.account = identityFromSyncKey(first.syncKey);
		await putNote(note('first-note'));
		await putStashedDataset({
			pid: second.id,
			savedAt: 1,
			notes: [note('second-note')],
			labels: [],
			imageBlobs: [],
			noteTombstones: {},
			labelTombstones: {},
			boardTombstones: {},
			boards: [],
			firedReminderKeys: [],
			outboxKeys: []
		});

		const switched = await profileCoordinator.switchTo(second.id);
		expect(switched.success, switched.error).toBe(true);
		expect(syncStore.activeProfile?.id).toBe(second.id);
		expect((await getAllNotesMetadata()).map(({ id }) => id)).toEqual(['second-note']);
		expect(await getStashedDataset(second.id)).toBeNull();

		const back = await profileCoordinator.switchTo(first.id);
		expect(back.success, back.error).toBe(true);
		expect((await getAllNotesMetadata()).map(({ id }) => id)).toEqual(['first-note']);
		expect(await getStashedDataset(first.id)).toBeNull();
	});

	it('refuses to switch while a sync flight is running and allows it once finished', async () => {
		const first = keyringEntry(createSyncIdentity().syncKey, 'First', 1);
		const second = keyringEntry(createSyncIdentity().syncKey, 'Second', 2);
		syncStore.profiles = [first, second];
		syncStore.account = identityFromSyncKey(first.syncKey);
		await putNote(note('first-note'));

		const fakeFlight = Promise.resolve(true);
		(notesStore as unknown as { syncFlight: Promise<boolean> | null }).syncFlight = fakeFlight;
		expect(notesStore.syncing).toBe(true);
		const blocked = await profileCoordinator.switchTo(second.id);
		expect(blocked.success).toBe(false);
		expect(blocked.error).toMatch(/sync/i);

		(notesStore as unknown as { syncFlight: Promise<boolean> | null }).syncFlight = null;
		await putStashedDataset({
			pid: second.id,
			savedAt: 1,
			notes: [note('second-note')],
			labels: [],
			imageBlobs: [],
			noteTombstones: {},
			labelTombstones: {},
			boardTombstones: {},
			boards: [],
			firedReminderKeys: [],
			outboxKeys: []
		});
		const switched = await profileCoordinator.switchTo(second.id);
		expect(switched.success, switched.error).toBe(true);
		expect(syncStore.activeProfile?.id).toBe(second.id);
	});

	it('starts a freshly created key with no notes while the previous dataset stays parked', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({}) }))
		);
		const existing = keyringEntry(createSyncIdentity().syncKey, 'First', 1);
		syncStore.profiles = [existing];
		syncStore.account = identityFromSyncKey(existing.syncKey);
		await putNote(note('kept-note'));

		const result = await profileCoordinator.create('Fresh');
		expect(result.success, result.error).toBe(true);
		expect(syncStore.activeProfile?.name).toBe('Fresh');
		expect(await getAllNotesMetadata()).toEqual([]);
		expect((await getStashedDataset(existing.id))?.notes.map(({ id }) => id)).toEqual([
			'kept-note'
		]);
	});

	it('keeps local notes when creating the very first key so they upload to it', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({}) }))
		);
		localStorage.clear();
		await putNote(note('existing-note'));

		const result = await profileCoordinator.create('Main');
		expect(result.success, result.error).toBe(true);
		expect(syncStore.activeProfile?.name).toBe('Main');
		expect((await getAllNotesMetadata()).map(({ id }) => id)).toEqual(['existing-note']);
	});
});
