import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, NoteImage } from '$lib/types';
import { createSyncIdentity, decryptSyncPayload } from '$lib/syncPairing';
import * as idb from '$lib/db/idb';
import { SyncStore } from './sync.svelte';

type RequestResult = { success: boolean; data?: Record<string, unknown>; error?: string };

function note(id: string, images: NoteImage[] = []): Note {
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
		images,
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

function attachment(id: string): NoteImage {
	return {
		id,
		mime: 'image/png',
		dataUrl: 'data:image/png;base64,QQ==',
		createdAt: 1,
		contentHash: `hash-${id}`
	};
}

/**
 * Issue #81: quota isolation in the sync engine is keyed on the HTTP status
 * (507), never on the server's error message text. This test replays the
 * over-quota scenario from sync.svelte.test.ts with an arbitrary error
 * message to prove wording independence.
 */
describe('quota isolation independent of server error wording', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it('isolates an oversized attachment even when the server words the error differently', async () => {
		const account = createSyncIdentity();
		const store = new SyncStore();
		store.account = account;
		const local = note('note-1', [attachment('ok'), attachment('huge')]);
		vi.spyOn(
			store as unknown as {
				sendSyncRequest(
					path: string,
					payload: string
				): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
			},
			'sendSyncRequest'
		).mockImplementation(async (_path, payload) => {
			const request = JSON.parse(payload) as {
				envelopes: Array<{ ciphertext: string }>;
			};
			const kinds = request.envelopes.map((item) => {
				const payload = decryptSyncPayload(account.syncKey, item.ciphertext) as {
					kind: string;
					value?: { id?: string };
				};
				return payload.kind === 'attachment' ? payload.value?.id : payload.kind;
			});
			if (kinds.includes('huge')) {
				// Same failure semantics, arbitrary wording — only the status matters.
				return { success: false, status: 507, error: 'Storage limit reached' };
			}
			return {
				success: true,
				data: { cursor: 1 + request.envelopes.length, writesAccepted: true }
			} satisfies RequestResult;
		});
		await idb.markSyncOutbox(['note:note-1', 'attachment:ok', 'attachment:huge']);

		const result = await store.sync([local], [], {}, {}, [], {}, false, false, async (s) => s);

		expect(result.success, result.error).toBe(true);
		expect(store.lastError).toMatch(/limit|quota/);
		expect(await idb.getSyncOutboxKeys()).toEqual(['attachment:huge']);
	});
});
