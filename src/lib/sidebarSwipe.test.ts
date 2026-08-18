import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	attachSidebarSwipe,
	isSidebarEdgeStart,
	restSidebarOffset,
	sidebarDrawerStyle,
	sidebarOffsetFromDelta,
	sidebarProgress,
	shouldCommitSidebarOpen,
	SIDEBAR_WIDTH_PX
} from './sidebarSwipe';

const originalMatchMedia = window.matchMedia;

afterEach(() => {
	window.matchMedia = originalMatchMedia;
});

function pointer(
	type: string,
	target: EventTarget,
	init: PointerEventInit & { timeStamp?: number } = {}
) {
	const { timeStamp, ...rest } = init;
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		clientX: 0,
		clientY: 200,
		...rest
	});
	if (timeStamp !== undefined) {
		Object.defineProperty(event, 'timeStamp', { value: timeStamp });
	}
	target.dispatchEvent(event);
	return event;
}

describe('isSidebarEdgeStart', () => {
	it('accepts contacts on the far left of the app frame', () => {
		expect(isSidebarEdgeStart(8, { left: 0 })).toBe(true);
		expect(isSidebarEdgeStart(40, { left: 0 })).toBe(false);
		expect(isSidebarEdgeStart(54, { left: 47 })).toBe(true);
		expect(isSidebarEdgeStart(90, { left: 47 })).toBe(false);
	});
});

describe('sidebarOffsetFromDelta', () => {
	it('pulls a closed drawer in from the left and clamps it', () => {
		expect(sidebarOffsetFromDelta(false, 0)).toBe(-SIDEBAR_WIDTH_PX);
		expect(sidebarOffsetFromDelta(false, 72)).toBe(-SIDEBAR_WIDTH_PX + 72);
		expect(sidebarOffsetFromDelta(false, 400)).toBe(0);
	});

	it('lets an open drawer slide back out', () => {
		expect(sidebarOffsetFromDelta(true, 0)).toBe(0);
		expect(sidebarOffsetFromDelta(true, -80)).toBe(-80);
		expect(sidebarOffsetFromDelta(true, -400)).toBe(-SIDEBAR_WIDTH_PX);
	});
});

describe('shouldCommitSidebarOpen', () => {
	it('opens once the drawer has been dragged far enough', () => {
		expect(shouldCommitSidebarOpen(-SIDEBAR_WIDTH_PX + 120, 120, 400)).toBe(true);
		expect(shouldCommitSidebarOpen(-SIDEBAR_WIDTH_PX + 40, 40, 400)).toBe(false);
	});

	it('follows a fast fling even when distance is short', () => {
		expect(shouldCommitSidebarOpen(-SIDEBAR_WIDTH_PX + 30, 30, 40)).toBe(true);
		expect(shouldCommitSidebarOpen(-20, -30, 40)).toBe(false);
	});
});

describe('sidebarProgress', () => {
	it('maps offset onto 0..1', () => {
		expect(sidebarProgress(-SIDEBAR_WIDTH_PX)).toBe(0);
		expect(sidebarProgress(0)).toBe(1);
		expect(sidebarProgress(-SIDEBAR_WIDTH_PX / 2)).toBe(0.5);
	});
});

describe('sidebarDrawerStyle', () => {
	it('returns to rest without animation when reduced motion is requested', () => {
		window.matchMedia = vi.fn().mockReturnValue({ matches: true });
		expect(sidebarDrawerStyle(0, false)).toContain('transition: none;');
	});

	it('keeps the snap animation when reduced motion is not requested', () => {
		window.matchMedia = vi.fn().mockReturnValue({ matches: false });
		expect(sidebarDrawerStyle(0, false)).toContain('transition: transform 0.2s');
	});
});

describe('attachSidebarSwipe', () => {
	function mount(open = false) {
		const node = document.createElement('div');
		const backdrop = document.createElement('button');
		backdrop.setAttribute('data-sidebar-backdrop', '');
		const drawer = document.createElement('div');
		drawer.setAttribute('data-sidebar-drawer', '');
		node.append(backdrop, drawer);
		document.body.appendChild(node);
		vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
			left: 0,
			top: 0,
			right: 390,
			bottom: 844,
			width: 390,
			height: 844,
			x: 0,
			y: 0,
			toJSON: () => ({})
		});

		let isOpen = open;
		const visual = { offset: restSidebarOffset(open), dragging: false };
		const cleanup = attachSidebarSwipe({
			getOpen: () => isOpen,
			setOpen: (next) => {
				isOpen = next;
			},
			setVisual: (state) => {
				visual.offset = state.offset;
				visual.dragging = state.dragging;
			},
			isEnabled: () => true
		})(node);

		return {
			node,
			backdrop,
			drawer,
			visual,
			isOpen: () => isOpen,
			cleanup: () => {
				cleanup();
				node.remove();
			}
		};
	}

	it('opens the drawer from a rightward swipe at the left edge', () => {
		const session = mount(false);
		pointer('pointerdown', session.node, { clientX: 4, clientY: 240 });
		pointer('pointermove', window, { clientX: 140, clientY: 242 });
		pointer('pointerup', window, { clientX: 140, clientY: 242 });
		expect(session.isOpen()).toBe(true);
		expect(session.visual.offset).toBe(0);
		session.cleanup();
	});

	it('ignores a swipe that does not start at the left edge', () => {
		const session = mount(false);
		pointer('pointerdown', session.node, { clientX: 80, clientY: 240 });
		pointer('pointermove', window, { clientX: 220, clientY: 240 });
		pointer('pointerup', window, { clientX: 220, clientY: 240 });
		expect(session.isOpen()).toBe(false);
		session.cleanup();
	});

	it('lets a vertical pan continue without opening the drawer', () => {
		const session = mount(false);
		pointer('pointerdown', session.node, { clientX: 4, clientY: 240 });
		pointer('pointermove', window, { clientX: 6, clientY: 320 });
		pointer('pointerup', window, { clientX: 6, clientY: 320 });
		expect(session.isOpen()).toBe(false);
		expect(session.visual.dragging).toBe(false);
		session.cleanup();
	});

	it('closes an open drawer from a leftward swipe on the backdrop', () => {
		const session = mount(true);
		pointer('pointerdown', session.backdrop, { clientX: 320, clientY: 240 });
		pointer('pointermove', window, { clientX: 80, clientY: 240 });
		pointer('pointerup', window, { clientX: 80, clientY: 240 });
		expect(session.isOpen()).toBe(false);
		expect(session.visual.offset).toBe(-SIDEBAR_WIDTH_PX);
		session.cleanup();
	});

	it('does not start on interactive controls', () => {
		const session = mount(false);
		const button = document.createElement('button');
		session.node.appendChild(button);
		pointer('pointerdown', button, { clientX: 4, clientY: 40 });
		pointer('pointermove', window, { clientX: 160, clientY: 40 });
		pointer('pointerup', window, { clientX: 160, clientY: 40 });
		expect(session.isOpen()).toBe(false);
		session.cleanup();
	});
});
