import { describe, expect, it, vi } from 'vitest';
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

function loadServiceWorker(
	showNotification: ReturnType<typeof vi.fn>,
	clients: Record<string, unknown> = {}
) {
	const listeners = new Map<string, (event: unknown) => void>();
	const self = {
		location: { origin: 'https://scraps-cache.example' },
		registration: { showNotification },
		clients,
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
	return listeners;
}

function loadPushHandler(showNotification: ReturnType<typeof vi.fn>) {
	const handler = loadServiceWorker(showNotification).get('push');
	if (!handler) throw new Error('Service worker did not register a push handler');
	return async (payload: unknown) => {
		let completion: Promise<unknown> | null = null;
		handler({
			data: {
				json: typeof payload === 'function' ? (payload as () => unknown) : () => payload
			},
			waitUntil(promise: Promise<unknown>) {
				completion = promise;
			}
		});
		await completion;
	};
}

function loadClickHandler(clients: Record<string, unknown>) {
	const handler = loadServiceWorker(vi.fn(), clients).get('notificationclick');
	if (!handler) throw new Error('Service worker did not register a notificationclick handler');
	return async (notification: { close: () => void; data?: unknown }) => {
		let completion: Promise<unknown> | null = null;
		handler({
			notification,
			waitUntil(promise: Promise<unknown>) {
				completion = promise;
			}
		});
		await completion;
	};
}

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

	it('shows a repeated wake only once when the note has not synced', async () => {
		await seedNotes([]);
		const show = vi.fn().mockResolvedValue(undefined);
		const push = loadPushHandler(show);
		const id = reminderWakeId('missing-note', 2_000);
		const payload = { type: 'reminder-wake', id, fireAt: 2_000 };
		await Promise.all([push(payload), push(payload)]);
		expect(show).toHaveBeenCalledTimes(1);
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

	it('falls back to the generic reminder for malformed payloads without crashing', async () => {
		await seedNotes([]);
		const show = vi.fn().mockResolvedValue(undefined);
		const push = loadPushHandler(show);
		const malformed: unknown[] = [
			() => {
				throw new Error('not json');
			},
			undefined,
			{},
			{ type: 'something-else' },
			{ type: 'reminder-wake', id: 'too-short', fireAt: 1_000 },
			{ type: 'reminder-wake', id: 'a'.repeat(43) },
			{ type: 'reminder-wake', id: 'a'.repeat(43), fireAt: 1.5 }
		];
		for (const payload of malformed) await push(payload);
		expect(show).toHaveBeenCalledTimes(malformed.length);
		for (const call of show.mock.calls) {
			expect(call[0]).toBe('Reminder');
			expect(call[1]).toMatchObject({ tag: 'scraps-cache-reminder:unknown' });
		}
	});

	it('focuses a matching window and posts the note to open on notificationclick', async () => {
		const client = {
			url: 'https://scraps-cache.example/',
			postMessage: vi.fn(),
			focus: vi.fn(async () => client)
		};
		const clients = { matchAll: vi.fn(async () => [client]), openWindow: vi.fn() };
		const click = loadClickHandler(clients);
		const close = vi.fn();
		await click({ close, data: { type: 'reminder', noteId: 'note-9', wakeId: 'w' } });
		expect(close).toHaveBeenCalled();
		expect(client.postMessage).toHaveBeenCalledWith({ type: 'open-note', noteId: 'note-9' });
		expect(client.focus).toHaveBeenCalled();
		expect(clients.openWindow).not.toHaveBeenCalled();
	});

	it('opens a fallback page when no window matches or no note is attached', async () => {
		const foreign = { url: 'https://other.example/', postMessage: vi.fn(), focus: vi.fn() };
		const clients = { matchAll: vi.fn(async () => [foreign]), openWindow: vi.fn() };
		const click = loadClickHandler(clients);
		await click({ close: vi.fn(), data: { type: 'reminder', wakeId: 'w' } });
		expect(clients.openWindow).toHaveBeenCalledWith('/reminders');
		await click({
			close: vi.fn(),
			data: { type: 'reminder', noteId: 'note 10', wakeId: 'w' }
		});
		expect(clients.openWindow).toHaveBeenCalledWith('/?note=note%2010');
	});
});
