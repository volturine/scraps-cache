import { describe, expect, it } from 'vitest';
import { mergeHydratedImages } from './noteAttachmentHydration';
import type { NoteImage } from './types';

function image(id: string, dataUrl = ''): NoteImage {
	return { id, mime: 'image/jpeg', dataUrl, createdAt: 1 };
}

describe('mergeHydratedImages', () => {
	it('fills only unloaded placeholders and preserves the current attachment list', () => {
		const current = [image('stored'), image('new', 'data:new')];
		const hydrated = [image('stored', 'data:stored')];

		expect(mergeHydratedImages(current, hydrated)).toEqual([
			image('stored', 'data:stored'),
			image('new', 'data:new')
		]);
	});

	it('does not resurrect an attachment removed while loading', () => {
		expect(
			mergeHydratedImages(
				[image('kept')],
				[image('removed', 'data:removed'), image('kept', 'data:kept')]
			)
		).toEqual([image('kept', 'data:kept')]);
	});
});
