// Profile keyring: saved sync keys ("profiles") and their stashed local datasets.
// Exactly one profile is active; its dataset lives in the live stores, every
// inactive profile's dataset is parked in the PROFILE_STASH_STORE.
import {
	captureLiveCore,
	deleteStoredProfile,
	getSyncState,
	listStoredProfiles,
	putStashedDataset,
	putStoredProfile,
	getStashedDataset,
	deleteStashedDataset,
	replaceLiveCore,
	setFiredReminderKeys,
	FIRED_REMINDERS_KEY,
	type DeviceDataset,
	type ProfileExtras,
	type StoredProfile
} from '$lib/db/idb';
import {
	BOARDS_IDB,
	BOARD_IDB,
	LABEL_IDB,
	NOTE_IDB,
	saveBoardsToDevice,
	writeBoardTombstones,
	writeLabelTombstones,
	writeTombstones
} from '$lib/syncTombstones';

export type { StoredProfile };

export async function loadProfiles(): Promise<StoredProfile[]> {
	const profiles = await listStoredProfiles();
	return profiles.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveProfile(profile: StoredProfile): Promise<void> {
	await putStoredProfile(profile);
}

/** Removes the keyring entry together with its stashed dataset. */
export async function removeProfileRecord(id: string): Promise<void> {
	await deleteStoredProfile(id);
}

function tombstoneMap(value: unknown): Record<string, number> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).flatMap(([id, at]) =>
			typeof id === 'string' && Number(at) > 0 ? [[id, Number(at)] as const] : []
		)
	);
}

/** Read the full live dataset (core rows plus tombstones/boards/reminders). */
export async function captureDeviceDataset(): Promise<DeviceDataset> {
	const [core, noteTombstones, labelTombstones, boardTombstones, boards, firedReminderKeys] =
		await Promise.all([
			captureLiveCore(),
			getSyncState<unknown>(NOTE_IDB),
			getSyncState<unknown>(LABEL_IDB),
			getSyncState<unknown>(BOARD_IDB),
			getSyncState<unknown>(BOARDS_IDB),
			getSyncState<unknown>(FIRED_REMINDERS_KEY)
		]);
	return {
		...core,
		noteTombstones: tombstoneMap(noteTombstones),
		labelTombstones: tombstoneMap(labelTombstones),
		boardTombstones: tombstoneMap(boardTombstones),
		boards,
		firedReminderKeys: Array.isArray(firedReminderKeys)
			? firedReminderKeys.filter((key): key is string => typeof key === 'string')
			: []
	};
}

/** Park the current live dataset under its profile id. */
export async function stashProfileDataset(profileId: string): Promise<void> {
	await putStashedDataset({
		pid: profileId,
		savedAt: Date.now(),
		...(await captureDeviceDataset())
	});
}

/**
 * Restore a stashed dataset into the live stores: core rows land in IDB and
 * the extras (tombstones, boards, reminder keys) are persisted through their
 * owning modules. Returns the extras for in-memory adoption; null when this
 * device holds no stash for the profile. The stash itself survives until
 * `dropStashedDataset` — callers drop it only after activating the profile,
 * so a crash mid-switch is always repairable from one of the two stashes.
 */
export async function restoreProfileDataset(profileId: string): Promise<ProfileExtras | null> {
	const stash = await getStashedDataset(profileId);
	if (!stash) return null;
	const { pid: _pid, savedAt: _savedAt, notes, labels, imageBlobs, outboxKeys, ...extras } = stash;
	await replaceLiveCore({ notes, labels, imageBlobs, outboxKeys });
	await persistExtras(extras);
	return extras;
}

/** Clear the live dataset (fresh profile) so nothing of the previous one remains. */
export async function resetDeviceDataset(): Promise<void> {
	await replaceLiveCore({ notes: [], labels: [], imageBlobs: [], outboxKeys: [] });
	await persistExtras({
		noteTombstones: {},
		labelTombstones: {},
		boardTombstones: {},
		boards: [],
		firedReminderKeys: []
	});
}

async function persistExtras(extras: ProfileExtras): Promise<void> {
	const boards = Array.isArray(extras.boards) ? JSON.parse(JSON.stringify(extras.boards)) : [];
	await Promise.all([
		writeTombstones(tombstoneMap(extras.noteTombstones)),
		writeLabelTombstones(tombstoneMap(extras.labelTombstones)),
		writeBoardTombstones(tombstoneMap(extras.boardTombstones)),
		saveBoardsToDevice(boards),
		setFiredReminderKeys(
			Array.isArray(extras.firedReminderKeys)
				? extras.firedReminderKeys.filter((key): key is string => typeof key === 'string')
				: []
		)
	]);
}

export async function dropStashedDataset(profileId: string): Promise<void> {
	await deleteStashedDataset(profileId);
}

/** The keyring entry matching an active sync key, if any. */
export function profileForSyncKey(
	profiles: StoredProfile[],
	syncKey: string
): StoredProfile | null {
	return profiles.find((profile) => profile.syncKey === syncKey) ?? null;
}

export function nextProfileName(existing: readonly { name: string }[]): string {
	return existing.length === 0 ? 'Sync key' : `Sync key ${existing.length + 1}`;
}

/**
 * A crash mid-switch leaves the previous profile's stash parked while the live
 * stores may already hold another dataset. Replaying that stash makes boot
 * self-healing; when it happens after activation the replay overwrites the
 * same data and is a no-op in practice.
 */
export async function repairInterruptedProfileSwitch(active: StoredProfile | null): Promise<void> {
	if (!active) return;
	if (!(await getStashedDataset(active.id))) return;
	await restoreProfileDataset(active.id);
	await dropStashedDataset(active.id);
}
