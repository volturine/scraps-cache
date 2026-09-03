import { afterEach, describe, expect, it } from 'vitest';
import { CANVAS_LIBRARY_KEY, loadCanvasLibrary, saveCanvasLibrary } from './canvasLibrary';

afterEach(() => {
	localStorage.removeItem(CANVAS_LIBRARY_KEY);
});

describe('canvas shape library', () => {
	it('round-trips personal library items on this device', () => {
		const items = [{ id: 'star', status: 'unpublished', created: 1, elements: [] }];
		saveCanvasLibrary(items);
		expect(loadCanvasLibrary()).toEqual(items);
	});

	it('treats missing or invalid storage as an empty library', () => {
		expect(loadCanvasLibrary()).toEqual([]);
		localStorage.setItem(CANVAS_LIBRARY_KEY, '{not-json');
		expect(loadCanvasLibrary()).toEqual([]);
		localStorage.setItem(CANVAS_LIBRARY_KEY, '{"id":"nope"}');
		expect(loadCanvasLibrary()).toEqual([]);
		saveCanvasLibrary({ not: 'an array' });
		expect(loadCanvasLibrary()).toEqual([]);
	});
});
