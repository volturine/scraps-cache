import { describe, expect, it } from 'vitest';
import { mergeTwoNotes } from './noteMerge';
import type { Note, NoteImage } from './types';

function image(id: string, dataUrl: string): NoteImage {
	return { id, name: `${id}.jpg`, mime: 'image/jpeg', dataUrl, createdAt: 1 };
}

function note(updatedAt: number, images: NoteImage[]): Note {
	return {
		id: 'note',
		title: '',
		body: '',
		color: 'default',
		pinned: false,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 1,
		updatedAt,
		reminder: null,
		labels: [],
		images
	};
}

describe('mergeTwoNotes', () => {
	it('hydrates bytes for the winning image list without adding removed ids', () => {
		const stored = note(10, [image('one', 'data:one'), image('removed', 'data:removed')]);
		const newer = note(11, [image('one', '')]);

		expect(mergeTwoNotes(newer, stored).images).toEqual([image('one', 'data:one')]);
	});

	it('keeps a newer body when the other device only changed pin', () => {
		const edited = {
			...note(10, []),
			body: 'edited',
			fieldTimes: { body: 20, pinned: 10 }
		};
		const pinned = {
			...note(15, []),
			body: '',
			pinned: true,
			fieldTimes: { body: 10, pinned: 15 }
		};
		const merged = mergeTwoNotes(edited, pinned);
		expect(merged.body).toBe('edited');
		expect(merged.pinned).toBe(true);
	});
});
