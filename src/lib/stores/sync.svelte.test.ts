import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, NoteImage } from '$lib/types';
import {
	createSyncIdentity,
	decryptSyncPayload,
	encryptSyncPayload,
	legacyAuthSecret,
	type SyncIdentity
} from '$lib/syncPairing';
import { syncControlKeys } from '$lib/syncEngine';
import { sha256 } from '$lib/syncHash';
import * as idb from '$lib/db/idb';
import { SyncStore, type SyncSnapshot } from './sync.svelte';

type RequestPayload = {
	cursor: number;
	envelopes: Array<{ id: string; slot: string; expectedId: string | null; ciphertext: string }>;
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
		storageBytes: number;
		maxBytes: number;
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
	if (state.outbox?.length) await idb.markSyncOutbox(state.outbox);
}

describe('client sync state machine', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});
	afterEach(() => vi.unstubAllGlobals());

	it('migrates a legacy credential once and caches the issued session', async () => {
		const account = createSyncIdentity();
		const store = new SyncStore();
		store.account = account;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ migrationRequired: true }), {
					status: 409,
					headers: { 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ accessToken: 'session-token', expiresAt: Date.now() + 60_000 }),
					{
						status: 200,
						headers: { 'content-type': 'application/json' }
					}
				)
			);
		vi.stubGlobal('fetch', fetchMock);
		const privateStore = store as unknown as { accessToken(): Promise<string> };

		await expect(privateStore.accessToken()).resolves.toBe('session-token');
		await expect(privateStore.accessToken()).resolves.toBe('session-token');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const migration = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as {
			authSecret: string;
			authPublicKey: string;
			signature: string;
		};
		expect(migration).toMatchObject({
			authSecret: legacyAuthSecret(account.syncKey),
			authPublicKey: account.authPublicKey
		});
		expect(migration.signature).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('keeps concurrent authentication scoped to the requested account', async () => {
		const accountA = createSyncIdentity();
		const accountB = createSyncIdentity();
		const store = new SyncStore();
		store.account = accountB;
		let releaseAccountA: ((response: Response) => void) | undefined;
		const accountAChallenge = new Promise<Response>((resolve) => {
			releaseAccountA = resolve;
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			const request = JSON.parse(String(init?.body ?? '{}')) as { accountId?: string };
			if (path.endsWith('/challenge')) {
				if (request.accountId === accountA.accountId) return accountAChallenge;
				return new Response(JSON.stringify({ challengeId: 'b', challenge: 'challenge-b' }));
			}
			return new Response(
				JSON.stringify({
					accessToken: `token-${request.accountId}`,
					expiresAt: Date.now() + 60_000
				})
			);
		});
		vi.stubGlobal('fetch', fetchMock);
		const privateStore = store as unknown as {
			accessToken(account: SyncIdentity): Promise<string>;
			session: { accountId: string; accessToken: string; expiresAt: number } | null;
		};

		const tokenA = privateStore.accessToken(accountA);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		const tokenB = privateStore.accessToken(accountB);
		await expect(tokenB).resolves.toBe(`token-${accountB.accountId}`);
		releaseAccountA?.(new Response(JSON.stringify({ challengeId: 'a', challenge: 'challenge-a' })));
		await expect(tokenA).resolves.toBe(`token-${accountA.accountId}`);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(privateStore.session?.accountId).toBe(accountB.accountId);
	});

	it('does not accept an authentication session that finishes after logout', async () => {
		const account = createSyncIdentity();
		const store = new SyncStore();
		store.account = account;
		let releaseChallenge: ((response: Response) => void) | undefined;
		const challenge = new Promise<Response>((resolve) => {
			releaseChallenge = resolve;
		});
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockImplementationOnce(() => challenge)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({ accessToken: 'late-token', expiresAt: Date.now() + 60_000 })
					)
				)
		);
		const privateStore = store as unknown as {
			accessToken(): Promise<string>;
			session: { accountId: string; accessToken: string; expiresAt: number } | null;
		};
		const pending = privateStore.accessToken();
		store.logout();
		releaseChallenge?.(
			new Response(JSON.stringify({ challengeId: 'late', challenge: 'challenge' }))
		);

		await expect(pending).rejects.toThrow('Sync authentication was cancelled');
		expect(privateStore.session).toBeNull();
	});

	it('reauthenticates and retries an authorized request once after a rejected session', async () => {
		const account = createSyncIdentity();
		const store = new SyncStore();
		store.account = account;
		(
			store as unknown as {
				session: { accountId: string; accessToken: string; expiresAt: number };
			}
		).session = {
			accountId: account.accountId,
			accessToken: 'stale-token',
			expiresAt: Date.now() + 60_000
		};
		const resourceTokens: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			if (path === '/resource') {
				resourceTokens.push(new Headers(init?.headers).get('authorization') ?? '');
				return new Response(null, { status: resourceTokens.length === 1 ? 401 : 204 });
			}
			if (path.endsWith('/challenge'))
				return new Response(JSON.stringify({ challengeId: 'fresh', challenge: 'challenge' }));
			return new Response(
				JSON.stringify({ accessToken: 'fresh-token', expiresAt: Date.now() + 60_000 })
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await store.authorizedFetch('/resource');

		expect(response.status).toBe(204);
		expect(resourceTokens).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
	});

	it('reauthenticates and retries the same delta request once after HTTP 401', async () => {
		const account = createSyncIdentity();
		const store = new SyncStore();
		store.account = account;
		const privateStore = store as unknown as {
			session: { accountId: string; accessToken: string; expiresAt: number };
			sendSyncRequest(
				path: string,
				payload: string,
				uploadBytes: number,
				indicate: boolean
			): Promise<{ success: boolean; status?: number; data?: RelayData }>;
			sendSyncRequestWithToken(
				path: string,
				payload: string,
				uploadBytes: number,
				indicate: boolean,
				accessToken: string
			): Promise<{ success: boolean; status?: number; data?: RelayData }>;
		};
		privateStore.session = {
			accountId: account.accountId,
			accessToken: 'stale-token',
			expiresAt: Date.now() + 60_000
		};
		const request = vi
			.spyOn(privateStore, 'sendSyncRequestWithToken')
			.mockResolvedValueOnce({ success: false, status: 401 })
			.mockResolvedValueOnce({ success: true, data: emptyData() });
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ challengeId: 'fresh', challenge: 'challenge' }))
				)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({ accessToken: 'fresh-token', expiresAt: Date.now() + 60_000 })
					)
				)
		);

		await expect(privateStore.sendSyncRequest('/api/sync/delta', '{}', 0, false)).resolves.toEqual({
			success: true,
			data: emptyData()
		});
		expect(request.mock.calls.map((call) => call[4])).toEqual(['stale-token', 'fresh-token']);
	});

	it('reports an outbox failure and allows the next durable marker write to retry', async () => {
		const store = new SyncStore();
		vi.spyOn(idb, 'markSyncOutbox').mockRejectedValueOnce(
			new Error('IndexedDB transaction aborted')
		);

		await expect(store.queueOutbox(['note:note-1'])).rejects.toThrow(
			'IndexedDB transaction aborted'
		);
		expect(await idb.getSyncOutboxKeys()).toEqual([]);

		await store.queueOutbox(['note:note-1']);
		expect(await idb.getSyncOutboxKeys()).toEqual(['note:note-1']);
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
			for (const item of snapshot.notes) await idb.putNote(item);
			return snapshot;
		});

		expect(result.success, result.error).toBe(true);
		expect((await idb.getAllNotesMetadata()).map(({ id }) => id)).toEqual(['note-1']);
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
		expect(await idb.getAllNotesMetadata()).toEqual([]);
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
		await idb.markSyncOutbox([`note:note-1`]);

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
		expect(await idb.getSyncOutboxKeys()).toEqual([]);
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
		await idb.markSyncOutbox([`note:note-1`]);

		const failed = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);
		expect(failed).toMatchObject({ success: false, error: 'Sync timed out' });
		expect(await idb.getSyncOutboxKeys()).toEqual(['note:note-1']);

		const retried = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);
		expect(retried.success, retried.error).toBe(true);
		expect(requests.filter((request) => request.envelopes.length > 0)).toHaveLength(1);
		expect(await idb.getSyncOutboxKeys()).toEqual([]);
		expect(await idb.getSyncState(syncControlKeys(account.accountId).recordIds)).toEqual({
			'note:note-1': accepted!.id
		});
	});

	it('rewinds a leftover cursor when there is no baseline so a full pull can run', async () => {
		const pulled = note('note-1', { title: 'from account' });
		const { store, account, requests } = createHarness((request) => {
			if (request.cursor > 0) {
				return {
					success: true,
					data: emptyData({
						cursor: request.cursor,
						usage: { ciphertextBytes: 10, envelopeCount: 1, storageBytes: 522, maxBytes: 1000 }
					})
				};
			}
			return {
				success: true,
				data: emptyData({
					cursor: 1,
					envelopes: [envelope(account, 'cloud-id', 1, { kind: 'note', value: pulled })],
					usage: { ciphertextBytes: 10, envelopeCount: 1, storageBytes: 522, maxBytes: 1000 }
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
		const resetRequestCount = requests.length;
		expect(resetRequestCount).toBe(2);

		const rebuilt = await store.sync([local], [], {}, {}, [], {}, false, false, passthrough);
		expect(rebuilt.success, rebuilt.error).toBe(true);
		const rebuiltUploads = requests
			.slice(resetRequestCount)
			.flatMap((request) => request.envelopes);
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
		await idb.markSyncOutbox(['note:note-1']);

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

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/quota/);
		expect(uploaded).toContain('note');
		expect(uploaded).toContain('attachment:ok');
		expect(store.lastError).toMatch(/quota/);
		expect(await idb.getSyncOutboxKeys()).toEqual(['attachment:huge']);
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
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/quota/);

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

	it('reports incomplete sync after isolating records rejected with 507', async () => {
		const notes = Array.from({ length: 4 }, (_, index) => note(`note-${index}`));
		let rejectWrites = true;
		const { store, account, requests } = createHarness((request) =>
			!rejectWrites || request.envelopes.length === 0
				? { success: true, data: emptyData({ cursor: 1 }) }
				: { success: false, status: 507, error: 'Sync account storage quota exceeded' }
		);

		const result = await store.sync(notes, [], {}, {}, [], {}, false, false, passthrough);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/quota/i);
		const isolatedIds = requests
			.filter((request) => request.envelopes.length === 1)
			.map((request) => {
				const payload = decryptSyncPayload(account.syncKey, request.envelopes[0].ciphertext) as {
					value: { id: string };
				};
				return payload.value.id;
			});
		expect(isolatedIds).toEqual(notes.map(({ id }) => id));
		expect(requests).toHaveLength(9);
		expect(requests.at(-1)?.envelopes).toEqual([]);
		expect(store.lastSync).toBe(0);
		expect(await idb.getSyncOutboxKeys()).toEqual(notes.map(({ id }) => `note:${id}`));

		rejectWrites = false;
		const retry = await store.sync(notes, [], {}, {}, [], {}, false, false, passthrough);

		expect(retry.success, retry.error).toBe(true);
		expect(await idb.getSyncOutboxKeys()).toEqual([]);
		expect(store.lastSync).toBeGreaterThan(0);
	});
});
