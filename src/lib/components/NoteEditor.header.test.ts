import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { Note } from '$lib/types';
import { notesStore } from '$lib/stores/notes.svelte';
import { formatReminder } from '$lib/utils';
import NoteEditor from './NoteEditor.svelte';

function note(partial: Partial<Note> = {}): Note {
	return {
		id: 'note-1',
		title: 'Groceries',
		body: '[ ] Oat milk',
		color: 'green',
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

function headerButtons(container: HTMLElement): string[] {
	return [...container.querySelectorAll('header button')].map(
		(button) => button.getAttribute('aria-label') ?? ''
	);
}

afterEach(() => {
	notesStore.notes = [];
});

describe('NoteEditor header reminder controls', () => {
	it('shows reminder then pin, and no time when the note has no reminder', () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});

		expect(headerButtons(container)).toEqual(['Close note', 'Reminder', 'Pin']);
		expect(container.querySelector('header')?.textContent).not.toContain('⏰');
	});

	it('puts the reminder time in the header and keeps reminder before pin', () => {
		const reminder = Date.now() + 60 * 60 * 1000;
		notesStore.notes = [note({ reminder })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});

		expect(headerButtons(container)).toEqual([
			'Close note',
			`Reminder, ${formatReminder(reminder)}`,
			'Reminder',
			'Pin'
		]);
		expect(container.querySelector('header')?.textContent).toContain(formatReminder(reminder));
	});

	it('marks the reminder button overdue when the time is in the past', () => {
		const reminder = Date.now() - 60 * 60 * 1000;
		notesStore.notes = [note({ reminder })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});

		expect(headerButtons(container)[1]).toBe(`Overdue reminder, ${formatReminder(reminder)}`);
		const bell = container.querySelector('header button[aria-label="Reminder"]');
		expect(bell?.className).toContain('text-rose-600');
	});
});
