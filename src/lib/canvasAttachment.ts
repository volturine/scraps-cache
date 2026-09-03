import { blobToDataUrl, dataUrlToBlob } from './imageBlob';
import { sha256 } from './syncHash';
import type { NoteImage } from './types';
import { uid } from './utils';

export const CANVAS_MIME = 'application/vnd.scrapscache.canvas+json';
export const CANVAS_ENCODING_VERSION = 1;

const MAX_CANVAS_BYTES = 7 * 1024 * 1024;
const MAX_CANVAS_ELEMENTS = 25_000;
const MAX_PREVIEW_LENGTH = 1_500_000;
const MAX_FILE_ID_LENGTH = 256;
export const ALLOWED_ELEMENT_TYPES = new Set([
	'rectangle',
	'diamond',
	'ellipse',
	'line',
	'arrow',
	'freedraw',
	'text',
	'image'
]);
const ALLOWED_FILE_MIMES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/bmp',
	'image/x-icon',
	'image/svg+xml',
	'image/avif'
]);

export type CanvasElement = Record<string, unknown> & { type: string };

export interface CanvasFile {
	id: string;
	mimeType: string;
	dataURL: string;
	created: number;
}

export interface CanvasScene {
	elements: CanvasElement[];
	appState: Record<string, unknown>;
	files?: Record<string, CanvasFile>;
}

interface StoredCanvasDocument {
	version: 1;
	engine: 'excalidraw';
	elements: CanvasElement[];
	appState: Record<string, unknown>;
	files: Record<string, CanvasFile>;
	previewDataUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function boundedNumber(value: unknown, minimum: number, maximum: number): value is number {
	return finiteNumber(value) && value >= minimum && value <= maximum;
}

function validFileId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_FILE_ID_LENGTH;
}

function validElement(value: unknown): value is CanvasElement {
	if (!isRecord(value) || typeof value.type !== 'string') return false;
	if (!ALLOWED_ELEMENT_TYPES.has(value.type)) return false;
	if (value.type === 'image' && !validFileId(value.fileId)) return false;
	return (
		typeof value.id === 'string' &&
		boundedNumber(value.x, -1_000_000_000, 1_000_000_000) &&
		boundedNumber(value.y, -1_000_000_000, 1_000_000_000) &&
		boundedNumber(value.width, 0, 1_000_000_000) &&
		boundedNumber(value.height, 0, 1_000_000_000)
	);
}

function validFile(value: unknown): value is CanvasFile {
	if (!isRecord(value) || !validFileId(value.id)) return false;
	if (typeof value.mimeType !== 'string') return false;
	const mimeType = value.mimeType.toLowerCase();
	if (!ALLOWED_FILE_MIMES.has(mimeType)) return false;
	if (typeof value.dataURL !== 'string' || value.dataURL.length > MAX_CANVAS_BYTES) return false;
	if (!value.dataURL.toLowerCase().startsWith(`data:${mimeType};base64,`)) return false;
	return boundedNumber(value.created, 0, 1e15);
}

function sceneFiles(value: unknown, elements: CanvasElement[]): Record<string, CanvasFile> {
	if (!isRecord(value)) return {};
	const files: Record<string, CanvasFile> = {};
	for (const element of elements) {
		if (element.type !== 'image' || !validFileId(element.fileId)) continue;
		const file = value[element.fileId];
		if (!validFile(file) || file.id !== element.fileId) continue;
		files[file.id] = {
			id: file.id,
			mimeType: file.mimeType,
			dataURL: file.dataURL,
			created: file.created
		};
	}
	return files;
}

function persistableElements(elements: unknown[], files: unknown): CanvasElement[] {
	const candidates = elements.filter(validElement);
	const fileMap = sceneFiles(files, candidates);
	return candidates.filter(
		(element) => element.type !== 'image' || fileMap[String(element.fileId)]
	);
}

function validPreview(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= MAX_PREVIEW_LENGTH &&
		/^data:image\/(?:png|jpeg|webp);base64,/i.test(value)
	);
}

function normalizeAppState(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {};
	const appState: Record<string, unknown> = {};
	if (boundedNumber(value.scrollX, -1_000_000_000, 1_000_000_000)) appState.scrollX = value.scrollX;
	if (boundedNumber(value.scrollY, -1_000_000_000, 1_000_000_000)) appState.scrollY = value.scrollY;
	if (
		typeof value.viewBackgroundColor === 'string' &&
		/^#[0-9a-f]{6}$/i.test(value.viewBackgroundColor)
	) {
		appState.viewBackgroundColor = value.viewBackgroundColor;
	}
	if (value.gridSize === null || boundedNumber(value.gridSize, 1, 1_000)) {
		appState.gridSize = value.gridSize;
	}
	if (isRecord(value.zoom) && finiteNumber(value.zoom.value)) {
		appState.zoom = { value: Math.min(30, Math.max(0.05, value.zoom.value)) };
	}
	return appState;
}

