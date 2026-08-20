import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	NOTES_MIRROR_KEY,
	noteForLocalStorage,
	readNotesMirror,
	writeNotesMirror
} from './noteStorage';
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
				contentHash: 'hash'
			})
		]);
		expect(mirrored.images?.[0]).not.toHaveProperty('thumbUrl');
		expect(JSON.stringify(mirrored).includes('data:image/jpeg;base64')).toBe(false);
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

	it('never writes thumbs or photo bytes into the notes mirror', () => {
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
		writeNotesMirror([note]);
		const stored = JSON.parse(localStorage.getItem(NOTES_MIRROR_KEY) || '[]') as Array<{
			images?: Array<{ thumbUrl?: string; dataUrl?: string }>;
		}>;
		expect(stored[0]?.images?.[0]?.thumbUrl).toBeUndefined();
		expect(stored[0]?.images?.[0]?.dataUrl).toBeUndefined();
		expect(readNotesMirror()[0]?.id).toBe('n1');
		expect(readNotesMirror()[0]?.images?.[0]?.id).toBe('pic');
	});
});
