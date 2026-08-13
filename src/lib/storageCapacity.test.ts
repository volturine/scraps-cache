import { describe, expect, it } from 'vitest';
import type { Note } from '$lib/types';
import {
	attachmentStorageBytes,
	dataUrlByteLength,
	replacementFitsStorage
} from './storageCapacity';

const note: Note = {
	id: 'cloud',
	title: '',
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
	images: [
		{ id: 'image', mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AAAAAA==', createdAt: 1 }
	]
};

describe('fresh-device replacement storage preflight', () => {
	it('counts decoded attachment bytes without allocating Blob copies', () => {
		expect(dataUrlByteLength('data:image/jpeg;base64,AAAAAA==')).toBe(4);
		expect(attachmentStorageBytes([note])).toBe(4);
	});

	it('rejects a replacement that cannot fit before destructive storage writes', () => {
		expect(replacementFitsStorage([note], { usage: 99, quota: 100 })).toBe(false);
		expect(replacementFitsStorage([note], { usage: 0, quota: 3_000 })).toBe(true);
	});
});
