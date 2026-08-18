import { describe, expect, it } from 'vitest';
import { attachSidebarSwipe, isSidebarEdgeStart } from './sidebarSwipe';

function pointer(type: string, target: EventTarget, clientX: number, clientY = 200) {
	target.dispatchEvent(
		new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX, clientY })
	);
}

function mount(open = false) {
	const node = document.createElement('div');
	const backdrop = document.createElement('button');
	backdrop.setAttribute('data-sidebar-backdrop', '');
	const drawer = document.createElement('div');
	drawer.setAttribute('data-sidebar-drawer', '');
	node.append(backdrop, drawer);
	document.body.appendChild(node);
	let isOpen = open;
	const cleanup = attachSidebarSwipe({
		getOpen: () => isOpen,
		open: () => {
			isOpen = true;
		},
		close: () => {
			isOpen = false;
		}
	})(node);
	return {
		node,
		backdrop,
		isOpen: () => isOpen,
		cleanup: () => {
			cleanup();
			node.remove();
		}
	};
}

describe('isSidebarEdgeStart', () => {
	it('only accepts the far left of the app frame', () => {
		expect(isSidebarEdgeStart(8)).toBe(true);
		expect(isSidebarEdgeStart(40)).toBe(false);
	});
});

describe('attachSidebarSwipe', () => {
	it('opens after a rightward swipe from the left edge', () => {
		const session = mount(false);
		pointer('pointerdown', session.node, 4);
		pointer('pointermove', window, 80);
		expect(session.isOpen()).toBe(true);
		session.cleanup();
	});

	it('ignores a swipe that starts away from the edge', () => {
		const session = mount(false);
		pointer('pointerdown', session.node, 80);
		pointer('pointermove', window, 180);
		expect(session.isOpen()).toBe(false);
		session.cleanup();
	});

	it('closes after a leftward swipe on the backdrop', () => {
		const session = mount(true);
		pointer('pointerdown', session.backdrop, 320);
		pointer('pointermove', window, 240);
		expect(session.isOpen()).toBe(false);
		session.cleanup();
	});
});
