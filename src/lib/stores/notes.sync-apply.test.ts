import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncIdentity, encryptSyncPayload } from '$lib/syncPairing';
import { syncControlKeys } from '$lib/syncEngine';
import {
	getAllNotesMetadata,
	getSyncOutboxKeys,
	getSyncState,
	putNote,
	setSyncState
} from '$lib/db/idb';
import { loadBoardsFromDevice } from '$lib/syncTombstones';
import { writeNotesMirror } from '$lib/noteStorage';
import { notesStore } from './notes.svelte';
import { syncStore } from './sync.svelte';
import type { Note } from '$lib/types';

function remoteNote(id = 'note-1'): Note {
	return {
		id,
		title: 'pulled from relay',
		body: '',
		color: 'default',
		pinned: false,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 1,
		updatedAt: 1,
		reminder: null,
		labels: [],
		images: [],
		fieldTimes: {
			title: 1,
			body: 1,
			color: 1,
			pinned: 1,
			archived: 1,
			trashed: 1,
			reminder: 1,
			labels: 1,
			images: 1,
			linkPreviews: 1
		}
	};
}

describe('notes store sync apply', () => {
	beforeEach(() => {
		localStorage.clear();
		notesStore.notes = [];
		notesStore.labels = [];
		notesStore.deletedNoteIds = {};
		notesStore.deletedLabelIds = {};
		notesStore.lastPersistError = null;
		syncStore.account = null;
		vi.restoreAllMocks();
	});

	afterEach(() => {
		syncStore.account = null;
		notesStore.notes = [];
		notesStore.labels = [];
	});

	it('persists pulled notes and boards to IndexedDB before committing the cursor', async () => {
		const account = createSyncIdentity();
		syncStore.account = account;
		const keys = syncControlKeys(account.accountId);
		const pulled = remoteNote();

		vi.spyOn(
			syncStore as unknown as {
				sendSyncRequest(
					path: string,
					payload: string
				): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
			},
			'sendSyncRequest'
		).mockImplementation(async (_path, payload) => {
			const request = JSON.parse(payload) as { cursor: number };
			if (request.cursor === 0) {
				return {
					success: true,
					data: {
						cursor: 1,
						envelopes: [
							{
								seq: 1,
								id: 'remote-id',
								slot: 'a'.repeat(64),
								ciphertext: encryptSyncPayload(account.syncKey, {
									kind: 'note',
									value: pulled
								})
							}
						],
						conflicts: [],
						hasMore: false,
						reset: false,
						writesAccepted: true
					}
				};
			}
			return {
				success: true,
				data: {
					cursor: 1,
					envelopes: [],
					conflicts: [],
					hasMore: false,
					reset: false,
					writesAccepted: true
				}
			};
		});

		expect(await notesStore.syncWithCloudManual()).toBe(true);
		expect(notesStore.lastPersistError).toBeNull();
		expect((await getAllNotesMetadata()).map(({ id, title }) => ({ id, title }))).toEqual([
			{ id: 'note-1', title: 'pulled from relay' }
		]);
		expect(await getSyncState(keys.cursor)).toBe(1);
		const boards = await loadBoardsFromDevice<unknown>(null);
		expect(Array.isArray(boards) && boards.length > 0).toBe(true);
	});

	it('replays a mirrored note that never reached IndexedDB', async () => {
		const kept = remoteNote('kept');
		kept.title = 'already on disk';
		const lost = remoteNote('lost');
		lost.title = 'only in the mirror';
		lost.updatedAt = 2;
		await putNote(kept);
		writeNotesMirror([kept, lost]);
		notesStore.notes = [];
		notesStore.labels = [];
		notesStore.loaded = false;
		notesStore.deletedNoteIds = {};
		notesStore.deletedLabelIds = {};

		await notesStore.init();

		expect((await getAllNotesMetadata()).map(({ id }) => id).sort()).toEqual(['kept', 'lost']);
		expect(await getSyncOutboxKeys()).toContain('note:lost');
	});

	it('does not re-enter the web lock during a relay-reset bootstrap', async () => {
		const account = createSyncIdentity();
		syncStore.account = account;
		let depth = 0;
		let maxDepth = 0;
		const locks = {
			request: async (_name: string, callback: () => Promise<boolean>) => {
				depth += 1;
				maxDepth = Math.max(maxDepth, depth);
				try {
					return await callback();
				} finally {
					depth -= 1;
				}
			}
		};
		Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
		vi.spyOn(
			syncStore as unknown as {
				sendSyncRequest(
					path: string,
					payload: string
				): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
			},
			'sendSyncRequest'
		).mockImplementation(async (_path, payload) => {
			const request = JSON.parse(payload) as { cursor: number };
			if (request.cursor > 0) {
				return {
					success: true,
					data: {
						cursor: 0,
						envelopes: [],
						conflicts: [],
						hasMore: false,
						reset: true,
						writesAccepted: false
					}
				};
			}
			return {
				success: true,
				data: {
					cursor: 0,
					envelopes: [],
					conflicts: [],
					hasMore: false,
					reset: false,
					writesAccepted: true
				}
			};
		});
		const keys = syncControlKeys(account.accountId);
		await setSyncState(keys.cursor, 99);
		await setSyncState(keys.baseline, { 'note:note-1': 'stale' });

		try {
			expect(await notesStore.syncWithCloudManual()).toBe(true);
			expect(maxDepth).toBe(1);
		} finally {
			Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
		}
	});
});
