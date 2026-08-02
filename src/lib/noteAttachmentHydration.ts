import type { NoteImage } from './types';

/**
 * Apply bytes read from IndexedDB without overwriting an edit made while they
 * were loading. The current list owns membership; hydration only fills an
 * existing empty payload.
 */
export function mergeHydratedImages(current: NoteImage[] = [], hydrated: NoteImage[] = []): NoteImage[] {
	const hydratedById = new Map(hydrated.map((image) => [image.id, image]));
	return current.map((image) => {
		if (image.dataUrl) return image;
		const loaded = hydratedById.get(image.id);
		if (!loaded?.dataUrl) return image;
		return {
			...image,
			dataUrl: loaded.dataUrl,
			mime: image.mime || loaded.mime,
			...(image.thumbUrl || loaded.thumbUrl ? { thumbUrl: image.thumbUrl || loaded.thumbUrl } : {}),
			...((image.width ?? loaded.width) != null ? { width: image.width ?? loaded.width } : {}),
			...((image.height ?? loaded.height) != null ? { height: image.height ?? loaded.height } : {}),
			...((image.byteSize ?? loaded.byteSize) != null ? { byteSize: image.byteSize ?? loaded.byteSize } : {}),
			...((image.contentHash ?? loaded.contentHash)
				? { contentHash: image.contentHash ?? loaded.contentHash }
				: {}),
			...((image.encodingVersion ?? loaded.encodingVersion) != null
				? { encodingVersion: image.encodingVersion ?? loaded.encodingVersion }
				: {})
		};
	});
}
