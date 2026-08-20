import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTES_MIRROR_KEY, readNotesMirror, writeNotesMirror } from './noteStorage';
import type { Note } from '$lib/types';

function note(id: string): Note {
	return {
		id,
		title: `Note ${id}`,
		body: 'x'.repeat(100),
		color: 'default',
		pinned: false,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 1,
		updatedAt: 1,
		reminder: null,
		labels: []
	};
}

describe('notes mirror quota failure (#83)', () => {
	afterEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it('leaves the mirror stale without any observable failure signal when setItem throws', () => {
		writeNotesMirror([note('old')]);
		expect(readNotesMirror().map(({ id }) => id)).toEqual(['old']);

		const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('QuotaExceededError');
		});
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		expect(() => writeNotesMirror([note('new')])).not.toThrow();
		setItem.mockRestore();
		logged.mockRestore();

		// The mirror still holds the pre-crash snapshot and nothing tells the
		// caller or the UI that crash protection silently stopped updating.
		expect(readNotesMirror().map(({ id }) => id)).toEqual(['old']);
		expect(localStorage.getItem(NOTES_MIRROR_KEY)).toContain('old');
	});
});
