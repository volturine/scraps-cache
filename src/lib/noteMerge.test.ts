import { describe, expect, it } from 'vitest';
import { mergeTwoNotes, retargetLocalNotes, touchNoteFields } from './noteMerge';
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
	it('fills a missing thumb from the other copy on a field-time tie', () => {
		const stored = note(10, [{ ...image('one', ''), thumbUrl: 'data:image/jpeg;base64,thumb' }]);
		const mirrored = note(10, [image('one', '')]);

		expect(mergeTwoNotes(mirrored, stored).images).toEqual([
			{ ...image('one', ''), thumbUrl: 'data:image/jpeg;base64,thumb' }
		]);
	});

	it('hydrates bytes for the winning image list without adding removed ids', () => {
		const stored = note(10, [image('one', 'data:one'), image('removed', 'data:removed')]);
		const newer = note(11, [image('one', '')]);

		expect(mergeTwoNotes(newer, stored).images).toEqual([image('one', 'data:one')]);
	});

	it('keeps existing photos when a newer list has no bytes yet', () => {
		const stored = note(10, [image('old', 'data:old')]);
		const pulled = note(11, [image('new', '')]);

		expect(mergeTwoNotes(pulled, stored).images).toEqual([
			image('new', ''),
			image('old', 'data:old')
		]);
	});

	it('drops photos when the newer list is empty', () => {
		const stored = note(10, [image('old', 'data:old')]);
		const cleared = note(11, []);

		expect(mergeTwoNotes(cleared, stored).images).toEqual([]);
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

	it('advances an edited field beyond a timestamp pulled from a fast device clock', () => {
		const pulled = {
			...note(10_000, []),
			title: 'older edit from fast clock',
			fieldTimes: { title: 10_000 }
		};
		const editedLater = touchNoteFields(
			{ ...pulled, title: 'newer intentional edit' },
			['title'],
			1_000
		);

		expect(editedLater.fieldTimes?.title).toBe(10_001);
		expect(editedLater.updatedAt).toBe(10_001);
		expect(mergeTwoNotes(pulled, editedLater).title).toBe('newer intentional edit');
	});
});

describe('retargetLocalNotes', () => {
	it('gives the local copy a new id when the account already has that note', () => {
		const local = { ...note(10, [image('photo', 'data:local')]), id: 'shared', title: 'mine' };
		const remote = { ...note(8, [image('photo', 'data:remote')]), id: 'shared', title: 'theirs' };
		let next = 0;
		const remapped = retargetLocalNotes([local], [remote], {}, () => `new-${++next}`);

		expect(remapped).toEqual([
			{
				...local,
				id: 'new-2',
				images: [{ ...image('photo', 'data:local'), id: 'new-1' }]
			}
		]);
		expect(remapped[0]?.id).not.toBe('shared');
		expect(remapped[0]?.images?.[0]?.id).not.toBe('photo');
	});

	it('keeps a local note that a remote tombstone would otherwise drop', () => {
		const local = { ...note(10, []), id: 'deleted-on-server', title: 'still on this phone' };
		let next = 0;
		const remapped = retargetLocalNotes(
			[local],
			[],
			{ 'deleted-on-server': 5 },
			() => `kept-${++next}`
		);

		expect(remapped[0]?.id).toBe('kept-1');
		expect(remapped[0]?.title).toBe('still on this phone');
	});

	it('leaves local-only notes and photos alone', () => {
		const local = { ...note(10, [image('only-here', 'data:x')]), id: 'local-1', title: 'mine' };
		const remote = { ...note(8, [image('cloud-photo', 'data:y')]), id: 'cloud-1', title: 'theirs' };
		const remapped = retargetLocalNotes([local], [remote], {}, () => 'should-not-run');

		expect(remapped).toEqual([local]);
	});
});
