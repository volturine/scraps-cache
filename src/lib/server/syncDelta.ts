// Delta-sync planning: manifests are tiny; full note blobs move only when their version differs.

export type ManifestRecord = { id: string; updatedAt: number; hash?: string };
export type TombstoneMap = Record<string, number>;

type Versioned = ManifestRecord & Record<string, unknown>;

function times(records: ManifestRecord[]): Map<string, number> {
	return new Map(records.map((record) => [record.id, Number(record.updatedAt) || 0]));
}

export function planDelta<T extends Versioned>(
	localManifest: ManifestRecord[],
	stored: T[],
	localTombstones: TombstoneMap = {},
	storedTombstones: TombstoneMap = {}
): {
	download: T[];
	uploadIds: string[];
	downloadTombstones: TombstoneMap;
	uploadTombstones: TombstoneMap;
} {
	const local = new Map(localManifest.map((record) => [record.id, record]));
	const server = new Map(stored.map((record) => [record.id, record]));
	const download: T[] = [];
	const uploadIds: string[] = [];
	const downloadTombstones: TombstoneMap = {};
	const uploadTombstones: TombstoneMap = {};

	const ids = new Set([
		...local.keys(),
		...server.keys(),
		...Object.keys(localTombstones),
		...Object.keys(storedTombstones)
	]);
	for (const id of ids) {
		const localRecord = local.get(id);
		const localTime = Number(localRecord?.updatedAt) || 0;
		const serverRecord = server.get(id);
		const serverTime = Number(serverRecord?.updatedAt) || 0;
		const localDeleted = Number(localTombstones[id]) || 0;
		const serverDeleted = Number(storedTombstones[id]) || 0;
		const winningDelete = Math.max(localDeleted, serverDeleted);

		if (winningDelete >= Math.max(localTime, serverTime) && winningDelete > 0) {
			if (serverDeleted > localDeleted) downloadTombstones[id] = serverDeleted;
			if (localDeleted > serverDeleted) uploadTombstones[id] = localDeleted;
			continue;
		}
		if (serverTime > localTime && serverRecord) download.push(serverRecord);
		else if (localTime > serverTime) uploadIds.push(id);
		else if (
			serverRecord &&
			localRecord?.hash &&
			typeof serverRecord.hash === 'string' &&
			localRecord.hash !== serverRecord.hash
		)
			download.push(serverRecord);
	}
	return { download, uploadIds, downloadTombstones, uploadTombstones };
}

/** Apply new permanent deletes without letting an older device resurrect a record. */
export function mergeTombstones(current: TombstoneMap, incoming: TombstoneMap): TombstoneMap {
	const merged = { ...current };
	for (const [id, updatedAt] of Object.entries(incoming)) {
		if ((Number(updatedAt) || 0) > (Number(merged[id]) || 0)) merged[id] = Number(updatedAt);
	}
	return merged;
}

/** Legacy full-snapshot clients must never revive a newer permanent delete. */
export function withoutTombstoned<T extends Versioned>(
	records: T[],
	tombstones: TombstoneMap = {}
): T[] {
	return records.filter(
		(record) => (Number(tombstones[record.id]) || 0) < Number(record.updatedAt)
	);
}
