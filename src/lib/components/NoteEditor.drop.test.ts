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
		body: 'Milk',
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

function mockDataTransfer(files: File[], types: string[]): DataTransfer {
	return {
		dropEffect: 'none',
		effectAllowed: 'all',
		files,
		items: [] as unknown as DataTransferItemList,
		types,
		clearData() {},
		getData() {
			return '';
		},
		setData() {},
		setDragImage() {}
	} as unknown as DataTransfer;
}

function fileDragEvent(
	type: string,
	files: File[],
	client: { x?: number; y?: number } = {},
	types = files.length > 0 ? ['Files'] : []
): DragEvent {
	const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperties(event, {
		dataTransfer: { value: mockDataTransfer(files, types) },
		clientX: { value: client.x ?? 10 },
		clientY: { value: client.y ?? 10 }
	});
	return event;
}

beforeEach(() => {
	vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	notesStore.notes = [];
	notesStore.labels = [];
});

describe('NoteEditor file drop', () => {
	it('shows a drop hint while files are dragged over the editor', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const overlay = editorOverlay(container);
		const file = new File(['hello'], 'note.txt', { type: 'text/plain' });

		overlay.dispatchEvent(fileDragEvent('dragenter', [file]));
		await tick();

		expect(container.querySelector('[data-file-drop-hint]')?.textContent).toContain(
			'Drop to attach'
		);
	});

	it('does not show a drop hint for text drags', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const overlay = editorOverlay(container);
		overlay.dispatchEvent(fileDragEvent('dragenter', [], {}, ['text/plain']));
		await tick();

		expect(container.querySelector('[data-file-drop-hint]')).toBeNull();
	});

	it('hides the drop hint after the pointer leaves the editor', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const overlay = editorOverlay(container);
		vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({
			x: 0,
			y: 0,
			width: 400,
			height: 400,
			top: 0,
			left: 0,
			right: 400,
			bottom: 400,
			toJSON() {
				return {};
			}
		});
		const file = new File(['hello'], 'note.txt', { type: 'text/plain' });

		overlay.dispatchEvent(fileDragEvent('dragenter', [file], { x: 20, y: 20 }));
		await tick();
		expect(container.querySelector('[data-file-drop-hint]')).not.toBeNull();

		overlay.dispatchEvent(fileDragEvent('dragleave', [file], { x: 500, y: 500 }));
		await tick();
		expect(container.querySelector('[data-file-drop-hint]')).toBeNull();
	});

	it('attaches a dropped file', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const overlay = editorOverlay(container);
		const file = new File(['hello'], 'todo.txt', { type: 'text/plain' });

		const drop = fileDragEvent('drop', [file]);
		overlay.dispatchEvent(drop);
		expect(drop.defaultPrevented).toBe(true);

		await vi.waitFor(() => {
			expect(container.querySelector('[aria-label="Open todo.txt"]')).not.toBeNull();
		});
		expect(container.querySelector('[data-file-drop-hint]')).toBeNull();
	});

	it('asks for photo quality when a dropped file looks like a photo', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const overlay = editorOverlay(container);
		const file = new File(['fake-image'], 'shot.jpg', { type: 'image/jpeg' });

		overlay.dispatchEvent(fileDragEvent('drop', [file]));
		await tick();

		expect(container.querySelector('#photo-quality-title')?.textContent).toBe('Photo quality');
	});

	it('does not close the note after dropping onto the backdrop', async () => {
		const onClose = vi.fn();
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose }
		});
		const overlay = editorOverlay(container);
		const file = new File(['hello'], 'todo.txt', { type: 'text/plain' });

		overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
		overlay.dispatchEvent(fileDragEvent('drop', [file]));
		await fireEvent.click(overlay);
		await tick();

		expect(onClose).not.toHaveBeenCalled();
		expect(container.querySelector('[role="dialog"]')).not.toBeNull();
	});
});
