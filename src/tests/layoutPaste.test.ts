import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notesStore } from '$lib/stores/notes.svelte';
import Layout from '../routes/+layout.svelte';

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
	if (typeof window !== 'undefined' && !window.ResizeObserver) {
		window.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
});

afterEach(() => {
	vi.restoreAllMocks();
	notesStore.notes = [];
	notesStore.labels = [];
});

describe('+layout global paste', () => {
	it('creates a new note and opens editor with photo when photo is pasted globally', async () => {
		const { container } = render(Layout);
		await vi.waitFor(() => expect(notesStore.loaded).toBe(true));

		const initialCount = notesStore.notes.length;
		const photo = new File(['fake-png-bytes'], 'screenshot.png', { type: 'image/png' });
		const pasteEvent = createClipboardEvent([photo]);

		window.dispatchEvent(pasteEvent);
		expect(pasteEvent.defaultPrevented).toBe(true);

		await vi.waitFor(() => {
			expect(notesStore.notes.length).toBe(initialCount + 1);
			expect(container.querySelector('#photo-quality-title')?.textContent).toContain(
				'Photo quality'
			);
		});
	});

	it('does not create note when plain text is pasted globally', async () => {
		render(Layout);
		await vi.waitFor(() => expect(notesStore.loaded).toBe(true));

		const initialCount = notesStore.notes.length;
		const pasteEvent = createClipboardEvent([], 'just text');
		window.dispatchEvent(pasteEvent);

		await tick();
		expect(notesStore.notes.length).toBe(initialCount);
	});

	it('does not hijack paste when an input or textarea is active', async () => {
		const { container } = render(Layout);
		await vi.waitFor(() => expect(notesStore.loaded).toBe(true));

		const initialCount = notesStore.notes.length;
		const input = document.createElement('input');
		container.appendChild(input);
		input.focus();

		const photo = new File(['fake-jpg'], 'pic.jpg', { type: 'image/jpeg' });
		const pasteEvent = createClipboardEvent([photo]);

		input.dispatchEvent(pasteEvent);

		await tick();
		expect(notesStore.notes.length).toBe(initialCount);
		input.remove();
	});
});
