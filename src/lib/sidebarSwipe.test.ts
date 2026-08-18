import { describe, expect, it } from 'vitest';
import { attachOpenSidebarFromEdge, isSidebarEdgeStart } from './sidebarSwipe';

function pointer(type: string, target: EventTarget, clientX: number, clientY = 200) {
	target.dispatchEvent(
		new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX, clientY })
	);
}

describe('isSidebarEdgeStart', () => {
	it('only accepts the far left of the app frame', () => {
		expect(isSidebarEdgeStart(8)).toBe(true);
		expect(isSidebarEdgeStart(40)).toBe(false);
	});
});

describe('attachOpenSidebarFromEdge', () => {
	it('opens after a rightward swipe from the left edge', () => {
		const node = document.createElement('div');
		document.body.appendChild(node);
		let open = false;
		const cleanup = attachOpenSidebarFromEdge({
			getOpen: () => open,
			open: () => {
				open = true;
			}
		})(node);

		pointer('pointerdown', node, 4);
		pointer('pointermove', window, 80);
		expect(open).toBe(true);
		cleanup();
		node.remove();
	});

	it('ignores a swipe that starts away from the edge', () => {
		const node = document.createElement('div');
		document.body.appendChild(node);
		let open = false;
		const cleanup = attachOpenSidebarFromEdge({
			getOpen: () => open,
			open: () => {
				open = true;
			}
		})(node);

		pointer('pointerdown', node, 80);
		pointer('pointermove', window, 180);
		expect(open).toBe(false);
		cleanup();
		node.remove();
	});
});
