// Profile keyring: saved sync keys ("profiles"). Each profile owns a
// namespaced dataset directly in the shared object stores, so switching is a
// pointer change plus an in-memory reload — no data copying.
import {
	deleteStoredProfile,
	listStoredProfiles,
	putStoredProfile,
	LOCAL_PROFILE_ID,
	copyProfileNamespace,
	getAllNotesMetadata,
	getAllLabels,
	getSyncState,
	hydrateNoteAttachments,
	scopedStateKey
} from '$lib/db/idb';
import { BOARDS_IDB, BOARD_IDB, LABEL_IDB, NOTE_IDB } from '$lib/syncTombstones';
import type { KanbanBoard } from '$lib/kanban';
import type { Note } from '$lib/types';
import type { ScrapsCacheBackup } from '$lib/backup';

export type { StoredProfile } from '$lib/db/idb';
import type { StoredProfile } from '$lib/db/idb';

const LS_LAST_ACTIVE = 'gkc-last-active-profile';
const LS_LEGACY_ACCOUNT = 'gkc-sync-account';

export async function loadProfiles(): Promise<StoredProfile[]> {
	const profiles = await listStoredProfiles();
	return profiles.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveProfile(profile: StoredProfile): Promise<void> {
	await putStoredProfile(profile);
}

/** Removes the keyring entry together with its entire namespaced dataset. */
export async function removeProfileRecord(id: string): Promise<void> {
	await deleteStoredProfile(id);
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

// --- Active-profile pointer -------------------------------------------------
// Per-origin default for newly opened windows; each window keeps its own
// active profile in memory once booted.

export function getLastActiveProfileId(): string | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		return localStorage.getItem(LS_LAST_ACTIVE);
	} catch {
		return null;
	}
}

export function setLastActiveProfileId(id: string | null): void {
	if (typeof localStorage === 'undefined') return;
	try {
		if (id) localStorage.setItem(LS_LAST_ACTIVE, id);
		else localStorage.removeItem(LS_LAST_ACTIVE);
	} catch (err) {
		console.error('[profiles] could not save the last active profile:', err);
	}
}

/**
 * Boot selection: the last active pointer when it still exists in the keyring,
 * else the legacy single-account mirror's entry, else the only entry, else
 * none (the window runs on the local no-key namespace until one is created).
 */
export function pickBootProfile(profiles: StoredProfile[]): StoredProfile | null {
	if (!profiles.length) return null;
	const pointer = getLastActiveProfileId();
	if (pointer) {
		const pointed = profiles.find((profile) => profile.id === pointer);
		if (pointed) return pointed;
	}
	let wantedSyncKey: string | null = null;
	try {
		const raw =
			typeof localStorage !== 'undefined' ? localStorage.getItem(LS_LEGACY_ACCOUNT) : null;
		const parsed = raw ? (JSON.parse(raw) as { syncKey?: unknown }) : null;
		if (parsed && typeof parsed.syncKey === 'string') wantedSyncKey = parsed.syncKey;
	} catch {
		/* unreadable mirror falls through */
	}
	if (wantedSyncKey) {
		const match = profileForSyncKey(profiles, wantedSyncKey);
		if (match) return match;
	}
	return profiles[0];
}

/** The namespace this window works on while no sync key exists yet. */
export const LOCAL_PID = LOCAL_PROFILE_ID;

/**
 * Give a freshly created first key ownership of any local no-account data so
 * registering does not look like data loss. Later keys start empty by design.
 */
export function adoptLocalDatasetInto(pid: string): Promise<void> {
	return copyProfileNamespace(LOCAL_PID, pid);
}

// --- Per-profile exports ----------------------------------------------------

/**
 * Build a standard notes backup file from any profile's namespace without
 * activating it. Never carries sync identity: importing lands as plain notes.
 */
export async function buildProfileNotesExport(pid: string): Promise<ScrapsCacheBackup | null> {
	const noteRows = await getAllNotesMetadata(pid);
	if (!noteRows.length && !(await getAllLabels(pid)).length) return null;
	const notes: Note[] = [];
	for (const row of noteRows) notes.push(await hydrateNoteAttachments(pid, row));
	const [labels, boards, tombstones, labelTombstones, boardTombstones] = await Promise.all([
		getAllLabels(pid),
		getSyncState<KanbanBoard[]>(scopedStateKey(BOARDS_IDB, pid)),
		getSyncState<Record<string, number>>(scopedStateKey(NOTE_IDB, pid)),
		getSyncState<Record<string, number>>(scopedStateKey(LABEL_IDB, pid)),
		getSyncState<Record<string, number>>(scopedStateKey(BOARD_IDB, pid))
	]);
	return {
		version: 4,
		exportedAt: Date.now(),
		notes,
		labels,
		boards: Array.isArray(boards) ? boards : [],
		activeBoardId: '',
		tombstones: tombstones ?? {},
		labelTombstones: labelTombstones ?? {},
		boardTombstones: boardTombstones ?? {},
		ui: { sidebarOpen: true, dark: null, layout: 'grid', view: 'notes' },
		linkPreviews: []
	};
}
