/** Visual viewport must shrink by more than this before the keyboard is treated as open. */
export const KEYBOARD_HEIGHT_THRESHOLD_PX = 120;

export const APP_FLOAT_SELECTOR = '[data-app-float]';

export type Insets = { top: number; right: number; bottom: number; left: number };

const NON_KEYBOARD_INPUT_TYPES = new Set([
	'button',
	'checkbox',
	'color',
	'file',
	'hidden',
	'image',
	'radio',
	'range',
	'reset',
	'submit'
]);

export function isKeyboardField(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target instanceof HTMLInputElement) return !NON_KEYBOARD_INPUT_TYPES.has(target.type);
	if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
	return !!target.closest('[contenteditable]');
}

export function isKeyboardOccluding(options: {
	fieldFocused: boolean;
	visualHeight: number;
	layoutHeight: number;
}): boolean {
	return (
		options.fieldFocused &&
		options.visualHeight > 0 &&
		options.visualHeight < options.layoutHeight - KEYBOARD_HEIGHT_THRESHOLD_PX
	);
}

/** Extra inset inside the safe rectangle while the software keyboard is up. */
export function keyboardOcclusion(options: {
	fieldFocused: boolean;
	visualTop: number;
	visualHeight: number;
	layoutHeight: number;
	safe: Insets;
}): { top: number; bottom: number } {
	if (!isKeyboardOccluding(options) || options.visualHeight <= 0) {
		return { top: 0, bottom: 0 };
	}
	const visualBottom = options.visualTop + options.visualHeight;
	return {
		top: Math.max(0, options.visualTop - options.safe.top),
		bottom: Math.max(0, options.layoutHeight - visualBottom - options.safe.bottom)
	};
}

export function rememberSafeArea(
	cached: Insets,
	measured: Insets,
	keyboardOccluding: boolean
): Insets {
	if (!keyboardOccluding) return measured;
	return {
		top: measured.top > 0 ? measured.top : cached.top,
		right: measured.right > 0 ? measured.right : cached.right,
		bottom: measured.bottom > 0 ? measured.bottom : cached.bottom,
		left: measured.left > 0 ? measured.left : cached.left
	};
}

export function readSafeAreaInsets(): Insets {
	if (typeof document === 'undefined') return { top: 0, right: 0, bottom: 0, left: 0 };
	const probe = document.createElement('div');
	probe.style.cssText =
		'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
	document.body.appendChild(probe);
	const style = getComputedStyle(probe);
	const insets = {
		top: Number.parseFloat(style.paddingTop) || 0,
		right: Number.parseFloat(style.paddingRight) || 0,
		bottom: Number.parseFloat(style.paddingBottom) || 0,
		left: Number.parseFloat(style.paddingLeft) || 0
	};
	probe.remove();
	return insets;
}

function setInsetVar(name: string, value: number) {
	document.documentElement.style.setProperty(name, `${value}px`);
}

/**
 * Root attachment: measure the device safe area and keyboard, then publish
 * them as CSS variables. The `.app-viewport` / `.app-float` layers consume
 * those variables so individual screens do not.
 */
export function attachAppViewport(_node: HTMLElement) {
	let cachedSafe: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
	let fieldFocused = isKeyboardField(document.activeElement);
	let layoutWidth = 0;
	let layoutHeight = 0;

	const apply = () => {
		const viewport = window.visualViewport;
		const visualHeight = viewport?.height ?? window.innerHeight;
		const visualTop = viewport?.offsetTop ?? 0;
		if (layoutWidth !== window.innerWidth || layoutHeight === 0) {
			layoutWidth = window.innerWidth;
			layoutHeight = Math.max(window.innerHeight, visualHeight);
		} else {
			layoutHeight = Math.max(layoutHeight, window.innerHeight, visualHeight);
		}

		const occluding = isKeyboardOccluding({
			fieldFocused,
			visualHeight,
			layoutHeight
		});
		cachedSafe = rememberSafeArea(cachedSafe, readSafeAreaInsets(), occluding);
		const occlusion = keyboardOcclusion({
			fieldFocused,
			visualTop,
			visualHeight,
			layoutHeight,
			safe: cachedSafe
		});

		setInsetVar('--app-inset-top', cachedSafe.top);
		setInsetVar('--app-inset-right', cachedSafe.right);
		setInsetVar('--app-inset-bottom', cachedSafe.bottom);
		setInsetVar('--app-inset-left', cachedSafe.left);
		setInsetVar('--app-keyboard-top', occlusion.top);
		setInsetVar('--app-keyboard-bottom', occlusion.bottom);
	};

	const onFocusIn = (event: FocusEvent) => {
		fieldFocused = isKeyboardField(event.target);
		apply();
	};
	const onFocusOut = () => {
		queueMicrotask(() => {
			fieldFocused = isKeyboardField(document.activeElement);
			apply();
		});
	};

	apply();
	const viewport = window.visualViewport;
	viewport?.addEventListener('resize', apply);
	viewport?.addEventListener('scroll', apply);
	window.addEventListener('resize', apply);
	document.addEventListener('focusin', onFocusIn);
	document.addEventListener('focusout', onFocusOut);
	return () => {
		viewport?.removeEventListener('resize', apply);
		viewport?.removeEventListener('scroll', apply);
		window.removeEventListener('resize', apply);
		document.removeEventListener('focusin', onFocusIn);
		document.removeEventListener('focusout', onFocusOut);
	};
}

/** Render an overlay into the keyboard-aware layer. Falls back to body in tests. */
export function portalToAppFloat(node: HTMLElement) {
	const host = document.querySelector(APP_FLOAT_SELECTOR) ?? document.body;
	host.appendChild(node);
}
