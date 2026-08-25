import { describe, expect, it } from 'vitest';
import {
	adjustTextIndent,
	formatCheckLine,
	parseBody,
	parseCheckLine,
	toggleLineAt
} from './checklistBody';

describe('checklist indent / sub-tasks', () => {
	it('parses indented checklist lines as nested tasks', () => {
		const body = ['[ ] parent', '  [ ] child', '    [x] deep', 'plain'].join('\n');
		expect(parseBody(body)).toEqual([
			{ type: 'check', checked: false, text: 'parent', indent: 0, lineIndex: 0 },
			{ type: 'check', checked: false, text: 'child', indent: 1, lineIndex: 1 },
			{ type: 'check', checked: true, text: 'deep', indent: 2, lineIndex: 2 },
			{ type: 'text', text: 'plain', lineIndex: 3 }
		]);
	});

	it('round-trips indent through format/parse', () => {
		const line = formatCheckLine(2, true, 'nested');
		expect(line).toBe('    [x] nested');
		expect(parseCheckLine(line)).toEqual({ indent: 2, checked: true, text: 'nested' });
	});

	it('preserves indent when toggling and completes the parent', () => {
		const body = ['[ ] a', '  [ ] b'].join('\n');
		expect(toggleLineAt(body, 1)).toBe(['[x] a', '  [x] b'].join('\n'));
	});
});

describe('plain-text segment indent', () => {
	it('indents and outdents a line by two spaces', () => {
		expect(adjustTextIndent('Hello', 1)).toEqual({ text: '  Hello', offsetDelta: 2 });
		expect(adjustTextIndent('  Hello', -1)).toEqual({ text: 'Hello', offsetDelta: -2 });
	});

	it('outdents a leading tab or leftover space', () => {
		expect(adjustTextIndent('\tHello', -1)).toEqual({ text: 'Hello', offsetDelta: -1 });
		expect(adjustTextIndent(' Hello', -1)).toEqual({ text: 'Hello', offsetDelta: -1 });
	});

	it('stops at the maximum indent and at the left edge', () => {
		expect(adjustTextIndent('Hello', -1)).toEqual({ text: 'Hello', offsetDelta: 0 });
		expect(adjustTextIndent('        Hello', 1, 4)).toEqual({
			text: '        Hello',
			offsetDelta: 0
		});
	});
});

describe('checklist toggle propagation', () => {
	const body = ['[ ] parent', '  [ ] a', '  [ ] b', '[ ] other'].join('\n');

	it('completes all sub-tasks when the main task is completed', () => {
		expect(toggleLineAt(body, 0)).toBe(
			['[x] parent', '  [x] a', '  [x] b', '[ ] other'].join('\n')
		);
	});

	it('completes the main task when all sub-tasks are completed', () => {
		let next = body;
		next = toggleLineAt(next, 1);
		expect(next).toBe(['[ ] parent', '  [x] a', '  [ ] b', '[ ] other'].join('\n'));
		next = toggleLineAt(next, 2);
		expect(next).toBe(['[x] parent', '  [x] a', '  [x] b', '[ ] other'].join('\n'));
	});

	it('leaves sub-task state untouched when completing a task with no sub-tasks', () => {
		expect(toggleLineAt(body, 3)).toBe(
			['[ ] parent', '  [ ] a', '  [ ] b', '[x] other'].join('\n')
		);
	});

	it('does not complete the parent while any sub-task is unchecked', () => {
		const partial = ['[ ] parent', '  [x] a', '  [ ] b', '  [ ] c'].join('\n');
		const next = toggleLineAt(partial, 2);
		expect(next).toBe(['[ ] parent', '  [x] a', '  [x] b', '  [ ] c'].join('\n'));
	});

	it('unchecks the main task when a sub-task is unchecked', () => {
		const done = ['[x] parent', '  [x] a', '  [x] b', '[ ] other'].join('\n');
		expect(toggleLineAt(done, 2)).toBe(
			['[ ] parent', '  [x] a', '  [ ] b', '[ ] other'].join('\n')
		);
	});
});
