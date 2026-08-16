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

beforeEach(() => {
	vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	notesStore.notes = [];
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
		const task = [...container.querySelectorAll('textarea[placeholder="Task"]')].at(
			-1
		) as HTMLTextAreaElement;
		scroller.scrollTop = 640;

		await fireEvent.pointerDown(task, { pointerType: 'touch' });

		expect(document.activeElement).toBe(task);
		expect(scroller.scrollTop).toBe(640);
	});

	it('keeps the tapped task anchored when focus chrome moves between tasks', () => {
		notesStore.notes = [note({ body: '[ ] First task\n[ ] Last task' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});
		const scroller = container.querySelector('.scrollable') as HTMLElement;
		const tasks = container.querySelectorAll(
			'textarea[placeholder="Task"]'
		) as NodeListOf<HTMLTextAreaElement>;
		scroller.scrollTop = 640;
		tasks[0].focus();
		Object.defineProperty(tasks[1], 'getBoundingClientRect', {
			configurable: true,
			value: () => {
				const top = document.activeElement === tasks[1] ? 264 : 300;
				return { top, bottom: top + 24, left: 0, right: 300, width: 300, height: 24 };
			}
		});

		const taskTap = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
		Object.defineProperty(taskTap, 'pointerType', { value: 'touch' });
		tasks[1].dispatchEvent(taskTap);

		expect(taskTap.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(tasks[1]);
		expect(scroller.scrollTop).toBe(604);
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

		const chocolate = [...container.querySelectorAll('textarea[placeholder="Task"]')].find(
			(el) => (el as HTMLTextAreaElement).value === 'Dark chocolate'
		) as HTMLTextAreaElement;
		chocolate.focus();
		chocolate.setSelectionRange(4, 4);
		await tick();

		const renderedChocolate = [...container.querySelectorAll('textarea[placeholder="Task"]')].find(
			(el) => (el as HTMLTextAreaElement).value === 'Dark chocolate'
		) as HTMLTextAreaElement;
		expect(renderedChocolate).toBe(chocolate);
		expect(document.activeElement).toBe(chocolate);
		expect(chocolate.selectionStart).toBe(4);
		expect(chocolate.selectionEnd).toBe(4);
	});

	it('drops the focused task group when clicking elsewhere in the note', async () => {
		notesStore.notes = [note({ body: '[ ] Avocados\n  [ ] tes\n[ ] Dark chocolate' })];
		const { container } = render(NoteEditor, {
			props: { noteId: 'note-1', onClose: () => {} }
		});

		const avocados = [...container.querySelectorAll('textarea[placeholder="Task"]')].find(
			(el) => (el as HTMLTextAreaElement).value === 'Avocados'
		) as HTMLTextAreaElement;
		await fireEvent.focus(avocados);
		await tick();

		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
		expect(container.querySelector('[data-add-subtask]')).not.toBeNull();

		const scroller = container.querySelector('.scrollable') as HTMLElement;
		await fireEvent.click(scroller);
		await tick();

		expect(container.querySelector('[data-focus-group]')).toBeNull();
		expect(container.querySelector('[data-add-subtask]')).toBeNull();
	});
});
