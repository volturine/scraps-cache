import { describe, expect, it } from 'vitest';
import {
	CANVAS_MIME,
	canvasThumbnailDataUrl,
	createCanvasAttachment,
	decodeCanvasAttachment,
	isCanvasAttachment,
	mergeCanvasEdit,
	type CanvasScene
} from './canvasAttachment';

const PREVIEW = 'data:image/webp;base64,AA==';

function scene(): CanvasScene {
	return {
		elements: [
			{
				id: 'stroke-1',
				type: 'freedraw',
				x: 10,
				y: 20,
				width: 100,
				height: 50,
				points: [
					[0, 0],
					[100, 50]
				]
			}
		],
		appState: {
			scrollX: 12,
			scrollY: -8,
			zoom: { value: 1.5 },
			viewBackgroundColor: '#ffffff',
			selectedElementIds: { 'stroke-1': true }
		}
	};
}

describe('canvas attachments', () => {
	it('round-trips an editable scene and its exact preview', async () => {
		const attachment = await createCanvasAttachment(scene(), PREVIEW);

		expect(attachment.mime).toBe(CANVAS_MIME);
		expect(attachment.thumbUrl).toBe(PREVIEW);
		expect(attachment.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(isCanvasAttachment(attachment)).toBe(true);

		const decoded = await decodeCanvasAttachment(attachment);
		expect(decoded.elements).toEqual(scene().elements);
		expect(decoded.previewDataUrl).toBe(PREVIEW);
		expect(decoded.appState).toEqual({
			scrollX: 12,
			scrollY: -8,
			zoom: { value: 1.5 },
			viewBackgroundColor: '#ffffff'
		});
		expect(await canvasThumbnailDataUrl(attachment)).toBe(PREVIEW);
	});

	it('preserves identity when an existing canvas is edited', async () => {
		const existing = await createCanvasAttachment(scene(), PREVIEW);
		const edited = await createCanvasAttachment(scene(), PREVIEW, existing);

		expect(edited.id).toBe(existing.id);
		expect(edited.createdAt).toBe(existing.createdAt);
	});

	it('rejects scenes that only contain unsupported remote content', async () => {
		const unsupported: CanvasScene = {
			elements: [{ id: 'embed-1', type: 'embeddable', x: 0, y: 0, width: 100, height: 100 }],
			appState: {}
		};

		await expect(createCanvasAttachment(unsupported, PREVIEW)).rejects.toThrow(
			'Draw something before saving'
		);
	});

	it('keeps both versions when sync changes a canvas while it is being edited', async () => {
		const original = await createCanvasAttachment(scene(), PREVIEW);
		const synced = { ...original, contentHash: 'newer-sync-hash' };
		const localEdit = { ...original, contentHash: 'local-edit-hash' };

		const merged = mergeCanvasEdit([synced], localEdit, original.contentHash);

		expect(merged.conflict).toBe(true);
		expect(merged.attachments).toHaveLength(2);
		expect(merged.attachments[0]).toBe(synced);
		expect(merged.attachments[1]).toMatchObject({
			name: 'Canvas (edited copy)',
			contentHash: 'local-edit-hash'
		});
		expect(merged.attachments[1].id).not.toBe(original.id);
	});
});
