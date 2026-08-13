import { describe, expect, it } from 'vitest';
import { formatCheckLine, parseBody, parseCheckLine, toggleLineAt } from './checklistBody';

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

	it('preserves indent when toggling', () => {
		const body = ['[ ] a', '  [ ] b'].join('\n');
		expect(toggleLineAt(body, 1)).toBe(['[ ] a', '  [x] b'].join('\n'));
		expect(toggleLineAt(toggleLineAt(body, 1), 1)).toBe(body);
	});
});
