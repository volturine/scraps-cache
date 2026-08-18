/** Open the mobile sidebar from a rightward swipe at the left edge. */

export const SIDEBAR_EDGE_PX = 28;
const THRESHOLD_PX = 48;

export function isSidebarEdgeStart(clientX: number, left = 0): boolean {
	return clientX - left <= SIDEBAR_EDGE_PX;
}

export function attachOpenSidebarFromEdge(opts: { getOpen: () => boolean; open: () => void }) {
	return (node: HTMLElement) => {
		let tracking = false;
		let startX = 0;
		let startY = 0;

		function onPointerDown(event: PointerEvent) {
			if (opts.getOpen()) return;
			if (document.documentElement.classList.contains('editor-open')) return;
			if (!isSidebarEdgeStart(event.clientX, node.getBoundingClientRect().left)) return;
			tracking = true;
			startX = event.clientX;
			startY = event.clientY;
		}

		function onPointerMove(event: PointerEvent) {
			if (!tracking) return;
			const dx = event.clientX - startX;
			const dy = event.clientY - startY;
			if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
			if (Math.abs(dy) >= Math.abs(dx) || dx <= 0) {
				tracking = false;
				return;
			}
			if (dx >= THRESHOLD_PX) {
				tracking = false;
				opts.open();
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
