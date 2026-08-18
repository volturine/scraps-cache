/** Swipe the mobile sidebar open from the left edge, or closed with a left swipe. */

export const SIDEBAR_EDGE_PX = 28;
const THRESHOLD_PX = 48;

export function isSidebarEdgeStart(clientX: number, left = 0): boolean {
	return clientX - left <= SIDEBAR_EDGE_PX;
}

export function attachSidebarSwipe(opts: {
	getOpen: () => boolean;
	open: () => void;
	close: () => void;
}) {
	return (node: HTMLElement) => {
		let tracking = false;
		let startX = 0;
		let startY = 0;
		let startOpen = false;

		function onPointerDown(event: PointerEvent) {
			if (document.documentElement.classList.contains('editor-open')) return;
			const target = event.target;
			startOpen = opts.getOpen();
			if (startOpen) {
				if (!(target instanceof Element)) return;
				if (!target.closest('[data-sidebar-drawer], [data-sidebar-backdrop]')) return;
				if (target.closest('a, input, textarea, select, [contenteditable]')) return;
				const button = target.closest('button');
				if (button && !button.closest('[data-sidebar-backdrop]')) return;
			} else if (!isSidebarEdgeStart(event.clientX, node.getBoundingClientRect().left)) {
				return;
			}
			tracking = true;
			startX = event.clientX;
			startY = event.clientY;
		}

		function onPointerMove(event: PointerEvent) {
			if (!tracking) return;
			const dx = event.clientX - startX;
			const dy = event.clientY - startY;
			if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
			if (Math.abs(dy) >= Math.abs(dx)) {
				tracking = false;
				return;
			}
			if (!startOpen && dx >= THRESHOLD_PX) {
				tracking = false;
				opts.open();
			} else if (startOpen && dx <= -THRESHOLD_PX) {
				tracking = false;
				opts.close();
			} else if ((!startOpen && dx <= 0) || (startOpen && dx >= 0)) {
				tracking = false;
			}
		}

		function onPointerUp() {
			tracking = false;
		}

		node.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerUp);
		return () => {
			node.removeEventListener('pointerdown', onPointerDown);
			window.removeEventListener('pointermove', onPointerMove);
			window.removeEventListener('pointerup', onPointerUp);
			window.removeEventListener('pointercancel', onPointerUp);
		};
	};
}
