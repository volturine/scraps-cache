/** Shared pointer swipe for note cards (touch + trackpad + mouse). */

import { PHONE_MEDIA } from './appViewport';
import { isSidebarEdgeStart } from './sidebarSwipe';

export type CardSwipeHandlers = {
	onPointerDown: (e: PointerEvent) => void;
	onPointerMove: (e: PointerEvent) => void;
	onPointerUp: (e: PointerEvent) => void;
	onPointerCancel: (e: PointerEvent) => void;
	/** True briefly after a drag so click does not open the note. */
	wasDrag: () => boolean;
	getOffsetX: () => number;
	isDragging: () => boolean;
	/** Cancels pending swipe/click timers; call on component teardown. */
	dispose: () => void;
};

export function createCardSwipe(opts: {
	onSwipeLeft: () => void;
	onSwipeRight: () => void;
	threshold?: number;
	/** Reactive sink so Svelte re-renders while dragging. */
	setVisual: (state: { offsetX: number; dragging: boolean }) => void;
}): CardSwipeHandlers {
	const threshold = opts.threshold ?? 80;
	let offsetX = 0;
	let dragging = false;
	let tracking = false;
	let startX = 0;
	let startY = 0;
	let decidedHorizontal = false;
	let pointerId: number | null = null;
	let justDragged = false;
	let swipeTimer: ReturnType<typeof setTimeout> | null = null;
	let dragResetTimer: ReturnType<typeof setTimeout> | null = null;

	function publish() {
		opts.setVisual({ offsetX, dragging });
	}

	function finishTracking() {
		tracking = false;
		pointerId = null;
		decidedHorizontal = false;
	}

	function onPointerDown(e: PointerEvent) {
		if (tracking) return;
		justDragged = false;
		const target = e.target as HTMLElement;
		if (
			target.closest('[data-checklist-toggle], [data-photo], [data-file], button, input, textarea')
		)
			return;
		// The left edge belongs to the navigation drawer.
		if (window.matchMedia(PHONE_MEDIA).matches && isSidebarEdgeStart(e.clientX)) return;

		// Keep the pointer until we can identify its direction, but do not promote
		// the card to a transformed layer yet. On iOS, transforming a card before
		// a vertical pan is classified interrupts its nested native scroll.
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		pointerId = e.pointerId;
		startX = e.clientX;
		startY = e.clientY;
		tracking = true;
		dragging = false;
		decidedHorizontal = false;
	}

	function onPointerMove(e: PointerEvent) {
		if (!tracking || e.pointerId !== pointerId) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		if (!decidedHorizontal) {
			if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
			decidedHorizontal = Math.abs(dx) > Math.abs(dy);
			if (!decidedHorizontal) {
				(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
				finishTracking();
				return;
			}

			// Only horizontal swipes opt into visual transform/compositing.
			dragging = true;
		}

		e.preventDefault();
		offsetX = Math.max(-120, Math.min(120, dx));
		publish();
	}

	function onPointerUp(e: PointerEvent) {
		if (!tracking || e.pointerId !== pointerId) return;
		finishTracking();
		if (!dragging) return;

		const wasDrag = Math.abs(offsetX) >= threshold;
		const moved = Math.abs(offsetX) > 5;
		dragging = false;

		if (wasDrag) {
			if (offsetX < 0) {
				offsetX = -300;
				publish();
				swipeTimer = setTimeout(() => opts.onSwipeLeft(), 150);
			} else {
				offsetX = 300;
				publish();
				swipeTimer = setTimeout(() => opts.onSwipeRight(), 150);
			}
		} else {
			offsetX = 0;
			publish();
		}

		if (moved) {
			e.stopPropagation();
			justDragged = true;
			dragResetTimer = setTimeout(() => {
				justDragged = false;
			}, 50);
		}
	}

	function onPointerCancel(e: PointerEvent) {
		if (e.pointerId !== pointerId) return;
		finishTracking();
		if (!dragging) return;
		dragging = false;
		offsetX = 0;
		publish();
	}

	return {
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel,
		wasDrag: () => justDragged,
		getOffsetX: () => offsetX,
		isDragging: () => dragging,
		dispose: () => {
			if (swipeTimer !== null) clearTimeout(swipeTimer);
			if (dragResetTimer !== null) clearTimeout(dragResetTimer);
			swipeTimer = null;
			dragResetTimer = null;
		}
	};
}

/** Inline transform style for a swiping card. */
export function cardSwipeStyle(offsetX: number, dragging: boolean): string {
	const transform =
		offsetX !== 0 || dragging ? `transform: translate3d(${offsetX}px, 0, 0);` : 'transform: none;';
	const willChange = offsetX !== 0 || dragging ? 'will-change: transform;' : '';
	const reducedMotion =
		typeof window !== 'undefined' &&
		window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
	const transition =
		dragging || reducedMotion
			? 'transition: none;'
			: 'transition: transform 0.25s cubic-bezier(0.2, 0.9, 0.3, 1), box-shadow 0.2s;';
	return `${transform} ${willChange} ${transition}`;
}
