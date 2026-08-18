import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function dispatchTouchPointer(
	target: Element,
	type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
	options: { pointerId?: number; clientX?: number; clientY?: number } = {}
): MouseEvent {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: options.clientX ?? 0,
		clientY: options.clientY ?? 0
	});
	Object.defineProperties(event, {
		pointerType: { value: 'touch' },
		pointerId: { value: options.pointerId ?? 1 }
	});
	target.dispatchEvent(event);
	return event;
}

function setCaret(element: Element, offset: number) {
	const range = document.createRange();
	range.setStart(element.firstChild ?? element, offset);
	range.collapse(true);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

beforeEach(() => {
	vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	notesStore.notes = [];
	notesStore.labels = [];
});

describe('NoteEditor header reminder controls', () => {
	it('shows reminder then pin, and no time when the note has no reminder', () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});

		expect(headerButtons(container)).toEqual(['Close note', 'Reminder', 'Pin']);
		expect(container.querySelector('header')?.textContent).not.toMatch(/Today|Tomorrow|AM|PM/);
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

	it('allows touch scrolling in the reminder wheels outside the editor dialog', async () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});

		const reminderButton = container.querySelector(
			'header button[aria-label="Reminder"]'
		) as HTMLButtonElement;
		await fireEvent.click(reminderButton);
		await tick();

		const wheel = container.querySelector('[role="listbox"][aria-label="Hour"]') as HTMLElement;
		Object.defineProperties(wheel, {
			scrollHeight: { configurable: true, value: 1_000 },
			clientHeight: { configurable: true, value: 180 }
		});
		wheel.scrollTop = 72;

		const start = new Event('touchstart', { bubbles: true, cancelable: true });
		Object.defineProperty(start, 'touches', { value: [{ clientY: 100 }] });
		wheel.dispatchEvent(start);
		const move = new Event('touchmove', { bubbles: true, cancelable: true });
		Object.defineProperty(move, 'touches', { value: [{ clientY: 80 }] });
		wheel.dispatchEvent(move);

		expect(move.defaultPrevented).toBe(false);
	});
});

