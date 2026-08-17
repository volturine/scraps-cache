import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { reminderWakeId } from './reminderNotify';

const DB_NAME = 'google-keep-clone';

function request<T>(operation: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		operation.onsuccess = () => resolve(operation.result);
		operation.onerror = () => reject(operation.error);
	});
}

async function seedNotes(notes: unknown[]): Promise<void> {
	const opened = indexedDB.open(DB_NAME, 1);
	opened.onupgradeneeded = () => {
		opened.result.createObjectStore('notes', { keyPath: 'id' });
		opened.result.createObjectStore('sync-state');
	};
	const db = await request(opened);
	const tx = db.transaction('notes', 'readwrite');
	for (const note of notes) tx.objectStore('notes').put(note);
	await new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	db.close();
}

async function firedWakeIds(): Promise<string[]> {
	const db = await request(indexedDB.open(DB_NAME));
	const stored = await request(
		db.transaction('sync-state').objectStore('sync-state').get('gkc-fired-reminders')
	);
	db.close();
	return Array.isArray(stored) ? stored : [];
}

function loadPushHandler(showNotification: ReturnType<typeof vi.fn>) {
	const listeners = new Map<string, (event: unknown) => void>();
	const self = {
		location: { origin: 'https://scraps-cache.example' },
		registration: { showNotification },
		clients: {},
		addEventListener(type: string, listener: (event: unknown) => void) {
			listeners.set(type, listener);
		},
		skipWaiting: vi.fn()
	};
	runInNewContext(readFileSync('static/sw.js', 'utf8'), {
		self,
		indexedDB,
		crypto: webcrypto,
		TextEncoder,
		URL,
		Request,
		Response,
		fetch: vi.fn(),
		caches: { open: vi.fn(), keys: vi.fn() },
		setTimeout,
		clearTimeout,
		btoa
	});
	const handler = listeners.get('push');
	if (!handler) throw new Error('Service worker did not register a push handler');
	return async (payload: unknown) => {
		let completion: Promise<unknown> | null = null;
		handler({
			data: { json: () => payload },
			waitUntil(promise: Promise<unknown>) {
				completion = promise;
			}
		});
		await completion;
	};
}

afterEach(async () => {
	await new Promise<void>((resolve) => {
		const deleted = indexedDB.deleteDatabase(DB_NAME);
		deleted.onsuccess = () => resolve();
		deleted.onerror = () => resolve();
		deleted.onblocked = () => resolve();
	});
});

describe('reminder service worker', () => {
	it('shows local note content for a matching opaque wake', async () => {
		const note = {
			id: '550e8400-e29b-41d4-a716-446655440000',
			title: 'Pick up groceries',
			body: '',
			reminder: 1_000,
			archived: false,
			trashed: false
		};
		await seedNotes([note]);
		const show = vi.fn().mockResolvedValue(undefined);
		const push = loadPushHandler(show);
		const id = reminderWakeId(note.id, note.reminder);
		await push({ type: 'reminder-wake', id, fireAt: note.reminder });
		expect(show).toHaveBeenCalledWith(
			'Pick up groceries',
			expect.objectContaining({
				tag: `scraps-cache-reminder:${id}`,
				data: { type: 'reminder', noteId: note.id, wakeId: id }
			})
		);
		expect(await firedWakeIds()).toEqual([id]);
	});

	it('uses one stable generic tag when the note has not synced', async () => {
		await seedNotes([]);
		const show = vi.fn().mockResolvedValue(undefined);
		const push = loadPushHandler(show);
		const id = reminderWakeId('missing-note', 2_000);
		const payload = { type: 'reminder-wake', id, fireAt: 2_000 };
		await push(payload);
		await push(payload);
		expect(show).toHaveBeenCalledTimes(2);
		for (const call of show.mock.calls) {
			expect(call).toEqual([
				'Reminder',
				expect.objectContaining({
					body: 'Open Scraps Cache to check your notes.',
					tag: `scraps-cache-reminder:${id}`
				})
			]);
		}
		expect(await firedWakeIds()).toEqual([id]);
	});
});
