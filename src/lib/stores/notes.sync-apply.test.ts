import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/imageThumb', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/imageThumb')>();
	return { ...actual, makeImageThumbDataUrl: vi.fn(async () => null) };
});

import { createSyncIdentity, encryptSyncPayload } from '$lib/syncPairing';
import { syncControlKeys } from '$lib/syncEngine';
import {
	clearAllLabels,
	clearAllNotes,
	clearSyncOutbox,
	closeDeviceDatabase,
	DEVICE_DB_NAME,
	deleteSyncState,
	getAllNotesMetadata,
	getSyncOutboxKeys,
	getSyncState,
	hydrateNoteAttachments,
	putNote,
	setSyncState
} from '$lib/db/idb';
import * as idb from '$lib/db/idb';
import { openDB } from 'idb';
import { loadBoardsFromDevice } from '$lib/syncTombstones';
import * as syncTombstones from '$lib/syncTombstones';
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
		vi.useFakeTimers();
		vi.clearAllTimers();
		vi.useRealTimers();
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

	it('writes the delete tombstone even when the IndexedDB delete fails', async () => {
		const doomed = remoteNote('gone');
		await putNote(doomed);
		notesStore.notes = [doomed];
		vi.spyOn(idb, 'deleteNote').mockRejectedValueOnce(new Error('IndexedDB delete failed'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		await notesStore.deleteNoteForever('gone');
		error.mockRestore();

		expect(notesStore.deletedNoteIds.gone).toBeGreaterThan(0);
		expect(await getSyncState('scrapscache-idb-note-tombstones')).toMatchObject({
			gone: expect.any(Number)
		});
		expect((await getAllNotesMetadata()).map(({ id }) => id)).toContain('gone');
	});

	it('keeps trashed notes in memory when the tombstone write fails', async () => {
		const doomed = remoteNote('doomed');
		doomed.trashed = true;
		doomed.trashedAt = Date.now();
		notesStore.notes = [doomed];
		vi.spyOn(syncTombstones, 'writeTombstones').mockRejectedValueOnce(
			new Error('tombstone write failed')
		);
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		notesStore.emptyTrash();
		await new Promise((resolve) => setTimeout(resolve, 0));
		error.mockRestore();

		expect(notesStore.notes.map((item) => item.id)).toEqual(['doomed']);
		expect(notesStore.deletedNoteIds.doomed).toBeUndefined();
	});

	it('reattaches photo blobs after a crash between blob write and note commit', async () => {
		await getAllNotesMetadata();
		closeDeviceDatabase();
		const db = await openDB(DEVICE_DB_NAME);
		await db.put('note-images', { mime: 'image/png', bytes: Uint8Array.from([65]) }, 'lost::pic');
		db.close();
		closeDeviceDatabase();

		const lost = remoteNote('lost');
		lost.images = [
			{
				id: 'pic',
				mime: 'image/png',
				dataUrl: '',
				createdAt: 1,
				contentHash: 'hash-pic'
			}
		];
		writeNotesMirror([lost]);
		notesStore.notes = [];
		notesStore.loaded = false;

		await notesStore.init();

		const stored = (await getAllNotesMetadata()).find((item) => item.id === 'lost');
		expect(stored).toBeDefined();
		const hydrated = await hydrateNoteAttachments(stored!);
		expect(hydrated.images?.[0]?.dataUrl?.startsWith('data:image/png')).toBe(true);
	});

	it('restores photo bytes from the relay after IndexedDB is wiped', async () => {
		const account = createSyncIdentity();
		syncStore.account = account;
		const image = {
			id: 'pic',
			mime: 'image/png',
			dataUrl: 'data:image/png;base64,QQ==',
			createdAt: 1,
			contentHash: 'hash-pic'
		};
		notesStore.notes = [
			{
				...remoteNote(),
				images: [{ ...image, dataUrl: '' }]
			}
		];
		const keys = syncControlKeys(account.accountId);
		await clearAllNotes();
		await clearAllLabels();
		await clearSyncOutbox(await getSyncOutboxKeys());
		await deleteSyncState(keys.cursor);
		await deleteSyncState(keys.baseline);
		await deleteSyncState(keys.recordIds);

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
						cursor: 2,
						envelopes: [
							{
								seq: 1,
								id: 'att-id',
								slot: 'a'.repeat(64),
								ciphertext: encryptSyncPayload(account.syncKey, {
									kind: 'attachment',
									value: {
										id: 'pic',
										mime: 'image/png',
										createdAt: 1,
										hash: 'hash-pic',
										dataUrl: image.dataUrl
									}
								})
							},
							{
								seq: 2,
								id: 'note-id',
								slot: 'b'.repeat(64),
								ciphertext: encryptSyncPayload(account.syncKey, {
									kind: 'note',
									value: {
										...remoteNote(),
										images: [
											{
												id: 'pic',
												mime: 'image/png',
												createdAt: 1,
												hash: 'hash-pic'
											}
										]
									}
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
					cursor: 2,
					envelopes: [],
					conflicts: [],
					hasMore: false,
					reset: false,
					writesAccepted: true
				}
			};
		});

		expect(await notesStore.syncWithCloudManual()).toBe(true);
		const stored = (await getAllNotesMetadata()).find((item) => item.id === 'note-1');
		expect(stored).toBeDefined();
		const hydrated = await hydrateNoteAttachments(stored!);
		expect(hydrated.images?.[0]?.dataUrl).toBe(image.dataUrl);
	});

	it('replace-with-cloud pulls the account from the start instead of wiping at a caught-up cursor', async () => {
		const account = createSyncIdentity();
		syncStore.account = account;
		const local = remoteNote('local-only');
		local.title = 'should be replaced';
		await putNote(local);
		notesStore.notes = [local];
		const keys = syncControlKeys(account.accountId);
		await setSyncState(keys.cursor, 9);
		await setSyncState(keys.baseline, { 'note:local-only': 'fp' });
		const cloud = remoteNote('cloud-1');
		cloud.title = 'from account';

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
						cursor: request.cursor,
						envelopes: [],
						conflicts: [],
						hasMore: false,
						reset: false,
						writesAccepted: true,
						usage: {
							ciphertextBytes: 20,
							envelopeCount: 1,
							maxBytes: 1000
						}
					}
				};
			}
			return {
				success: true,
				data: {
					cursor: 1,
					envelopes: [
						{
							seq: 1,
							id: 'cloud-id',
							slot: 'a'.repeat(64),
							ciphertext: encryptSyncPayload(account.syncKey, {
								kind: 'note',
								value: cloud
							})
						}
					],
					conflicts: [],
					hasMore: false,
					reset: false,
					writesAccepted: true,
					usage: {
						ciphertextBytes: 20,
						envelopeCount: 1,
						maxBytes: 1000
					}
				}
			};
		});

		expect(await notesStore.replaceWithCloudManual()).toBe(true);
		expect(notesStore.notes.map((item) => item.id)).toEqual(['cloud-1']);
		expect((await getAllNotesMetadata()).map(({ id }) => id)).toEqual(['cloud-1']);
	});

	it('serializes replacement with normal sync before local notes can upload', async () => {
		const account = createSyncIdentity();
		syncStore.account = account;
		const local = remoteNote('local-only');
		notesStore.notes = [local];
		let lockRequests = 0;
		let tail: Promise<unknown> = Promise.resolve();
		const locks = {
			request: async (_name: string, callback: () => Promise<boolean>) => {
				lockRequests += 1;
				const run = tail.then(callback);
				tail = run.catch(() => undefined);
				return run;
			}
		};
		Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
		vi.spyOn(syncStore, 'clearAccountControlPlane').mockImplementation(async () => undefined);
		vi.spyOn(
			syncStore as unknown as {
				sendSyncRequest(
					path: string,
					payload: string
				): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
			},
			'sendSyncRequest'
		).mockResolvedValue({
			success: true,
			data: {
				cursor: 1,
				envelopes: [],
				conflicts: [],
				hasMore: false,
				reset: false,
				writesAccepted: true,
				usage: {
					ciphertextBytes: 0,
					envelopeCount: 0,
					maxBytes: 1000
				}
			}
		});

		try {
			const replacement = notesStore.replaceWithCloudManual();
			const normalSync = notesStore.syncWithCloudManual();
			const [replaced, synced] = await Promise.all([replacement, normalSync]);
			expect(replaced).toBe(true);
			expect(synced).toBe(true);
		} finally {
			Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
		}

		expect(lockRequests).toBe(2);
		expect(notesStore.notes).toEqual([]);
	});

	it('pairing merge keeps both notes when this device and the account share an id', async () => {
		const account = createSyncIdentity();
		syncStore.account = account;
		const local = remoteNote('shared');
		local.title = 'mine';
		local.updatedAt = 20;
		await putNote(local);
		notesStore.notes = [local];
		const cloud = remoteNote('shared');
		cloud.title = 'theirs';
		cloud.updatedAt = 10;

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
						cursor: request.cursor,
						envelopes: [],
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
					envelopes: [
						{
							seq: 1,
							id: 'cloud-id',
							slot: 'b'.repeat(64),
							ciphertext: encryptSyncPayload(account.syncKey, {
								kind: 'note',
								value: cloud
							})
						}
					],
					conflicts: [],
					hasMore: false,
					reset: false,
					writesAccepted: true
				}
			};
		});

		expect(await notesStore.mergeWithCloudManual()).toBe(true);
		const titles = notesStore.notes.map((item) => item.title).sort();
		expect(titles).toEqual(['mine', 'theirs']);
		const ids = notesStore.notes.map((item) => item.id);
		expect(ids).toContain('shared');
		expect(ids.some((id) => id !== 'shared')).toBe(true);
		expect(notesStore.notes.find((item) => item.id === 'shared')?.title).toBe('theirs');
		expect(notesStore.notes.find((item) => item.id !== 'shared')?.title).toBe('mine');
	});

	it('runs the pairing merge through the same web lock as automatic sync without overlap or re-entry', async () => {
		const account = createSyncIdentity();
		syncStore.account = account;
		let depth = 0;
		let maxDepth = 0;
		let active = 0;
		let overlaps = 0;
		const events: string[] = [];
		let tail: Promise<unknown> = Promise.resolve();
		const locks = {
			request: async (_name: string, callback: () => Promise<boolean>) => {
				const run = tail.then(async () => {
					depth += 1;
					active += 1;
					maxDepth = Math.max(maxDepth, depth);
					if (active > 1) overlaps += 1;
					events.push('enter');
					try {
						return await callback();
					} finally {
						events.push('exit');
						active -= 1;
						depth -= 1;
					}
				});
				tail = run.catch(() => undefined);
				return run;
			}
		};
		Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
		let firstAutoRound: (() => void) | null = null;
		const started = new Promise<void>((resolve) => {
			firstAutoRound = resolve;
		});
		vi.spyOn(
			syncStore as unknown as {
				sendSyncRequest(
					path: string,
					payload: string
				): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
			},
			'sendSyncRequest'
		).mockImplementation(async () => {
			firstAutoRound?.();
			firstAutoRound = null;
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
		vi.spyOn(syncStore, 'clearAccountControlPlane').mockImplementation(async () => undefined);

		try {
			const auto = notesStore.flushSync(true);
			await started;

			const merged = notesStore.mergeWithCloudManual();
			expect(await auto).toBe(true);
			expect(await merged).toBe(true);
		} finally {
			Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
		}

		expect(overlaps).toBe(0);
		expect(maxDepth).toBe(1);
		expect(events.filter((event) => event === 'enter').length).toBeGreaterThanOrEqual(3);
	});
});
