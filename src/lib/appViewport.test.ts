import { afterEach, describe, expect, it } from 'vitest';
import {
	APP_FLOAT_SELECTOR,
	APP_OVERLAY_SELECTOR,
	appBottomInset,
	appKeyboardFrame,
	isKeyboardField,
	isKeyboardOccluding,
	keyboardOcclusion,
	portalToAppFloat,
	portalToAppOverlay,
	readSafeAreaInsets,
	rememberSafeArea
} from './appViewport';

const safe = { top: 59, right: 0, bottom: 34, left: 0 };

describe('appBottomInset', () => {
	it('keeps the home-indicator safe area on iPad-sized layouts', () => {
		expect(appBottomInset(20, false, false)).toBe(20);
		expect(appBottomInset(20, false, true)).toBe(20);
	});

	it('lets the phone keyboard replace the home-indicator inset', () => {
		expect(appBottomInset(34, true, true)).toBe(0);
		expect(appBottomInset(34, true, false)).toBe(34);
	});
});

describe('appKeyboardFrame', () => {
	it('keeps the generic floating layer aligned to the visual viewport', () => {
		expect(
			appKeyboardFrame({
				editorOpen: false,
				visualTop: 80,
				visualHeight: 360,
				layoutHeight: 844,
				occlusion: { top: 21, bottom: 404 }
			})
		).toEqual({ viewportOffsetTop: 0, keyboardTop: 21, keyboardBottom: 404 });
	});

	it('docks a backup sheet to the visual viewport including the suggestion bar', () => {
		expect(
			appKeyboardFrame({
				editorOpen: false,
				dockToKeyboard: true,
				visualTop: 0,
				visualHeight: 420,
				layoutHeight: 500,
				occlusion: { top: 0, bottom: 0 }
			})
		).toEqual({ viewportOffsetTop: 0, keyboardTop: 0, keyboardBottom: 80 });
	});

	it('anchors an open note and keeps its keyboard height independent of visual panning', () => {
		const frame = (visualTop: number, occlusion: { top: number; bottom: number }) =>
			appKeyboardFrame({
				editorOpen: true,
				visualTop,
				visualHeight: 360,
				layoutHeight: 844,
				occlusion
			});

		expect(frame(80, { top: 21, bottom: 404 })).toEqual({
			viewportOffsetTop: 80,
			keyboardTop: 0,
			keyboardBottom: 484
		});
		expect(frame(120, { top: 61, bottom: 364 })).toEqual({
			viewportOffsetTop: 120,
			keyboardTop: 0,
			keyboardBottom: 484
		});
	});

	it('counters visual panning without adding a keyboard inset when the layout already resized', () => {
		expect(
			appKeyboardFrame({
				editorOpen: true,
				visualTop: 32,
				visualHeight: 500,
				layoutHeight: 500,
				occlusion: { top: 0, bottom: 0 }
			})
		).toEqual({ viewportOffsetTop: 32, keyboardTop: 0, keyboardBottom: 0 });
	});
});

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

	it('appends floating content to its host and removes it during cleanup', () => {
		const host = document.createElement('div');
		host.setAttribute('data-app-float', '');
		document.body.append(host);
		const node = document.createElement('div');
		const cleanup = portalToAppFloat(node);
		expect(host.contains(node)).toBe(true);
		expect(document.querySelector(APP_FLOAT_SELECTOR)).toBe(host);
		cleanup();
		expect(host.contains(node)).toBe(false);
	});

	it('places global dialogs in the app overlay above navigation', () => {
		const host = document.createElement('div');
		host.setAttribute('data-app-overlay', '');
		document.body.append(host);
		const node = document.createElement('div');
		const cleanup = portalToAppOverlay(node);
		expect(host.contains(node)).toBe(true);
		expect(document.querySelector(APP_OVERLAY_SELECTOR)).toBe(host);
		cleanup();
		expect(host.contains(node)).toBe(false);
	});
});
