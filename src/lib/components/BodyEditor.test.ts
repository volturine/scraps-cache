import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
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
