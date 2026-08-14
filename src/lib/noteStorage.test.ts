import { describe, expect, it } from 'vitest';
import { noteForLocalStorage } from './noteStorage';
import type { Note } from './types';

describe('fast-boot note mirror', () => {
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
});
