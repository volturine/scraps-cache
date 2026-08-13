import { describe, expect, it } from 'vitest';
import {
	approximatePayloadBytes,
	buildSyncRecords,
	changedRecords,
	fingerprintMap,
	hydrateNoteImages,
	legacySnapshotPayloads,
	splitNoteForSync
} from './syncRecords';
import type { Note, NoteImage } from './types';

function image(id: string, dataUrl: string): NoteImage {
	return { id, name: `${id}.jpg`, mime: 'image/jpeg', dataUrl, createdAt: 1 };
}

function note(id: string, updatedAt: number, body = '', images: NoteImage[] = []): Note {
	return {
		id,
		title: id,
		body,
		color: 'default',
		pinned: false,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 1,
		updatedAt,
		reminder: null,
		labels: [],
		...(images.length ? { images } : {})
	};
}

describe('opaque per-record sync payloads', () => {
	it('sends no payloads for an unchanged established device', async () => {
		const records = await buildSyncRecords([note('one', 1, 'photo-free text')], [], []);
		expect(changedRecords(records, fingerprintMap(records))).toEqual([]);
	});

	it('selects exactly the changed note rather than every note', async () => {
		const before = await buildSyncRecords([note('one', 1), note('two', 1)], [], []);
		const after = await buildSyncRecords([note('one', 2, 'edited'), note('two', 1)], [], []);
		expect(changedRecords(after, fingerprintMap(before)).map((record) => record.key)).toEqual([
			'note:one'
		]);
	});

	it('sends a tombstone without re-sending its stale deleted record', async () => {
		const records = await buildSyncRecords([note('gone', 10)], [], [], { gone: 20 });
		expect(records.map((record) => record.key)).toEqual(['note-tombstone:gone']);
	});

	it('stores each photo as its own attachment record and keeps only a ref on the note', async () => {
		const photo = image('pic', `data:image/jpeg;base64,${'A'.repeat(20_000)}`);
		const records = await buildSyncRecords([note('n1', 1, 'has photo', [photo])], [], []);
		expect(records.map((record) => record.key).sort()).toEqual(['attachment:pic', 'note:n1']);
		const notePayload = records.find((record) => record.key === 'note:n1')!.payload;
		expect(notePayload.kind).toBe('note');
		if (notePayload.kind === 'note') {
			expect(JSON.stringify(notePayload).includes(photo.dataUrl)).toBe(false);
			expect(notePayload.value.images?.[0]).toMatchObject({ id: 'pic', hash: expect.any(String) });
		}
	});

	it('title-only edits upload the small note, not the photo bytes again', async () => {
		const photo = image('pic', `data:image/jpeg;base64,${'B'.repeat(50_000)}`);
		const before = await buildSyncRecords([note('n1', 1, 'old title', [photo])], [], []);
		const after = await buildSyncRecords([note('n1', 2, 'new title', [photo])], [], []);
		const changed = changedRecords(after, fingerprintMap(before));
		expect(changed.map((record) => record.key)).toEqual(['note:n1']);
		expect(approximatePayloadBytes(changed)).toBeLessThan(2_000);
		expect(approximatePayloadBytes(changed)).toBeLessThan(photo.dataUrl.length / 10);
	});

	it('new photos upload as attachment records once', async () => {
		const photo = image('pic', `data:image/jpeg;base64,${'C'.repeat(10_000)}`);
		const before = await buildSyncRecords([note('n1', 1, 'plain')], [], []);
		const after = await buildSyncRecords([note('n1', 2, 'plain', [photo])], [], []);
		const changed = changedRecords(after, fingerprintMap(before))
			.map((record) => record.key)
			.sort();
		expect(changed).toEqual(['attachment:pic', 'note:n1']);
	});

	it('hydrates a ref-only note from the global attachment map', async () => {
		const photo = image('pic', 'data:image/jpeg;base64,abc');
		const split = await splitNoteForSync(note('n1', 1, 'x', [photo]));
		const attachments = new Map([[photo.id, photo]]);
		expect(hydrateNoteImages(split.note, attachments).images?.[0]?.dataUrl).toBe(photo.dataUrl);
	});

	it('keeps attachment references while full bytes are evicted from memory', async () => {
		const full = image('pic', 'data:image/jpeg;base64,abc');
		const hash = (await splitNoteForSync(note('source', 1, '', [full]))).note.images?.[0]?.hash;
		const placeholder = { ...full, dataUrl: '', contentHash: hash };
		const split = await splitNoteForSync(note('source', 2, 'edited', [placeholder]));
		expect(split.note.images).toEqual([expect.objectContaining({ id: 'pic', hash })]);
		expect(split.attachments).toEqual([]);
	});

	it('builds only durable outbox keys during an ordinary sync', async () => {
		const records = await buildSyncRecords(
			[note('one', 1), note('two', 1)],
			[],
			[],
			{},
			{},
			{},
			new Set(['note:two'])
		);
		expect(records.map((record) => record.key)).toEqual(['note:two']);
	});

	it('expands legacy inline-photo snapshots into note + attachment records', async () => {
		const photo = image('pic', 'data:image/jpeg;base64,legacy');
		const payloads = await legacySnapshotPayloads({
			notes: [note('old', 10, 'body', [photo])],
			labels: [],
			boards: [],
			tombstones: { deleted: 20 }
		});
		expect(payloads?.map((payload) => payload.kind).sort()).toEqual([
			'attachment',
			'note',
			'note-tombstone'
		]);
	});

	it('keeps a baseline after a no-op merge so the next sync uploads zero bytes', async () => {
		const local = [note('photo', 5, 'x'.repeat(1000))];
		const records = await buildSyncRecords(local, [], []);
		const baseline = fingerprintMap(records);
		expect(changedRecords(await buildSyncRecords(local, [], []), baseline)).toEqual([]);
	});
});
