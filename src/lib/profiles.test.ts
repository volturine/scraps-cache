import { describe, expect, it } from 'vitest';
import type { Label, Note } from '$lib/types';
import {
	clearAllNotes,
	getAllLabels,
	getAllNotesMetadata,
	getStashedDataset,
	getSyncOutboxKeys,
	getSyncState,
	hydrateNoteAttachments,
	markSyncOutbox,
	putNote,
	putLabel,
	replaceLiveCore,
	setFiredReminderKeys,
	FIRED_REMINDERS_KEY,
	type StoredProfile
} from '$lib/db/idb';
import {
	nextProfileName,
	resetDeviceDataset,
	restoreProfileDataset,
	stashProfileDataset,
	dropStashedDataset
} from './profiles';
import { writeTombstones, writeLabelTombstones, BOARDS_IDB } from '$lib/syncTombstones';

function note(id: string, overrides: Partial<Note> = {}): Note {
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
		images: [],
		...overrides
	};
}

function label(id: string): Label {
	return { id, name: `label-${id}`, createdAt: 1, updatedAt: 1 };
}

async function seedLiveDataset(): Promise<void> {
	await putNote(
		note('n1', {
			images: [
				{
					id: 'img-1',
					mime: 'image/png',
					dataUrl: 'data:image/png;base64,QQ==',
					createdAt: 1
				}
			]
		}),
		['note:n1', 'attachment:img-1']
	);
	await putLabel(label('l1'));
	await markSyncOutbox(['note:n1']);
	await writeTombstones({ 'gone-note': 9 });
	await writeLabelTombstones({ 'gone-label': 8 });
	await setFiredReminderKeys(['wake-1']);
}

describe('profile dataset stash', () => {
	it('captures the whole live dataset and restores it after the stores were cleared', async () => {
		await seedLiveDataset();
		await stashProfileDataset('p1');
		await clearAllNotes();

		const extras = await restoreProfileDataset('p1');

		expect(extras).not.toBeNull();
		const notes = await getAllNotesMetadata();
		expect(notes.map(({ id }) => id)).toEqual(['n1']);
		expect((await getAllLabels()).map(({ id }) => id)).toEqual(['l1']);
		// The outbox store is keyed by record key, so keys read back in key order.
		expect(await getSyncOutboxKeys()).toEqual(['attachment:img-1', 'note:n1']);
		expect(extras?.noteTombstones).toEqual({ 'gone-note': 9 });
		expect(extras?.labelTombstones).toEqual({ 'gone-label': 8 });
		expect(extras?.firedReminderKeys).toEqual(['wake-1']);

		// Attachment blobs survive the round trip through the stash.
		const hydrated = await hydrateNoteAttachments(notes[0]);
		expect(hydrated.images?.[0]?.dataUrl).toBe('data:image/png;base64,QQ==');
	});

	it('keeps the stash until it is dropped so a mid-switch crash stays repairable', async () => {
		await seedLiveDataset();
		await stashProfileDataset('p1');

		await restoreProfileDataset('p1');
		expect(await getStashedDataset('p1')).not.toBeNull();

		await dropStashedDataset('p1');
		expect(await restoreProfileDataset('p1')).toBeNull();
	});

	it('restores pending outbox markers so they upload when the profile returns', async () => {
		await seedLiveDataset();
		await stashProfileDataset('p1');
		await resetDeviceDataset();
		expect(await getSyncOutboxKeys()).toEqual([]);

		await restoreProfileDataset('p1');
		expect(await getSyncOutboxKeys()).toEqual(['attachment:img-1', 'note:n1']);
	});

	it('clears every dataset layer for a fresh profile', async () => {
		await seedLiveDataset();
		await stashProfileDataset('p2');
		await resetDeviceDataset();

		expect(await getAllNotesMetadata()).toEqual([]);
		expect(await getAllLabels()).toEqual([]);
		expect(await getSyncOutboxKeys()).toEqual([]);
		expect(await getSyncState(FIRED_REMINDERS_KEY)).toEqual([]);
		expect(await getSyncState(BOARDS_IDB)).toEqual([]);
		expect(await restoreProfileDataset('p2')).not.toBeNull();
	});
});

describe('replaceLiveCore write gate', () => {
	it('drops a note write queued before the replacement instead of committing it after', async () => {
		const stale = putNote(note('stale'));

		await replaceLiveCore({
			notes: [note('fresh')],
			labels: [],
			imageBlobs: [],
			outboxKeys: []
		});
		await stale;

		expect((await getAllNotesMetadata()).map(({ id }) => id)).toEqual(['fresh']);
	});
});

describe('profile naming', () => {
	it('names the first key plainly and numbers later ones', () => {
		expect(nextProfileName([])).toBe('Sync key');
		expect(nextProfileName([{ name: 'Sync key' } as StoredProfile])).toBe('Sync key 2');
		expect(nextProfileName([{ name: 'a' }, { name: 'b' }] as StoredProfile[])).toBe('Sync key 3');
	});
});
