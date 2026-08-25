import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '$lib/types';
import { notesStore } from '$lib/stores/notes.svelte';
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

function editorOverlay(container: HTMLElement): HTMLElement {
	const overlay = container.querySelector('[role="dialog"]')?.closest('.fixed.z-50');
	if (!(overlay instanceof HTMLElement)) throw new Error('editor overlay missing');
	return overlay;
}

beforeEach(() => {
	vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	notesStore.notes = [];
	notesStore.labels = [];
});

describe('NoteEditor backdrop dismiss', () => {
	it('closes when a click starts and ends outside the note', async () => {
		const onClose = vi.fn();
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose }
		});
		const overlay = editorOverlay(container);

		overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
		await fireEvent.click(overlay);
		await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
	});

	it('does not close when a press starts inside the note and ends outside', async () => {
		const onClose = vi.fn();
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose }
		});
		const overlay = editorOverlay(container);
		const dialog = container.querySelector('[role="dialog"]') as HTMLElement;

		dialog.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
		await fireEvent.click(overlay);
		await tick();
		await Promise.resolve();

		expect(onClose).not.toHaveBeenCalled();
		expect(container.querySelector('[role="dialog"]')).not.toBeNull();
	});
});
