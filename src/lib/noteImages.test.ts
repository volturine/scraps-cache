import { describe, expect, it } from 'vitest';
import { createCanvasAttachment, type CanvasScene } from './canvasAttachment';
import { isInlinePreviewable, prepareAttachmentForMemory } from './noteImages';

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
