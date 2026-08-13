// Service worker — caches the app shell so iOS reloads are instant.
// JS/CSS must not be cache-first forever: hashed builds change filenames, but
// a stale shell HTML or long-lived module cache leaves phones on old UI bugs.

const CACHE_NAME = 'shard-notes-v2';
const APP_SHELL = [
	'/',
	'/manifest.json',
	'/icon-192.png',
	'/icon-512.png',
	'/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(APP_SHELL).catch(() => undefined))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((keys) =>
			Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
		).then(() => self.clients.claim())
	);
});

function isImmutableAsset(url) {
	return url.pathname.startsWith('/_app/immutable/');
}

self.addEventListener('fetch', (event) => {
	const req = event.request;
	// Only handle GET requests.
	if (req.method !== 'GET') return;

	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;

	// Don't intercept API calls (sync) — always go to network.
	if (url.pathname.startsWith('/api/')) return;

	// Never cache the service worker itself.
	if (url.pathname === '/sw.js') {
		event.respondWith(fetch(req));
		return;
	}

	// Navigation: network first so deploys replace the shell HTML promptly.
	if (req.mode === 'navigate') {
		event.respondWith(
			fetch(req)
				.then((res) => {
					const copy = res.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
					return res;
				})
				.catch(() => caches.match(req).then((res) => res || caches.match('/')))
		);
		return;
	}

	// Hashed build assets are immutable: cache-first is safe once fetched.
	if (isImmutableAsset(url)) {
		event.respondWith(
			caches.match(req).then((cached) => {
				if (cached) return cached;
				return fetch(req).then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
					}
					return res;
				});
			})
		);
		return;
	}

	// Other same-origin GETs (CSS from shell, icons, etc.): network first, cache fallback.
	event.respondWith(
		fetch(req)
			.then((res) => {
				if (res.ok) {
					const copy = res.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
				}
				return res;
			})
			.catch(() => caches.match(req).then((res) => res || fetch(req)))
	);
});

const NOTES_DB = 'google-keep-clone';
const NOTES_STORE = 'notes';
const SYNC_STATE_STORE = 'sync-state';
const FIRED_KEY = 'gkc-fired-reminders';

function openNotesDb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(NOTES_DB);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
}

function idbRequest(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timeout')), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

async function loadLocalReminderState() {
	const db = await openNotesDb();
	try {
		let notes = [];
		let fired = [];
		if (db.objectStoreNames.contains(NOTES_STORE)) {
			notes = await idbRequest(db.transaction(NOTES_STORE).objectStore(NOTES_STORE).getAll());
		}
		if (db.objectStoreNames.contains(SYNC_STATE_STORE)) {
			const stored = await idbRequest(
				db.transaction(SYNC_STATE_STORE).objectStore(SYNC_STATE_STORE).get(FIRED_KEY)
			);
			if (Array.isArray(stored)) fired = stored.filter((item) => typeof item === 'string');
		}
		return { notes, fired };
	} finally {
		db.close();
	}
}

function showGenericReminder() {
	return self.registration.showNotification('Reminder', {
		body: 'Open Shard to see it.',
		tag: 'shard-reminder-tick',
		icon: '/icon-192.png',
		data: { type: 'reminder' }
	});
}

function reminderPreview(note) {
	const title = String(note.title || '').trim();
	if (title) return title;
	for (const raw of String(note.body || '').split('\n')) {
		const line = raw.replace(/^(?:\s*(?:[-*•]\s+)?)?\[[ xX]?\]\s*/, '').trim();
		if (line) return line.slice(0, 80);
	}
	return 'Untitled note';
}

function formatWhen(ts) {
	return new Date(ts).toLocaleString([], {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

async function showDueRemindersFromDevice() {
	const now = Date.now();
	let notes = [];
	let fired = [];
	try {
		const loaded = await withTimeout(loadLocalReminderState(), 1_500);
		notes = loaded.notes;
		fired = loaded.fired;
	} catch {
		notes = [];
	}

	const seen = new Set(fired);
	const due = (Array.isArray(notes) ? notes : []).filter((note) => {
		if (!note || note.archived || note.trashed || note.reminder == null) return false;
		if (Number(note.reminder) > now) return false;
		return !seen.has(`${note.id}:${note.reminder}`);
	});

	if (due.length === 0) {
		await showGenericReminder();
		return;
	}

	for (const note of due) {
		const key = `${note.id}:${note.reminder}`;
		seen.add(key);
		await self.registration.showNotification(reminderPreview(note), {
			body: formatWhen(Number(note.reminder)),
			tag: 'shard-reminder:' + note.id,
			icon: '/icon-192.png',
			data: { type: 'reminder', noteId: note.id }
		});
	}

	try {
		const db = await openNotesDb();
		try {
			if (db.objectStoreNames.contains(SYNC_STATE_STORE)) {
				await idbRequest(
					db.transaction(SYNC_STATE_STORE, 'readwrite').objectStore(SYNC_STATE_STORE).put([...seen], FIRED_KEY)
				);
			}
		} finally {
			db.close();
		}
	} catch {
		/* keep notifications even if fired-set persist fails */
	}
}

self.addEventListener('push', (event) => {
	event.waitUntil(showDueRemindersFromDevice().catch(() => showGenericReminder()));
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const noteId = event.notification.data && event.notification.data.noteId;
	const path =
		typeof noteId === 'string' && noteId ? '/?note=' + encodeURIComponent(noteId) : '/reminders';
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
			for (const client of clients) {
				try {
					if (new URL(client.url).origin !== self.location.origin) continue;
				} catch {
					continue;
				}
				client.postMessage({ type: 'open-note', noteId: typeof noteId === 'string' ? noteId : null });
				if ('focus' in client) return client.focus();
			}
			if (self.clients.openWindow) return self.clients.openWindow(path);
		})
	);
});
