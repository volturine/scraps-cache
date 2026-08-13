/// <reference types="node" />

import { extractDngJpeg, jpegName } from '$lib/dngCanonical';
import type { SyncNote } from '$lib/server/syncMerge';

type SyncImage = {
	id: string;
	mime?: string;
	dataUrl?: string;
	name?: string;
	createdAt?: number;
};

function isDng(image: SyncImage): boolean {
	return (
		image.mime?.toLowerCase() === 'image/dng' ||
		/\.dng$/i.test(image.name ?? '') ||
		/^data:image\/(?:x-adobe-)?dng[;,]/i.test(image.dataUrl ?? '')
	);
}

/** Enforce the cloud invariant that active note images are browser-renderable. */
export function canonicalizeSyncNote(note: SyncNote): { note: SyncNote; changed: boolean } {
	let changed = false;
	const images = ((note.images as SyncImage[] | undefined) ?? []).map((image) => {
		if (!isDng(image)) return image;
		if (!image.dataUrl) throw new Error(`Missing DNG payload for ${note.id}/${image.id}`);
		const comma = image.dataUrl.indexOf(',');
		if (comma < 0 || !/;base64$/i.test(image.dataUrl.slice(0, comma))) {
			throw new Error(`Invalid DNG data URL for ${note.id}/${image.id}`);
		}
		const raw = Buffer.from(image.dataUrl.slice(comma + 1), 'base64');
		const jpeg = extractDngJpeg(raw);
		changed = true;
		return {
			...image,
			mime: 'image/jpeg',
			name: jpegName(image.name ?? 'photo.dng'),
			dataUrl: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`
		};
	});
	if (!changed) return { note, changed: false };
	return {
		note: {
			...note,
			images,
			updatedAt: Math.max(Date.now(), Number(note.updatedAt) + 1)
		} as SyncNote,
		changed: true
	};
}
