import type { Note } from './types';

/** Approximate decoded byte count without allocating a Blob or binary string. */
export function dataUrlByteLength(dataUrl: string): number {
	if (!dataUrl.startsWith('data:')) return 0;
	const comma = dataUrl.indexOf(',');
	if (comma < 0) return 0;
	const header = dataUrl.slice(0, comma);
	const payload = dataUrl.slice(comma + 1);
	if (/;base64/i.test(header)) {
		const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
		return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
	}
	try {
		return new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
	} catch {
		return payload.length;
	}
}

export function attachmentStorageBytes(notes: Note[]): number {
	return notes.reduce(
		(total, note) =>
			total +
			(note.images ?? []).reduce(
				(noteTotal, image) => noteTotal + dataUrlByteLength(image.dataUrl),
				0
			),
		0
	);
}

export type StorageEstimate = { usage?: number; quota?: number };

/** A conservative disk requirement for decoded Blobs plus their metadata/index overhead. */
export function replacementFitsStorage(notes: Note[], estimate: StorageEstimate): boolean {
	if (!Number.isFinite(estimate.usage) || !Number.isFinite(estimate.quota)) return true;
	const required = attachmentStorageBytes(notes) * 1.1 + notes.length * 2048;
	return required <= Math.max(0, (estimate.quota ?? 0) - (estimate.usage ?? 0));
}
