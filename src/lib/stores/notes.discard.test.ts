import { describe, expect, it } from 'vitest';
import type { Note } from '$lib/types';
import { noteIsBlank } from './notes.svelte';

function note(partial: Partial<Note> = {}): Note {
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
		updatedAt: 1,
		reminder: null,
		labels: [],
		...partial
	};
}

describe('noteIsBlank', () => {
	it('is false when the note only has a reminder', () => {
		expect(noteIsBlank(note({ reminder: Date.now() + 60_000 }))).toBe(false);
	});

	it('is true for a note with no text, reminder, or attachments', () => {
		expect(noteIsBlank(note())).toBe(true);
	});
});
