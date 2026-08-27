import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncQuotaExceededError, SyncStore as RelayStore } from '$lib/server/syncStore';
import { createSyncIdentity, decryptSyncPayload, type SyncIdentity } from '$lib/syncPairing';
import {
	closeDeviceDatabase,
	DEVICE_DB_NAME,
	getAllNotesMetadata,
	hydrateNoteAttachments,
	putNote
} from '$lib/db/idb';
import { SyncStore, type SyncSnapshot } from './sync.svelte';
import type { Note, NoteImage } from '$lib/types';

const relays: RelayStore[] = [];
const directories: string[] = [];

function photo(id: string, dataUrl: string): NoteImage {
	return {
		id,
		mime: 'image/png',
		dataUrl,
		createdAt: 1,
		contentHash: `hash-${id}`
	};
}

function noteWithPhoto(image: NoteImage): Note {
	return {
		id: 'note-1',
		title: 'note-1',
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
		images: [image],
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

function wipeDevice(): Promise<void> {
	closeDeviceDatabase();
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(DEVICE_DB_NAME);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => resolve();
	});
}

function wire(
	client: SyncStore,
	relay: RelayStore,
	requests: Array<{ envelopes: unknown[]; deleteSlots: Array<{ id: string; slot: string }> }>
): void {
	vi.spyOn(
		client as unknown as {
			sendSyncRequest(
				path: string,
				payload: string
			): Promise<{ success: boolean; data?: unknown; error?: string }>;
		},
		'sendSyncRequest'
	).mockImplementation(async (_path, payload) => {
		const body = JSON.parse(payload) as {
			cursor: number;
			envelopes: unknown[];
			deleteSlots: Array<{ id: string; slot: string }>;
			limit?: number;
		};
		requests.push({ envelopes: body.envelopes, deleteSlots: body.deleteSlots });
		try {
			return {
				success: true,
				data: relay.sync(
					client.account!.accountId,
					body.cursor,
					body.envelopes as never,
					body.deleteSlots,
					body.limit ?? 12
				)
			};
		} catch (error) {
			if (error instanceof SyncQuotaExceededError) {
				return { success: false, status: 507, error: 'Sync account storage quota exceeded' };
			}
			throw error;
		}
	});
}

async function applyToDevice(snapshot: SyncSnapshot): Promise<SyncSnapshot> {
	for (const item of snapshot.notes) await putNote(item);
	return snapshot;
}

describe('client sync against the sqlite relay', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		for (const relay of relays.splice(0)) relay.close();
		for (const directory of directories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('lets a second device download photos after the first device is wiped', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'scrapscache-sync-'));
		directories.push(directory);
		const relay = new RelayStore(directory);
		relays.push(relay);
		const identity = createSyncIdentity();
		relay.createAccount(identity.accountId, 'credential');
		const image = photo('old', 'data:image/png;base64,QQ==');
		const local = noteWithPhoto(image);

		const deviceA = new SyncStore();
		deviceA.account = identity;
		const requestsA: Array<{
			envelopes: unknown[];
			deleteSlots: Array<{ id: string; slot: string }>;
		}> = [];
		wire(deviceA, relay, requestsA);
		await putNote(local, [`note:${local.id}`, `attachment:${image.id}`]);
		const uploaded = await deviceA.sync([local], [], {}, {}, [], {}, false, false, applyToDevice);
		expect(uploaded.success, uploaded.error).toBe(true);

		await wipeDevice();
		const deviceB = new SyncStore();
		deviceB.account = identity;
		const requestsB: Array<{
			envelopes: unknown[];
			deleteSlots: Array<{ id: string; slot: string }>;
		}> = [];
		wire(deviceB, relay, requestsB);
		const pulled = await deviceB.sync([], [], {}, {}, [], {}, false, false, applyToDevice);
		expect(pulled.success, pulled.error).toBe(true);

		const stored = (await getAllNotesMetadata()).find((item) => item.id === 'note-1');
		expect(stored).toBeDefined();
		const hydrated = await hydrateNoteAttachments(stored!);
		expect(hydrated.images?.[0]?.dataUrl).toBe(image.dataUrl);
	});

	it('keeps the previous photo on the relay until the replacement bytes are stored', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'scrapscache-sync-'));
		directories.push(directory);
		const relay = new RelayStore(directory);
		relays.push(relay);
		const identity: SyncIdentity = createSyncIdentity();
		relay.createAccount(identity.accountId, 'credential');
		const oldImage = photo('old', 'data:image/png;base64,QQ==');
		const newImage = photo('new', 'data:image/png;base64,Qg==');
		const original = noteWithPhoto(oldImage);

		const client = new SyncStore();
		client.account = identity;
		const requests: Array<{
			envelopes: Array<{ id: string; slot: string; ciphertext: string }>;
			deleteSlots: Array<{ id: string; slot: string }>;
		}> = [];
		wire(client, relay, requests as never);
		await putNote(original, [`note:${original.id}`, `attachment:${oldImage.id}`]);
		expect(
			(await client.sync([original], [], {}, {}, [], {}, false, false, applyToDevice)).success
		).toBe(true);

		const oldSlot = requests
			.flatMap((request) => request.envelopes)
			.find((envelope) => {
				const payload = decryptSyncPayload(identity.syncKey, envelope.ciphertext) as {
					kind?: string;
					value?: { id?: string };
				};
				return payload.kind === 'attachment' && payload.value?.id === 'old';
			})?.slot;
		expect(oldSlot).toBeDefined();

		const replaced = noteWithPhoto(newImage);
		replaced.updatedAt = 2;
		replaced.fieldTimes = { ...original.fieldTimes, images: 2, title: 1 };
		await putNote(replaced, [`note:${replaced.id}`, `attachment:${newImage.id}`]);
		let replacementStored = false;
		vi.spyOn(
			client as unknown as {
				sendSyncRequest(
					path: string,
					payload: string
				): Promise<{ success: boolean; data?: unknown; error?: string }>;
			},
			'sendSyncRequest'
		).mockImplementation(async (_path, payload) => {
			const body = JSON.parse(payload) as {
				cursor: number;
				envelopes: Array<{ id: string; slot: string; ciphertext: string }>;
				deleteSlots: Array<{ id: string; slot: string }>;
				limit?: number;
			};
			if (body.deleteSlots.some((slot) => slot.slot === oldSlot)) {
				const page = relay.sync(identity.accountId, 0, [], [], 50);
				const hasNew = page.envelopes.some((envelope) => {
					try {
						const payload = decryptSyncPayload(identity.syncKey, envelope.ciphertext) as {
							kind?: string;
							value?: { id?: string };
						};
						return payload.kind === 'attachment' && payload.value?.id === 'new';
					} catch {
						return false;
					}
				});
				expect(hasNew).toBe(true);
			}
			const data = relay.sync(
				identity.accountId,
				body.cursor,
				body.envelopes as never,
				body.deleteSlots,
				body.limit ?? 12
			);
			if (
				body.envelopes.some((envelope) => {
					const payload = decryptSyncPayload(identity.syncKey, envelope.ciphertext) as {
						kind?: string;
						value?: { id?: string };
					};
					return payload.kind === 'attachment' && payload.value?.id === 'new';
				})
			) {
				replacementStored = true;
			}
			return { success: true, data };
		});

		const afterReplace = await client.sync(
			[replaced],
			[],
			{},
			{},
			[],
			{},
			false,
			false,
			applyToDevice
		);
		expect(afterReplace.success, afterReplace.error).toBe(true);
		expect(replacementStored).toBe(true);
	});
});
