// Small durable delete manifests. Tombstones prevent deleted records from being
// resurrected by an older device during delta sync.
const NOTE_KEY = 'gkc-note-tombstones';
const LABEL_KEY = 'gkc-label-tombstones';

export type Tombstones = Record<string, number>;

function readManifest(key: string): Tombstones {
	if (typeof localStorage === 'undefined') return {};
	try {
		const raw = localStorage.getItem(key);
		const parsed = raw ? JSON.parse(raw) : {};
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed)
				.filter(([, at]) => Number(at) > 0)
				.map(([id, at]) => [id, Number(at)])
		);
	} catch (err) {
		console.error('[sync] could not read delete tombstones:', err);
		return {};
	}
}

function writeManifest(key: string, tombstones: Tombstones): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key, JSON.stringify(tombstones));
	} catch (err) {
		console.error('[sync] could not save delete tombstones:', err);
	}
}

export function readTombstones(): Tombstones {
	return readManifest(NOTE_KEY);
}

export function writeTombstones(tombstones: Tombstones): void {
	writeManifest(NOTE_KEY, tombstones);
}

export function readLabelTombstones(): Tombstones {
	return readManifest(LABEL_KEY);
}

export function writeLabelTombstones(tombstones: Tombstones): void {
	writeManifest(LABEL_KEY, tombstones);
}
