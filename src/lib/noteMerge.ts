// Field-level last-write-wins. Each edited field carries its own time; missing
// fieldTimes fall back to updatedAt so older notes still merge as a whole record.
import type { Label, Note, NoteField, NoteFieldTimes, NoteImage } from './types';
import { stableStringify } from './syncHash';

export const NOTE_FIELDS: NoteField[] = [
	'title',
	'body',
	'color',
	'pinned',
	'archived',
	'trashed',
	'reminder',
	'labels',
	'images',
	'linkPreviews'
];

function equalTimestampWinner<T>(left: T, right: T): T {
	return stableStringify(left) >= stableStringify(right) ? left : right;
}

export function fieldTime(note: Note, field: NoteField): number {
	return Number(note.fieldTimes?.[field]) || note.updatedAt;
}

export function touchNoteFields(note: Note, fields: NoteField[], at = Date.now()): Note {
	const fieldTimes: NoteFieldTimes = { ...note.fieldTimes };
	for (const field of fields) fieldTimes[field] = Math.max(at, fieldTime(note, field) + 1);
	return { ...note, updatedAt: Math.max(note.updatedAt, ...Object.values(fieldTimes)), fieldTimes };
}

/** Permanent delete wins until the tombstone is explicitly cleared. */
export function isTombstoned(id: string, tombstones: Record<string, number>): boolean {
	return (Number(tombstones[id]) || 0) > 0;
}

export function withoutTombstoned<T extends { id: string }>(
	records: T[],
	tombstones: Record<string, number>
): T[] {
	return records.filter((record) => !isTombstoned(record.id, tombstones));
}

function pickField<T>(
	primary: T,
	secondary: T,
	primaryTime: number,
	secondaryTime: number
): { value: T; time: number } {
	if (primaryTime === secondaryTime)
		return { value: equalTimestampWinner(primary, secondary), time: primaryTime };
	return primaryTime > secondaryTime
		? { value: primary, time: primaryTime }
		: { value: secondary, time: secondaryTime };
}

function hydrateImageList(preferred: NoteImage[] = [], fallback: NoteImage[] = []): NoteImage[] {
	const fallbackById = new Map(fallback.map((image) => [image.id, image]));
	const filled = preferred.map((image) => {
		if (image.dataUrl?.length) return image;
		const stored = fallbackById.get(image.id);
		return stored?.dataUrl?.length ? { ...image, dataUrl: stored.dataUrl } : image;
	});
	if (preferred.length === 0 || filled.some((image) => image.dataUrl?.length)) return filled;
	const preferredIds = new Set(preferred.map((image) => image.id));
	const extras = fallback.filter((image) => !preferredIds.has(image.id) && image.dataUrl?.length);
	return extras.length ? [...filled, ...extras] : filled;
}

export function mergeTwoNotes(primary: Note, secondary: Note): Note {
	const fieldTimes: NoteFieldTimes = {};
	const title = pickField(
		primary.title,
		secondary.title,
		fieldTime(primary, 'title'),
		fieldTime(secondary, 'title')
	);
	const body = pickField(
		primary.body,
		secondary.body,
		fieldTime(primary, 'body'),
		fieldTime(secondary, 'body')
	);
	const color = pickField(
		primary.color,
		secondary.color,
		fieldTime(primary, 'color'),
		fieldTime(secondary, 'color')
	);
	const pinned = pickField(
		primary.pinned,
		secondary.pinned,
		fieldTime(primary, 'pinned'),
		fieldTime(secondary, 'pinned')
	);
	const archived = pickField(
		primary.archived,
		secondary.archived,
		fieldTime(primary, 'archived'),
		fieldTime(secondary, 'archived')
	);
	const trashed = pickField(
		primary.trashed,
		secondary.trashed,
		fieldTime(primary, 'trashed'),
		fieldTime(secondary, 'trashed')
	);
	const reminder = pickField(
		primary.reminder,
		secondary.reminder,
		fieldTime(primary, 'reminder'),
		fieldTime(secondary, 'reminder')
	);
	const labels = pickField(
		primary.labels,
		secondary.labels,
		fieldTime(primary, 'labels'),
		fieldTime(secondary, 'labels')
	);
	const imageSide = pickField(
		primary.images ?? [],
		secondary.images ?? [],
		fieldTime(primary, 'images'),
		fieldTime(secondary, 'images')
	);
	const linkPreviews = pickField(
		primary.linkPreviews,
		secondary.linkPreviews,
		fieldTime(primary, 'linkPreviews'),
		fieldTime(secondary, 'linkPreviews')
	);
	fieldTimes.title = title.time;
	fieldTimes.body = body.time;
	fieldTimes.color = color.time;
	fieldTimes.pinned = pinned.time;
	fieldTimes.archived = archived.time;
	fieldTimes.trashed = trashed.time;
	fieldTimes.reminder = reminder.time;
	fieldTimes.labels = labels.time;
	fieldTimes.images = imageSide.time;
	fieldTimes.linkPreviews = linkPreviews.time;
	const images = hydrateImageList(
		imageSide.value,
		imageSide.value === (primary.images ?? []) ? (secondary.images ?? []) : (primary.images ?? [])
	);
	const trashedAt = trashed.value
		? Math.max(Number(primary.trashedAt) || 0, Number(secondary.trashedAt) || 0) || Date.now()
		: null;
	return {
		id: primary.id,
		title: title.value,
		body: body.value,
		color: color.value,
		pinned: pinned.value,
		archived: archived.value,
		trashed: trashed.value,
		trashedAt,
		createdAt: Math.min(
			primary.createdAt || secondary.createdAt,
			secondary.createdAt || primary.createdAt
		),
		updatedAt: Math.max(primary.updatedAt, secondary.updatedAt, ...Object.values(fieldTimes)),
		reminder: reminder.value,
		labels: [...labels.value],
		images,
		...(linkPreviews.value?.length ? { linkPreviews: linkPreviews.value } : {}),
		fieldTimes
	};
}

export function mergeNoteLists(primary: Note[], secondary: Note[]): Note[] {
	const byId = new Map<string, Note>();
	for (const note of primary) byId.set(note.id, note);
	for (const note of secondary) {
		const existing = byId.get(note.id);
		byId.set(note.id, existing ? mergeTwoNotes(existing, note) : note);
	}
	return Array.from(byId.values());
}

function labelTime(label: Label): number {
	return label.updatedAt;
}

export function mergeTwoLabels(primary: Label, secondary: Label): Label {
	return labelTime(primary) === labelTime(secondary)
		? equalTimestampWinner(primary, secondary)
		: labelTime(primary) > labelTime(secondary)
			? primary
			: secondary;
}

export function mergeLabelLists(primary: Label[], secondary: Label[]): Label[] {
	const byId = new Map<string, Label>();
	for (const label of primary) byId.set(label.id, label);
	for (const label of secondary) {
		const existing = byId.get(label.id);
		byId.set(label.id, existing ? mergeTwoLabels(existing, label) : label);
	}
	return Array.from(byId.values());
}