function parseDocument(value: unknown): StoredCanvasDocument {
	if (!isRecord(value) || value.version !== 1 || value.engine !== 'excalidraw') {
		throw new Error('This canvas is not in a supported format.');
	}
	if (!Array.isArray(value.elements) || value.elements.length > MAX_CANVAS_ELEMENTS) {
		throw new Error('This canvas contains too many objects.');
	}
	if (!value.elements.every(validElement) || !validPreview(value.previewDataUrl)) {
		throw new Error('This canvas contains unsupported content.');
	}
	const elements = value.elements;
	const files = sceneFiles(value.files, elements);
	if (elements.some((element) => element.type === 'image' && !files[String(element.fileId)])) {
		throw new Error('This canvas contains unsupported content.');
	}
	return {
		version: 1,
		engine: 'excalidraw',
		elements,
		appState: normalizeAppState(value.appState),
		files,
		previewDataUrl: value.previewDataUrl
	};
}

export function isCanvasAttachment(attachment: Pick<NoteImage, 'mime'>): boolean {
	return (attachment.mime || '').toLowerCase() === CANVAS_MIME;
}

export async function decodeCanvasAttachment(
	attachment: Pick<NoteImage, 'mime' | 'dataUrl'>
): Promise<CanvasScene & { previewDataUrl: string }> {
	if (!isCanvasAttachment(attachment) || !attachment.dataUrl) {
		throw new Error('Canvas data is not available on this device.');
	}
	const blob = await dataUrlToBlob(attachment.dataUrl);
	if (blob.size > MAX_CANVAS_BYTES) throw new Error('This canvas is too large to open.');
	const document = parseDocument(JSON.parse(await blob.text()));
	return {
		elements: document.elements,
		appState: document.appState,
		files: document.files,
		previewDataUrl: document.previewDataUrl
	};
}

export async function canvasThumbnailDataUrl(
	attachment: Pick<NoteImage, 'mime' | 'dataUrl'>
): Promise<string | undefined> {
	if (!isCanvasAttachment(attachment) || !attachment.dataUrl) return undefined;
	try {
		return (await decodeCanvasAttachment(attachment)).previewDataUrl;
	} catch {
		return undefined;
	}
}

export async function createCanvasAttachment(
	scene: CanvasScene,
	previewDataUrl: string,
	existing?: NoteImage
): Promise<NoteImage> {
	const elements = persistableElements(scene.elements, scene.files);
	const files = sceneFiles(scene.files, elements);
	if (elements.length === 0) throw new Error('Draw something before saving the canvas.');
	if (elements.length > MAX_CANVAS_ELEMENTS)
		throw new Error('This canvas contains too many objects.');
	if (!validPreview(previewDataUrl)) throw new Error('Could not create a canvas preview.');

	const document: StoredCanvasDocument = {
		version: 1,
		engine: 'excalidraw',
		elements,
		appState: normalizeAppState(scene.appState),
		files,
		previewDataUrl
	};
	const json = JSON.stringify(document);
	const bytes = new TextEncoder().encode(json).byteLength;
	if (bytes > MAX_CANVAS_BYTES) throw new Error('This canvas is too large to save.');
	const dataUrl = await blobToDataUrl(new Blob([json], { type: CANVAS_MIME }));

	return {
		id: existing?.id ?? uid(),
		mime: CANVAS_MIME,
		dataUrl,
		thumbUrl: previewDataUrl,
		name: existing?.name ?? 'Canvas',
		createdAt: existing?.createdAt ?? Date.now(),
		byteSize: bytes,
		contentHash: await sha256(dataUrl),
		encodingVersion: CANVAS_ENCODING_VERSION
	};
}

export function mergeCanvasEdit(
	attachments: NoteImage[],
	saved: NoteImage,
	sourceHash?: string
): { attachments: NoteImage[]; conflict: boolean } {
	const current = attachments.find((attachment) => attachment.id === saved.id);
	const conflict = !!(
		current &&
		sourceHash &&
		current.contentHash &&
		current.contentHash !== sourceHash
	);
	const result = conflict
		? {
				...saved,
				id: uid(),
				name: 'Canvas (edited copy)',
				createdAt: Date.now()
			}
		: saved;
	const replaced = attachments.some((attachment) => attachment.id === result.id);
	return {
		attachments: replaced
			? attachments.map((attachment) => (attachment.id === result.id ? result : attachment))
			: [...attachments, result],
		conflict
	};
}
