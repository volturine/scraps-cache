import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import BodyEditor from './BodyEditor.svelte';

describe('BodyEditor empty task Enter behavior', () => {
	it('replaces an empty root task with a focused plain-text line', async () => {
		const { container } = render(BodyEditor, { props: { body: '[ ] \nafter' } });
		const task = container.querySelector('textarea[data-line-id]') as HTMLTextAreaElement;

		await fireEvent.keyDown(task, { key: 'Enter' });

		expect(container.querySelector('[data-checklist-toggle]')).toBeNull();
		const plainText = container.querySelector('[data-plain-run="0"]') as HTMLTextAreaElement;
		expect(plainText.value).toBe('\nafter');
		expect(document.activeElement).toBe(plainText);
	});

	it('keeps the existing empty sub-task Enter behavior', async () => {
		const { container } = render(BodyEditor, { props: { body: '[ ] parent\n  [ ] ' } });
		const tasks = container.querySelectorAll('textarea[data-line-id]');

		await fireEvent.keyDown(tasks[1], { key: 'Enter' });

		expect(container.querySelectorAll('[data-checklist-toggle]')).toHaveLength(2);
	});
});

describe('BodyEditor task focus chrome', () => {
	it('keeps plain text in place when a task group receives focus', async () => {
		const { container } = render(BodyEditor, {
			props: { body: '[ ] Parent\ncontext between tasks\n  [ ] Child', focusLine: 0 }
		});
		await tick();

		expect([...container.querySelectorAll('textarea')].map((field) => field.value)).toEqual([
			'Parent',
			'context between tasks',
			'Child'
		]);
	});

	it('shows Add sub-task on the focused root and drops it when focus leaves', async () => {
		const { container, rerender } = render(BodyEditor, {
			props: { body: '[ ] Avocados\n  [ ] tes\n[ ] Dark chocolate', focusLine: 0 }
		});
		await tick();

		expect(container.querySelector('[data-focus-group]')).not.toBeNull();
		expect(container.querySelector('[data-add-subtask]')).not.toBeNull();

		await rerender({ body: '[ ] Avocados\n  [ ] tes\n[ ] Dark chocolate', focusLine: null });
		await tick();

		expect(container.querySelector('[data-focus-group]')).toBeNull();
		expect(container.querySelector('[data-add-subtask]')).toBeNull();
	});
});

describe('BodyEditor task selection', () => {
	it('deletes multiple selected tasks and promotes a surviving sub-task', async () => {
		vi.useFakeTimers();
		const { container } = render(BodyEditor, {
			props: { body: '[ ] Parent\n  [ ] Child\n[ ] Keep', focusLine: 0 }
		});
		await tick();

		const parentToggle = container.querySelector('[data-checklist-toggle]') as HTMLButtonElement;
		const hold = new Event('pointerdown', { bubbles: true });
		Object.defineProperties(hold, {
			pointerType: { value: 'touch' },
			pointerId: { value: 1 },
			clientX: { value: 10 },
			clientY: { value: 10 }
		});
		parentToggle.dispatchEvent(hold);
		await vi.advanceTimersByTimeAsync(450);

		await fireEvent.click(
			container.querySelector('[aria-label="Select Keep"]') as HTMLButtonElement
		);

		expect(container.querySelector('[data-task-selection-toolbar]')?.textContent).toContain(
			'2 selected'
		);
		await fireEvent.click(container.querySelector('[aria-label="Delete 2 selected tasks"]')!);

		const remaining = container.querySelector('textarea[data-line-id]') as HTMLTextAreaElement;
		expect(remaining.value).toBe('Child');
		expect(remaining.placeholder).toBe('Task');
		expect(container.querySelectorAll('[data-task-row]')).toHaveLength(1);
		expect(container.querySelector('[data-task-selection-toolbar]')).toBeNull();
		vi.useRealTimers();
	});
});
