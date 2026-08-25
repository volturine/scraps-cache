import { describe, expect, it } from 'vitest';
import type { Label, Note } from '$lib/types';
import {
	estimateProfileBytes,
	getAllLabels,
	getAllNotesMetadata,
	getFiredReminderKeys,
	getSyncOutboxKeys,
	getSyncState,
	markSyncOutbox,
	putLabel,
	putNote,
	scopedStateKey,
	setFiredReminderKeys
} from '$lib/db/idb';
import {
	adoptLocalDatasetInto,
	buildProfileNotesExport,
	loadProfiles,
	nextProfileName,
	pickBootProfile,
	saveProfile,
	type StoredProfile
} from './profiles';
import {
	hydrateTombstones,
	writeTombstones,
	writeLabelTombstones,
	NOTE_IDB
} from './syncTombstones';

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

function label(id: string): Label {
	return { id, name: `label-${id}`, createdAt: 1, updatedAt: 1 };
}

describe('profile namespaces', () => {
	it('keeps notes, labels, outbox, tombstones, and reminders isolated per profile', async () => {
		await putNote('p-one', note('shared-id'));
		await putNote('p-two', note('other-note'));
		await putLabel('p-one', label('label-1'));
		await markSyncOutbox('p-one', ['note:shared-id']);
		await writeTombstones('p-one', { gone: 5 });
		await setFiredReminderKeys('p-one', ['wake-1']);

		expect((await getAllNotesMetadata('p-one')).map(({ id }) => id)).toEqual(['shared-id']);
		expect((await getAllNotesMetadata('p-two')).map(({ id }) => id)).toEqual(['other-note']);
		expect((await getAllLabels('p-two')).map(({ id }) => id)).toEqual([]);
		expect(await getSyncOutboxKeys('p-two')).toEqual([]);
		expect(await getSyncState(scopedStateKey(NOTE_IDB, 'p-two'))).toBeUndefined();
		expect(await getFiredReminderKeys('p-two')).toEqual([]);
		await hydrateTombstones('p-two');
		expect((await hydrateTombstones('p-two')).notes).toEqual({});
		expect(await getFiredReminderKeys('p-two')).toEqual([]);
	});

	it('moves the whole local no-key dataset when the first sync key adopts it', async () => {
		await putNote('device-local', note('kept'));
		await putLabel('device-local', label('kept-label'));
		await markSyncOutbox('device-local', ['note:kept']);
		await writeTombstones('device-local', { old: 3 });
		await writeLabelTombstones('device-local', { 'old-label': 4 });

		await adoptLocalDatasetInto('p-new');

		const adopted = await getAllNotesMetadata('p-new');
		expect(adopted.map(({ id }) => id)).toEqual(['kept']);
		expect((await getAllLabels('p-new')).map(({ id }) => id)).toEqual(['kept-label']);
		expect(await getSyncOutboxKeys('p-new')).toEqual(['note:kept']);
		await hydrateTombstones('p-new');
		expect(await getSyncState(scopedStateKey(NOTE_IDB, 'p-new'))).toEqual({ old: 3 });
	});
});

describe('per-profile size estimation', () => {
	it('grows with stored notes and stays separate per profile', async () => {
		expect(await estimateProfileBytes('p-empty')).toBe(0);
		await putNote('p-full', note('n1'));
		expect(await estimateProfileBytes('p-full')).toBeGreaterThan(0);
	});
});

describe('single-profile export', () => {
	it('builds a standard backup from one namespace without touching others', async () => {
		await putNote('p-exp', note('exported'));
		await putLabel('p-exp', label('exp-label'));
		await writeTombstones('p-exp', { 'gone-exp': 9 });

		const backup = await buildProfileNotesExport('p-exp');

		expect(backup?.notes.map(({ id }) => id)).toEqual(['exported']);
		expect(backup?.labels.map(({ id }) => id)).toEqual(['exp-label']);
		expect(backup?.tombstones).toEqual({ 'gone-exp': 9 });
		expect(backup?.version).toBe(4);
		expect(await buildProfileNotesExport('p-other')).toBeNull();
	});
});

describe('keyring boot selection', () => {
	it('prefers the pointer, then the first entry, and names later keys by count', () => {
		const first: StoredProfile = {
			id: 'a',
			name: 'First',
			syncKey: 'k-a',
			createdAt: 1
		};
		const second: StoredProfile = { id: 'b', name: 'Second', syncKey: 'k-b', createdAt: 2 };

		localStorage.clear();
		expect(pickBootProfile([first, second])).toBe(first);

		localStorage.setItem('gkc-last-active-profile', 'b');
		expect(pickBootProfile([first, second])).toBe(second);
		expect(nextProfileName([first, second])).toBe('Sync key 3');
		void saveProfile;
		void loadProfiles;
	});
});
