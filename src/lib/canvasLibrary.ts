export const CANVAS_LIBRARY_KEY = 'scrapscache-excalidraw-library';

export function loadCanvasLibrary(): unknown[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(CANVAS_LIBRARY_KEY) ?? '[]');
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function saveCanvasLibrary(items: unknown): void {
	if (!Array.isArray(items)) return;
	try {
		localStorage.setItem(CANVAS_LIBRARY_KEY, JSON.stringify(items));
	} catch {
		/* ignore quota */
	}
}
