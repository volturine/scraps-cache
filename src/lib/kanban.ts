import type { Note } from '$lib/types';
import { stableStringify } from '$lib/syncHash';
import { uid } from '$lib/utils';

export interface KanbanColumn {
	id: string;
	/** null is the fixed backlog; every other column is exactly one note tag. */
	labelId: string | null;
}

/**
 * Controls which notes appear in the backlog column.
 * Notes that already match a tag column never appear here.
 *
 * - `all-non-column` (default): any note without a board tag-column label
 * - `custom`: only untagged and/or notes that carry one of `labelIds`
 */
export interface BacklogFilter {
	mode: 'all-non-column' | 'custom';
	includeUntagged: boolean;
	/** Tag ids that qualify a note for the backlog when mode is `custom`. */
	labelIds: string[];
}

export interface KanbanBoard {
	id: string;
	name: string;
	columns: KanbanColumn[];
	backlogFilter: BacklogFilter;
	/** Last configuration edit; this is the board's delta-sync version. */
	updatedAt: number;
}

export function defaultBacklogFilter(): BacklogFilter {
	return { mode: 'all-non-column', includeUntagged: true, labelIds: [] };
}

export function normalizeBacklogFilter(value: unknown): BacklogFilter {
	const fallback = defaultBacklogFilter();
	if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
	const raw = value as Partial<BacklogFilter>;
	const mode = raw.mode === 'custom' ? 'custom' : 'all-non-column';
	const includeUntagged = raw.includeUntagged !== false;
	const labelIds = Array.isArray(raw.labelIds)
		? [
				...new Set(
					raw.labelIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
				)
			]
		: [];
	return { mode, includeUntagged, labelIds };
}

export function createKanbanBoard(name = 'Untitled board'): KanbanBoard {
	const now = Date.now();
	return {
		id: uid(),
		name: name.trim() || 'Untitled board',
		columns: [{ id: uid(), labelId: null }],
		backlogFilter: defaultBacklogFilter(),
		updatedAt: now
	};
}

/** Label ids used by this board's non-backlog columns. */
export function boardColumnLabelIds(board: KanbanBoard): Set<string> {
	return new Set(
		board.columns.flatMap((candidate) => (candidate.labelId === null ? [] : [candidate.labelId]))
	);
}

/**
 * A note belongs in the backlog when it does not carry any board tag-column
 * label, and it matches the board's backlog filter.
 */
export function noteMatchesBacklog(board: KanbanBoard, note: Note): boolean {
	const columnLabels = boardColumnLabelIds(board);
	if (note.labels.some((labelId) => columnLabels.has(labelId))) return false;

	const filter = board.backlogFilter ?? defaultBacklogFilter();
	if (filter.mode !== 'custom') {
		// Legacy / default: everything that is not already in a tag column.
		return true;
	}

	if (filter.includeUntagged && note.labels.length === 0) return true;
	if (filter.labelIds.length === 0) return false;
	const allowed = new Set(filter.labelIds);
	return note.labels.some((labelId) => allowed.has(labelId));
}

/**
 * A tag column contains notes with that tag. The backlog uses {@link noteMatchesBacklog}.
 */
export function columnNotes(board: KanbanBoard, column: KanbanColumn, notes: Note[]): Note[] {
	const columnLabelId = column.labelId;
	if (columnLabelId !== null) return notes.filter((note) => note.labels.includes(columnLabelId));
	return notes.filter((note) => noteMatchesBacklog(board, note));
}

/** Newer boards win; equal timestamps use canonical content ordering on every device. */
export function mergeKanbanBoards(
	local: KanbanBoard[],
	remote: KanbanBoard[],
	tombstones: Record<string, number> = {}
): KanbanBoard[] {
	const byId = new Map(local.map((board) => [board.id, board]));
	for (const board of remote) {
		const current = byId.get(board.id);
		if (
			!current ||
			board.updatedAt > current.updatedAt ||
			(board.updatedAt === current.updatedAt && stableStringify(board) > stableStringify(current))
		) {
			byId.set(board.id, board);
		}
	}
	return [...byId.values()].filter((board) => !(Number(tombstones[board.id]) || 0));
}

/**
 * Moving is deliberately label-only: remove the exact source tag and add the
 * destination tag. Labels outside the board are never changed.
 */
export function moveNoteLabels(
	labels: string[],
	sourceLabelId: string | null,
	destinationLabelId: string | null
): string[] {
	const withoutSource =
		sourceLabelId === null ? [...labels] : labels.filter((labelId) => labelId !== sourceLabelId);
	return destinationLabelId !== null && !withoutSource.includes(destinationLabelId)
		? [...withoutSource, destinationLabelId]
		: withoutSource;
}
