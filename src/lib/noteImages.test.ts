import { describe, expect, it } from 'vitest';
import { isInlinePreviewable } from './noteImages';

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
