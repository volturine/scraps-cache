import {
	ALLOWED_ELEMENT_TYPES,
	createCanvasAttachment,
	type CanvasElement,
	type CanvasFile,
	type CanvasScene
} from './canvasAttachment';
import type { NoteImage } from './types';

export const FALLBACK_CANVAS_PREVIEW =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isExcalidrawFileName(name: string): boolean {
	return /\.(?:excalidraw|excalidraw\.json|excalidraw\.png|excalidraw\.svg)$/i.test(name);
}

export function cleanCanvasName(fileName: string): string {
	const base = fileName
		.replace(/\.(?:excalidraw(?:\.json|\.svg|\.png)?|json|svg|png)$/i, '')
		.trim();
	return base || 'Canvas';
}

export async function isExcalidrawFile(file: File | Blob, name?: string): Promise<boolean> {
	const fileName = name ?? (file instanceof File ? file.name : '');
	if (isExcalidrawFileName(fileName)) return true;
	if (file.type === 'application/vnd.excalidraw+json') return true;

	// Check JSON files
	if (/\.json$/i.test(fileName) || file.type === 'application/json' || file.type === '') {
		if (file.size > 15 * 1024 * 1024) return false;
		try {
			const slice = file.slice(0, 4096);
			const text = await slice.text();
			if (/"type"\s*:\s*"excalidraw"/i.test(text)) {
				return true;
			}
			if (file.size < 512 * 1024) {
				const fullText = await file.text();
				const parsed = JSON.parse(fullText);
				if (isRecord(parsed)) {
					if (parsed.type === 'excalidraw' || parsed.source === 'https://excalidraw.com')
						return true;
					if (Array.isArray(parsed.elements) && parsed.elements.length > 0) {
						const first = parsed.elements[0];
						if (
							isRecord(first) &&
							typeof first.type === 'string' &&
							ALLOWED_ELEMENT_TYPES.has(first.type)
						) {
							return true;
						}
					}
				}
			}
		} catch {
			return false;
		}
	}

	// Check SVG files
	if (/\.svg$/i.test(fileName) || file.type === 'image/svg+xml') {
		try {
			const text = await file.text();
			if (
				text.includes('application/vnd.excalidraw') ||
				(text.includes('payload-start') && text.includes('excalidraw'))
			) {
				return true;
			}
		} catch {
			return false;
		}
	}

	return false;
}

export async function parseExcalidrawScene(
	file: File | Blob,
	fileName = 'canvas.excalidraw'
): Promise<{ scene: CanvasScene; name: string }> {
	const cleanName = cleanCanvasName(fileName);

	// Try direct text/JSON parsing for non-binary files
	const isPng = fileName.toLowerCase().endsWith('.png') || file.type === 'image/png';
	if (!isPng) {
		try {
			const text = await file.text();
			if (
				text.includes('payload-start') ||
				fileName.toLowerCase().endsWith('.svg') ||
				file.type === 'image/svg+xml'
			) {
				// Handled by restoreSceneFromBlob below
			} else {
				const data = JSON.parse(text);
				if (isRecord(data) || Array.isArray(data)) {
					const rawElements: unknown[] = Array.isArray(data)
						? data
						: Array.isArray(data.elements)
							? data.elements
							: [];
					const elements = rawElements.filter(
						(el) => isRecord(el) && el.isDeleted !== true
					) as CanvasElement[];

					if (
						isRecord(data) &&
						(data.type === 'excalidraw' || data.source === 'https://excalidraw.com')
					) {
						if (elements.length === 0) {
							throw new Error('This Excalidraw file contains no drawings.');
						}
						const appState = (isRecord(data.appState) ? data.appState : {}) as Record<
							string,
							unknown
						>;
						const files = (isRecord(data.files) ? data.files : {}) as Record<string, CanvasFile>;
						return { scene: { elements, appState, files }, name: cleanName };
					}

					if (elements.length > 0) {
						const appState = (
							isRecord(data) && isRecord(data.appState) ? data.appState : {}
						) as Record<string, unknown>;
						const files = (isRecord(data) && isRecord(data.files) ? data.files : {}) as Record<
							string,
							CanvasFile
						>;
						return { scene: { elements, appState, files }, name: cleanName };
					}
				}
			}
		} catch (err) {
			if (err instanceof Error && err.message === 'This Excalidraw file contains no drawings.') {
				throw err;
			}
		}
	}

	// For SVG, PNG, or complex scenes, use Excalidraw's loadFromBlob
	try {
		const { restoreSceneFromBlob } = await import('./excalidrawHost');
		const scene = await restoreSceneFromBlob(file);
		if (scene.elements.length === 0) {
			throw new Error('This Excalidraw file contains no drawings.');
		}
		return { scene, name: cleanName };
	} catch (cause) {
		if (cause instanceof Error && cause.message === 'This Excalidraw file contains no drawings.') {
			throw cause;
		}
		throw new Error('Could not parse Excalidraw file.');
	}
}

export async function convertExcalidrawFileToCanvas(file: File): Promise<NoteImage> {
	const { scene, name } = await parseExcalidrawScene(file, file.name);
	if (scene.elements.length === 0) {
		throw new Error('This Excalidraw file contains no drawings.');
	}

	let previewDataUrl = FALLBACK_CANVAS_PREVIEW;
	let width = 480;
	let height = 360;

	try {
		const { renderCanvasThumbnail } = await import('./excalidrawHost');
		const rendered = await renderCanvasThumbnail(scene);
		previewDataUrl = rendered.dataUrl;
		width = rendered.width;
		height = rendered.height;
	} catch {
		// Use fallback preview when canvas rendering is unavailable
	}

	const attachment = await createCanvasAttachment(scene, previewDataUrl, {
		name
	} as NoteImage);

	return {
		...attachment,
		width,
		height
	};
}
