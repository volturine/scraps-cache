// Incremental sync decisions. Upload only dirty records; never infer "unused"
// attachments from a page that has not yet applied their parent notes.
import type { KanbanBoard } from '$lib/kanban';
import type { Label, Note } from '$lib/types';
import { isTombstoned } from '$lib/noteMerge';
import type { SyncRecord } from '$lib/syncRecords';

export type TombstoneMaps = {
	notes: Record<string, number>;
	labels: Record<string, number>;
	boards: Record<string, number>;
};

export function currentRecordKeys(
	notes: Note[],
	labels: Label[],
	boards: KanbanBoard[],
	tombstones: TombstoneMaps
): Set<string> {
	const keys = new Set<string>();
	for (const note of notes) {
		if (isTombstoned(note.id, tombstones.notes)) continue;
		keys.add(`note:${note.id}`);
		for (const image of note.images ?? []) keys.add(`attachment:${image.id}`);
	}
	for (const label of labels) {
		if (!isTombstoned(label.id, tombstones.labels)) keys.add(`label:${label.id}`);
	}
	for (const board of boards) {
		if (!isTombstoned(board.id, tombstones.boards)) keys.add(`board:${board.id}`);
	}
	for (const id of Object.keys(tombstones.notes)) keys.add(`note-tombstone:${id}`);
	for (const id of Object.keys(tombstones.labels)) keys.add(`label-tombstone:${id}`);
	for (const id of Object.keys(tombstones.boards)) keys.add(`board-tombstone:${id}`);
	return keys;
}

/**
 * Slot deletes are incremental GC, not catch-up. Attachments are only removed
 * after this device has finished downloading (`catchUpComplete`) and no live
 * applied note still lists them. Tombstone slots stay on the relay.
 */
export function planDeletableKeys(input: {
	recordIds: Record<string, string>;
	notes: Note[];
	labels: Label[];
	boards: KanbanBoard[];
	tombstones: TombstoneMaps;
	pullOnly: boolean;
	catchUpComplete: boolean;
}): string[] {
	if (input.pullOnly) return [];
	const current = currentRecordKeys(input.notes, input.labels, input.boards, input.tombstones);
	const deletable: string[] = [];
	for (const key of Object.keys(input.recordIds)) {
		if (current.has(key)) continue;
		if (key.startsWith('note:')) {
			if (isTombstoned(key.slice('note:'.length), input.tombstones.notes)) deletable.push(key);
			continue;
		}
		if (key.startsWith('label:')) {
			if (isTombstoned(key.slice('label:'.length), input.tombstones.labels)) deletable.push(key);
			continue;
		}
		if (key.startsWith('board:')) {
			if (isTombstoned(key.slice('board:'.length), input.tombstones.boards)) deletable.push(key);
			continue;
		}
		if (key.startsWith('attachment:')) {
			if (!input.catchUpComplete) continue;
			// A replacement note can land before its new photo. Keep the old slot
			// until every photo this device still lists is on the relay.
			const waitingForUpload = [...current].some(
				(item) => item.startsWith('attachment:') && !input.recordIds[item]
			);
			if (waitingForUpload) continue;
			deletable.push(key);
		}
	}
	return deletable.slice(0, 500);
}

/** A drained pull may reveal orphaned slots, which require one more relay round to delete. */
export function syncRoundHasMore(options: {
	remoteHasMore: boolean;
	remainingUploads: boolean;
	pendingDeletes: boolean;
}): boolean {
	return options.remoteHasMore || options.remainingUploads || options.pendingDeletes;
}

export function reconcileBaseline(input: {
	previous: Record<string, string>;
	uploaded: Record<string, string>;
	remote: Record<string, string>;
	merged: Record<string, string>;
	currentKeys: Set<string>;
	referencedAttachments: Set<string>;
}): { baseline: Record<string, string>; dirtyKeys: string[]; ackKeys: string[] } {
	const baseline = { ...input.previous };
	const dirtyKeys: string[] = [];
	const ackKeys: string[] = [];

	for (const [key, fingerprint] of Object.entries(input.uploaded)) {
		baseline[key] = fingerprint;
		if (!input.merged[key] || input.merged[key] === fingerprint) ackKeys.push(key);
		else dirtyKeys.push(key);
	}

	for (const [key, remoteFingerprint] of Object.entries(input.remote)) {
		const mergedFingerprint = input.merged[key];
		if (mergedFingerprint && mergedFingerprint !== remoteFingerprint) {
			baseline[key] = remoteFingerprint;
			dirtyKeys.push(key);
			continue;
		}
		if (mergedFingerprint) {
			baseline[key] = mergedFingerprint;
			ackKeys.push(key);
			continue;
		}
		delete baseline[key];
		ackKeys.push(key);
	}

	for (const [key, fingerprint] of Object.entries(input.previous)) {
		if (!key.startsWith('attachment:')) continue;
		const attachmentId = key.slice('attachment:'.length);
		if (input.referencedAttachments.has(attachmentId) && !(key in baseline)) {
			baseline[key] = fingerprint;
		}
	}

	for (const key of Object.keys(baseline)) {
		if (key.startsWith('attachment:')) {
			const attachmentId = key.slice('attachment:'.length);
			if (!input.referencedAttachments.has(attachmentId)) delete baseline[key];
			continue;
		}
		if (!input.currentKeys.has(key) && !(key in input.uploaded)) delete baseline[key];
	}

	return { baseline, dirtyKeys: [...new Set(dirtyKeys)], ackKeys: [...new Set(ackKeys)] };
}

export function referencedAttachmentIds(
	notes: Note[],
	tombstones: Record<string, number>
): Set<string> {
	const ids = new Set<string>();
	for (const note of notes) {
		if (isTombstoned(note.id, tombstones)) continue;
		for (const image of note.images ?? []) ids.add(image.id);
	}
	return ids;
}

export function fingerprintMapFrom(records: SyncRecord[]): Record<string, string> {
	return Object.fromEntries(records.map((record) => [record.key, record.fingerprint]));
}

export function syncControlKeys(accountId: string): {
	cursor: string;
	baseline: string;
	recordIds: string;
	migration: string;
} {
	return {
		cursor: `gkc-sync-cursor:${accountId}`,
		baseline: `gkc-sync-record-fingerprints:${accountId}`,
		recordIds: `gkc-sync-record-ids:${accountId}`,
		migration: `gkc-sync-slot-migration:${accountId}`
	};
}
