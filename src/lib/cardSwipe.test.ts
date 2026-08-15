import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardSwipeStyle } from './cardSwipe';

const originalMatchMedia = window.matchMedia;

afterEach(() => {
	window.matchMedia = originalMatchMedia;
});

describe('cardSwipeStyle', () => {
	it('returns to rest without animation when reduced motion is requested', () => {
		window.matchMedia = vi.fn().mockReturnValue({ matches: true });

		expect(cardSwipeStyle(0, false)).toContain('transition: none;');
	});

	it('keeps the return animation when reduced motion is not requested', () => {
		window.matchMedia = vi.fn().mockReturnValue({ matches: false });

		expect(cardSwipeStyle(0, false)).toContain('transition: transform 0.25s');
	});
});
