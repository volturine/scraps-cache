/** Visual viewport must shrink by more than this before the keyboard is treated as open. */
export const KEYBOARD_HEIGHT_THRESHOLD_PX = 120;

export const APP_FLOAT_SELECTOR = '[data-app-float]';
export const APP_OVERLAY_SELECTOR = '[data-app-overlay]';
export const PHONE_MEDIA = '(max-width: 767px)';

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
	restingLayoutHeight?: number;
	safe: Insets;
}): { top: number; bottom: number } {
	if (!options.fieldFocused || options.visualHeight <= 0) {
		return { top: 0, bottom: 0 };
	}
	// The window already shrank with the keyboard. Another inset would
	// leave a gap the size of the keyboard.
	const resting = options.restingLayoutHeight ?? 0;
	if (resting > 0 && options.layoutHeight < resting - KEYBOARD_HEIGHT_THRESHOLD_PX) {
		return { top: 0, bottom: 0 };
	}
	if (!isKeyboardOccluding(options)) {
		return { top: 0, bottom: 0 };
	}
	const visualBottom = options.visualTop + options.visualHeight;
	return {
		top: Math.max(0, options.visualTop - options.safe.top),
		bottom: Math.max(0, options.layoutHeight - visualBottom)
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

export function appBottomInset(
	safeBottom: number,
	onPhone: boolean,
	fieldFocused: boolean
): number {
	return onPhone && fieldFocused ? 0 : safeBottom;
}

export type AppKeyboardFrame = {
	viewportOffsetTop: number;
	keyboardTop: number;
	keyboardBottom: number;
	/** Resting layout height to pin `.app-viewport` to, or null to stretch. */
	lockFrameHeight: number | null;
};

export function keyboardCoverPx(restingLayoutHeight: number, visualHeight: number): number {
	if (restingLayoutHeight <= 0 || visualHeight <= 0) return 0;
	const cover = restingLayoutHeight - visualHeight;
	return cover > KEYBOARD_HEIGHT_THRESHOLD_PX ? cover : 0;
}

/**
 * Keep the notes canvas on the visual screen. Safari may pan or resize the
 * layout viewport when a field is focused. Dialogs lock the canvas at its
 * pre-keyboard size and only shrink the floating layer. The editor keeps
 * filling the (possibly resized) visual screen.
 */
export function appKeyboardFrame(options: {
	editorOpen: boolean;
	fieldFocused?: boolean;
	visualTop: number;
	visualHeight: number;
	layoutHeight: number;
	restingLayoutHeight?: number;
	occlusion: { top: number; bottom: number };
}): AppKeyboardFrame {
	const keyboardOverlaysLayout = options.occlusion.top > 0 || options.occlusion.bottom > 0;
	if (options.editorOpen) {
		if (!keyboardOverlaysLayout) {
			return {
				viewportOffsetTop: Math.max(0, options.visualTop),
				keyboardTop: 0,
				keyboardBottom: 0,
				lockFrameHeight: null
			};
		}
		return {
			viewportOffsetTop: Math.max(0, options.visualTop),
			keyboardTop: 0,
			keyboardBottom: Math.max(0, options.layoutHeight - options.visualHeight),
			lockFrameHeight: null
		};
	}

	const resting = options.restingLayoutHeight ?? options.layoutHeight;
	const cover = options.fieldFocused ? keyboardCoverPx(resting, options.visualHeight) : 0;
	if (cover <= 0 && !keyboardOverlaysLayout) {
		return {
			viewportOffsetTop: 0,
			keyboardTop: 0,
			keyboardBottom: 0,
			lockFrameHeight: null
		};
	}

	return {
		viewportOffsetTop: Math.max(0, options.visualTop),
		keyboardTop: 0,
		keyboardBottom: cover > 0 ? cover : Math.max(0, options.layoutHeight - options.visualHeight),
		lockFrameHeight: resting
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
	let restingLayoutHeight = window.innerHeight;
	let editorOpen = document.documentElement.classList.contains('editor-open');
	const phone = window.matchMedia(PHONE_MEDIA);

	const apply = () => {
		const viewport = window.visualViewport;
		const visualHeight = viewport?.height ?? window.innerHeight;
		const visualTop = viewport?.offsetTop ?? 0;
		const layoutHeight = window.innerHeight;
		const onPhone = phone.matches;
		if (!fieldFocused) {
			restingLayoutHeight = Math.max(layoutHeight, visualHeight);
		}

		const occluding =
			onPhone &&
			(isKeyboardOccluding({
				fieldFocused,
				visualHeight,
				layoutHeight
			}) ||
				keyboardCoverPx(restingLayoutHeight, visualHeight) > 0);
		cachedSafe = rememberSafeArea(cachedSafe, readSafeAreaInsets(), occluding);
		const occlusion = onPhone
			? keyboardOcclusion({
					fieldFocused,
					visualTop,
					visualHeight,
					layoutHeight,
					restingLayoutHeight,
					safe: cachedSafe
				})
			: { top: 0, bottom: 0 };
		const keyboardFrame = appKeyboardFrame({
			editorOpen: onPhone && editorOpen,
			fieldFocused: onPhone && fieldFocused,
			visualTop,
			visualHeight,
			layoutHeight,
			restingLayoutHeight,
			occlusion
		});

		const lockFrameHeight = keyboardFrame.lockFrameHeight;
		document.documentElement.classList.toggle('keyboard-open', onPhone && fieldFocused);
		document.documentElement.classList.toggle('keyboard-lock-canvas', lockFrameHeight != null);
		setInsetVar('--app-inset-top', cachedSafe.top);
		setInsetVar('--app-inset-right', cachedSafe.right);
		// Keep installed iPhone and iPad controls above the home indicator. When
		// the phone keyboard is active, its own occlusion replaces this inset.
		setInsetVar('--app-inset-bottom', appBottomInset(cachedSafe.bottom, onPhone, fieldFocused));
		setInsetVar('--app-inset-left', cachedSafe.left);
		setInsetVar('--app-visual-offset-top', keyboardFrame.viewportOffsetTop);
		setInsetVar('--app-keyboard-top', keyboardFrame.keyboardTop);
		setInsetVar('--app-keyboard-bottom', keyboardFrame.keyboardBottom);
		if (lockFrameHeight != null) {
			setInsetVar('--app-frame-height', Math.max(0, lockFrameHeight - cachedSafe.top));
			if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
		} else {
			document.documentElement.style.removeProperty('--app-frame-height');
		}
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
	const editorClassObserver = new MutationObserver(() => {
		const nextEditorOpen = document.documentElement.classList.contains('editor-open');
		if (nextEditorOpen === editorOpen) return;
		editorOpen = nextEditorOpen;
		apply();
	});

	apply();
	const viewport = window.visualViewport;
	viewport?.addEventListener('resize', apply);
	viewport?.addEventListener('scroll', apply);
	window.addEventListener('resize', apply);
	phone.addEventListener('change', apply);
	document.addEventListener('focusin', onFocusIn);
	document.addEventListener('focusout', onFocusOut);
	editorClassObserver.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['class']
	});
	return () => {
		viewport?.removeEventListener('resize', apply);
		viewport?.removeEventListener('scroll', apply);
		window.removeEventListener('resize', apply);
		phone.removeEventListener('change', apply);
		document.removeEventListener('focusin', onFocusIn);
		document.removeEventListener('focusout', onFocusOut);
		editorClassObserver.disconnect();
		document.documentElement.classList.remove('keyboard-open');
		document.documentElement.classList.remove('keyboard-lock-canvas');
		document.documentElement.style.removeProperty('--app-frame-height');
	};
}

/** Render an overlay into the keyboard-aware layer. Falls back to body in tests. */
export function portalToAppFloat(node: HTMLElement) {
	const host = document.querySelector(APP_FLOAT_SELECTOR) ?? document.body;
	host.appendChild(node);
	return () => node.remove();
}

/** Render a global dialog above navigation and remove it with its owner. */
export function portalToAppOverlay(node: HTMLElement) {
	const host = document.querySelector(APP_OVERLAY_SELECTOR) ?? document.body;
	host.appendChild(node);
	return () => node.remove();
}
