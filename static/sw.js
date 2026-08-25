// Service worker — caches the app shell so iOS reloads are instant.
// JS/CSS must not be cache-first forever: hashed builds change filenames, but
// a stale shell HTML or long-lived module cache leaves phones on old UI bugs.

const CACHE_NAME = 'scrapscache-v2';
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

const NOTES_DB = 'scrapscache';
const NOTES_STORE = 'notes';
const SYNC_STATE_STORE = 'sync-state';
const FIRED_KEY = 'scrapscache-fired-reminders';
const WAKE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const WAKE_DOMAIN = 'scraps-cache-reminder-wake:v1\0';

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

function idbTransaction(transaction) {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
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
		if (db.objectStoreNames.contains(NOTES_STORE)) {
			notes = await idbRequest(db.transaction(NOTES_STORE).objectStore(NOTES_STORE).getAll());
		}
		return notes;
	} finally {
		db.close();
	}
}

function showGenericReminder(wakeId) {
	return self.registration.showNotification('Reminder', {
		body: 'Open Scraps Cache to check your notes.',
		tag: 'scrapscache-reminder:' + wakeId,
		renotify: false,
		icon: '/icon-192.png',
		data: { type: 'reminder', wakeId }
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

function bytesToBase64Url(bytes) {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function reminderWakeId(noteId, reminder) {
	const bytes = new TextEncoder().encode(WAKE_DOMAIN + noteId + '\0' + reminder);
	return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function claimFiredWake(wakeId) {
	const db = await openNotesDb();
	try {
		if (!db.objectStoreNames.contains(SYNC_STATE_STORE)) return true;
		const tx = db.transaction(SYNC_STATE_STORE, 'readwrite');
		const done = idbTransaction(tx);
		const store = tx.objectStore(SYNC_STATE_STORE);
		const stored = await idbRequest(store.get(FIRED_KEY));
		const fired = new Set(
			Array.isArray(stored) ? stored.filter((item) => typeof item === 'string') : []
		);
		if (fired.has(wakeId)) {
			await done;
			return false;
		}
		fired.add(wakeId);
		await idbRequest(store.put([...fired], FIRED_KEY));
		await done;
		return true;
	} finally {
		db.close();
	}
}

async function showReminderWake(wake) {
	try {
		if (!(await claimFiredWake(wake.id))) return;
	} catch {
		/* IndexedDB can be unavailable; retain once-per-push delivery. */
	}

	let notes = [];
	try {
		notes = await withTimeout(loadLocalReminderState(), 1_500);
	} catch {
		notes = [];
	}

	let matching = null;
	for (const note of Array.isArray(notes) ? notes : []) {
		if (!note || note.archived || note.trashed || Number(note.reminder) !== wake.fireAt) continue;
		if ((await reminderWakeId(String(note.id), Number(note.reminder))) === wake.id) {
			matching = note;
			break;
		}
	}

	if (matching) {
		await self.registration.showNotification(reminderPreview(matching), {
			body: formatWhen(wake.fireAt),
			tag: 'scrapscache-reminder:' + wake.id,
			renotify: false,
			icon: '/icon-192.png',
			data: { type: 'reminder', noteId: matching.id, wakeId: wake.id }
		});
	} else {
		await showGenericReminder(wake.id);
	}
}

self.addEventListener('push', (event) => {
	let data = null;
	try {
		data = event.data && event.data.json();
	} catch {
		data = null;
	}
	const wake =
		data &&
		data.type === 'reminder-wake' &&
		typeof data.id === 'string' &&
		WAKE_ID_RE.test(data.id) &&
		Number.isSafeInteger(data.fireAt)
			? { id: data.id, fireAt: data.fireAt }
			: null;
	if (!wake) {
		event.waitUntil(showGenericReminder('unknown'));
		return;
	}
	event.waitUntil(showReminderWake(wake).catch(() => showGenericReminder(wake.id)));
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
