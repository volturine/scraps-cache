import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import BodyEditor from './BodyEditor.svelte';

function textNode(element: Element): Node {
	return element.firstChild ?? element;
}

function select(
	start: Element,
	startOffset: number,
	end: Element = start,
	endOffset = startOffset
) {
	const range = document.createRange();
	range.setStart(textNode(start), startOffset);
	range.setEnd(textNode(end), endOffset);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

function lineTexts(container: HTMLElement): string[] {
	return [...container.querySelectorAll('[data-line-text]')].map((line) => line.textContent ?? '');
}

describe('BodyEditor native editing', () => {
	it('replaces an empty root task with a focused plain-text line', async () => {
		const { container } = render(BodyEditor, { props: { body: '[ ] \nafter' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const emptyTask = container.querySelector('[data-line-text]') as HTMLElement;
		select(emptyTask, 0);

		await fireEvent.keyDown(editor, { key: 'Enter' });

		expect(container.querySelector('[data-checklist-toggle]')).toBeNull();
		expect(lineTexts(container)).toEqual(['', 'after']);
		expect(document.activeElement).toBe(editor);
	});

	it('keeps the existing empty sub-task Enter behavior', async () => {
		const { container } = render(BodyEditor, { props: { body: '[ ] parent\n  [ ] ' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const tasks = container.querySelectorAll('[data-line-text]');
		select(tasks[1], 0);

		await fireEvent.keyDown(editor, { key: 'Enter' });

		expect(container.querySelectorAll('[data-checklist-toggle]')).toHaveLength(2);
	});

	it('supports one native selection across multiple task rows and deletes it', async () => {
		const { container } = render(BodyEditor, {
			props: { body: '[ ] First task\n[ ] Second task\n[ ] Keep' }
		});
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const tasks = container.querySelectorAll('[data-line-text]');
		select(tasks[0], 0, tasks[1], 'Second task'.length);

		expect(window.getSelection()?.toString()).toContain('First task');
		expect(window.getSelection()?.toString()).toContain('Second task');
		const setData = vi.fn();
		const copy = new Event('copy', { bubbles: true, cancelable: true });
		Object.defineProperty(copy, 'clipboardData', { value: { setData } });
		editor.dispatchEvent(copy);
		expect(setData).toHaveBeenCalledWith('text/plain', 'First task\nSecond task');

		const beforeInput = new InputEvent('beforeinput', {
			bubbles: true,
			cancelable: true,
			inputType: 'deleteContentBackward'
		});
		editor.dispatchEvent(beforeInput);
		await tick();

		expect(beforeInput.defaultPrevented).toBe(true);
		expect(lineTexts(container)).toEqual(['Keep']);
		expect(container.querySelectorAll('[data-task-row]')).toHaveLength(1);
	});
});

describe('BodyEditor task focus chrome', () => {
	it('keeps every line in the same native editing host when a task receives focus', async () => {
		const { container } = render(BodyEditor, {
			props: { body: '[ ] Parent\ncontext between tasks\n  [ ] Child', focusLine: 0 }
		});
		await tick();

		expect(lineTexts(container)).toEqual(['Parent', 'context between tasks', 'Child']);
		expect(container.querySelectorAll('[contenteditable="plaintext-only"]')).toHaveLength(1);
	});

	it('shows Add sub-task on the focused root and drops it when focus leaves', async () => {
		const { container, rerender } = render(BodyEditor, {
			props: { body: '[ ] Avocados\n  [ ] tes\n[ ] Dark chocolate', focusLine: 0 }
		});
		await tick();

		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
		expect(container.querySelector('[data-add-subtask]')).not.toBeNull();
		expect(container.querySelector('[data-add-subtask]')?.closest('[data-editor-line]')).toBe(
			container.querySelector('[data-editor-line="1"]')
		);
		expect(container.querySelector('[data-editor-line="0"]')?.className).toContain('rounded-t-lg');
		expect(container.querySelector('[data-editor-line="1"]')?.className).toContain('rounded-b-lg');

		await fireEvent.pointerDown(
			container.querySelector('[data-add-subtask]') as HTMLButtonElement,
			{
				pointerType: 'touch'
			}
		);

		expect(container.querySelectorAll('[data-task-row]')).toHaveLength(4);
		expect(container.querySelector('[data-editor-line="0"]')?.className).not.toContain(
			'rounded-b-lg'
		);
		expect(container.querySelector('[data-editor-line="2"]')?.className).toContain('rounded-b-lg');
		expect(
			container
				.querySelector('[data-editor-line="2"] [data-line-text]')
				?.getAttribute('data-placeholder')
		).toBe('Sub-task');
		expect(container.querySelector('[data-add-subtask]')?.closest('[data-editor-line]')).toBe(
			container.querySelector('[data-editor-line="2"]')
		);
		expect(document.activeElement).toBe(container.querySelector('[data-body-editor]'));

		const draft = container.querySelector('[data-editor-line="2"] [data-line-text]') as HTMLElement;
		draft.textContent = 'a';
		await fireEvent.input(draft, { inputType: 'insertText', data: 'a' });
		await tick();
		expect(draft.textContent).toBe('a');

		await rerender({ body: '[ ] Avocados\n  [ ] tes\n[ ] Dark chocolate', focusLine: null });
		await tick();

		expect(container.querySelector('[data-focus-group]')).toBeNull();
		expect(container.querySelector('[data-add-subtask]')).toBeNull();
	});
});
