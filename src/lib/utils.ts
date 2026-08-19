// Small utility helpers shared across components and stores.

/** Generate a reasonably unique id (crypto when available, fallback to Math.random). */
export function uid(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Format epoch ms as a human-friendly relative-ish string. */
export function formatReminder(ts: number | null, nowMs = Date.now()): string {
	if (ts == null) return '';
	const d = new Date(ts);
	const now = new Date(nowMs);
	const sameDay = d.toDateString() === now.toDateString();
	const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	if (sameDay) return `Today, ${time}`;
	const tomorrow = new Date(now);
	tomorrow.setDate(now.getDate() + 1);
	if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${time}`;
	return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function countLabel(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Remaining time until a reminder fires, e.g. "in 2 hours 15 minutes". */
export function formatReminderCountdown(ts: number, nowMs = Date.now()): string {
	if (ts < nowMs) return 'Overdue';
	const totalSeconds = Math.floor((ts - nowMs) / 1000);
	if (totalSeconds < 1) return 'Due now';
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) {
		return hours > 0
			? `in ${countLabel(days, 'day')} ${countLabel(hours, 'hour')}`
			: `in ${countLabel(days, 'day')}`;
	}
	if (hours > 0) {
		return minutes > 0
			? `in ${countLabel(hours, 'hour')} ${countLabel(minutes, 'minute')}`
			: `in ${countLabel(hours, 'hour')}`;
	}
	if (minutes > 0) return `in ${countLabel(minutes, 'minute')}`;
	return `in ${countLabel(seconds, 'second')}`;
}

/** True when a reminder timestamp is in the past. */
export function isReminderOverdue(ts: number | null, now = Date.now()): boolean {
	return ts != null && ts < now;
}

/** Days a trashed note has been sitting in the trash. */
export function daysSinceTrashed(trashedAt: number | null): number {
	if (trashedAt == null) return Infinity;
	return (Date.now() - trashedAt) / (1000 * 60 * 60 * 24);
}

export const TRASH_PURGE_DAYS = 7;

/** Give pointer-activated card surfaces an equivalent keyboard interaction. */
export function activateOnKeyboard(event: KeyboardEvent, activate: () => void): void {
	if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
	event.preventDefault();
	activate();
}

/** Deep-clone a note for editing without mutating the stored one. Plain objects only. */
export function cloneNote(note: import('$lib/types').Note): import('$lib/types').Note {
	return {
		id: note.id,
		title: note.title,
		body: note.body,
		color: note.color,
		pinned: note.pinned,
		archived: note.archived,
		trashed: note.trashed,
		trashedAt: note.trashedAt,
		createdAt: note.createdAt,
		updatedAt: note.updatedAt,
		reminder: note.reminder,
		labels: [...note.labels],
		...(note.fieldTimes ? { fieldTimes: { ...note.fieldTimes } } : {}),
		images: (note.images ?? []).map((image) => ({
			id: image.id,
			mime: image.mime,
			dataUrl: image.dataUrl,
			createdAt: image.createdAt,
			...(image.name != null ? { name: image.name } : {}),
			...(image.thumbUrl ? { thumbUrl: image.thumbUrl } : {}),
			...(image.width != null ? { width: image.width } : {}),
			...(image.height != null ? { height: image.height } : {}),
			...(image.byteSize != null ? { byteSize: image.byteSize } : {}),
			...(image.contentHash ? { contentHash: image.contentHash } : {}),
			...(image.encodingVersion != null ? { encodingVersion: image.encodingVersion } : {})
		})),
		...(note.linkPreviews?.length
			? {
					linkPreviews: note.linkPreviews.map((preview) => ({
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

/** Note clone for JSON backup: full note metadata, attachment meta + thumbs, never full image bytes. */
export function cloneNoteForBackup(note: import('$lib/types').Note): import('$lib/types').Note {
	const cloned = cloneNote(note);
	return {
		...cloned,
		images: (cloned.images ?? []).map((image) => ({
			...image,
			dataUrl: ''
		}))
	};
}

/** Download a JSON backup file in the browser. */
export function downloadJSON(data: unknown, filename: string): void {
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