describe('NoteEditor task focus', () => {
	it('keeps the outer page anchored while the note body owns scrolling', () => {
		notesStore.notes = [note()];
		render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});

		expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
	});

	it('focuses a scrolled task without resetting the note body', async () => {
		notesStore.notes = [
			note({ body: Array.from({ length: 30 }, (_, index) => `[ ] Task ${index}`).join('\n') })
		];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const scroller = container.querySelector('.scrollable') as HTMLElement;
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const task = [...container.querySelectorAll('[data-task-row] [data-line-text]')].at(
			-1
		) as HTMLElement;
		scroller.scrollTop = 640;

		dispatchTouchPointer(task, 'pointerdown');
		dispatchTouchPointer(task, 'pointerup');

		expect(document.activeElement).toBe(editor);
		expect(scroller.scrollTop).toBe(640);
	});

	it('keeps one native editing host when focus chrome moves between tasks', async () => {
		notesStore.notes = [note({ body: '[ ] First task\n[ ] Last task' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const scroller = container.querySelector('.scrollable') as HTMLElement;
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const tasks = container.querySelectorAll('[data-task-row] [data-line-text]');
		scroller.scrollTop = 640;
		editor.focus();
		setCaret(tasks[0], 4);
		await fireEvent.click(tasks[1]);

		expect(document.activeElement).toBe(editor);
		expect(container.querySelectorAll('[contenteditable="plaintext-only"]')).toHaveLength(1);
		expect(scroller.scrollTop).toBe(640);
	});

	it('moves an active edge task into the note body safe area before native caret placement', () => {
		notesStore.notes = [note({ body: '[ ] Edge task' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const scroller = container.querySelector('.scrollable') as HTMLElement;
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const task = container.querySelector('[data-task-row] [data-line-text]') as HTMLElement;
		scroller.scrollTop = 500;
		Object.defineProperty(scroller, 'getBoundingClientRect', {
			configurable: true,
			value: () => ({ top: 100, bottom: 500, left: 0, right: 300, width: 300, height: 400 })
		});
		Object.defineProperty(task, 'getBoundingClientRect', {
			configurable: true,
			value: () => {
				const top = 490 - (scroller.scrollTop - 500);
				return { top, bottom: top + 24, left: 0, right: 300, width: 300, height: 24 };
			}
		});
		editor.focus();

		dispatchTouchPointer(task, 'pointerdown', { clientY: 499 });
		const taskTap = dispatchTouchPointer(task, 'pointerup', { clientY: 499 });

		expect(taskTap.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(editor);
		expect(scroller.scrollTop).toBeGreaterThan(500);
		expect(window.scrollTo).toHaveBeenLastCalledWith(0, 0);
	});

	it('does not change task focus when a touch becomes a note-body scroll', () => {
		notesStore.notes = [note({ body: '[ ] First task\n[ ] Last task' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const scroller = container.querySelector('.scrollable') as HTMLElement;
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const tasks = container.querySelectorAll('[data-task-row] [data-line-text]');
		editor.focus();
		setCaret(tasks[0], 4);

		dispatchTouchPointer(tasks[1], 'pointerdown', { clientY: 300 });
		scroller.scrollTop = 40;
		dispatchTouchPointer(tasks[1], 'pointermove', { clientY: 250 });
		dispatchTouchPointer(tasks[1], 'pointerup', { clientY: 250 });

		expect(document.activeElement).toBe(editor);
		expect(scroller.scrollTop).toBe(40);
	});

	it('does not cancel touch movement at the note body boundary', () => {
		notesStore.notes = [note()];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const scroller = container.querySelector('.scrollable') as HTMLElement;
		Object.defineProperties(scroller, {
			scrollHeight: { configurable: true, value: 1_000 },
			clientHeight: { configurable: true, value: 300 }
		});
		scroller.scrollTop = 700;
		const move = new Event('touchmove', { bubbles: true, cancelable: true });
		scroller.dispatchEvent(move);

		expect(move.defaultPrevented).toBe(false);
	});

	it('keeps the native task field and caret when focus styling opens', async () => {
		notesStore.notes = [note({ body: '[ ] Avocados\n  [ ] tes\n[ ] Dark chocolate' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});

		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const chocolate = [...container.querySelectorAll('[data-task-row] [data-line-text]')].find(
			(el) => el.textContent === 'Dark chocolate'
		) as HTMLElement;
		editor.focus();
		setCaret(chocolate, 4);
		await fireEvent.click(chocolate);
		await tick();

		const renderedChocolate = [
			...container.querySelectorAll('[data-task-row] [data-line-text]')
		].find((el) => el.textContent === 'Dark chocolate') as HTMLElement;
		expect(renderedChocolate).toBe(chocolate);
		expect(document.activeElement).toBe(editor);
		expect(window.getSelection()?.anchorOffset).toBe(4);
		expect(window.getSelection()?.focusOffset).toBe(4);
	});

	it('drops the focused task group when clicking elsewhere in the note', async () => {
		notesStore.notes = [note({ body: '[ ] Avocados\n  [ ] tes\n[ ] Dark chocolate' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});

		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const avocados = [...container.querySelectorAll('[data-task-row] [data-line-text]')].find(
			(el) => el.textContent === 'Avocados'
		) as HTMLElement;
		editor.focus();
		setCaret(avocados, 4);
		await fireEvent.click(avocados);
		await tick();

		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
		expect(container.querySelector('[data-add-subtask]')).not.toBeNull();

		const scroller = container.querySelector('.scrollable') as HTMLElement;
		await fireEvent.click(scroller);
		await tick();

		expect(container.querySelector('[data-focus-group]')).toBeNull();
		expect(container.querySelector('[data-add-subtask]')).toBeNull();
	});

	it('only toggles a checkbox without activating task focus or moving the note body', async () => {
		notesStore.notes = [note({ body: '[ ] Avocados\n  [ ] tes\n[ ] Dark chocolate' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const scroller = container.querySelector('.scrollable') as HTMLElement;
		const toggle = container.querySelector('[data-checklist-toggle]') as HTMLButtonElement;
		scroller.scrollTop = 640;
		editor.focus();

		const pointerDown = dispatchTouchPointer(toggle, 'pointerdown');
		dispatchTouchPointer(toggle, 'pointerup');
		await fireEvent.click(toggle);
		await tick();

		expect(pointerDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(editor);
		expect(scroller.scrollTop).toBe(640);
		expect(container.querySelector('[data-focus-group]')).toBeNull();
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
	});

	it('shows restore instead of archive for a trashed note', () => {
		notesStore.notes = [note({ trashed: true, trashedAt: 1 })];
		const restore = vi.spyOn(notesStore, 'restoreNote').mockImplementation(() => {});
		const { getByRole, queryByRole } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});

		expect(queryByRole('button', { name: 'Archive' })).toBeNull();
		void fireEvent.click(getByRole('button', { name: 'Restore' }));
		expect(restore).toHaveBeenCalledWith('note-1');
	});

	it('drops task focus when the editor loses focus and the keyboard is dismissed', async () => {
		notesStore.notes = [note({ body: '[ ] Avocados\n  [ ] tes' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const task = container.querySelector('[data-task-row] [data-line-text]') as HTMLElement;
		editor.focus();
		setCaret(task, 4);
		await fireEvent.click(task);
		await tick();

		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
		editor.blur();
		await tick();

		expect(container.querySelector('[data-focus-group]')).toBeNull();
	});

	it('blurs the body when empty editor chrome is tapped, then focuses it from an idle tap', async () => {
		notesStore.notes = [note({ body: 'Plain note' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const scroller = container.querySelector('.scrollable') as HTMLElement;
		editor.focus();

		await fireEvent.click(scroller);
		expect(document.activeElement).not.toBe(editor);

		await fireEvent.click(scroller);
		await tick();
		expect(document.activeElement).toBe(editor);
	});

	it('applies a touched color without dismissing the keyboard', async () => {
		notesStore.notes = [note({ body: 'Plain note' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const color = container.querySelector('footer button[aria-label="Color"]') as HTMLButtonElement;
		editor.focus();

		const pointerDown = dispatchTouchPointer(color, 'pointerdown');
		expect(pointerDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(editor);

		await fireEvent.click(color);
		await tick();
		const popup = container.querySelector('[data-editor-popup]') as HTMLElement;
		expect(popup).not.toBeNull();
		expect(document.activeElement).toBe(editor);
		expect(editor.closest('[role="dialog"]')?.classList.contains('editor-caret-hidden')).toBe(true);

		const yellow = popup.querySelector(
			'button[aria-label="Set color yellow"]'
		) as HTMLButtonElement;
		const palettePointerDown = dispatchTouchPointer(yellow, 'pointerdown');
		expect(palettePointerDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(editor);

		await fireEvent.click(yellow);
		await tick();
		expect(container.querySelector('[data-editor-popup]')).toBeNull();
		expect(document.activeElement).toBe(editor);
		expect(notesStore.notes[0].color).toBe('yellow');
		expect(editor.closest('[role="dialog"]')?.classList.contains('editor-caret-hidden')).toBe(
			false
		);
	});

	it('handles label buttons on the first touch without dismissing the keyboard', async () => {
		notesStore.notes = [note({ body: 'Plain note' })];
		notesStore.labels = [{ id: 'label-1', name: 'Work', createdAt: 1, updatedAt: 1 }];
		vi.spyOn(notesStore, 'toggleLabel').mockImplementation((noteId, labelId) => {
			notesStore.notes = notesStore.notes.map((item) =>
				item.id === noteId
					? {
							...item,
							labels: item.labels.includes(labelId)
								? item.labels.filter((id) => id !== labelId)
								: [...item.labels, labelId]
						}
					: item
			);
		});
		vi.spyOn(notesStore, 'createLabel').mockImplementation((name) => {
			const label = { id: 'label-2', name: name.trim(), createdAt: 2, updatedAt: 2 };
			notesStore.labels = [...notesStore.labels, label];
			return label;
		});
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const labels = container.querySelector(
			'footer button[aria-label="Labels"]'
		) as HTMLButtonElement;
		editor.focus();

		dispatchTouchPointer(labels, 'pointerdown');
		await fireEvent.click(labels);
		await tick();
		const popup = container.querySelector('[data-editor-popup]') as HTMLElement;
		const work = popup.querySelector('button:not([aria-label])') as HTMLButtonElement;
		const labelPointerDown = dispatchTouchPointer(work, 'pointerdown');
		expect(labelPointerDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(editor);

		await fireEvent.click(work);
		await tick();
		expect(notesStore.notes[0].labels).toContain('label-1');
		expect(document.activeElement).toBe(editor);

		const input = popup.querySelector('input[placeholder="Create new label…"]') as HTMLInputElement;
		input.focus();
		await fireEvent.input(input, { target: { value: 'Personal' } });
		await tick();
		const create = popup.querySelector('button[aria-label="Create label"]') as HTMLButtonElement;
		const createPointerDown = dispatchTouchPointer(create, 'pointerdown');
		expect(createPointerDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(input);

		await fireEvent.click(create);
		await tick();
		const personal = notesStore.labels.find((label) => label.name === 'Personal');
		expect(personal).toBeDefined();
		expect(notesStore.notes[0].labels).toContain(personal?.id);
		expect(document.activeElement).toBe(input);
	});

	it('dismisses the keyboard before opening the attachment picker', async () => {
		notesStore.notes = [note({ body: 'Plain note' })];
		const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const attach = container.querySelector(
			'footer button[aria-label="Attach"]'
		) as HTMLButtonElement;
		editor.focus();

		const pointerDown = dispatchTouchPointer(attach, 'pointerdown');
		expect(pointerDown.defaultPrevented).toBe(true);
		await fireEvent.click(attach);

		expect(inputClick).toHaveBeenCalledOnce();
		expect(document.activeElement).not.toBe(editor);
		const picker = document.body.querySelector('input[type="file"]') as HTMLInputElement;
		picker.dispatchEvent(new Event('change'));
	});
});
