import { describe, expect, it, vi } from 'vitest';
import { canonicalizeSyncNote } from './canonicalImages';
import type { SyncNote } from './syncMerge';

function dngDataUrl(): string {
	const jpeg = Uint8Array.from([
		0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xd0, 0x0f, 0xc0, 0x03, 0x01, 0x11, 0x00, 0x02,
		0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9
	]);
	const jpegOffset = 38;
	const bytes = new Uint8Array(jpegOffset + jpeg.length);
	const view = new DataView(bytes.buffer);
	bytes.set([0x49, 0x49], 0);
	view.setUint16(2, 42, true);
	view.setUint32(4, 8, true);
	view.setUint16(8, 2, true);
	view.setUint16(10, 513, true);
	view.setUint16(12, 4, true);
	view.setUint32(14, 1, true);
	view.setUint32(18, jpegOffset, true);
	view.setUint16(22, 514, true);
	view.setUint16(24, 4, true);
	view.setUint32(26, 1, true);
	view.setUint32(30, jpeg.length, true);
	bytes.set(jpeg, jpegOffset);
	return `data:image/dng;base64,${Buffer.from(bytes).toString('base64')}`;
}

function note(dataUrl: string, mime: string, name: string): SyncNote {
	return {
		id: 'note-1',
		title: '',
		body: '',
		color: 'default',
		pinned: false,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 1,
		updatedAt: 10,
		reminder: null,
		labels: [],
		images: [{ id: 'image-1', mime, name, createdAt: 1, dataUrl }]
	} as SyncNote;
}

describe('canonicalizeSyncNote', () => {
	it('converts incoming DNG payloads before cloud storage', () => {
		const now = vi.spyOn(Date, 'now').mockReturnValue(100);
		const result = canonicalizeSyncNote(note(dngDataUrl(), 'image/dng', 'IMG_0012.dng'));
		now.mockRestore();
		const image = (result.note.images as Array<{ mime: string; name: string; dataUrl: string }>)[0];
		expect(result.changed).toBe(true);
		expect(result.note.updatedAt).toBe(100);
		expect(image.mime).toBe('image/jpeg');
		expect(image.name).toBe('IMG_0012.jpg');
		expect(image.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
	});

	it('leaves canonical images untouched', () => {
		const original = note('data:image/jpeg;base64,/9j/2Q==', 'image/jpeg', 'photo.jpg');
		const result = canonicalizeSyncNote(original);
		expect(result).toEqual({ note: original, changed: false });
	});
});
