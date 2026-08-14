import {
	createKanbanBoard,
	mergeKanbanBoards,
	normalizeBacklogFilter,
	type BacklogFilter,
	type KanbanBoard,
	type KanbanColumn
} from '$lib/kanban';
import { syncStore } from '$lib/stores/sync.svelte';
import {
	loadBoardsFromDevice,
	saveBoardsToDevice,
	writeBoardTombstones
} from '$lib/syncTombstones';
import { uid } from '$lib/utils';

const BOARDS_KEY = 'gkc-kanban-boards-v1';
const ACTIVE_BOARD_KEY = 'gkc-kanban-active-board-v1';
const BOARD_TOMBSTONES_KEY = 'gkc-kanban-board-tombstones-v1';

type StoredBoard = {
	id?: unknown;
	name?: unknown;
	columns?: unknown;
	backlogFilter?: unknown;
	updatedAt?: unknown;
};

function normalizeBoard(value: unknown): KanbanBoard | null {
	if (!value || typeof value !== 'object') return null;
	const board = value as StoredBoard;
	if (
		typeof board.id !== 'string' ||
		typeof board.name !== 'string' ||
		!Array.isArray(board.columns)
	)
		return null;

	const usedLabels = new Set<string>();
	let hasBacklog = false;
	const columns = board.columns.flatMap((column): KanbanColumn[] => {
		if (!column || typeof column !== 'object') return [];
		// Ignore legacy column aliases: a column is now only its tag.
		const candidate = column as { id?: unknown; labelId?: unknown };
		if (typeof candidate.id !== 'string') return [];
		const labelId = typeof candidate.labelId === 'string' ? candidate.labelId : null;
		if (labelId === null) {
			if (hasBacklog) return [];
			hasBacklog = true;
		} else {
			if (usedLabels.has(labelId)) return [];
			usedLabels.add(labelId);
		}
		return [{ id: candidate.id, labelId }];
	});
	if (!hasBacklog) columns.unshift({ id: uid(), labelId: null });
	const backlogFilter = normalizeBacklogFilter(board.backlogFilter);
	// A tag cannot be both a column and a backlog filter tag.
	backlogFilter.labelIds = backlogFilter.labelIds.filter((labelId) => !usedLabels.has(labelId));
	return {
		id: board.id,
		name: board.name.trim() || 'Untitled board',
		columns,
		backlogFilter,
		// Pre-sync boards did not have a version. Persist a one-time local version so they upload.
		updatedAt: Number(board.updatedAt) || Date.now()
	};
}

function normalizeBoards(value: unknown): KanbanBoard[] {
	return Array.isArray(value)
		? value.flatMap((board): KanbanBoard[] => {
				const normalized = normalizeBoard(board);
				return normalized ? [normalized] : [];
			})
		: [];
}

function readBoards(): KanbanBoard[] {
	if (typeof localStorage === 'undefined') return [createKanbanBoard()];
	try {
		const boards = normalizeBoards(JSON.parse(localStorage.getItem(BOARDS_KEY) || '[]'));
		return boards.length ? boards : [createKanbanBoard()];
	} catch {
		return [createKanbanBoard()];
	}
}

function readTombstones(): Record<string, number> {
	if (typeof localStorage === 'undefined') return {};
	try {
		const value: unknown = JSON.parse(localStorage.getItem(BOARD_TOMBSTONES_KEY) || '{}');
		if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).flatMap(([id, updatedAt]) =>
				typeof id === 'string' && Number(updatedAt) > 0 ? [[id, Number(updatedAt)]] : []
			)
		);
	} catch {
		return {};
	}
}

export class KanbanStore {
	boards = $state<KanbanBoard[]>(readBoards());
	activeBoardId = $state<string>('');
	boardTombstones = $state<Record<string, number>>(readTombstones());

	constructor() {
		if (typeof localStorage !== 'undefined') {
			const storedId = localStorage.getItem(ACTIVE_BOARD_KEY);
			this.activeBoardId = this.boards.some((board) => board.id === storedId)
				? storedId!
				: this.boards[0].id;
		} else {
			this.activeBoardId = this.boards[0].id;
		}

		$effect.root(() => {
			$effect(() => {
				if (typeof localStorage === 'undefined') return;
				localStorage.setItem(BOARDS_KEY, JSON.stringify(this.boards));
				localStorage.setItem(ACTIVE_BOARD_KEY, this.activeBoardId);
				localStorage.setItem(BOARD_TOMBSTONES_KEY, JSON.stringify(this.boardTombstones));
				void saveBoardsToDevice(this.boards).catch(() => undefined);
				void writeBoardTombstones(this.boardTombstones).catch(() => undefined);
			});
		});
	}

	async hydrateFromDevice(remoteTombstones: Record<string, number> = {}): Promise<void> {
		const stored = await loadBoardsFromDevice<KanbanBoard[] | undefined>(undefined);
		if (Array.isArray(stored) && stored.length) {
			this.boards = stored;
			if (!this.boards.some((board) => board.id === this.activeBoardId))
				this.activeBoardId = this.boards[0].id;
		}
		const tombstones = { ...this.boardTombstones, ...remoteTombstones };
		this.boardTombstones = tombstones;
		this.boards = mergeKanbanBoards(this.boards, [], tombstones);
		if (!this.boards.length) {
			this.boards = [createKanbanBoard()];
			this.activeBoardId = this.boards[0].id;
		}
	}

	get activeBoard(): KanbanBoard {
		return this.boards.find((board) => board.id === this.activeBoardId) ?? this.boards[0];
	}

