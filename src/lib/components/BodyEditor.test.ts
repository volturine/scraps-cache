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
	it('renders exactly one block row for each saved newline', () => {
		const { container } = render(BodyEditor, {
			props: { body: 'Plain line\n[ ] Task line\nLast line' }
		});
		const rows = [...container.querySelectorAll('[data-editor-line]')];

		expect(rows).toHaveLength(3);
		expect(lineTexts(container)).toEqual(['Plain line', 'Task line', 'Last line']);
		for (const row of rows) {
			expect(row.querySelector(':scope > [data-line-text]')).not.toBeNull();
			expect(row.querySelector(':scope > div')).toBeNull();
		}
	});

	it('toggles a checklist item without moving focus from the editor', async () => {
		const { container } = render(BodyEditor, { props: { body: '[ ] Task' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const toggle = container.querySelector('[data-checklist-toggle]') as HTMLButtonElement;
		editor.focus();

		const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
		toggle.dispatchEvent(pointerDown);
		await fireEvent.click(toggle);

		expect(pointerDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(editor);
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
	});

	it('does not focus a task when a checkbox touch ends over its label', () => {
		const onFocusTask = vi.fn();
		const { container } = render(BodyEditor, {
			props: { body: '[ ] Task', onFocusTask }
		});
		const toggle = container.querySelector('[data-checklist-toggle]') as HTMLButtonElement;
		const label = container.querySelector('[data-line-text]') as HTMLElement;
		const pointer = (type: string, target: Element) => {
			const event = new MouseEvent(type, { bubbles: true, cancelable: true });
			Object.defineProperties(event, {
				pointerId: { value: 7 },
				pointerType: { value: 'touch' }
			});
			target.dispatchEvent(event);
		};

		pointer('pointerdown', toggle);
		pointer('pointerup', label);
		label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

		expect(onFocusTask).not.toHaveBeenCalled();
		expect(container.querySelector('[data-focus-group]')).toBeNull();
	});

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

	it('gives blank lines a full editable line height after Enter', async () => {
		const { container } = render(BodyEditor, { props: { body: 'before\nafter' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const first = container.querySelector('[data-line-text]') as HTMLElement;
		select(first, 'before'.length);

		await fireEvent.keyDown(editor, { key: 'Enter' });

		const blank = container.querySelector('[data-editor-line="1"] [data-line-text]');
		expect(lineTexts(container)).toEqual(['before', '', 'after']);
		expect(blank?.className).toContain('min-h-[1lh]');
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
		expect(setData).toHaveBeenCalledWith('text/plain', '[ ] First task\n[ ] Second task');

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

	it('copies the whole body from a select-all anchored on the editor host', () => {
		const { container } = render(BodyEditor, {
			props: { body: '[ ] First task\nplain middle\n[ ] Last task' }
		});
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		// Ctrl/Cmd+A anchors the selection on the host element itself, not a text node.
		const range = document.createRange();
		range.setStart(editor, 0);
		range.setEnd(editor, editor.childNodes.length);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const setData = vi.fn();
		const copy = new Event('copy', { bubbles: true, cancelable: true });
		Object.defineProperty(copy, 'clipboardData', { value: { setData } });
		editor.dispatchEvent(copy);

		expect(copy.defaultPrevented).toBe(true);
		expect(setData).toHaveBeenCalledWith(
			'text/plain',
			'[ ] First task\nplain middle\n[ ] Last task'
		);
	});

	it('keeps task focus when selected text is deleted from the focused task', async () => {
		const onExitTaskFocus = vi.fn();
		const { container } = render(BodyEditor, {
			props: { body: '[ ] Focused task', focusLine: 0, onExitTaskFocus }
		});
		await tick();
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const task = container.querySelector('[data-line-text]') as HTMLElement;
		select(task, 0, task, 'Focused '.length);

		const beforeInput = new InputEvent('beforeinput', {
			bubbles: true,
			cancelable: true,
			inputType: 'deleteContentBackward'
		});
		editor.dispatchEvent(beforeInput);
		await tick();

		expect(lineTexts(container)).toEqual(['task']);
		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
		expect(document.activeElement).toBe(editor);
		expect(window.getSelection()?.anchorOffset).toBe(0);
		expect(onExitTaskFocus).not.toHaveBeenCalled();
	});

	it('keeps task focus when selected text is deleted from a subtask and can undo the deletion', async () => {
		const onExitTaskFocus = vi.fn();
		const onFocusTask = vi.fn();
		const { container } = render(BodyEditor, {
			props: {
				body: '[ ] Parent\n  [ ] Focused subtask',
				focusLine: 0,
				onFocusTask,
				onExitTaskFocus
			}
		});
		await tick();
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const subtask = container.querySelectorAll('[data-line-text]')[1];
		select(subtask, 'Focused '.length, subtask, 'Focused sub'.length);

		editor.dispatchEvent(
			new InputEvent('beforeinput', {
				bubbles: true,
				cancelable: true,
				inputType: 'deleteContentBackward'
			})
		);
		await tick();

		expect(lineTexts(container)).toEqual(['Parent', 'Focused task']);
		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
		expect(document.activeElement).toBe(editor);
		expect(onFocusTask).not.toHaveBeenCalled();
		expect(onExitTaskFocus).not.toHaveBeenCalled();

		await fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
		await tick();

		expect(lineTexts(container)).toEqual(['Parent', 'Focused subtask']);
		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
	});

	it('removes a fully selected task row', async () => {
		const { container } = render(BodyEditor, {
			props: { body: '[ ] Remove task\n[ ] Keep task', focusLine: 0 }
		});
		await tick();
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const task = container.querySelector('[data-line-text]') as HTMLElement;
		select(task, 0, task, 'Remove task'.length);

		editor.dispatchEvent(
			new InputEvent('beforeinput', {
				bubbles: true,
				cancelable: true,
				inputType: 'deleteContentBackward'
			})
		);
		await tick();

		expect(lineTexts(container)).toEqual(['Keep task']);
		expect(container.querySelectorAll('[data-task-row]')).toHaveLength(1);
	});

	it('turns an empty first-row task back into a plain line with Backspace', async () => {
		const onExitTaskFocus = vi.fn();
		const { container } = render(BodyEditor, {
			props: { body: '[ ] \nAfter', focusLine: 0, onExitTaskFocus }
		});
		await tick();
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const task = container.querySelector('[data-line-text]') as HTMLElement;
		select(task, 0);

		await fireEvent.keyDown(editor, { key: 'Backspace' });

		expect(lineTexts(container)).toEqual(['', 'After']);
		expect(container.querySelector('[data-editor-line="0"] [data-checklist-toggle]')).toBeNull();
		expect(onExitTaskFocus).toHaveBeenCalledOnce();
	});

	it('undoes and redoes a selected-text deletion while restoring the caret', async () => {
		const { container } = render(BodyEditor, {
			props: { body: '[ ] Focused task', focusLine: 0 }
		});
		await tick();
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const task = container.querySelector('[data-line-text]') as HTMLElement;
		select(task, 0, task, 'Focused '.length);

		editor.dispatchEvent(
			new InputEvent('beforeinput', {
				bubbles: true,
				cancelable: true,
				inputType: 'deleteContentBackward'
			})
		);
		await tick();
		expect(lineTexts(container)).toEqual(['task']);

		await fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
		await tick();
		expect(lineTexts(container)).toEqual(['Focused task']);
		expect(window.getSelection()?.anchorOffset).toBe(0);
		expect(window.getSelection()?.focusOffset).toBe('Focused '.length);

		await fireEvent.keyDown(editor, { key: 'Z', ctrlKey: true, shiftKey: true });
		await tick();
		expect(lineTexts(container)).toEqual(['task']);
		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
	});

	it('cuts the selected task rows from the model', async () => {
		const onExitTaskFocus = vi.fn();
		const { container } = render(BodyEditor, {
			props: {
				body: '[ ] First task\n[ ] Second task\n[ ] Keep',
				focusLine: 0,
				onExitTaskFocus
			}
		});
		await tick();
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const tasks = container.querySelectorAll('[data-line-text]');
		select(tasks[0], 0, tasks[1], 'Second task'.length);

		const setData = vi.fn();
		const cut = new Event('cut', { bubbles: true, cancelable: true });
		Object.defineProperty(cut, 'clipboardData', { value: { setData } });
		editor.dispatchEvent(cut);
		await tick();

		expect(cut.defaultPrevented).toBe(true);
		expect(setData).toHaveBeenCalledWith('text/plain', '[ ] First task\n[ ] Second task');
		expect(lineTexts(container)).toEqual(['Keep']);
		expect(container.querySelectorAll('[data-task-row]')).toHaveLength(1);
		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
		expect(onExitTaskFocus).not.toHaveBeenCalled();
	});

	it('removes a fully selected single row instead of leaving a micro row', async () => {
		const { container } = render(BodyEditor, {
			props: { body: '[ ] Keep before\nplain row to remove\n[ ] Keep after', focusLine: 1 }
		});
		await tick();
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const row = container.querySelector('[data-editor-line="1"] [data-line-text]') as HTMLElement;
		select(row, 0, row, 'plain row to remove'.length);
		const beforeInput = new InputEvent('beforeinput', {
			bubbles: true,
			cancelable: true,
			inputType: 'deleteContentBackward'
		});

		editor.dispatchEvent(beforeInput);
		await tick();

		expect(lineTexts(container)).toEqual(['Keep before', 'Keep after']);
		expect(container.querySelectorAll('[data-editor-line]')).toHaveLength(2);
		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
	});

	it('pastes multiple clipboard lines as structured task rows', async () => {
		const { container } = render(BodyEditor, { props: { body: '[ ] ' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const emptyTask = container.querySelector('[data-line-text]') as HTMLElement;
		select(emptyTask, 0);

		const paste = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(paste, 'clipboardData', {
			value: { getData: () => '[ ] First task\n  [x] Second task' }
		});
		editor.dispatchEvent(paste);
		await tick();

		expect(paste.defaultPrevented).toBe(true);
		expect(lineTexts(container)).toEqual(['First task', 'Second task']);
		expect(container.querySelectorAll('[data-task-row]')).toHaveLength(2);
		expect(
			container.querySelector('[data-editor-line="1"] [data-checklist-toggle]')?.className
		).toContain('checked');
		expect(
			[...editor.childNodes].filter(
				(node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
			)
		).toHaveLength(0);
	});

	it('indents the current text segment with Tab and outdents with Control+Tab', async () => {
		const { container } = render(BodyEditor, { props: { body: 'Hello' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		select(container.querySelector('[data-line-text]') as HTMLElement, 0);

		const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		editor.dispatchEvent(tab);
		await tick();

		expect(tab.defaultPrevented).toBe(true);
		expect(lineTexts(container)).toEqual(['  Hello']);
		expect(document.activeElement).toBe(editor);

		const controlTab = new KeyboardEvent('keydown', {
			key: 'Tab',
			ctrlKey: true,
			bubbles: true,
			cancelable: true
		});
		editor.dispatchEvent(controlTab);
		await tick();

		expect(controlTab.defaultPrevented).toBe(true);
		expect(lineTexts(container)).toEqual(['Hello']);
	});

	it('outdents a text segment with Shift+Tab', async () => {
		const { container } = render(BodyEditor, { props: { body: '  Hello' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		select(container.querySelector('[data-line-text]') as HTMLElement, 2);

		await fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true });
		await tick();

		expect(lineTexts(container)).toEqual(['Hello']);
	});

	it('indents a selection that spans whole editor rows', async () => {
		const { container } = render(BodyEditor, { props: { body: 'First\nSecond\nThird' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const rows = [...container.querySelectorAll('[data-editor-line]')];
		const range = document.createRange();
		range.setStart(rows[0], 0);
		range.setEnd(rows[1], rows[1].childNodes.length);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		await fireEvent.keyDown(editor, { key: 'Tab' });
		await tick();

		expect(lineTexts(container)).toEqual(['  First', '  Second', 'Third']);
		expect(window.getSelection()?.isCollapsed).toBe(false);
		expect(window.getSelection()?.toString()).toContain('First');
		expect(window.getSelection()?.toString()).toContain('Second');

		await fireEvent.keyDown(editor, { key: 'Tab' });
		await tick();

		expect(lineTexts(container)).toEqual(['    First', '    Second', 'Third']);
	});

	it('indents every selected text segment and keeps the selection', async () => {
		const { container } = render(BodyEditor, { props: { body: 'First\nSecond' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const rows = container.querySelectorAll('[data-line-text]');
		select(rows[0], 0, rows[1], 'Second'.length);

		await fireEvent.keyDown(editor, { key: 'Tab' });
		await tick();

		expect(lineTexts(container)).toEqual(['  First', '  Second']);
		expect(window.getSelection()?.toString()).toContain('First');
		expect(window.getSelection()?.toString()).toContain('Second');
		expect(window.getSelection()?.isCollapsed).toBe(false);

		await fireEvent.keyDown(editor, { key: 'Tab' });
		await tick();

		expect(lineTexts(container)).toEqual(['    First', '    Second']);
		expect(window.getSelection()?.toString()).toContain('First');
		expect(window.getSelection()?.toString()).toContain('Second');
	});

	it('does not indent the previous line when the range starts on a row boundary', async () => {
		const { container } = render(BodyEditor, { props: { body: 'a\nb\nc' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const rows = [...container.querySelectorAll('[data-editor-line]')];
		const texts = [...container.querySelectorAll('[data-line-text]')];
		const range = document.createRange();
		// Shift+ArrowUp from C to the start of B lands here: B's row start is the
		// same DOM point as the end of A, which intersectsNode treats as selecting A.
		range.setStart(rows[1], 0);
		range.setEnd(textNode(texts[2]), 'c'.length);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		await fireEvent.keyDown(editor, { key: 'Tab' });
		await tick();

		expect(lineTexts(container)).toEqual(['a', '  b', '  c']);
	});

	it('does not indent a line whose only selected point is its trailing boundary', async () => {
		const { container } = render(BodyEditor, { props: { body: 'a\nb\nc' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const texts = [...container.querySelectorAll('[data-line-text]')];
		const range = document.createRange();
		range.setStart(textNode(texts[0]), 'a'.length);
		range.setEnd(textNode(texts[2]), 'c'.length);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		await fireEvent.keyDown(editor, { key: 'Tab' });
		await tick();

		expect(lineTexts(container)).toEqual(['a', '  b', '  c']);
	});

	it('indents a reversed keyboard selection of later lines only', async () => {
		const { container } = render(BodyEditor, { props: { body: 'a\nb\nc' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const texts = [...container.querySelectorAll('[data-line-text]')];
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.setBaseAndExtent(textNode(texts[2]), 'c'.length, textNode(texts[1]), 0);

		await fireEvent.keyDown(editor, { key: 'Tab' });
		await tick();

		expect(lineTexts(container)).toEqual(['a', '  b', '  c']);
		expect(window.getSelection()?.toString()).toContain('b');
		expect(window.getSelection()?.toString()).toContain('c');
		expect(window.getSelection()?.toString()).not.toContain('a');
	});

	it('indents a text segment more than four times', async () => {
		const { container } = render(BodyEditor, { props: { body: 'Hello' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		select(container.querySelector('[data-line-text]') as HTMLElement, 0);

		for (let step = 0; step < 5; step++) {
			await fireEvent.keyDown(editor, { key: 'Tab' });
			await tick();
		}

		expect(lineTexts(container)).toEqual([`${'  '.repeat(5)}Hello`]);
	});

	it('keeps a partial selection after indenting a line', async () => {
		const { container } = render(BodyEditor, { props: { body: 'Hello world' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const line = container.querySelector('[data-line-text]') as HTMLElement;
		select(line, 6, line, 11);

		await fireEvent.keyDown(editor, { key: 'Tab' });
		await tick();

		expect(lineTexts(container)).toEqual(['  Hello world']);
		expect(window.getSelection()?.toString()).toBe('world');
	});

	it('nests a checklist line under the previous task with Tab', async () => {
		const { container } = render(BodyEditor, { props: { body: '[ ] parent\n[ ] child' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const rows = container.querySelectorAll('[data-line-text]');
		select(rows[1], 0);

		await fireEvent.keyDown(editor, { key: 'Tab' });
		await tick();

		expect(lineTexts(container)).toEqual(['parent', 'child']);
		expect(
			container.querySelector('[data-editor-line="1"] [data-checklist-toggle]')?.className
		).toContain('checklist-toggle-sub');
		expect(container.querySelector('[data-editor-line="1"]')?.getAttribute('style')).toContain(
			'padding-left'
		);
	});

	it('restores a single copied checklist line as a task', async () => {
		const { container } = render(BodyEditor, { props: { body: '' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		select(container.querySelector('[data-line-text]') as HTMLElement, 0);
		const paste = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(paste, 'clipboardData', {
			value: { getData: () => '[x] Finished task' }
		});

		editor.dispatchEvent(paste);
		await tick();

		expect(lineTexts(container)).toEqual(['Finished task']);
		expect(container.querySelector('[data-checklist-toggle]')?.className).toContain('checked');
	});
});

describe('BodyEditor markdown bullets', () => {
	it('renders markdown bullet rows with a marker', () => {
		const { container } = render(BodyEditor, { props: { body: '- Milk\n* Bread' } });
		expect(lineTexts(container)).toEqual(['Milk', 'Bread']);
		expect(container.querySelectorAll('[data-bullet-row]')).toHaveLength(2);
		expect(container.querySelectorAll('[data-task-row]')).toHaveLength(0);
	});

	it('continues a bullet list with Enter and exits on an empty bullet', async () => {
		const { container } = render(BodyEditor, { props: { body: '- Milk' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const line = container.querySelector('[data-line-text]') as HTMLElement;
		select(line, 'Milk'.length);

		await fireEvent.keyDown(editor, { key: 'Enter' });
		await tick();

		expect(lineTexts(container)).toEqual(['Milk', '']);
		expect(container.querySelectorAll('[data-bullet-row]')).toHaveLength(2);

		await fireEvent.keyDown(editor, { key: 'Enter' });
		await tick();

		expect(container.querySelectorAll('[data-bullet-row]')).toHaveLength(1);
		expect(lineTexts(container)).toEqual(['Milk', '']);
		expect(document.activeElement).toBe(editor);
	});

	it('splits bullet text across two rows at the same level', async () => {
		const { container } = render(BodyEditor, { props: { body: '- Milk Bread' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const line = container.querySelector('[data-line-text]') as HTMLElement;
		select(line, 'Milk '.length);

		await fireEvent.keyDown(editor, { key: 'Enter' });
		await tick();

		expect(lineTexts(container)).toEqual(['Milk ', 'Bread']);
		expect(container.querySelectorAll('[data-bullet-row]')).toHaveLength(2);
	});

	it('converts a typed dash prefix into a bullet while editing', async () => {
		const { container } = render(BodyEditor, { props: { body: 'Milk' } });
		const line = container.querySelector('[data-line-text]') as HTMLElement;
		select(line, 0);

		line.textContent = '- Milk';
		await fireEvent.input(line);

		expect(lineTexts(container)).toEqual(['Milk']);
		expect(container.querySelectorAll('[data-bullet-row]')).toHaveLength(1);
	});

	it('pastes bullet lines as bullet rows', async () => {
		const { container } = render(BodyEditor, { props: { body: '' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		select(container.querySelector('[data-line-text]') as HTMLElement, 0);

		const paste = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(paste, 'clipboardData', {
			value: { getData: () => '- Milk\n* Bread' }
		});
		editor.dispatchEvent(paste);
		await tick();

		expect(paste.defaultPrevented).toBe(true);
		expect(lineTexts(container)).toEqual(['Milk', 'Bread']);
		expect(container.querySelectorAll('[data-bullet-row]')).toHaveLength(2);
	});

	it('copies a whole bullet line with its markdown marker', async () => {
		const { container } = render(BodyEditor, { props: { body: '- Milk\nplain' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		const rows = container.querySelectorAll('[data-line-text]');
		select(rows[0], 0, rows[0], 'Milk'.length);

		const setData = vi.fn();
		const copy = new Event('copy', { bubbles: true, cancelable: true });
		Object.defineProperty(copy, 'clipboardData', { value: { setData } });
		editor.dispatchEvent(copy);

		expect(setData).toHaveBeenCalledWith('text/plain', '- Milk');
	});

	it('indents bullet rows with Tab and outdents with Shift+Tab', async () => {
		const { container } = render(BodyEditor, { props: { body: '- Milk' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		select(container.querySelector('[data-line-text]') as HTMLElement, 0);

		await fireEvent.keyDown(editor, { key: 'Tab' });
		await tick();

		expect(lineTexts(container)).toEqual(['Milk']);
		expect(container.querySelectorAll('[data-bullet-row]')).toHaveLength(1);
		expect(container.querySelector('[data-editor-line="0"]')?.getAttribute('style')).toContain(
			'padding-left'
		);

		await fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true });
		await tick();

		expect(
			container.querySelector('[data-editor-line="0"]')?.getAttribute('style') ?? ''
		).not.toContain('padding-left');
	});

	it('outdents a nested bullet with Backspace while keeping its text', async () => {
		const { container } = render(BodyEditor, { props: { body: '  - Milk' } });
		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		select(container.querySelector('[data-line-text]') as HTMLElement, 0);

		await fireEvent.keyDown(editor, { key: 'Backspace' });
		await tick();

		expect(lineTexts(container)).toEqual(['Milk']);
		expect(container.querySelectorAll('[data-bullet-row]')).toHaveLength(1);
		expect(
			container.querySelector('[data-editor-line="0"]')?.getAttribute('style') ?? ''
		).not.toContain('padding-left');
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

	it('aligns Add sub-task with subtask indentation and avoids double indenting under existing subtasks', async () => {
		const { container: c1 } = render(BodyEditor, {
			props: { body: '[ ] Avocados\n[ ] Dark chocolate', focusLine: 0 }
		});
		await tick();

		const buttonNoSub = c1.querySelector('[data-add-subtask]') as HTMLButtonElement;
		expect(buttonNoSub).not.toBeNull();
		expect(buttonNoSub.className).toContain('pl-6');
		expect(buttonNoSub.className).not.toContain('pl-1');

		const { container: c2 } = render(BodyEditor, {
			props: { body: '[ ] Avocados\n  [ ] Hass\n[ ] Dark chocolate', focusLine: 0 }
		});
		await tick();

		const buttonWithSub = c2.querySelector('[data-add-subtask]') as HTMLButtonElement;
		expect(buttonWithSub).not.toBeNull();
		expect(buttonWithSub.className).toContain('pl-1');
		expect(buttonWithSub.className).not.toContain('pl-6');
	});

	it('preserves the subtask draft across mobile pointerdown and blur cycles', async () => {
		const onFocusTask = vi.fn();
		const { container } = render(BodyEditor, {
			props: { body: '[ ] Avocados\n  [ ] Hass\n[ ] Dark chocolate', focusLine: 0, onFocusTask }
		});
		await tick();

		const addBtn = container.querySelector('[data-add-subtask]') as HTMLButtonElement;
		expect(addBtn).not.toBeNull();

		await fireEvent.pointerDown(addBtn, { pointerId: 42, pointerType: 'touch' });
		expect(container.querySelectorAll('[data-task-row]')).toHaveLength(4);

		const editor = container.querySelector('[data-body-editor]') as HTMLElement;
		await fireEvent.blur(editor, { relatedTarget: null });

		expect(container.querySelectorAll('[data-task-row]')).toHaveLength(4);

		await fireEvent.pointerUp(editor, { pointerId: 42, pointerType: 'touch' });
	});

	it('ignores editor click when target is the add subtask button', async () => {
		const onFocusTask = vi.fn();
		const { container } = render(BodyEditor, {
			props: { body: '[ ] Avocados\n  [ ] Hass\n[ ] Dark chocolate', focusLine: 0, onFocusTask }
		});
		await tick();

		const addBtn = container.querySelector('[data-add-subtask]') as HTMLButtonElement;
		onFocusTask.mockClear();

		// Clicking the button directly should not trigger container's handleEditorClick row refocus
		await fireEvent.click(addBtn);
		expect(container.querySelectorAll('[data-task-row]')).toHaveLength(4);
	});
});
