import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealEditorField, scrollTopForReveal } from './editorVisibility';

const viewport = { top: 100, bottom: 500 };

function rect(top: number, bottom: number, left = 0, width = 200): DOMRect {
	return {
		top,
		bottom,
		left,
		right: left + width,
		width,
		height: bottom - top,
		x: left,
		y: top,
		toJSON: () => ({})
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe('scrollTopForReveal', () => {
	it('does not move an already visible caret line', () => {
		expect(scrollTopForReveal(300, { top: 220, bottom: 240 }, viewport)).toBe(300);
	});

	it('reveals a caret line hidden below the keyboard edge', () => {
		expect(scrollTopForReveal(300, { top: 510, bottom: 530 }, viewport)).toBe(342);
	});

	it('reveals the caret instead of the top of a tall textarea', () => {
		expect(scrollTopForReveal(300, { top: 470, bottom: 490 }, viewport)).toBe(302);
	});

	it('reveals a caret line above the editor viewport', () => {
		expect(scrollTopForReveal(300, { top: 70, bottom: 90 }, viewport)).toBe(258);
	});

	it('uses the caret line when the textarea itself extends beyond both edges', () => {
		const scroller = document.createElement('div');
		const textarea = document.createElement('textarea');
		textarea.value = 'A long wrapped task';
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		scroller.append(textarea);
		document.body.append(scroller);
		scroller.scrollTop = 300;

		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement
		) {
			if (this === scroller) return rect(100, 500);
			if (this === textarea) return rect(50, 700);
			if (this instanceof HTMLSpanElement) return rect(470, 490);
			return rect(50, 700);
		});

		revealEditorField(scroller, textarea);

		expect(scroller.scrollTop).toBe(302);
		expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
	});
});
