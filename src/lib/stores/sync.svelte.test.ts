const PID = 'device-local';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, NoteImage } from '$lib/types';
import {
	createSyncIdentity,
	decryptSyncPayload,
	encryptSyncPayload,
	type SyncIdentity
} from '$lib/syncPairing';
import { syncControlKeys } from '$lib/syncEngine';
import { recordTag, sha256 } from '$lib/syncHash';
import * as idb from '$lib/db/idb';
import { SyncStore, type SyncSnapshot } from './sync.svelte';

type RequestPayload = {
	cursor: number;
	envelopes: Array<{
		id: string;
		slot: string;
		expectedId: string | null;
		ciphertext: string;
		tag?: string;
	}>;

	deleteSlots: Array<{ id: string; slot: string }>;
};

type RelayData = {
	cursor: number;
	envelopes: Array<{ seq: number; id: string; slot: string; ciphertext: string }>;
	conflicts: Array<{ seq: number; id: string; slot: string; ciphertext: string }>;
	hasMore: boolean;
	reset: boolean;
	writesAccepted: boolean;
	usage?: {
		ciphertextBytes: number;
		envelopeCount: number;
		maxBytes: number;
		maxEnvelopes: number;
	};
};

type RequestResult = { success: true; data: RelayData } | { success: false; error: string };

const emptyData = (overrides: Partial<RelayData> = {}): RelayData => ({
	cursor: 0,
	envelopes: [],
	conflicts: [],
	hasMore: false,
	reset: false,
	writesAccepted: true,
	...overrides
});

function note(
	id = 'note-1',
	overrides: Partial<Note> = {},
	images: NoteImage[] = overrides.images ?? []
): Note {
	const fieldTimes = {
		title: 1,
		body: 1,
		color: 1,
		pinned: 1,
		archived: 1,
		trashed: 1,
		reminder: 1,
		labels: 1,
		images: 1,
		linkPreviews: 1,
		...overrides.fieldTimes
	};
	return {
		id,
		title: id,
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
		...overrides,
		images,
		fieldTimes
	};
}

function attachment(id: string, dataUrl = 'data:image/png;base64,QQ=='): NoteImage {
	return {
		id,
		mime: 'image/png',
		dataUrl,
		createdAt: 1,
		contentHash: `hash-${id}`
	};
}

function envelope(
	account: SyncIdentity,
	id: string,
	seq: number,
	payload: unknown,
	slot = 'a'.repeat(64)
): RelayData['envelopes'][number] {
	return {
		seq,
		id,
		slot,
		ciphertext: encryptSyncPayload(account.syncKey, payload)
	};
}

function createHarness(
	responder: (request: RequestPayload, index: number) => RequestResult | Promise<RequestResult>
): { store: SyncStore; account: SyncIdentity; requests: RequestPayload[] } {
	const account = createSyncIdentity();
	const store = new SyncStore();
	store.account = account;
	const requests: RequestPayload[] = [];
	vi.spyOn(
		store as unknown as {
			sendSyncRequest(
				path: string,
				payload: string
			): Promise<{ success: boolean; data?: RelayData; error?: string }>;
		},
		'sendSyncRequest'
	).mockImplementation(async (_path, payload) => {
		const request = JSON.parse(payload) as RequestPayload;
		requests.push(request);
		return responder(request, requests.length - 1);
	});
	return { store, account, requests };
}

async function passthrough(snapshot: SyncSnapshot): Promise<SyncSnapshot> {
	return snapshot;
}

async function seedControl(
	accountId: string,
	state: {
		cursor?: number;
		baseline?: Record<string, string>;
		recordIds?: Record<string, string>;
		outbox?: string[];
	}
): Promise<void> {
	const keys = syncControlKeys(accountId);
	if (state.cursor != null) await idb.setSyncState(keys.cursor, state.cursor);
	if (state.baseline) await idb.setSyncState(keys.baseline, state.baseline);
	if (state.recordIds) await idb.setSyncState(keys.recordIds, state.recordIds);
	if (state.outbox?.length) await idb.markSyncOutbox(PID, state.outbox);
}

