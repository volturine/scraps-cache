import type { Label, Note, NoteImage } from './types';

/** Canonical fast-boot mirrors. IndexedDB remains the durable device store. */
export const NOTES_MIRROR_KEY = 'scrapscache-notes-mirror';
export const LABELS_MIRROR_KEY = 'scrapscache-labels-mirror';

type MirroredImage = Omit<NoteImage, 'dataUrl' | 'thumbUrl'>;
type MirroredNote = Omit<Note, 'images'> & { images?: MirroredImage[] };

function imageRef(image: NoteImage): MirroredImage {
	const { dataUrl: _bytes, thumbUrl: _thumb, ...meta } = image;
	return {
		...meta,
		id: image.id,
		mime: image.mime,
		createdAt: image.createdAt
	};
}

/** Notes crash mirror: text and attachment ids only. Attachment bytes stay in IndexedDB. */
export function noteForLocalStorage(note: Note): MirroredNote {
	const { images, linkPreviews, ...rest } = note;
	return {
		...rest,
		labels: [...(note.labels ?? [])],
		...(images?.length ? { images: images.map(imageRef) } : {}),
		fieldTimes: note.fieldTimes ? { ...note.fieldTimes } : undefined,
		...(linkPreviews?.length
			? {
					linkPreviews: linkPreviews.map((preview) => ({
						url: preview.url,
						hostname: preview.hostname,
						title: preview.title,
						...(preview.description ? { description: preview.description } : {})
					}))
				}
			: {})
	};
}

function parseArray<T>(raw: string | null): T[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

function readJson<T>(key: string): T[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		return parseArray<T>(localStorage.getItem(key));
	} catch (err) {
		console.error('[storage] read mirror failed:', key, err);
		return [];
	}
}

function writeJson<T>(key: string, value: T[]): boolean {
	if (typeof localStorage === 'undefined') return false;
	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch (err) {
		console.error('[storage] write mirror failed:', key, err);
		return false;
	}
}

export function readNotesMirror(): Note[] {
	return readJson<MirroredNote>(NOTES_MIRROR_KEY).map((note) => {
		const { images, ...rest } = note;
		return {
			...rest,
			images: (images ?? []).map((image) => ({
				...image,
				dataUrl: ''
			}))
		};
	});
}

/** Fallback mirror size when the full write exceeds the localStorage quota. */
export const MIRROR_FALLBACK_LIMIT = 50;

/** True when any mirror write landed; false means the mirror went stale. */
export function writeNotesMirror(notes: Note[]): boolean {
	if (writeJson(NOTES_MIRROR_KEY, notes.map(noteForLocalStorage))) return true;
	// The full mirror exceeded the quota. Keep crash protection for the most
	// recent notes — the ones most likely to have unsynced edits — instead of
	// letting the mirror go entirely stale.
	const recent = [...notes]
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, MIRROR_FALLBACK_LIMIT)
		.map(noteForLocalStorage);
	return writeJson(NOTES_MIRROR_KEY, recent);
}

export function readLabelsMirror(): Label[] {
	return readJson<Label>(LABELS_MIRROR_KEY);
}

export function writeLabelsMirror(labels: Label[]): void {
	writeJson(LABELS_MIRROR_KEY, labels);
}
