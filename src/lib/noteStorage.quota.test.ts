import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	MIRROR_FALLBACK_LIMIT,
	NOTES_MIRROR_KEY,
	readNotesMirror,
	writeNotesMirror
} from './noteStorage';
import type { Note } from '$lib/types';

function note(id: string, updatedAt: number): Note {
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
		updatedAt,
		reminder: null,
		labels: []
	};
}

describe('notes mirror quota fallback (#83)', () => {
	afterEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it('keeps the most recent notes when the full mirror exceeds the quota', () => {
		const notes = Array.from({ length: 200 }, (_, index) => note(`n${index}`, index));
		writeNotesMirror(notes);
		expect(readNotesMirror()).toHaveLength(200);

		// Simulate a quota that fits only small payloads.
		const real = Storage.prototype.setItem;
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
			if (value.length > 20_000) throw new DOMException('QuotaExceededError');
			real.call(localStorage, key, value);
		});
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		writeNotesMirror(notes);
		logged.mockRestore();

		const mirrored = readNotesMirror().map(({ id }) => id);
		expect(mirrored).toHaveLength(MIRROR_FALLBACK_LIMIT);
		expect(mirrored).toEqual(
			notes
				.slice(-MIRROR_FALLBACK_LIMIT)
				.map(({ id }) => id)
				.reverse()
		);
	});

	it('leaves the previous mirror in place when even the fallback exceeds the quota', () => {
		writeNotesMirror([note('old', 1)]);
		expect(readNotesMirror().map(({ id }) => id)).toEqual(['old']);

		const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('QuotaExceededError');
		});
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		expect(writeNotesMirror([note('new', 2)])).toBe(false);
		setItem.mockRestore();
		logged.mockRestore();

		expect(readNotesMirror().map(({ id }) => id)).toEqual(['old']);
		expect(localStorage.getItem(NOTES_MIRROR_KEY)).toContain('old');
	});
});
