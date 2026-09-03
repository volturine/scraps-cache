import {
	createCanvasAttachment,
	type CanvasElement,
	type CanvasFile,
	type CanvasScene
} from './canvasAttachment';
import type { NoteImage } from './types';

export const FALLBACK_CANVAS_PREVIEW =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
	if (isExcalidrawFileName(fileName) || file.type === 'application/vnd.excalidraw+json') {
		return true;
	}
	if (file.size > 15 * 1024 * 1024) return false;

	try {
		const text = await file.slice(0, 4096).text();
		return (
			/"type"\s*:\s*"excalidraw"/i.test(text) ||
			text.includes('application/vnd.excalidraw') ||
			(text.includes('payload-start') && text.includes('excalidraw')) ||
			/"elements"\s*:\s*\[\s*\{[^}]*"type"\s*:\s*"(?:rectangle|ellipse|diamond|arrow|line|freedraw|text|image)"/i.test(
				text
			)
		);
	} catch {
		return false;
	}
}

async function loadScene(file: File | Blob): Promise<CanvasScene> {
	const text = await file.text().catch(() => '');
	if (text && !text.includes('payload-start') && !file.type.includes('svg')) {
		try {
			const data = JSON.parse(text);
			const raw = Array.isArray(data) ? data : data?.elements;
			if (Array.isArray(raw)) {
				const elements = (raw as (CanvasElement & { isDeleted?: boolean })[]).filter(
					(el) => el && !el.isDeleted
				);
				return {
					elements,
					appState: (data?.appState ?? {}) as Record<string, unknown>,
					files: (data?.files ?? {}) as Record<string, CanvasFile>
				};
			}
		} catch {
			// Fall through to restoreSceneFromBlob
		}
	}
	const { restoreSceneFromBlob } = await import('./excalidrawHost');
	return restoreSceneFromBlob(file);
}

export async function parseExcalidrawScene(
	file: File | Blob,
	fileName = 'canvas.excalidraw'
): Promise<{ scene: CanvasScene; name: string }> {
	let scene: CanvasScene;
	try {
		scene = await loadScene(file);
	} catch (cause) {
		throw new Error('Could not parse Excalidraw file.', { cause });
	}

	if (scene.elements.length === 0) {
		throw new Error('This Excalidraw file contains no drawings.');
	}
	return { scene, name: cleanCanvasName(fileName) };
}

export async function convertExcalidrawFileToCanvas(file: File): Promise<NoteImage> {
	const { scene, name } = await parseExcalidrawScene(file, file.name);

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

	const attachment = await createCanvasAttachment(scene, previewDataUrl, { name } as NoteImage);
	return { ...attachment, width, height };
}
