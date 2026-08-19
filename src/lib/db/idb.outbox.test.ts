import { describe, expect, it } from 'vitest';
import type { Note } from '$lib/types';
import {
	clearSyncOutbox,
	commitSyncControl,
	getAllNotesMetadata,
	getSyncOutboxKeys,
	getSyncState,
	hydrateNoteAttachments,
	markSyncOutbox,
	putNote,
	setSyncState
} from './idb';

function note(title: string): Note {
	return {
		id: 'atomic-note',
		title,
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

describe('durable sync outbox', () => {
	it('stores a note that the next case must not see', async () => {
		await putNote(note('isolation-note'));
		expect((await getAllNotesMetadata()).map(({ title }) => title)).toEqual(['isolation-note']);
	});

	it('starts the next case with an empty database', async () => {
		expect(await getAllNotesMetadata()).toEqual([]);
	});

	it('deduplicates keys and clears only acknowledged generations', async () => {
		await markSyncOutbox(['note:one', 'note:one', 'label:two']);
		expect((await getSyncOutboxKeys()).sort()).toEqual(['label:two', 'note:one']);

		await clearSyncOutbox(['note:one'], 0);
		expect((await getSyncOutboxKeys()).sort()).toEqual(['label:two', 'note:one']);

		await clearSyncOutbox(['note:one', 'label:two']);
		expect(await getSyncOutboxKeys()).toEqual([]);
	});

	it('clears an internally marked generation without clearing a later edit', async () => {
		await markSyncOutbox(['note:one'], 100);
		await clearSyncOutbox(['note:one'], 99);
		expect(await getSyncOutboxKeys()).toEqual(['note:one']);

		await markSyncOutbox(['note:one'], 200);
		await clearSyncOutbox(['note:one'], 100);
		expect(await getSyncOutboxKeys()).toEqual(['note:one']);

		await clearSyncOutbox(['note:one'], 200);
		expect(await getSyncOutboxKeys()).toEqual([]);
	});

	it('rolls back cursor and outbox changes together when a control write fails', async () => {
		await setSyncState('test-cursor', 4);
		await markSyncOutbox(['note:atomic'], 100);

		await expect(
			commitSyncControl(
				[
					['test-cursor', 5],
					['uncloneable-value', () => undefined]
				],
				[{ keys: ['note:atomic'], through: 100 }]
			)
		).rejects.toThrow();

		expect(await getSyncState('test-cursor')).toBe(4);
		expect(await getSyncOutboxKeys()).toEqual(['note:atomic']);
	});

	it('commits a note and its outbox marker together or rolls both back', async () => {
		await clearSyncOutbox(await getSyncOutboxKeys());
		await putNote(note('before'));

		await putNote(note('saved'), ['note:atomic-note', 'note:atomic-note']);
		expect((await getAllNotesMetadata()).find(({ id }) => id === 'atomic-note')?.title).toBe(
			'saved'
		);
		expect(await getSyncOutboxKeys()).toEqual(['note:atomic-note']);

		await clearSyncOutbox(['note:atomic-note']);
		await expect(
			putNote(note('must roll back'), [Number.NaN as unknown as string])
		).rejects.toThrow();
		expect((await getAllNotesMetadata()).find(({ id }) => id === 'atomic-note')?.title).toBe(
			'saved'
		);
		expect(await getSyncOutboxKeys()).toEqual([]);
	});

	it('keeps photo blobs after a later metadata-only save', async () => {
		const withPhoto = {
			...note('photo'),
			id: 'photo-note',
			images: [
				{
					id: 'pic',
					mime: 'image/png',
					dataUrl: 'data:image/png;base64,QQ==',
					createdAt: 1,
					contentHash: 'hash-pic'
				}
			]
		};
		await putNote(withPhoto, ['note:photo-note', 'attachment:pic']);
		await putNote(
			{
				...withPhoto,
				title: 'metadata only',
				images: [{ ...withPhoto.images[0], dataUrl: '' }]
			},
			['note:photo-note']
		);
		const hydrated = await hydrateNoteAttachments(
			(await getAllNotesMetadata()).find((item) => item.id === 'photo-note')!
		);
		expect(hydrated.images[0]?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
	});
});