describe('client sync state machine', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it('reports an outbox failure and allows the next durable marker write to retry', async () => {
		const store = new SyncStore();
		vi.spyOn(idb, 'markSyncOutbox').mockRejectedValueOnce(
			new Error('IndexedDB transaction aborted')
		);

		await expect(store.queueOutbox(['note:note-1'])).rejects.toThrow(
			'IndexedDB transaction aborted'
		);
		expect(await idb.getSyncOutboxKeys(PID)).toEqual([]);

		await store.queueOutbox(['note:note-1']);
		expect(await idb.getSyncOutboxKeys(PID)).toEqual(['note:note-1']);
	});

	it('durably applies a downloaded page before committing its cursor', async () => {
		const { store, account } = createHarness(() => ({
			success: true,
			data: emptyData({
				cursor: 1,
				envelopes: [envelope(account, 'remote-envelope', 1, { kind: 'note', value: note() })]
			})
		}));
		const keys = syncControlKeys(account.accountId);

		const result = await store.sync([], [], {}, {}, [], {}, false, true, async (snapshot) => {
			expect(await idb.getSyncState(keys.cursor)).toBeUndefined();
			for (const item of snapshot.notes) await idb.putNote(PID, item);
			return snapshot;
		});

		expect(result.success, result.error).toBe(true);
		expect((await idb.getAllNotesMetadata(PID)).map(({ id }) => id)).toEqual(['note-1']);
		expect(await idb.getSyncState(keys.cursor)).toBe(1);
	});

	it('leaves all control state untouched when durable application fails', async () => {
		const { store, account } = createHarness(() => ({
			success: true,
			data: emptyData({
				cursor: 1,
				envelopes: [envelope(account, 'remote-envelope', 1, { kind: 'note', value: note() })]
			})
		}));
		const keys = syncControlKeys(account.accountId);

		const result = await store.sync([], [], {}, {}, [], {}, false, true, async () => {
			throw new Error('IndexedDB write failed');
		});

		expect(result).toMatchObject({ success: false });
		expect(await idb.getSyncState(keys.cursor)).toBeUndefined();
		expect(await idb.getSyncState(keys.baseline)).toBeUndefined();
		expect(await idb.getSyncState(keys.recordIds)).toBeUndefined();
		expect(await idb.getAllNotesMetadata(PID)).toEqual([]);
	});

	it('drains every page before applying or committing, including cross-page attachments', async () => {
		const applied: SyncSnapshot[] = [];
		let cursorAtSecondRequest: unknown = 'not-requested';
		const { store, account, requests } = createHarness(async (_request, index) => {
			if (index === 0) {
				return {
					success: true,
					data: emptyData({
						cursor: 1,
						hasMore: true,
						envelopes: [
							envelope(account, 'note-envelope', 1, {
								kind: 'note',
								value: {
									...note(),
									images: [
										{
											id: 'image-1',
											mime: 'image/png',
											createdAt: 1,
											hash: 'image-hash'
										}
									]
								}
							})
						]
					})
				};
			}
			cursorAtSecondRequest = await idb.getSyncState(syncControlKeys(account.accountId).cursor);
			return {
				success: true,
				data: emptyData({
					cursor: 2,
					envelopes: [
						envelope(account, 'attachment-envelope', 2, {
							kind: 'attachment',
							value: {
								id: 'image-1',
								mime: 'image/png',
								createdAt: 1,
								hash: 'image-hash',
								dataUrl: 'data:image/png;base64,QQ=='
							}
						})
					]
				})
			};
		});

		const result = await store.sync([], [], {}, {}, [], {}, false, true, async (snapshot) => {
			applied.push(snapshot);
			return snapshot;
		});

		expect(result.success, result.error).toBe(true);
		expect(requests).toHaveLength(2);
		expect(requests.every((request) => request.envelopes.length === 0)).toBe(true);
		expect(cursorAtSecondRequest).toBeUndefined();
		expect(applied).toHaveLength(1);
		expect(applied[0].notes[0]?.images?.[0]?.dataUrl).toBe('data:image/png;base64,QQ==');
		expect(await idb.getSyncState(syncControlKeys(account.accountId).cursor)).toBe(2);
	});

	it('merges downloaded state before building the first conditional upload', async () => {
		const local = note('note-1', {
			title: 'local winner',
			updatedAt: 20,
			fieldTimes: { title: 20, body: 1 }
		});
		const { store, account, requests } = createHarness((_request, index) => {
			if (index === 0) {
				return {
					success: true,
					data: emptyData({
						cursor: 1,
						envelopes: [
							envelope(account, 'remote-id', 1, {
								kind: 'note',
								value: note('note-1', {
									title: 'remote older',
									updatedAt: 10,
									fieldTimes: { title: 10, body: 1 }
								})
							})
						]
					})
				};
			}
			return { success: true, data: emptyData({ cursor: 2 }) };
		});
		await idb.markSyncOutbox(PID, [`note:note-1`]);

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(requests[0].envelopes).toEqual([]);
		expect(requests[1].envelopes).toHaveLength(1);
		expect(requests[1].envelopes[0].expectedId).toBe('remote-id');
		expect(decryptSyncPayload(account.syncKey, requests[1].envelopes[0].ciphertext)).toMatchObject({
			kind: 'note',
			value: { title: 'local winner' }
		});
	});

	it('applies a conditional-write conflict and retries against the returned version', async () => {
		const local = note('note-1', {
			title: 'local winner',
			updatedAt: 20,
			fieldTimes: { title: 20, body: 1 }
		});
		const { store, account, requests } = createHarness((_request, index) => {
			if (index === 0) return { success: true, data: emptyData({ cursor: 1 }) };
			if (index === 1) {
				return {
					success: true,
					data: emptyData({
						cursor: 2,
						writesAccepted: false,
						conflicts: [
							envelope(account, 'current-id', 2, {
								kind: 'note',
								value: note('note-1', {
									title: 'server older',
									updatedAt: 15,
									fieldTimes: { title: 15, body: 1 }
								})
							})
						]
					})
				};
			}
			return { success: true, data: emptyData({ cursor: 3 }) };
		});
		await seedControl(account.accountId, {
			cursor: 1,
			baseline: { 'note:note-1': 'old-fingerprint' },
			recordIds: { 'note:note-1': 'old-id' },
			outbox: ['note:note-1']
		});

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(requests).toHaveLength(3);
		expect(requests[1].envelopes[0].expectedId).toBe('old-id');
		expect(requests[2].envelopes[0].expectedId).toBe('current-id');
		expect(requests[2].envelopes[0].id).not.toBe(requests[1].envelopes[0].id);
		expect(await idb.getSyncOutboxKeys(PID)).toEqual([]);
	});

	it('recovers from an accepted upload whose response was lost without uploading it twice', async () => {
		const local = note();
		let accepted: RelayData['envelopes'][number] | null = null;
		let calls = 0;
		const { store, account, requests } = createHarness((request) => {
			calls += 1;
			if (calls === 1) return { success: true, data: emptyData() };
			if (calls === 2) {
				accepted = {
					seq: 1,
					id: request.envelopes[0].id,
					slot: request.envelopes[0].slot,
					ciphertext: request.envelopes[0].ciphertext
				};
				return { success: false, error: 'Sync timed out' };
			}
			if (calls === 3) {
				return { success: true, data: emptyData({ cursor: 1, envelopes: [accepted!] }) };
			}
			return { success: true, data: emptyData({ cursor: 1 }) };
		});
		await idb.markSyncOutbox(PID, [`note:note-1`]);

		const failed = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);
		expect(failed).toMatchObject({ success: false, error: 'Sync timed out' });
		expect(await idb.getSyncOutboxKeys(PID)).toEqual(['note:note-1']);

		const retried = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);
		expect(retried.success, retried.error).toBe(true);
		expect(requests.filter((request) => request.envelopes.length > 0)).toHaveLength(1);
		expect(await idb.getSyncOutboxKeys(PID)).toEqual([]);
		expect(await idb.getSyncState(syncControlKeys(account.accountId).recordIds)).toEqual({
			'note:note-1': accepted!.id
		});
	});

	it('backfills records the relay is missing when its envelope count runs short', async () => {
		const local = note('note-1', { title: 'must exist on relay' });
		const { store, account, requests } = createHarness((request, index) => {
			if (index === 0)
				return {
					success: true,
					data: emptyData({
						cursor: 1,
						usage: { ciphertextBytes: 0, envelopeCount: 0, maxBytes: 1000, maxEnvelopes: 50 }
					})
				};
			// Repair round: the record the ledger claimed was uploaded is missing.
			return { success: true, data: emptyData({ cursor: 2, writesAccepted: true }) };
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ cursor: 1, slots: [] })
			}))
		);
		const keys = syncControlKeys(account.accountId);
		await seedControl(account.accountId, {
			cursor: 1,
			baseline: { 'note:note-1': 'claimed-fingerprint' },
			recordIds: { 'note:note-1': 'old-id' }
		});

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(vi.mocked(fetch)).toHaveBeenCalled();
		vi.unstubAllGlobals();
		// The repair round re-uploaded the missing record as a replacement.
		const upload = requests.at(-1)?.envelopes[0];
		expect(upload?.expectedId).toBe('old-id');
		expect(decryptSyncPayload(account.syncKey, upload!.ciphertext)).toMatchObject({
			kind: 'note',
			value: { title: 'must exist on relay' }
		});
		expect(await idb.getSyncOutboxKeys(PID)).toEqual([]);
		expect(await idb.getSyncState(keys.baseline)).toMatchObject({
			'note:note-1': expect.any(String)
		});
	});

	it('re-uploads a record whose stored content tag went stale even when counts match', async () => {
		const local = note('note-1', { title: 'current local version' });
		const { store, account, requests } = createHarness((_request, index) =>
			index === 0
				? { success: true, data: emptyData({ cursor: 1 }) }
				: { success: true, data: emptyData({ cursor: 2, writesAccepted: true }) }
		);
		const staleSlot = await sha256(`${account.syncKey}\u0000note:note-1`);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					cursor: 1,
					slots: [{ id: 'relay-id', slot: staleSlot, tag: 'f'.repeat(64) }]
				})
			}))
		);
		await seedControl(account.accountId, {
			cursor: 1,
			baseline: { 'note:note-1': 'ledger-fingerprint' },
			recordIds: { 'note:note-1': 'relay-id' }
		});

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		vi.unstubAllGlobals();
		// Equal counts but a foreign tag means the slot holds a stale version:
		// the ledger must be overridden and the current payload re-uploaded.
		const upload = requests.at(-1)?.envelopes[0];
		expect(upload?.expectedId).toBe('relay-id');
		expect(upload?.tag).toMatch(/^[a-f0-9]{64}$/);
		expect(decryptSyncPayload(account.syncKey, upload!.ciphertext)).toMatchObject({
			kind: 'note',
			value: { title: 'current local version' }
		});
	});

	it('deletes unexpected relay slots during exact integrity repair', async () => {
		const { store, requests } = createHarness(() => ({
			success: true,
			data: emptyData({ cursor: 1, writesAccepted: true })
		}));
		const extraSlot = 'e'.repeat(64);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					cursor: 1,
					slots: [{ id: 'unexpected-id', slot: extraSlot, tag: 'f'.repeat(64) }]
				})
			}))
		);

		const result = await store.sync([], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(requests.at(-1)?.deleteSlots).toEqual([{ id: 'unexpected-id', slot: extraSlot }]);
		expect(JSON.stringify(requests.at(-1)?.deleteSlots)).not.toContain('key');
	});

	it('pulls a concurrent write before classifying its slot as unexpected', async () => {
		const remote = note('concurrent-note');
		const payload = { kind: 'note' as const, value: remote };
		let remoteSlot = '';
		const { store, account, requests } = createHarness((_request, index) =>
			index === 0
				? { success: true, data: emptyData({ cursor: 1 }) }
				: {
						success: true,
						data: emptyData({
							cursor: 2,
							envelopes: [envelope(account, 'concurrent-id', 2, payload, remoteSlot)]
						})
					}
		);
		remoteSlot = await sha256(`${account.syncKey}\u0000note:${remote.id}`);
		const remoteTag = await recordTag(account.syncKey, payload);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					cursor: 2,
					slots: [{ id: 'concurrent-id', slot: remoteSlot, tag: remoteTag }]
				})
			}))
		);
		await seedControl(account.accountId, { cursor: 1, baseline: { existing: 'state' } });

		const result = await store.sync([], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(result.notes?.map(({ id }) => id)).toContain(remote.id);
		expect(requests.flatMap((request) => request.deleteSlots)).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('surfaces partial success when integrity verification is unavailable', async () => {
		const { store } = createHarness(() => ({ success: true, data: emptyData() }));
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false }))
		);

		const result = await store.sync([], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(store.lastError).toMatch(/integrity verification could not complete/i);
	});

	it('rewinds a leftover cursor when there is no baseline so a full pull can run', async () => {
		const pulled = note('note-1', { title: 'from account' });
		const { store, account, requests } = createHarness((request) => {
			if (request.cursor > 0) {
				return {
					success: true,
					data: emptyData({
						cursor: request.cursor,
						usage: { ciphertextBytes: 10, envelopeCount: 1, maxBytes: 1000, maxEnvelopes: 50 }
					})
				};
			}
			return {
				success: true,
				data: emptyData({
					cursor: 1,
					envelopes: [envelope(account, 'cloud-id', 1, { kind: 'note', value: pulled })],
					usage: { ciphertextBytes: 10, envelopeCount: 1, maxBytes: 1000, maxEnvelopes: 50 }
				})
			};
		});
		await seedControl(account.accountId, { cursor: 9 });

		const result = await store.sync([], [], {}, {}, [], {}, false, true, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(requests[0]?.cursor).toBe(0);
		expect(result.notes?.map((item) => item.id)).toEqual(['note-1']);
	});

	it('resets stale control state and rebuilds it on the requested bootstrap pass', async () => {
		const image = attachment('image-1');
		const local = note('note-1', { updatedAt: 5 }, [image]);
		const { store, account, requests } = createHarness((request, index) => {
			if (index === 0) {
				return {
					success: true,
					data: emptyData({ cursor: 0, reset: true, writesAccepted: false })
				};
			}
			if (index === 1 || index === 2 || index === 3) {
				return { success: true, data: emptyData() };
			}
			return {
				success: true,
				data: emptyData({ cursor: request.envelopes.length })
			};
		});
		await seedControl(account.accountId, {
			cursor: 99,
			baseline: { 'note:note-1': 'stale' },
			recordIds: { 'note:note-1': 'stale-id' }
		});

		const reset = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);

		expect(reset.success, reset.error).toBe(true);
		expect(store.consumeCurrentStateBootstrapRequest()).toBe(true);
		expect(requests[0].envelopes).toEqual([]);
		expect(requests[2].envelopes).toEqual([]);

		const rebuilt = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);
		expect(rebuilt.success, rebuilt.error).toBe(true);
		const rebuiltUploads = requests.slice(4).flatMap((request) => request.envelopes);
		expect(rebuiltUploads).toHaveLength(2);
		expect(rebuiltUploads.every((item) => item.expectedId === null)).toBe(true);
	});

	it('splits more than 500 ordinary records into bounded rounds', async () => {
		const notes = Array.from({ length: 501 }, (_, index) => note(`note-${index}`));
		const { store, requests } = createHarness((_request, index) => ({
			success: true,
			data: emptyData({ cursor: index === 0 ? 0 : index === 1 ? 500 : 501 })
		}));

		const result = await store.sync(notes, [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(requests.map((request) => request.envelopes.length)).toEqual([0, 500, 1]);
	});

	it('limits attachment bytes to two records per upload round', async () => {
		const local = note('note-1', {}, [
			attachment('image-1'),
			attachment('image-2'),
			attachment('image-3')
		]);
		const { store, account, requests } = createHarness((request, index) => ({
			success: true,
			data: emptyData({ cursor: index === 0 ? 0 : index + request.envelopes.length })
		}));

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);
		const kinds = requests
			.slice(1)
			.map((request) =>
				request.envelopes.map(
					(item) => (decryptSyncPayload(account.syncKey, item.ciphertext) as { kind: string }).kind
				)
			);

		expect(result.success, result.error).toBe(true);
		expect(kinds).toEqual([['note'], ['attachment', 'attachment'], ['attachment']]);
	});

	it('does not delete the old photo until the replacement upload is accepted', async () => {
		const local = note('note-1', {}, [attachment('new')]);
		const { store, account, requests } = createHarness((_request, index) => ({
			success: true,
			data: emptyData({ cursor: index === 0 ? 1 : index + 1, writesAccepted: true })
		}));
		await seedControl(account.accountId, {
			cursor: 1,
			baseline: {
				'note:note-1': 'old-note-fp',
				'attachment:old': 'old-pic-fp'
			},
			recordIds: {
				'note:note-1': 'note-id',
				'attachment:old': 'old-att-id'
			},
			outbox: ['note:note-1', 'attachment:new']
		});

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		let replacementAccepted = false;
		for (const request of requests) {
			const deletedOld = request.deleteSlots.some((slot) => slot.id === 'old-att-id');
			if (deletedOld) expect(replacementAccepted).toBe(true);
			const uploadedNew = request.envelopes.some((item) => {
				const payload = decryptSyncPayload(account.syncKey, item.ciphertext) as {
					kind?: string;
					value?: { id?: string };
				};
				return payload.kind === 'attachment' && payload.value?.id === 'new';
			});
			if (uploadedNew) replacementAccepted = true;
		}
		expect(replacementAccepted).toBe(true);
		expect(requests.some((request) => request.deleteSlots.length > 0)).toBe(true);
	});

	it('waits for catch-up before sending an orphaned attachment deletion', async () => {
		const { store, account, requests } = createHarness((_request, index) => ({
			success: true,
			data: emptyData({ cursor: index === 0 ? 3 : 3 })
		}));
		const keys = syncControlKeys(account.accountId);
		await seedControl(account.accountId, {
			cursor: 3,
			baseline: { 'attachment:orphan': 'fingerprint' },
			recordIds: { 'attachment:orphan': 'orphan-id' }
		});

		const result = await store.sync([], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(requests[0].deleteSlots).toEqual([]);
		expect(requests[1].deleteSlots).toEqual([expect.objectContaining({ id: 'orphan-id' })]);
		expect(await idb.getSyncState(keys.recordIds)).toEqual({});
	});

	it('skips unreadable ciphertext without applying it and records a warning', async () => {
		const { store, account } = createHarness(() => ({
			success: true,
			data: emptyData({
				cursor: 1,
				envelopes: [{ seq: 1, id: 'poison', slot: 'f'.repeat(64), ciphertext: 'not-decryptable' }]
			})
		}));
		const applied: SyncSnapshot[] = [];

		const result = await store.sync([], [], {}, {}, [], {}, false, true, async (snapshot) => {
			applied.push(snapshot);
			return snapshot;
		});

		expect(result.success, result.error).toBe(true);
		expect(applied[0].notes).toEqual([]);
		expect(store.lastError).toBe('Skipped 1 unreadable sync record');
		expect(await idb.getSyncState(syncControlKeys(account.accountId).cursor)).toBe(1);
	});

	it('adopts an identifiable unreadable slot so the next upload replaces it', async () => {
		const { store, account, requests } = createHarness((request, index) => {
			if (index === 0) {
				return {
					success: true,
					data: emptyData({
						cursor: 1,
						envelopes: [
							{
								seq: 1,
								id: 'poison',
								slot: poisonedSlot,
								ciphertext: 'not-decryptable'
							}
						]
					})
				};
			}
			if (request.envelopes[0]?.expectedId === 'poison') {
				return { success: true, data: emptyData({ cursor: 2, writesAccepted: true }) };
			}
			return { success: true, data: emptyData({ cursor: 1 }) };
		});
		const local = note('note-1', { title: 'local replacement' });
		const poisonedSlot = await sha256(`${account.syncKey}\u0000note:note-1`);
		await idb.markSyncOutbox(PID, ['note:note-1']);

		const pull = await store.sync([local], [], {}, {}, [], {}, false, true, passthrough);
		expect(pull.success, pull.error).toBe(true);
		expect(store.lastError).toBe('Skipped 1 unreadable sync record');
		expect(await idb.getSyncState(syncControlKeys(account.accountId).recordIds)).toEqual({
			'note:note-1': 'poison'
		});

		const push = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);
		expect(push.success, push.error).toBe(true);
		const upload = requests.at(-1)?.envelopes[0];
		expect(upload?.expectedId).toBe('poison');
		expect(decryptSyncPayload(account.syncKey, upload!.ciphertext)).toMatchObject({
			kind: 'note',
			value: { title: 'local replacement' }
		});
	});

	it('does not steal the recorded id when an unrelated slot is unreadable', async () => {
		const local = note('note-1');
		const { store, account } = createHarness(() => ({
			success: true,
			data: emptyData({
				cursor: 1,
				envelopes: [{ seq: 1, id: 'poison', slot: 'f'.repeat(64), ciphertext: 'not-decryptable' }]
			})
		}));
		await seedControl(account.accountId, {
			cursor: 0,
			baseline: { 'note:note-1': 'fp' },
			recordIds: { 'note:note-1': 'tracked-id' }
		});

		const result = await store.sync([local], [], {}, {}, [], {}, false, true, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(await idb.getSyncState(syncControlKeys(account.accountId).recordIds)).toEqual({
			'note:note-1': 'tracked-id'
		});
	});

	it('overwrites an undecryptable slot after adopting the conflict id', async () => {
		const local = note();
		const { store, account, requests } = createHarness((request, index) => {
			if (index === 0) return { success: true, data: emptyData({ cursor: 1 }) };
			if (request.envelopes[0]?.expectedId === 'current-id') {
				return { success: true, data: emptyData({ cursor: 2, writesAccepted: true }) };
			}
			return {
				success: true,
				data: emptyData({
					cursor: 1,
					writesAccepted: false,
					conflicts: [
						{
							seq: 1,
							id: 'current-id',
							slot: request.envelopes[0]?.slot ?? 'f'.repeat(64),
							ciphertext: 'not-decryptable'
						}
					]
				})
			};
		});
		await seedControl(account.accountId, {
			cursor: 1,
			baseline: { 'note:note-1': 'old-fingerprint' },
			recordIds: { 'note:note-1': 'old-id' },
			outbox: ['note:note-1']
		});

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(requests.map((request) => request.envelopes[0]?.expectedId)).toEqual([
			undefined,
			'old-id',
			'current-id'
		]);
		expect(await idb.getSyncState(syncControlKeys(account.accountId).recordIds)).toEqual({
			'note:note-1': requests[2].envelopes[0].id
		});
	});

	it('does not abort when writes are deferred for unread envelopes', async () => {
		const local = note();
		const { store, account, requests } = createHarness((_request, index) => {
			if (index === 0) return { success: true, data: emptyData({ cursor: 1 }) };
			if (index < 4) {
				return {
					success: true,
					data: emptyData({
						cursor: index,
						writesAccepted: false,
						envelopes: [
							envelope(account, `remote-${index}`, index, {
								kind: 'note',
								value: note(`remote-${index}`, { updatedAt: index, fieldTimes: { title: index } })
							})
						]
					})
				};
			}
			return { success: true, data: emptyData({ cursor: 4, writesAccepted: true }) };
		});
		await seedControl(account.accountId, {
			cursor: 1,
			baseline: { 'note:note-1': 'old-fingerprint' },
			recordIds: { 'note:note-1': 'old-id' },
			outbox: ['note:note-1']
		});

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success, result.error).toBe(true);
		expect(requests.length).toBeGreaterThanOrEqual(5);
		expect(result.error).toBeUndefined();
	});

	it('stops after repeated undecryptable write conflicts instead of looping forever', async () => {
		const local = note();
		const { store, account, requests } = createHarness((_request, index) => {
			if (index === 0) return { success: true, data: emptyData({ cursor: 1 }) };
			return {
				success: true,
				data: emptyData({
					cursor: 1,
					writesAccepted: false,
					conflicts: [
						{ seq: 1, id: 'current-id', slot: 'f'.repeat(64), ciphertext: 'not-decryptable' }
					]
				})
			};
		});
		await seedControl(account.accountId, {
			cursor: 1,
			baseline: { 'note:note-1': 'old-fingerprint' },
			recordIds: { 'note:note-1': 'old-id' },
			outbox: ['note:note-1']
		});

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/repeated conflicts/);
		expect(requests.length).toBeLessThan(10);
	});

	it('uploads notes and other photos when one attachment exceeds quota', async () => {
		const local = note('note-1', {}, [attachment('ok'), attachment('huge')]);
		const { store, account, requests } = createHarness((request) => {
			if (request.envelopes.length > 1) {
				return { success: false, status: 507, error: 'Sync account storage quota exceeded' };
			}
			if (request.envelopes.length === 1) {
				const payload = decryptSyncPayload(account.syncKey, request.envelopes[0].ciphertext) as {
					kind: string;
					value?: { id?: string };
				};
				if (payload.kind === 'attachment' && payload.value?.id === 'huge') {
					return { success: false, status: 507, error: 'Sync account storage quota exceeded' };
				}
				return { success: true, data: emptyData({ cursor: 1, writesAccepted: true }) };
			}
			return { success: true, data: emptyData({ cursor: 1, writesAccepted: true }) };
		});

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);
		const uploaded = requests.flatMap((request) =>
			request.envelopes.map((item) => {
				const payload = decryptSyncPayload(account.syncKey, item.ciphertext) as {
					kind: string;
					value?: { id?: string };
				};
				return payload.kind === 'attachment' ? `attachment:${payload.value?.id}` : payload.kind;
			})
		);

		expect(result.success, result.error).toBe(true);
		expect(uploaded).toContain('note');
		expect(uploaded).toContain('attachment:ok');
		expect(store.lastError).toMatch(/quota/);
		expect(await idb.getSyncOutboxKeys(PID)).toEqual(['attachment:huge']);
	});

	it('returns to batched uploads after an oversized record is isolated', async () => {
		const local = note('note-1', {}, [attachment('huge'), attachment('ok-a'), attachment('ok-b')]);
		const { store, account, requests } = createHarness((request) => {
			const kinds = request.envelopes.map((item) => {
				const payload = decryptSyncPayload(account.syncKey, item.ciphertext) as {
					kind: string;
					value?: { id?: string };
				};
				return payload.kind === 'attachment' ? payload.value?.id : payload.kind;
			});
			if (kinds.includes('huge')) {
				return { success: false, status: 507, error: 'Sync account storage quota exceeded' };
			}
			return { success: true, data: emptyData({ cursor: 1, writesAccepted: true }) };
		});

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);
		expect(result.success, result.error).toBe(true);

		const hugeSingle = requests.findIndex((request) => {
			if (request.envelopes.length !== 1) return false;
			const payload = decryptSyncPayload(account.syncKey, request.envelopes[0].ciphertext) as {
				kind?: string;
				value?: { id?: string };
			};
			return payload.kind === 'attachment' && payload.value?.id === 'huge';
		});
		expect(hugeSingle).toBeGreaterThan(0);
		expect(requests.slice(hugeSingle + 1).some((request) => request.envelopes.length > 1)).toBe(
			true
		);
	});

	it('aborts cleanly when the account is logged out mid-sync', async () => {
		const { store, account } = createHarness((_request, index) => {
			if (index === 0) {
				store.logout();
				return { success: true, data: emptyData({ cursor: 1, hasMore: true }) };
			}
			return { success: true, data: emptyData({ cursor: 2 }) };
		});
		const keys = syncControlKeys(account.accountId);
		await seedControl(account.accountId, { cursor: 0 });

		const result = await store.sync([], [], {}, {}, [], {}, false, true, passthrough);

		expect(result).toEqual({ success: false, error: 'Sync was cancelled' });
		expect(store.lastError).toBeNull();
		expect(await idb.getSyncState(keys.cursor)).toBeUndefined();
	});

	it('stops after repeated relay reset requests instead of looping forever', async () => {
		const local = note();
		const { store, requests } = createHarness(() => ({
			success: true,
			data: emptyData({ cursor: 0, reset: true, writesAccepted: false })
		}));

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/reset/);
		expect(requests.length).toBeLessThanOrEqual(5);
	});

	it('caps quota retries when the relay keeps rejecting uploads with 507', async () => {
		const notes = Array.from({ length: 1010 }, (_, index) => note(`note-${index}`));
		const { store, requests } = createHarness((_request, index) =>
			index === 0
				? { success: true, data: emptyData({ cursor: 1 }) }
				: { success: false, status: 507, error: 'Sync account storage quota exceeded' }
		);

		const result = await store.sync(notes, [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/quota/i);
		expect(requests.length).toBeGreaterThan(1000);
		expect(requests.length).toBeLessThanOrEqual(1100);
	}, 60000);
});
