import { describe, expect, it } from 'vitest';
import {
	CANVAS_MIME,
	createCanvasAttachment,
	decodeCanvasAttachment,
	isCanvasAttachment,
	type CanvasScene
} from './canvasAttachment';
import {
	fileToNoteImage,
	getClipboardFiles,
	isInlinePreviewable,
	looksLikePhoto,
	prepareAttachmentForMemory
} from './noteImages';

describe('attachment preview routing', () => {
	it('keeps browser-viewable files in the app viewer', () => {
		for (const mime of [
			'application/pdf',
			'text/plain',
			'text/yaml',
			'application/yaml',
			'application/json',
			'audio/mpeg',
			'video/mp4'
		]) {
			expect(isInlinePreviewable({ mime })).toBe(true);
		}
	});

	it('sends unsupported files to the platform save/share flow', () => {
		for (const mime of [
			'application/zip',
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		]) {
			expect(isInlinePreviewable({ mime })).toBe(false);
		}
	});
});

describe('looksLikePhoto', () => {
	it('identifies image mime types as photos', () => {
		expect(looksLikePhoto({ type: 'image/png', name: 'screenshot' })).toBe(true);
		expect(looksLikePhoto({ type: 'image/jpeg', name: 'photo' })).toBe(true);
		expect(looksLikePhoto({ type: 'image/webp', name: 'pic' })).toBe(true);
		expect(looksLikePhoto({ type: 'image/heic', name: 'camera' })).toBe(true);
	});

	it('identifies image file extensions even without mime type', () => {
		expect(looksLikePhoto({ type: '', name: 'photo.jpg' })).toBe(true);
		expect(looksLikePhoto({ type: '', name: 'photo.JPEG' })).toBe(true);
		expect(looksLikePhoto({ type: '', name: 'photo.png' })).toBe(true);
		expect(looksLikePhoto({ type: '', name: 'photo.webp' })).toBe(true);
		expect(looksLikePhoto({ type: '', name: 'photo.avif' })).toBe(true);
		expect(looksLikePhoto({ type: '', name: 'photo.gif' })).toBe(true);
		expect(looksLikePhoto({ type: '', name: 'photo.heic' })).toBe(true);
		expect(looksLikePhoto({ type: '', name: 'photo.dng' })).toBe(true);
	});

	it('rejects non-image files', () => {
		expect(looksLikePhoto({ type: 'application/pdf', name: 'doc.pdf' })).toBe(false);
		expect(looksLikePhoto({ type: 'text/plain', name: 'notes.txt' })).toBe(false);
		expect(looksLikePhoto({ type: '', name: 'archive.zip' })).toBe(false);
	});

	it('rejects excalidraw files even with image extension', () => {
		expect(looksLikePhoto({ type: 'image/png', name: 'diagram.excalidraw.png' })).toBe(false);
		expect(looksLikePhoto({ type: '', name: 'diagram.excalidraw' })).toBe(false);
	});
});

describe('getClipboardFiles', () => {
	it('extracts files from clipboardData.files', () => {
		const photo = new File(['data'], 'shot.png', { type: 'image/png' });
		const dataTransfer = {
			files: [photo]
		} as unknown as DataTransfer;
		expect(getClipboardFiles(dataTransfer)).toEqual([photo]);
	});

	it('extracts files from clipboardData.items when files is empty', () => {
		const photo = new File(['data'], 'shot.png', { type: 'image/png' });
		const dataTransfer = {
			files: [],
			items: [
				{
					kind: 'file',
					type: 'image/png',
					getAsFile: () => photo
				},
				{
					kind: 'string',
					type: 'text/plain',
					getAsFile: () => null
				}
			]
		} as unknown as DataTransfer;
		expect(getClipboardFiles(dataTransfer)).toEqual([photo]);
	});

	it('returns empty array when no files are present', () => {
		expect(getClipboardFiles(null)).toEqual([]);
		const dataTransfer = {
			files: [],
			items: [
				{
					kind: 'string',
					type: 'text/plain',
					getAsFile: () => null
				}
			]
		} as unknown as DataTransfer;
		expect(getClipboardFiles(dataTransfer)).toEqual([]);
	});
});

describe('resident attachment previews', () => {
	it('extracts an encrypted canvas payload preview before releasing full bytes', async () => {
		const scene: CanvasScene = {
			elements: [{ id: 'text-1', type: 'text', x: 0, y: 0, width: 20, height: 10 }],
			appState: {}
		};
		const preview = 'data:image/png;base64,AA==';
		const attachment = await createCanvasAttachment(scene, preview);
		delete attachment.thumbUrl;

		const compacted = await prepareAttachmentForMemory(attachment);

		expect(compacted.thumbUrl).toBe(preview);
		expect(compacted.dataUrl).toBe('');
		expect(compacted.contentHash).toBeTruthy();
	});
});

describe('excalidraw file transformation', () => {
	it('transforms excalidraw files into native canvas attachments', async () => {
		const excalidrawJson = JSON.stringify({
			type: 'excalidraw',
			version: 2,
			elements: [
				{
					id: 'box-1',
					type: 'rectangle',
					x: 10,
					y: 10,
					width: 100,
					height: 60
				}
			],
			appState: { viewBackgroundColor: '#121212' },
			files: {}
		});
		const file = new File([excalidrawJson], 'Architecture.excalidraw', {
			type: 'application/octet-stream'
		});

		const attachment = await fileToNoteImage(file, 'compressed');

		expect(isCanvasAttachment(attachment)).toBe(true);
		expect(attachment.mime).toBe(CANVAS_MIME);
		expect(attachment.name).toBe('Architecture');
		expect(attachment.thumbUrl).toBeTruthy();

		const decoded = await decodeCanvasAttachment(attachment);
		expect(decoded.elements).toHaveLength(1);
		expect(decoded.elements[0].id).toBe('box-1');
		expect(decoded.appState.viewBackgroundColor).toBe('#121212');
	});
});
