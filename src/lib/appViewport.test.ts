import { afterEach, describe, expect, it } from 'vitest';
import {
	APP_FLOAT_SELECTOR,
	isKeyboardField,
	isKeyboardOccluding,
	keyboardOcclusion,
	portalToAppFloat,
	readSafeAreaInsets,
	rememberSafeArea
} from './appViewport';

const safe = { top: 59, right: 0, bottom: 34, left: 0 };

describe('isKeyboardOccluding', () => {
	it('is false when no field is focused, even if the visual viewport is short', () => {
		expect(isKeyboardOccluding({ fieldFocused: false, visualHeight: 400, layoutHeight: 800 })).toBe(
			false
		);
	});

	it('is false when the visual viewport is only slightly shorter than the layout viewport', () => {
		expect(isKeyboardOccluding({ fieldFocused: true, visualHeight: 720, layoutHeight: 800 })).toBe(
			false
		);
	});

	it('is true when a field is focused and the visual viewport has shrunk for the keyboard', () => {
		expect(isKeyboardOccluding({ fieldFocused: true, visualHeight: 400, layoutHeight: 800 })).toBe(
			true
		);
	});
});

describe('keyboardOcclusion', () => {
	it('adds nothing when the layout viewport already resized with the keyboard', () => {
		expect(
			keyboardOcclusion({
				fieldFocused: true,
				visualTop: 0,
				visualHeight: 500,
				layoutHeight: 500,
				restingLayoutHeight: 844,
				safe
			})
		).toEqual({ top: 0, bottom: 0 });
	});

	it('adds nothing when the keyboard is not occluding the visual viewport', () => {
		expect(
			keyboardOcclusion({
				fieldFocused: false,
				visualTop: 0,
				visualHeight: 400,
				layoutHeight: 800,
				safe
			})
		).toEqual({ top: 0, bottom: 0 });
	});

	it('raises the overlay layer above the keyboard without eating the status-bar inset', () => {
		expect(
			keyboardOcclusion({
				fieldFocused: true,
				visualTop: 0,
				visualHeight: 420,
				layoutHeight: 844,
				safe
			})
		).toEqual({ top: 0, bottom: 844 - 420 });
	});

	it('shifts the overlay layer down when iOS pans the visual viewport', () => {
		expect(
			keyboardOcclusion({
				fieldFocused: true,
				visualTop: 80,
				visualHeight: 360,
				layoutHeight: 844,
				safe
			})
		).toEqual({ top: 80 - 59, bottom: 844 - 440 });
	});
});

describe('rememberSafeArea', () => {
	it('keeps the last real insets if iOS reports 0 while the keyboard is up', () => {
		expect(rememberSafeArea(safe, { top: 0, right: 0, bottom: 0, left: 0 }, true)).toEqual(safe);
	});

	it('takes a fresh measurement when the keyboard is down', () => {
		const next = { top: 47, right: 0, bottom: 34, left: 0 };
		expect(rememberSafeArea(safe, next, false)).toEqual(next);
	});
});

describe('isKeyboardField', () => {
	it('treats text fields as keyboard hosts and ignores chrome controls', () => {
		const input = document.createElement('input');
		const file = document.createElement('input');
		file.type = 'file';
		const button = document.createElement('button');
		document.body.append(input, file, button);
		expect(isKeyboardField(input)).toBe(true);
		expect(isKeyboardField(file)).toBe(false);
		expect(isKeyboardField(button)).toBe(false);
		input.remove();
		file.remove();
		button.remove();
	});
});

describe('readSafeAreaInsets', () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it('reads non-negative insets from the document', () => {
		const insets = readSafeAreaInsets();
		expect(insets.top).toBeGreaterThanOrEqual(0);
		expect(insets.bottom).toBeGreaterThanOrEqual(0);
	});
});

describe('portalToAppFloat', () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it('appends overlays to the app float host when it exists', () => {
		const host = document.createElement('div');
		host.setAttribute('data-app-float', '');
		document.body.append(host);
		const node = document.createElement('div');
		portalToAppFloat(node);
		expect(host.contains(node)).toBe(true);
		expect(document.querySelector(APP_FLOAT_SELECTOR)).toBe(host);
	});
});