	boardsForSync(): KanbanBoard[] {
		return this.boards.map((board) => ({
			...board,
			columns: board.columns.map((column) => ({ ...column })),
			backlogFilter: {
				...board.backlogFilter,
				labelIds: [...board.backlogFilter.labelIds]
			}
		}));
	}

	boardTombstonesForSync(): Record<string, number> {
		return { ...this.boardTombstones };
	}

	/** Merge delta results without scheduling another upload. */
	applySync(remoteBoards: KanbanBoard[], remoteTombstones: Record<string, number> = {}): void {
		const tombstones = { ...this.boardTombstones };
		for (const [id, deletedAt] of Object.entries(remoteTombstones)) {
			if (Number(deletedAt) > (tombstones[id] || 0)) tombstones[id] = Number(deletedAt);
		}
		const remote = normalizeBoards(remoteBoards);
		const merged = mergeKanbanBoards(this.boards, remote, tombstones);
		this.boardTombstones = tombstones;
		this.boards = merged.length ? merged : [createKanbanBoard()];
		if (!this.boards.some((board) => board.id === this.activeBoardId))
			this.activeBoardId = this.boards[0].id;
	}

	/** Used for the explicit “discard local data” link flow. */
	replaceWithCloud(
		remoteBoards: KanbanBoard[],
		remoteTombstones: Record<string, number> = {}
	): void {
		this.boardTombstones = { ...remoteTombstones };
		const boards = normalizeBoards(remoteBoards).filter(
			(board) => (this.boardTombstones[board.id] || 0) < board.updatedAt
		);
		this.boards = boards.length ? boards : [createKanbanBoard()];
		this.activeBoardId = this.boards[0].id;
	}

	selectBoard(id: string): void {
		if (this.boards.some((board) => board.id === id)) this.activeBoardId = id;
	}

	createBoard(name = 'Untitled board'): KanbanBoard {
		const board = createKanbanBoard(name);
		this.boards = [...this.boards, board];
		this.activeBoardId = board.id;
		this.requestSync([`board:${board.id}`]);
		return board;
	}

	renameBoard(boardId: string, name: string): void {
		const nextName = name.trim();
		if (!nextName) return;
		this.changeBoard(boardId, (board) => ({ ...board, name: nextName }));
	}

	/**
	 * Delete a board locally and sync a tombstone so other devices drop it too.
	 * Always leaves at least one board: if the last board is removed, a fresh
	 * untitled board is created so the Kanban view stays usable.
	 */
	deleteBoard(boardId: string): void {
		const existing = this.boards.find((board) => board.id === boardId);
		if (!existing) return;

		const deletedAt = Date.now();
		this.boardTombstones = { ...this.boardTombstones, [boardId]: deletedAt };
		const remaining = this.boards.filter((board) => board.id !== boardId);
		const syncKeys = [`board-tombstone:${boardId}`];

		if (remaining.length === 0) {
			const replacement = createKanbanBoard();
			this.boards = [replacement];
			this.activeBoardId = replacement.id;
			syncKeys.push(`board:${replacement.id}`);
		} else {
			this.boards = remaining;
			if (this.activeBoardId === boardId) this.activeBoardId = remaining[0].id;
		}

		this.requestSync(syncKeys);
	}

	addTagColumn(boardId: string, labelId: string): KanbanColumn | null {
		const board = this.boards.find((candidate) => candidate.id === boardId);
		if (!board || !labelId || board.columns.some((column) => column.labelId === labelId))
			return null;
		const column: KanbanColumn = { id: uid(), labelId };
		this.changeBoard(boardId, (candidate) => ({
			...candidate,
			columns: [...candidate.columns, column],
			// A column tag leaves the backlog filter (it lives in its own column).
			backlogFilter: {
				...candidate.backlogFilter,
				labelIds: candidate.backlogFilter.labelIds.filter((id) => id !== labelId)
			}
		}));
		return column;
	}

	removeTagColumn(boardId: string, columnId: string): void {
		const board = this.boards.find((candidate) => candidate.id === boardId);
		const column = board?.columns.find((candidate) => candidate.id === columnId);
		if (!board || !column || column.labelId === null) return;
		this.changeBoard(boardId, (candidate) => ({
			...candidate,
			columns: candidate.columns.filter((item) => item.id !== columnId)
		}));
	}

	/** Replace the backlog membership rules for a board. */
	setBacklogFilter(boardId: string, filter: BacklogFilter): void {
		const board = this.boards.find((candidate) => candidate.id === boardId);
		if (!board) return;
		const columnLabels = new Set(
			board.columns.flatMap((column) => (column.labelId === null ? [] : [column.labelId]))
		);
		const next = normalizeBacklogFilter(filter);
		next.labelIds = next.labelIds.filter((labelId) => !columnLabels.has(labelId));
		this.changeBoard(boardId, (candidate) => ({ ...candidate, backlogFilter: next }));
	}

	private changeBoard(
		boardId: string,
		change: (
			board: KanbanBoard
		) => Omit<KanbanBoard, 'updatedAt'> & Partial<Pick<KanbanBoard, 'updatedAt'>>
	): void {
		let changed = false;
		const updatedAt = Date.now();
		this.boards = this.boards.map((board) => {
			if (board.id !== boardId) return board;
			changed = true;
			return { ...change(board), updatedAt };
		});
		if (changed) this.requestSync([`board:${boardId}`]);
	}

	private requestSync(keys: Iterable<string> = []): void {
		syncStore.requestAutoSync(keys);
	}
}

export const kanbanStore = new KanbanStore();
