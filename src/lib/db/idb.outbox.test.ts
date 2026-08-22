const PID = 'device-local';
import { describe, expect, it, vi } from 'vitest';
import type { Note } from '$lib/types';
import {
	clearSyncOutbox,
	commitSyncControl,
	getAllNotesMetadata,
	getSyncOutboxKeys,
	getSyncState,
	getOutboxGeneration,
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
		await putNote(PID, note('isolation-note'));
		expect((await getAllNotesMetadata(PID)).map(({ title }) => title)).toEqual(['isolation-note']);
	});

	it('starts the next case with an empty database', async () => {
		expect(await getAllNotesMetadata(PID)).toEqual([]);
	});

	it('deduplicates keys and clears only acknowledged generations', async () => {
		await markSyncOutbox(PID, ['note:one', 'note:one', 'label:two']);
		expect((await getSyncOutboxKeys(PID)).sort()).toEqual(['label:two', 'note:one']);

		await clearSyncOutbox(PID, ['note:one'], 0);
		expect((await getSyncOutboxKeys(PID)).sort()).toEqual(['label:two', 'note:one']);

		await clearSyncOutbox(PID, ['note:one', 'label:two']);
		expect(await getSyncOutboxKeys(PID)).toEqual([]);
	});

	it('clears an internally marked generation without clearing a later edit', async () => {
		const first = await markSyncOutbox(PID, ['note:one']);
		await clearSyncOutbox(PID, ['note:one'], first - 1);
		expect(await getSyncOutboxKeys(PID)).toEqual(['note:one']);

		const second = await markSyncOutbox(PID, ['note:one']);
		await clearSyncOutbox(PID, ['note:one'], first);
		expect(await getSyncOutboxKeys(PID)).toEqual(['note:one']);

		await clearSyncOutbox(PID, ['note:one'], second);
		expect(await getSyncOutboxKeys(PID)).toEqual([]);
	});

	it('allocates strictly increasing generations even when the clock jumps backward', async () => {
		const realNow = Date.now;
		vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
		const first = await markSyncOutbox(PID, ['note:a']);
		Date.now = () => 500;
		const second = await markSyncOutbox(PID, ['note:b']);
		Date.now = realNow;

		expect(second).toBeGreaterThan(first);
		expect(await getOutboxGeneration()).toBe(second);
	});

	it('rolls back cursor and outbox changes together when a control write fails', async () => {
		await setSyncState('test-cursor', 4);
		const marked = await markSyncOutbox(PID, [`note:atomic`]);

		await expect(
			commitSyncControl(
				PID,
				[
					['test-cursor', 5],
					['uncloneable-value', () => undefined]
				],
				[{ keys: ['note:atomic'], through: marked }]
			)
		).rejects.toThrow();

		expect(await getSyncState('test-cursor')).toBe(4);
		expect(await getSyncOutboxKeys(PID)).toEqual(['note:atomic']);
	});

	it('commits a note and its outbox marker together or rolls both back', async () => {
		await clearSyncOutbox(PID, await getSyncOutboxKeys(PID));
		await putNote(PID, note('before'));

		await putNote(PID, note('saved'), ['note:atomic-note', 'note:atomic-note']);
		expect((await getAllNotesMetadata(PID)).find(({ id }) => id === 'atomic-note')?.title).toBe(
			'saved'
		);
		expect(await getSyncOutboxKeys(PID)).toEqual(['note:atomic-note']);

		await clearSyncOutbox(PID, ['note:atomic-note']);
		await expect(
			putNote(PID, note('must roll back'), [Number.NaN as unknown as string])
		).rejects.toThrow();
		expect((await getAllNotesMetadata(PID)).find(({ id }) => id === 'atomic-note')?.title).toBe(
			'saved'
		);
		expect(await getSyncOutboxKeys(PID)).toEqual([]);
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
		await putNote(PID, withPhoto, ['note:photo-note', 'attachment:pic']);
		await putNote(
			PID,
			{
				...withPhoto,
				title: 'metadata only',
				images: [{ ...withPhoto.images[0], dataUrl: '' }]
			},
			['note:photo-note']
		);
		const hydrated = await hydrateNoteAttachments(
			PID,
			(await getAllNotesMetadata(PID)).find((item) => item.id === 'photo-note')!
		);
		expect(hydrated.images?.[0]?.dataUrl?.startsWith('data:image/png;base64,')).toBe(true);
	});

	it('keeps existing photo blobs when a replacement note has no bytes yet', async () => {
		const withPhoto = {
			...note('photo'),
			id: 'photo-note',
			images: [
				{
					id: 'old',
					mime: 'image/png',
					dataUrl: 'data:image/png;base64,QQ==',
					createdAt: 1,
					contentHash: 'hash-old'
				}
			]
		};
		await putNote(PID, withPhoto);
		await putNote(PID, {
			...withPhoto,
			images: [
				{
					id: 'new',
					mime: 'image/png',
					dataUrl: '',
					createdAt: 2,
					contentHash: 'hash-new'
				}
			]
		});
		const metadata = (await getAllNotesMetadata(PID)).find((item) => item.id === 'photo-note')!;
		const hydrated = await hydrateNoteAttachments(PID, {
			...metadata,
			images: withPhoto.images.map((image) => ({ ...image, dataUrl: '' }))
		});
		expect(hydrated.images?.[0]?.dataUrl?.startsWith('data:image/png;base64,')).toBe(true);
	});
});
