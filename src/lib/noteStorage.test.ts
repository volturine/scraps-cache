import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteForLocalStorage, readNotesMirror, writeNotesMirror } from './noteStorage';
import type { Note } from './types';

describe('fast-boot note mirror', () => {
	afterEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it('keeps image refs and drops only the bytes', () => {
		const note: Note = {
			id: 'n1',
			title: 'Photo',
			body: '',
			color: 'default',
			pinned: false,
			archived: false,
			trashed: false,
			trashedAt: null,
			createdAt: 1,
			updatedAt: 2,
			reminder: null,
			labels: [],
			images: [
				{
					id: 'pic',
					mime: 'image/jpeg',
					dataUrl: 'data:image/jpeg;base64,abc',
					contentHash: 'hash',
					createdAt: 1,
					thumbUrl: 'data:image/jpeg;base64,thumb'
				}
			]
		};
		const mirrored = noteForLocalStorage(note);
		expect(mirrored.images).toEqual([
			expect.objectContaining({
				id: 'pic',
				mime: 'image/jpeg',
				contentHash: 'hash',
				thumbUrl: 'data:image/jpeg;base64,thumb'
			})
		]);
		expect(JSON.stringify(mirrored).includes('data:image/jpeg;base64,abc')).toBe(false);
	});

	it('mirrors every note, not a recent subset', () => {
		const notes = Array.from({ length: 51 }, (_, index) => ({
			id: `n${index}`,
			title: `Note ${index}`,
			body: '',
			color: 'default' as const,
			pinned: false,
			archived: false,
			trashed: false,
			trashedAt: null,
			createdAt: index,
			updatedAt: index,
			reminder: null,
			labels: []
		}));
		writeNotesMirror(notes);
		expect(readNotesMirror().map((item) => item.id)).toEqual(notes.map((item) => item.id));
	});

	it('retries without thumbs when localStorage quota is exceeded', () => {
		const note: Note = {
			id: 'n1',
			title: 'Photo',
			body: '',
			color: 'default',
			pinned: false,
			archived: false,
			trashed: false,
			trashedAt: null,
			createdAt: 1,
			updatedAt: 2,
			reminder: null,
			labels: [],
			images: [
				{
					id: 'pic',
					mime: 'image/jpeg',
					dataUrl: 'data:image/jpeg;base64,abc',
					contentHash: 'hash',
					createdAt: 1,
					thumbUrl: 'data:image/jpeg;base64,thumb'
				}
			]
		};
		const setItem = vi.spyOn(Storage.prototype, 'setItem');
		setItem.mockImplementationOnce(() => {
			throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
		});
		writeNotesMirror([note]);
		expect(readNotesMirror()[0]?.images?.[0]?.thumbUrl).toBeUndefined();
		expect(readNotesMirror()[0]?.id).toBe('n1');
	});
});
