import { describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import {
	DEVICE_DB_NAME,
	getAllNotesMetadata,
	hydrateNoteAttachments,
	pruneOrphanImageBlobs,
	putNote
} from '$lib/db/idb';
import type { Note, NoteImage } from '$lib/types';

function image(id: string, dataUrl: string): NoteImage {
	return {
		id,
		mime: 'image/png',
		dataUrl,
		createdAt: 1,
		contentHash: `hash-${id}`
	};
}

function note(id: string, images: NoteImage[]): Note {
	return {
		id,
		title: id,
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
		images
	};
}

async function storedImageKeys(): Promise<string[]> {
	const db = await openDB(DEVICE_DB_NAME);
	try {
		return (await db.getAllKeys('note-images')).map(String).sort();
	} finally {
		db.close();
	}
}

/**
 * Issue #82: metadata-only writes keep existing blobs by design (crash
 * safety), so a shrunk image list orphans the removed image's bytes. Boot
 * reclaims ownership with a GC sweep over unreferenced keys.
 */
describe('orphaned image blob reclamation', () => {
	it('reclaims blobs no note row references at boot', async () => {
		const original = note('n1', [
			image('kept', 'data:image/png;base64,QQ=='),
			image('gone', 'data:image/png;base64,Qg==')
		]);
		await putNote(original);
		expect(await storedImageKeys()).toEqual(['n1::gone', 'n1::kept']);

		// Crash-recovery style replay: byte-less metadata listing only 'kept'.
		await putNote({
			...original,
			title: 'replayed from mirror',
			images: [image('kept', '')]
		});
		// The write itself must not drop bytes it cannot verify (crash safety).
		expect(await storedImageKeys()).toEqual(['n1::gone', 'n1::kept']);

		await pruneOrphanImageBlobs();

		expect(await storedImageKeys()).toEqual(['n1::kept']);
		const stored = (await getAllNotesMetadata()).find((item) => item.id === 'n1');
		expect(stored?.images?.map(({ id }) => id)).toEqual(['kept']);
		const hydrated = await hydrateNoteAttachments(stored!);
		expect(hydrated.images?.[0]?.dataUrl?.startsWith('data:image/png')).toBe(true);
	});

	it('keeps blobs that are still referenced after recovery reattaches them', async () => {
		await getAllNotesMetadata();
		const db = await openDB(DEVICE_DB_NAME);
		await db.put('note-images', { mime: 'image/png', bytes: Uint8Array.from([65]) }, 'lost::pic');
		db.close();

		const lost = note('lost', [image('pic', '')]);
		await putNote(lost);
		await pruneOrphanImageBlobs();

		expect(await storedImageKeys()).toEqual(['lost::pic']);
	});
});
