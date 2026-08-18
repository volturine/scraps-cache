/** Left-edge swipe that reveals the mobile navigation drawer. */

export const SIDEBAR_WIDTH_PX = 288;
export const SIDEBAR_EDGE_ZONE_PX = 28;
export const SIDEBAR_DECIDE_PX = 8;
export const SIDEBAR_OPEN_RATIO = 0.35;
export const SIDEBAR_FLING_PX_PER_MS = 0.45;

export type SidebarSwipeVisual = { offset: number; dragging: boolean };

export type SidebarSwipeOpts = {
	getOpen: () => boolean;
	setOpen: (open: boolean) => void;
	setVisual: (state: SidebarSwipeVisual) => void;
	isEnabled: () => boolean;
	isBlocked?: () => boolean;
	width?: number;
	edgeZone?: number;
};

const INTERACTIVE = 'button, a, input, textarea, select, [contenteditable]';

export function isSidebarEdgeStart(
	clientX: number,
	options: { left?: number; edgeZone?: number } = {}
): boolean {
	const left = options.left ?? 0;
	const edgeZone = options.edgeZone ?? SIDEBAR_EDGE_ZONE_PX;
	return clientX - left <= edgeZone;
}

export function clampSidebarOffset(offset: number, width = SIDEBAR_WIDTH_PX): number {
	return Math.max(-width, Math.min(0, offset));
}

export function sidebarOffsetFromDelta(
	startOpen: boolean,
	dx: number,
	width = SIDEBAR_WIDTH_PX
): number {
	return clampSidebarOffset((startOpen ? 0 : -width) + dx, width);
}

export function sidebarProgress(offset: number, width = SIDEBAR_WIDTH_PX): number {
	if (width <= 0) return 0;
	return (offset + width) / width;
}

export function shouldCommitSidebarOpen(
	offset: number,
	dx: number,
	dtMs: number,
	width = SIDEBAR_WIDTH_PX
): boolean {
	const velocity = dtMs > 0 ? dx / dtMs : 0;
	if (velocity >= SIDEBAR_FLING_PX_PER_MS) return true;
	if (velocity <= -SIDEBAR_FLING_PX_PER_MS) return false;
	return sidebarProgress(offset, width) >= SIDEBAR_OPEN_RATIO;
}

function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
	);
}

export function sidebarDrawerStyle(offset: number, dragging: boolean): string {
	const transform = `transform: translate3d(${offset}px, 0, 0); translate: none;`;
	const transition =
		dragging || prefersReducedMotion()
			? 'transition: none;'
			: 'transition: transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1);';
	return `${transform} ${transition}`;
}

export function restSidebarOffset(open: boolean, width = SIDEBAR_WIDTH_PX): number {
	return open ? 0 : -width;
}

function skipInteractive(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	const interactive = target.closest(INTERACTIVE);
	if (!interactive) return false;
	return !interactive.closest('[data-sidebar-backdrop]');
}

