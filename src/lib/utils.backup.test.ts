import { describe, expect, it } from 'vitest';
import { cloneNote } from './utils';
import { stableStringify } from './syncHash';
import type { Note } from './types';

function noteWithPhoto(): Note {
	return {
		id: 'n1',
		title: 'Trip',
		body: 'line one\nline two',
		color: 'yellow',
		pinned: true,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 10,
		updatedAt: 20,
		reminder: 30,
		labels: ['work'],
		images: [
			{
				id: 'img1',
				mime: 'image/jpeg',
				dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(200),
				thumbUrl: 'data:image/jpeg;base64,thumb',
				name: 'shot.jpg',
				createdAt: 11
			}
		],
		linkPreviews: [
			{
				url: 'https://example.com',
				hostname: 'example.com',
				title: 'Example',
				description: 'desc'
			}
		]
	};
}

describe('full backup note clone', () => {
	it('preserves full-resolution image bytes and all note fields', () => {
		const source = noteWithPhoto();
		const backup = cloneNote(source);
		expect(backup.title).toBe('Trip');
		expect(backup.body).toBe('line one\nline two');
		expect(backup.pinned).toBe(true);
		expect(backup.reminder).toBe(30);
		expect(backup.labels).toEqual(['work']);
		expect(backup.linkPreviews?.[0]?.title).toBe('Example');
		expect(backup.images?.[0]?.dataUrl).toBe(source.images?.[0]?.dataUrl);
		expect(backup.images?.[0]?.thumbUrl).toBe('data:image/jpeg;base64,thumb');
		expect(backup.images?.[0]?.name).toBe('shot.jpg');
	});

	it('omits images when the source note has none so clones hash identically', () => {
		const source = noteWithPhoto() as Partial<Note>;
		delete source.images;
		delete source.linkPreviews;
		const cloned = cloneNote(source as Note);
		expect('images' in cloned).toBe(false);
		expect(stableStringify(cloned)).toBe(stableStringify(source));
	});
});
