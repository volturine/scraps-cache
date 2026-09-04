import { describe, expect, it } from 'vitest';
import { createCanvasAttachment, type CanvasScene } from './canvasAttachment';
import {
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
