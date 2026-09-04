import { render } from '@testing-library/svelte';
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

function createClipboardEvent(
	files: File[],
	text = '',
	types = files.length > 0 ? ['Files'] : ['text/plain']
): ClipboardEvent {
	const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
	const clipboardData = {
		files,
		items: files.map((f) => ({
			kind: 'file',
			type: f.type,
			getAsFile: () => f
		})),
		types,
		getData: (format: string) => (format === 'text/plain' ? text : ''),
		setData: () => {},
		clearData: () => {}
	};
	Object.defineProperty(event, 'clipboardData', { value: clipboardData });
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

describe('NoteEditor paste photo', () => {
	it('asks for photo quality when a photo is pasted into NoteEditor', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const overlay = editorOverlay(container);
		const photo = new File(['fake-jpg-content'], 'camera.jpg', { type: 'image/jpeg' });

		const pasteEvent = createClipboardEvent([photo]);
		overlay.dispatchEvent(pasteEvent);
		expect(pasteEvent.defaultPrevented).toBe(true);

		await vi.waitFor(() => {
			expect(container.querySelector('#photo-quality-title')?.textContent).toContain(
				'Photo quality'
			);
		});
	});

	it('attaches directly when a non-photo file is pasted into NoteEditor', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const overlay = editorOverlay(container);
		const file = new File(['todo list'], 'tasks.txt', { type: 'text/plain' });

		const pasteEvent = createClipboardEvent([file]);
		overlay.dispatchEvent(pasteEvent);
		expect(pasteEvent.defaultPrevented).toBe(true);

		await vi.waitFor(() => {
			expect(container.querySelector('[aria-label="Open tasks.txt"]')).not.toBeNull();
		});
	});

	it('intercepts paste and attaches photo when focused inside BodyEditor', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const bodyEditor = container.querySelector('[data-body-editor]') as HTMLElement;
		expect(bodyEditor).not.toBeNull();

		const photo = new File(['fake-png-content'], 'screenshot.png', { type: 'image/png' });
		const pasteEvent = createClipboardEvent([photo]);

		bodyEditor.dispatchEvent(pasteEvent);
		expect(pasteEvent.defaultPrevented).toBe(true);

		await vi.waitFor(() => {
			expect(container.querySelector('#photo-quality-title')?.textContent).toContain(
				'Photo quality'
			);
		});
	});

	it('intercepts paste and attaches photo when focused inside Title input', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const titleInput = container.querySelector('input[placeholder="Title"]') as HTMLInputElement;
		expect(titleInput).not.toBeNull();

		const photo = new File(['fake-png-content'], 'pic.webp', { type: 'image/webp' });
		const pasteEvent = createClipboardEvent([photo]);

		titleInput.dispatchEvent(pasteEvent);
		expect(pasteEvent.defaultPrevented).toBe(true);

		await vi.waitFor(() => {
			expect(container.querySelector('#photo-quality-title')?.textContent).toContain(
				'Photo quality'
			);
		});
	});

	it('allows plain text paste in BodyEditor without attaching file', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const bodyEditor = container.querySelector('[data-body-editor]') as HTMLElement;
		const line = container.querySelector('[data-editor-line]') as HTMLElement;

		// Set selection range inside the editor line
		const textNode = line.firstChild ?? line;
		const range = document.createRange();
		range.setStart(textNode, 0);
		range.setEnd(textNode, 0);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const textPaste = createClipboardEvent([], 'Apples');
		bodyEditor.dispatchEvent(textPaste);

		// Plain text paste should NOT show photo quality dialog
		await tick();
		expect(container.querySelector('#photo-quality-title')).toBeNull();
	});

	it('ignores paste events originating from inside CanvasEditor', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const overlay = editorOverlay(container);

		// Simulate a fake element inside .canvas-editor-shell
		const fakeShell = document.createElement('div');
		fakeShell.className = 'canvas-editor-shell';
		const canvasChild = document.createElement('div');
		fakeShell.appendChild(canvasChild);
		overlay.appendChild(fakeShell);

		const photo = new File(['bytes'], 'shot.png', { type: 'image/png' });
		const pasteEvent = createClipboardEvent([photo]);
		canvasChild.dispatchEvent(pasteEvent);

		await tick();
		expect(pasteEvent.defaultPrevented).toBe(false);
		expect(container.querySelector('#photo-quality-title')).toBeNull();
	});
});