export function attachSidebarSwipe(opts: SidebarSwipeOpts) {
	const width = opts.width ?? SIDEBAR_WIDTH_PX;
	const edgeZone = opts.edgeZone ?? SIDEBAR_EDGE_ZONE_PX;

	return (node: HTMLElement) => {
		let tracking = false;
		let dragging = false;
		let decided = false;
		let pointerId: number | null = null;
		let startX = 0;
		let startY = 0;
		let startTime = 0;
		let startOpen = false;
		let offset = restSidebarOffset(opts.getOpen(), width);
		let justDragged = false;
		let suppressTimer: ReturnType<typeof setTimeout> | null = null;

		function publish() {
			opts.setVisual({ offset, dragging });
		}

		function finishTracking(event?: PointerEvent) {
			if (pointerId !== null && event && node.hasPointerCapture?.(pointerId)) {
				try {
					node.releasePointerCapture(pointerId);
				} catch {
					/* already released */
				}
			}
			tracking = false;
			dragging = false;
			decided = false;
			pointerId = null;
		}

		function onPointerDown(event: PointerEvent) {
			if (tracking || !opts.isEnabled() || opts.isBlocked?.()) return;
			if (skipInteractive(event.target)) return;
			if (event.target instanceof Element && event.target.closest('[data-app-float]')) return;

			startOpen = opts.getOpen();
			if (startOpen) {
				if (
					!(event.target instanceof Element) ||
					!event.target.closest('[data-sidebar-drawer], [data-sidebar-backdrop]')
				) {
					return;
				}
			} else if (
				!isSidebarEdgeStart(event.clientX, {
					left: node.getBoundingClientRect().left,
					edgeZone
				})
			) {
				return;
			}

			// Steal the left-edge gesture from cards so they do not archive/trash.
			if (!startOpen) event.stopPropagation();

			pointerId = event.pointerId;
			startX = event.clientX;
			startY = event.clientY;
			startTime = event.timeStamp;
			tracking = true;
			dragging = false;
			decided = false;
			offset = restSidebarOffset(startOpen, width);
		}

		function onPointerMove(event: PointerEvent) {
			if (!tracking || event.pointerId !== pointerId) return;
			const dx = event.clientX - startX;
			const dy = event.clientY - startY;
			if (!decided) {
				if (Math.abs(dx) < SIDEBAR_DECIDE_PX && Math.abs(dy) < SIDEBAR_DECIDE_PX) return;
				const horizontal = Math.abs(dx) > Math.abs(dy);
				if (!horizontal || (!startOpen && dx <= 0)) {
					finishTracking(event);
					return;
				}
				decided = true;
				dragging = true;
				try {
					node.setPointerCapture(event.pointerId);
				} catch {
					/* jsdom and already-released pointers */
				}
			}

			event.preventDefault();
			offset = sidebarOffsetFromDelta(startOpen, dx, width);
			publish();
		}

		function onPointerUp(event: PointerEvent) {
			if (!tracking || event.pointerId !== pointerId) return;
			const dx = event.clientX - startX;
			const dt = event.timeStamp - startTime;
			const wasDragging = dragging;
			finishTracking(event);
			if (!wasDragging) return;

			const open = shouldCommitSidebarOpen(offset, dx, dt, width);
			offset = restSidebarOffset(open, width);
			dragging = false;
			publish();
			opts.setOpen(open);

			justDragged = true;
			if (suppressTimer !== null) clearTimeout(suppressTimer);
			suppressTimer = setTimeout(() => {
				justDragged = false;
				suppressTimer = null;
			}, 50);
		}

		function onPointerCancel(event: PointerEvent) {
			if (event.pointerId !== pointerId) return;
			const wasDragging = dragging;
			finishTracking(event);
			if (!wasDragging) return;
			offset = restSidebarOffset(opts.getOpen(), width);
			publish();
		}

		function onClickCapture(event: Event) {
			if (!justDragged) return;
			event.preventDefault();
			event.stopPropagation();
		}

		const pointerOpts: AddEventListenerOptions = { capture: true, passive: false };
		node.addEventListener('pointerdown', onPointerDown, pointerOpts);
		window.addEventListener('pointermove', onPointerMove, pointerOpts);
		window.addEventListener('pointerup', onPointerUp, pointerOpts);
		window.addEventListener('pointercancel', onPointerCancel, pointerOpts);
		window.addEventListener('click', onClickCapture, true);

		return () => {
			if (suppressTimer !== null) clearTimeout(suppressTimer);
			node.removeEventListener('pointerdown', onPointerDown, pointerOpts);
			window.removeEventListener('pointermove', onPointerMove, pointerOpts);
			window.removeEventListener('pointerup', onPointerUp, pointerOpts);
			window.removeEventListener('pointercancel', onPointerCancel, pointerOpts);
			window.removeEventListener('click', onClickCapture, true);
		};
	};
}
