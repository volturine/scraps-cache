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
		caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
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

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const noteId = event.notification.data && event.notification.data.noteId;
	const path = typeof noteId === 'string' && noteId ? '/?note=' + encodeURIComponent(noteId) : '/';
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
