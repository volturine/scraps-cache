import type { Label, Note, NoteImage } from './types';

/** Canonical fast-boot mirrors. IndexedDB remains the durable device store. */
export const NOTES_MIRROR_KEY = 'gkc-notes-mirror';
export const LABELS_MIRROR_KEY = 'gkc-labels-mirror';
export const MAX_MIRRORED_NOTES = 50;

type MirroredImage = Omit<NoteImage, 'dataUrl'>;
type MirroredNote = Omit<Note, 'images'> & { images?: MirroredImage[] };

function imageRef(image: NoteImage): MirroredImage {
	const { dataUrl: _bytes, ...meta } = image;
	return {
		...meta,
		id: image.id,
		mime: image.mime,
		createdAt: image.createdAt
	};
}

/** Note shape safe for localStorage: attachment bytes never enter the mirror. Image refs stay. */
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
						...(preview.description ? { description: preview.description } : {}),
						...(preview.image ? { image: preview.image } : {}),
						...(preview.icon ? { icon: preview.icon } : {})
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

function writeJson<T>(key: string, value: T[]): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch (err) {
		console.error('[storage] write mirror failed:', key, err);
	}
}

export function readNotesMirror(): Note[] {
	return readJson<MirroredNote>(NOTES_MIRROR_KEY).map((note) => {
		const { hasImages: _legacy, images, ...rest } = note as MirroredNote & { hasImages?: boolean };
		return {
			...rest,
			images: (images ?? []).map((image) => ({
				...image,
				dataUrl: ''
			}))
		};
	});
}

export function writeNotesMirror(notes: Note[]): void {
	writeJson(
		NOTES_MIRROR_KEY,
		[...notes]
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.slice(0, MAX_MIRRORED_NOTES)
			.map(noteForLocalStorage)
	);
}

export function readLabelsMirror(): Label[] {
	return readJson<Label>(LABELS_MIRROR_KEY);
}

export function writeLabelsMirror(labels: Label[]): void {
	writeJson(LABELS_MIRROR_KEY, labels);
}
