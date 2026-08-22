// Client-side account, sync status, and real transfer progress for full-size photo backups.

import type { KanbanBoard } from '$lib/kanban';
import type { Label, Note, NoteImage } from '$lib/types';
import { mergeKanbanBoards } from '$lib/kanban';
import { mergeLabelLists, mergeNoteLists, withoutTombstoned } from '$lib/noteMerge';
import {
	currentRecordKeys,
	fingerprintMapFrom,
	planDeletableKeys,
	reconcileBaseline,
	referencedAttachmentIds,
	syncRoundHasMore,
	syncControlKeys
} from '$lib/syncEngine';
import {
	attachmentToImage,
	buildSyncRecords,
	changedRecords,
	hydrateNoteImages,
	isSyncRecordPayload,
	legacySnapshotPayloads,
	syncRecordKey,
	type SyncRecord,
	type SyncRecordPayload
} from '$lib/syncRecords';
import { sha256 } from '$lib/syncHash';
import {
	createOneTimePairingCode,
	createPairingRequestKey,
	createSyncIdentity,
	identityFromSyncKey,
	openSyncKeyFromPeer,
	pairingCodeTag,
	sealSyncKeyForPeer,
	encryptSyncPayload,
	decryptSyncPayload,
	randomOpaqueId
} from '$lib/syncPairing';
import {
	commitSyncControl,
	deleteSyncState,
	getOutboxGeneration,
	getSyncOutboxKeys,
	getSyncState,
	markSyncOutbox,
	LOCAL_PROFILE_ID
} from '$lib/db/idb';
import {
	getLastActiveProfileId,
	loadProfiles,
	nextProfileName,
	pickBootProfile,
	profileForSyncKey,
	removeProfileRecord,
	saveProfile,
	setLastActiveProfileId,
	type StoredProfile
} from '$lib/profiles';

const LS_SYNC_STATUS_PREFIX = 'gkc-sync-status';
const LS_LEGACY_ACCOUNT_KEY = 'gkc-sync-account';
/** Encrypted profile-name record; the name follows its sync key across devices. */
export const PROFILE_META_KEY = 'profile-meta';

export interface SyncAccount {
	syncKey: string;
	accountId: string;
	authSecret: string;
	pairingCode: string;
}

export type StartedDeviceLink = {
	id: string;
	expiresAt: number;
	role: 'existing' | 'new';
	syncCode: string;
	pake: { ephemeralSecret: string; share: string };
};
type LinkPoll =
	| { state: 'waiting'; expiresAt: number }
	| { state: 'matched'; expiresAt: number; peerPublicKey: string }
	| { state: 'connected'; expiresAt: number; peerPublicKey: string; grant: { ciphertext: string } }
	| { state: 'expired' | 'not-found' };

interface SyncStatus {
	lastSync: number;
}

function isSyncAccount(value: unknown): value is Pick<SyncAccount, 'syncKey'> {
	return !!value && typeof value === 'object' && typeof (value as SyncAccount).syncKey === 'string';
}

export interface SyncProgress {
	phase: 'upload' | 'download';
	loadedBytes: number;
	totalBytes: number | null;
}

export interface SyncUsage {
	ciphertextBytes: number;
	envelopeCount: number;
	maxBytes: number;
	maxEnvelopes: number;
}

type SyncResult = {
	success: boolean;
	notes?: Note[];
	labels?: Label[];
	boards?: KanbanBoard[];
	tombstones?: Record<string, number>;
	labelTombstones?: Record<string, number>;
	boardTombstones?: Record<string, number>;
	data?: Record<string, unknown>;
	error?: string;
	/** HTTP status of a failed request; lets callers react to codes, not message text. */
	status?: number;
};

export type SyncSnapshot = {
	notes: Note[];
	labels: Label[];
	boards: KanbanBoard[];
	tombstones: Record<string, number>;
	labelTombstones: Record<string, number>;
	boardTombstones: Record<string, number>;
};

type ApplyPulled = (snapshot: SyncSnapshot) => Promise<SyncSnapshot>;

function mergeTombstoneMaps(
	local: Record<string, number>,
	remote: unknown
): Record<string, number> {
	if (!remote || typeof remote !== 'object') return local;
	const merged = { ...local };
	for (const [id, timestamp] of Object.entries(remote as Record<string, unknown>)) {
		const value = Number(timestamp) || 0;
		if (value > (merged[id] || 0)) merged[id] = value;
	}
	return merged;
}

export class SyncStore {
	account = $state<SyncAccount | null>(null);
	lastSync = $state(0);
	lastError = $state<string | null>(null);
	progress = $state<SyncProgress | null>(null);
	usage = $state<SyncUsage | null>(null);
	/** Saved sync keys on this device; the one matching `account` is active. */
	profiles = $state<StoredProfile[]>([]);
	private profilesReady: Promise<void> | null = null;
	private bootstrapRequested = false;
	private pendingOutboxWrites: Promise<void> = Promise.resolve();

	// Non-reactive callbacks avoid re-rendering the note grid for cloud feedback.
	onSyncStart: (() => void) | null = null;
	onSyncEnd: (() => void) | null = null;
	/** Registered by the central data store so board edits share its debounced sync. */
	onLocalDataChange: (() => void) | null = null;

	constructor() {
		if (typeof localStorage === 'undefined') return;
		void this.ensureProfilesLoaded();
	}

	get isLoggedIn(): boolean {
		return this.account !== null;
	}

	get activeProfile(): StoredProfile | null {
		return this.account
			? (profileForSyncKey(this.profiles, this.account.syncKey) ?? this.profiles[0] ?? null)
			: null;
	}

	/** Namespace this window reads and writes right now. */
	get activePid(): string {
		return this.activeProfile?.id ?? LOCAL_PROFILE_ID;
	}

	/**
	 * Per-window boot: restore the keyring, adopt installs that predate
	 * profiles, and activate the last-used profile. Windows opened later start
	 * on the same default profile but can switch independently.
	 */
	ensureProfilesLoaded(): Promise<void> {
		this.profilesReady ??= (async () => {
			try {
				let profiles = await loadProfiles();
				const rawLegacy = localStorage.getItem(LS_LEGACY_ACCOUNT_KEY);
				try {
					const parsed: unknown = rawLegacy ? JSON.parse(rawLegacy) : null;
					if (isSyncAccount(parsed) && !profiles.some((p) => p.syncKey === parsed.syncKey)) {
						const adopted: StoredProfile = {
							id: randomOpaqueId(),
							name: nextProfileName(profiles),
							syncKey: parsed.syncKey,
							createdAt: Date.now()
						};
						await saveProfile(adopted);
						profiles = [...profiles, adopted];
					}
				} catch {
					/* unreadable legacy mirror is ignored */
				}
				this.profiles = profiles.sort((a, b) => a.createdAt - b.createdAt);
				if (this.profiles.length) localStorage.removeItem(LS_LEGACY_ACCOUNT_KEY);

				const pointerId = getLastActiveProfileId();
				const pointed =
					pointerId != null
						? (this.profiles.find((entry) => entry.id === pointerId) ?? null)
						: null;
				const chosen = pointed ?? pickBootProfile(this.profiles);
				if (chosen) this.activateProfile(chosen);
				else this.restoreStatus(LOCAL_PROFILE_ID);
			} catch (err) {
				console.error('[sync] could not load saved profiles:', err);
			}
		})();
		return this.profilesReady;
	}

	/** Persist a keyring entry and surface it in the reactive profile list. */
	async addKeyringEntry(profile: StoredProfile): Promise<void> {
		await saveProfile(profile);
		this.profiles = [...this.profiles, profile].sort((a, b) => a.createdAt - b.createdAt);
	}

	async renameProfile(id: string, name: string): Promise<StoredProfile | null> {
		const trimmed = name.trim().slice(0, 60);
		const profile = this.profiles.find((entry) => entry.id === id);
		if (!profile || !trimmed || profile.name === trimmed) return profile ?? null;
		const updated = { ...profile, name: trimmed };
		this.profiles = this.profiles.map((entry) => (entry.id === id ? updated : entry));
		await saveProfile(updated).catch((err) =>
			console.error('[sync] could not rename profile:', err)
		);
		// The name travels inside its own account's encrypted records so every
		// device holding this key converges on it.
		if (this.activeProfile?.id === id)
			void this.queueOutbox([PROFILE_META_KEY]).catch(() => undefined);
		return updated;
	}

	/** Remove a non-active keyring entry together with its namespaced dataset. */
	async removeProfile(id: string): Promise<boolean> {
		if (this.activeProfile?.id === id) return false;
		if (!this.profiles.some((entry) => entry.id === id)) return false;
		try {
			await removeProfileRecord(id);
		} catch (err) {
			console.error('[sync] could not remove profile:', err);
			return false;
		}
		this.profiles = this.profiles.filter((entry) => entry.id !== id);
		return true;
	}

	requestAutoSync(keys: Iterable<string> = []): void {
		void this.queueOutbox(keys).catch((err) => {
			console.error('[sync] could not persist outbox:', err);
		});
	}

	async queueOutbox(keys: Iterable<string> = []): Promise<void> {
		const pendingKeys = [...new Set(keys)];
		const pid = this.activePid;
		const write = this.pendingOutboxWrites.then(async () => {
			await markSyncOutbox(pid, pendingKeys);
		});
		this.pendingOutboxWrites = write.catch(() => undefined);
		await write;
		this.onLocalDataChange?.();
	}

	async waitForOutboxWrites(): Promise<void> {
		await this.pendingOutboxWrites;
	}

	private restoreStatus(pid: string): void {
		if (typeof localStorage === 'undefined') return;
		try {
			const raw = localStorage.getItem(`${LS_SYNC_STATUS_PREFIX}:${pid}`);
			this.lastSync = raw ? Number((JSON.parse(raw) as SyncStatus).lastSync) || 0 : 0;
		} catch {
			this.lastSync = 0;
		}
	}

	private saveStatus(): void {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(
				`${LS_SYNC_STATUS_PREFIX}:${this.activePid}`,
				JSON.stringify({ lastSync: this.lastSync })
			);
		} catch (err) {
			console.error('[sync] could not save status:', err);
		}
	}

	/**
	 * Create a new sync key on the relay and save it as a keyring entry.
	 * Activation is the caller's job: the coordinator decides whether local
	 * no-account data is adopted into it and reloads the dataset.
	 */
	async register(
		name?: string
	): Promise<{ success: boolean; profile?: StoredProfile; error?: string }> {
		const account = createSyncIdentity();
		try {
			const res = await fetch('/api/sync/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ accountId: account.accountId, authSecret: account.authSecret })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok)
				return {
					success: false,
					error: typeof data.error === 'string' ? data.error : 'Registration failed'
				};
			const profile: StoredProfile = {
				id: randomOpaqueId(),
				name: name?.trim() || nextProfileName(this.profiles),
				syncKey: account.syncKey,
				createdAt: Date.now()
			};
			await this.addKeyringEntry(profile);
			return { success: true, profile };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : 'Network error' };
		}
	}

	/**
	 * Point this window at a saved sync key. Datasets are namespaced, so this
	 * only flips in-memory identity plus the last-active pointer; the caller
	 * reloads memory from the target namespace.
	 */
	activateProfile(profile: StoredProfile): void {
		this.account = identityFromSyncKey(profile.syncKey);
		this.lastError = null;
		this.progress = null;
		this.usage = null;
		setLastActiveProfileId(profile.id);
		this.restoreStatus(profile.id);
	}

	async startDeviceLink(
		input: string
	): Promise<{ success: boolean; link?: StartedDeviceLink; error?: string }> {
		return this.startRendezvous('new', input);
	}

	async startExistingDeviceLink(): Promise<{
		success: boolean;
		link?: StartedDeviceLink;
		error?: string;
	}> {
		if (!this.account) return { success: false, error: 'Sync is not set up on this device' };
		return this.startRendezvous('existing', createOneTimePairingCode());
	}

	private async startRendezvous(
		role: 'existing' | 'new',
		input: string
	): Promise<{ success: boolean; link?: StartedDeviceLink; error?: string }> {
		try {
			const requestKey = createPairingRequestKey(input);
			const res = await fetch('/api/sync/pair/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ codeTag: pairingCodeTag(input), role, publicKey: requestKey.share })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || typeof data.id !== 'string' || typeof data.expiresAt !== 'number')
				return {
					success: false,
					error: typeof data.error === 'string' ? data.error : 'Could not start device rendezvous'
				};
			return {
				success: true,
				link: { id: data.id, expiresAt: data.expiresAt, role, syncCode: input, pake: requestKey }
			};
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : 'Could not start device rendezvous'
			};
		}
	}

	async pollDeviceLink(link: StartedDeviceLink): Promise<{
		success: boolean;
		linked?: boolean;
		matched?: boolean;
		expired?: boolean;
		receivedSyncKey?: string;
		error?: string;
	}> {
		try {
			const res = await fetch('/api/sync/pair/poll', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId: link.id })
			});
			const data = (await res.json().catch(() => ({}))) as Partial<LinkPoll>;
			if (!res.ok) return { success: false, error: 'Could not check device rendezvous' };
			if (data.state === 'waiting') return { success: true };
			if (data.state === 'expired' || data.state === 'not-found')
				return { success: true, expired: true };
			if (data.state === 'matched' && typeof data.peerPublicKey === 'string') {
				if (link.role === 'new') return { success: true, matched: true };
				if (!this.account) return { success: false, error: 'Sync is not set up on this device' };
				const grant = sealSyncKeyForPeer(
					this.account.syncKey,
					link.syncCode,
					link.pake,
					data.peerPublicKey
				);
				const sent = await fetch('/api/sync/pair/approve', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ sessionId: link.id, grant })
				});
				return sent.ok
					? { success: true, linked: true }
					: { success: false, error: 'Could not deliver encrypted sync key' };
			}
			if (data.state !== 'connected' || !data.grant || typeof data.grant !== 'object')
				return { success: false, error: 'Invalid device rendezvous response' };
			if (link.role !== 'new') return { success: true, linked: true };
			const grant = data.grant as { existingPublicKey?: unknown; ciphertext?: unknown };
			if (typeof grant.ciphertext !== 'string')
				return { success: false, error: 'Invalid encrypted sync key' };
			// Hand the raw key back; activation is the caller's job so the current
			// profile's dataset can be stashed first.
			const syncKey = openSyncKeyFromPeer(link.syncCode, link.pake, data.peerPublicKey ?? '', {
				ciphertext: grant.ciphertext
			});
			return { success: true, linked: true, receivedSyncKey: syncKey };
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : 'Could not complete device rendezvous'
			};
		}
	}

	private sendSyncRequest(
		path: string,
		payload: string,
		uploadBytes: number,
		indicate: boolean
	): Promise<SyncResult> {
		return new Promise((resolve) => {
			const xhr = new XMLHttpRequest();
			xhr.open('POST', path);
			// Pairing expires in 60 seconds; photo/data sync must be allowed to finish.
			xhr.timeout = 300_000;
			xhr.setRequestHeader('Content-Type', 'application/json');

			const showTransfer = indicate && uploadBytes >= 32 * 1024;
			if (showTransfer) {
				this.progress = { phase: 'upload', loadedBytes: 0, totalBytes: uploadBytes };
				xhr.upload.onprogress = (event) => {
					this.progress = {
						phase: 'upload',
						loadedBytes: event.loaded,
						totalBytes: event.lengthComputable ? event.total : uploadBytes
					};
				};
			}
			if (indicate) {
				xhr.onprogress = (event) => {
					if (!event.lengthComputable || event.total < 32 * 1024) return;
					this.progress = {
						phase: 'download',
						loadedBytes: event.loaded,
						totalBytes: event.total
					};
				};
			}

			xhr.onload = () => {
				let data: Record<string, unknown> = {};
				try {
					data = JSON.parse(xhr.responseText || '{}') as Record<string, unknown>;
				} catch {
					/* handled below */
				}
				if (xhr.status < 200 || xhr.status >= 300) {
					resolve({
						success: false,
						status: xhr.status,
						error:
							typeof data.error === 'string' ? data.error : `Sync request failed (${xhr.status})`
					});
					return;
				}
				resolve({
					success: true,
					notes: data.notes as Note[],
					labels: data.labels as Label[],
					boards: data.boards as KanbanBoard[],
					tombstones: data.tombstones as Record<string, number> | undefined,
					labelTombstones: data.labelTombstones as Record<string, number> | undefined,
					boardTombstones: data.boardTombstones as Record<string, number> | undefined,
					data
				});
			};
			xhr.onerror = () => resolve({ success: false, error: 'Sync network error' });
			xhr.ontimeout = () => resolve({ success: false, error: 'Sync timed out' });
			xhr.onabort = () => resolve({ success: false, error: 'Sync was cancelled' });
			xhr.send(payload);
		});
	}

	/** End-to-end encrypted per-record delta. Uploads only dirty outbox keys. */
	async sync(
		notes: Note[],
		labels: Label[],
		tombstones: Record<string, number> = {},
		labelTombstones: Record<string, number> = {},
		boards: KanbanBoard[] = [],
		boardTombstones: Record<string, number> = {},
		indicate = false,
		pullOnly = false,
		applyPulled?: ApplyPulled
	): Promise<SyncResult> {
		if (!this.account) return { success: false, error: 'Not linked' };
		const account = this.account;
		const pid = this.activePid;
		const syncCancelled = (): boolean => this.account !== account;
		if (indicate) this.onSyncStart?.();
		try {
			const ATTACHMENT_UPLOAD_BUDGET = 2;
			const UPLOAD_RECORD_BUDGET = 500;
			const DOWNLOAD_LIMIT = 12;
			const MAX_QUOTA_RETRIES = 1000;
			const MAX_RESET_RETRIES = 3;
			let quotaRetries = 0;
			let resetRetries = 0;
			const quotaBlockedKeys = new Set<string>();
			let quotaSingleUpload = false;
			const keys = syncControlKeys(account.accountId);
			let baseline: Record<string, string> = {};
			try {
				const durable = await getSyncState<unknown>(keys.baseline);
				if (durable && typeof durable === 'object' && !Array.isArray(durable))
					baseline = Object.fromEntries(
						Object.entries(durable).filter(
							([key, value]) => typeof key === 'string' && typeof value === 'string'
						)
					);
			} catch {
				/* first sync */
			}
			const firstFullUpload = Object.keys(baseline).length === 0;
			let recordIds =
				(await getSyncState<Record<string, string>>(keys.recordIds).catch(() => undefined)) ?? {};
			if (!recordIds || typeof recordIds !== 'object' || Array.isArray(recordIds)) recordIds = {};
			const outboxSnapshotAt = await getOutboxGeneration();
			let outboxKeys = new Set(await getSyncOutboxKeys(pid).catch(() => []));
			let cursor = Number((await getSyncState<number>(keys.cursor).catch(() => undefined)) || 0);
			if (firstFullUpload && cursor > 0) cursor = 0;

			let mergedNotes = notes,
				mergedLabels = labels,
				mergedBoards = boards;
			let mergedTombstones = { ...tombstones },
				mergedLabelTombstones = { ...labelTombstones },
				mergedBoardTombstones = { ...boardTombstones };
			const attachments = new Map<string, NoteImage>();
			for (const note of notes) {
				for (const image of note.images ?? []) {
					if (image.dataUrl?.length) attachments.set(image.id, image);
				}
			}

			let hasMore = true;
			let downloadsDrained = false;
			const acknowledgedOutbox = new Set<string>();
			const internallyMarkedOutbox = new Map<string, number>();
			let poisonCount = 0;
			let stalledWrites = 0;
			while (hasMore) {
				if (syncCancelled()) return { success: false, error: 'Sync was cancelled' };
				const startedWithDownloadsDrained = downloadsDrained;
				const tombstoneMaps = {
					notes: mergedTombstones,
					labels: mergedLabelTombstones,
					boards: mergedBoardTombstones
				};
				const uploadKeys =
					pullOnly || !downloadsDrained
						? new Set<string>()
						: firstFullUpload
							? undefined
							: outboxKeys;
				const currentRecords = await buildSyncRecords(
					mergedNotes,
					mergedLabels,
					mergedBoards,
					mergedTombstones,
					mergedLabelTombstones,
					mergedBoardTombstones,
					uploadKeys
				);
				// The profile name rides its own account's encrypted records so every
				// device holding this sync key converges on one local label.
				const metaUploadDue =
					!pullOnly &&
					downloadsDrained &&
					outboxKeys.has(PROFILE_META_KEY) &&
					!quotaBlockedKeys.has(PROFILE_META_KEY) &&
					(uploadKeys === undefined || uploadKeys.has(PROFILE_META_KEY));
				if (metaUploadDue) {
					const metaPayload = {
						kind: 'profile-meta' as const,
						value: { name: this.activeProfile?.name ?? '' }
					};
					currentRecords.push({
						key: PROFILE_META_KEY,
						fingerprint: await sha256(metaPayload),
						payload: metaPayload
					});
				}
				const changed =
					pullOnly || !downloadsDrained ? [] : changedRecords(currentRecords, baseline);
				const nonAttachments = changed.filter(
					(record) => record.payload.kind !== 'attachment' && !quotaBlockedKeys.has(record.key)
				);
				const changedAttachments = changed.filter(
					(record) => record.payload.kind === 'attachment' && !quotaBlockedKeys.has(record.key)
				);
				// Notes/labels/boards go before photos so one over-quota image cannot strand text.
				const recordBudget = quotaSingleUpload ? 1 : UPLOAD_RECORD_BUDGET;
				const attachBudget = quotaSingleUpload ? 1 : ATTACHMENT_UPLOAD_BUDGET;
				const outgoing = nonAttachments.length
					? nonAttachments.slice(0, recordBudget)
					: changedAttachments.slice(0, attachBudget);
				const sentRecordKeys = new Set(outgoing.map((record) => record.key));
				const sentIds = new Set<string>();
				const sentRecordIds = new Map<string, string>();
				const sentSlots = new Map<string, string>();
				const outbound = await Promise.all(
					outgoing.map(async (record: SyncRecord) => {
						const id = randomOpaqueId();
						sentIds.add(id);
						sentRecordIds.set(record.key, id);
						// Keyed, non-reversible slot token: relay can replace old ciphertext but cannot
						// infer whether this is a note, attachment, board, or its plaintext identity.
						const slot = await sha256(`${account.syncKey}\u0000${record.key}`);
						sentSlots.set(slot, record.key);
						return {
							id,
							slot,
							expectedId: recordIds[record.key] ?? null,
							ciphertext: encryptSyncPayload(account.syncKey, record.payload)
						};
					})
				);
				const currentKeys = currentRecordKeys(
					mergedNotes,
					mergedLabels,
					mergedBoards,
					tombstoneMaps
				);
				if (recordIds[PROFILE_META_KEY] || sentRecordIds.has(PROFILE_META_KEY) || metaUploadDue)
					currentKeys.add(PROFILE_META_KEY);
				// Slot tokens are keyed hashes of record keys, so an unreadable envelope can
				// still be identified locally. Adopting its id lets a later upload replace
				// it or a delete reclaim it instead of stranding the slot on the relay;
				// keys this device already tracks keep their existing mapping.
				let knownSlotMap: Promise<Map<string, string>> | null = null;
				const knownSlotKey = async (slot: string): Promise<string | undefined> => {
					const sentKey = sentSlots.get(slot);
					if (sentKey) return sentKey;
					knownSlotMap ??= Promise.all(
						[...new Set([...Object.keys(recordIds), ...currentKeys])].map(
							async (key) => [await sha256(`${account.syncKey}\u0000${key}`), key] as const
						)
					).then((entries) => new Map(entries));
					return (await knownSlotMap).get(slot);
				};
				const deletableKeys = planDeletableKeys({
					recordIds,
					notes: mergedNotes,
					labels: mergedLabels,
					boards: mergedBoards,
					tombstones: tombstoneMaps,
					pullOnly,
					catchUpComplete: downloadsDrained
				}).filter((key) => key !== PROFILE_META_KEY);
				const deleteSlots = await Promise.all(
					deletableKeys.map(async (key) => ({
						id: recordIds[key],
						slot: await sha256(`${account.syncKey}\u0000${key}`)
					}))
				);
				const payload = JSON.stringify({
					accountId: account.accountId,
					authSecret: account.authSecret,
					cursor,
					limit: DOWNLOAD_LIMIT,
					envelopes: outbound,
					deleteSlots
				});
				const response = await this.sendSyncRequest(
					'/api/sync/delta',
					payload,
					new Blob([payload]).size,
					indicate
				);
				if (syncCancelled()) return { success: false, error: 'Sync was cancelled' };
				if (!response.success && response.status === 507 && outgoing.length > 0) {
					quotaRetries += 1;
					if (quotaRetries > MAX_QUOTA_RETRIES)
						throw new Error('Relay kept rejecting uploads for storage quota');
					if (outgoing.length > 1) quotaSingleUpload = true;
					else {
						const blockedKey = outgoing[0].key;
						quotaBlockedKeys.add(blockedKey);
						await markSyncOutbox(pid, [blockedKey]);
						outboxKeys.add(blockedKey);
						quotaSingleUpload = false;
					}
					hasMore = true;
					continue;
				}
				if (!response.success || !response.data) return this.fail(response);
				const remoteUsage = response.data.usage;
				if (remoteUsage && typeof remoteUsage === 'object') {
					const candidate = remoteUsage as Partial<SyncUsage>;
					if (
						[
							candidate.ciphertextBytes,
							candidate.envelopeCount,
							candidate.maxBytes,
							candidate.maxEnvelopes
						].every((value) => typeof value === 'number' && Number.isFinite(value))
					) {
						this.usage = candidate as SyncUsage;
					}
				}
				const writesAccepted = response.data.writesAccepted === true;
				if (writesAccepted) {
					stalledWrites = 0;
					for (const key of deletableKeys) delete recordIds[key];
					for (const [key, id] of sentRecordIds) recordIds[key] = id;
					for (const key of deletableKeys) acknowledgedOutbox.add(key);
				}
				if (response.data.reset === true) {
					// The relay was deliberately reset while this device retained a baseline.
					// Ask the notes store to reload full attachments before its retry.
					resetRetries += 1;
					if (resetRetries > MAX_RESET_RETRIES)
						throw new Error('Relay repeatedly requested a state reset');
					this.bootstrapRequested = true;
					baseline = {};
					recordIds = {};
					cursor = 0;
					continue;
				}

				const pendingNotes: Note[] = [];
				const remoteFingerprints: Record<string, string> = {};
				let decodedAny = false;
				let adoptedConflictId = false;
				const applyPayload = (record: SyncRecordPayload) => {
					switch (record.kind) {
						case 'attachment':
							attachments.set(record.value.id, attachmentToImage(record.value));
							break;
						case 'note':
							pendingNotes.push(hydrateNoteImages(record.value, attachments));
							break;
						case 'label':
							mergedLabels = mergeLabelLists(mergedLabels, [record.value]);
							break;
						case 'board':
							mergedBoards = mergeKanbanBoards(mergedBoards, [record.value], mergedBoardTombstones);
							break;
						case 'note-tombstone':
							mergedTombstones = mergeTombstoneMaps(mergedTombstones, {
								[record.id]: record.deletedAt
							});
							break;
						case 'label-tombstone':
							mergedLabelTombstones = mergeTombstoneMaps(mergedLabelTombstones, {
								[record.id]: record.deletedAt
							});
							break;
						case 'board-tombstone':
							mergedBoardTombstones = mergeTombstoneMaps(mergedBoardTombstones, {
								[record.id]: record.deletedAt
							});
							break;
						case 'profile-meta':
							if (typeof (record as { value?: { name?: unknown } }).value?.name === 'string')
								this.applySyncedProfileName((record as { value: { name: string } }).value.name);
							break;
					}
				};
				const downloaded = Array.isArray(response.data.envelopes) ? response.data.envelopes : [];
				const envelopes = [
					...downloaded,
					...(Array.isArray(response.data.conflicts) ? response.data.conflicts : [])
				];
				for (const envelope of envelopes) {
					if (!envelope || typeof envelope !== 'object') {
						poisonCount += 1;
						continue;
					}
					const id =
						typeof (envelope as { id?: unknown }).id === 'string'
							? (envelope as { id: string }).id
							: '';
					const slot =
						typeof (envelope as { slot?: unknown }).slot === 'string'
							? (envelope as { slot: string }).slot
							: '';
					if (id && sentIds.has(id)) continue;
					if (typeof (envelope as { ciphertext?: unknown }).ciphertext !== 'string') {
						poisonCount += 1;
						continue;
					}
					let decodedRecords: SyncRecordPayload[] | null = null;
					try {
						const remote = decryptSyncPayload(
							account.syncKey,
							(envelope as { ciphertext: string }).ciphertext
						);
						decodedRecords = isSyncRecordPayload(remote)
							? [remote]
							: await legacySnapshotPayloads(remote);
					} catch {
						decodedRecords = null;
					}
					if (!decodedRecords) {
						poisonCount += 1;
						const key = slot ? await knownSlotKey(slot) : undefined;
						if (key && id && (sentSlots.has(slot) || !recordIds[key])) {
							recordIds[key] = id;
							adoptedConflictId = true;
						}
						continue;
					}
					decodedAny = true;
					const ordered = [
						...decodedRecords.filter((record) => record.kind === 'attachment'),
						...decodedRecords.filter((record) => record.kind !== 'attachment')
					];
					for (const record of ordered) {
						applyPayload(record);
						const key = syncRecordKey(record);
						recordIds[key] = id;
						remoteFingerprints[key] = await sha256(record);
						currentKeys.add(key);
					}
				}
				if (!writesAccepted && (outgoing.length > 0 || deleteSlots.length > 0)) {
					if (decodedAny || adoptedConflictId || downloaded.length > 0) {
						stalledWrites = 0;
					} else {
						stalledWrites += 1;
						if (stalledWrites >= 3) {
							throw new Error('Could not commit encrypted writes after repeated conflicts');
						}
					}
				}
				if (pendingNotes.length) {
					mergedNotes = mergeNoteLists(
						mergedNotes,
						pendingNotes.map((note) => hydrateNoteImages(note, attachments))
					);
				}
				mergedNotes = mergedNotes.map((note) => hydrateNoteImages(note, attachments));

				if (typeof response.data.cursor === 'number') {
					cursor = response.data.cursor;
				}
				downloadsDrained = response.data.hasMore !== true;

				mergedNotes = withoutTombstoned(mergedNotes, mergedTombstones);
				mergedLabels = withoutTombstoned(mergedLabels, mergedLabelTombstones);
				mergedBoards = withoutTombstoned(mergedBoards, mergedBoardTombstones);
				if (
					downloadsDrained &&
					(!startedWithDownloadsDrained || envelopes.length > 0) &&
					applyPulled
				) {
					const applied = await applyPulled({
						notes: mergedNotes,
						labels: mergedLabels,
						boards: mergedBoards,
						tombstones: mergedTombstones,
						labelTombstones: mergedLabelTombstones,
						boardTombstones: mergedBoardTombstones
					});
					mergedNotes = applied.notes;
					mergedLabels = applied.labels;
					mergedBoards = applied.boards;
					mergedTombstones = applied.tombstones;
					mergedLabelTombstones = applied.labelTombstones;
					mergedBoardTombstones = applied.boardTombstones;
					for (const note of mergedNotes) {
						for (const image of note.images ?? []) {
							if (image.dataUrl?.length) attachments.set(image.id, image);
						}
					}
				}
				if (syncCancelled()) return { success: false, error: 'Sync was cancelled' };
				const appliedTombstoneMaps = {
					notes: mergedTombstones,
					labels: mergedLabelTombstones,
					boards: mergedBoardTombstones
				};
				const mergedRecords = await buildSyncRecords(
					mergedNotes,
					mergedLabels,
					mergedBoards,
					mergedTombstones,
					mergedLabelTombstones,
					mergedBoardTombstones,
					new Set([...sentRecordKeys, ...Object.keys(remoteFingerprints), ...outboxKeys])
				);
				const uploadedFingerprints = writesAccepted
					? Object.fromEntries(outgoing.map((record) => [record.key, record.fingerprint]))
					: {};
				const reconciled = reconcileBaseline({
					previous: baseline,
					uploaded: uploadedFingerprints,
					remote: remoteFingerprints,
					merged: fingerprintMapFrom(mergedRecords),
					currentKeys: (() => {
						const keys = currentRecordKeys(
							mergedNotes,
							mergedLabels,
							mergedBoards,
							appliedTombstoneMaps
						);
						if (recordIds[PROFILE_META_KEY] || sentRecordIds.has(PROFILE_META_KEY) || metaUploadDue)
							keys.add(PROFILE_META_KEY);
						return keys;
					})(),
					referencedAttachments: referencedAttachmentIds(mergedNotes, mergedTombstones)
				});
				baseline = reconciled.baseline;
				for (const key of reconciled.ackKeys) acknowledgedOutbox.add(key);
				if (reconciled.dirtyKeys.length) {
					const generation = await markSyncOutbox(pid, reconciled.dirtyKeys);
					for (const key of reconciled.dirtyKeys) {
						outboxKeys.add(key);
						internallyMarkedOutbox.set(key, generation);
					}
				}

				if (downloadsDrained) {
					const internalAcknowledgements = new Map<number, string[]>();
					for (const key of acknowledgedOutbox) {
						const markedAt = internallyMarkedOutbox.get(key);
						if (markedAt == null) continue;
						const keysAtGeneration = internalAcknowledgements.get(markedAt) ?? [];
						keysAtGeneration.push(key);
						internalAcknowledgements.set(markedAt, keysAtGeneration);
					}
					if (syncCancelled()) return { success: false, error: 'Sync was cancelled' };
					await commitSyncControl(
						pid,
						[
							[keys.cursor, cursor],
							[keys.baseline, baseline],
							[keys.recordIds, recordIds],
							[keys.migration, true]
						],
						[
							{ keys: acknowledgedOutbox, through: outboxSnapshotAt },
							...[...internalAcknowledgements].map(([markedAt, keysAtGeneration]) => ({
								keys: keysAtGeneration,
								through: markedAt
							}))
						]
					);
					for (const keysAtGeneration of internalAcknowledgements.values()) {
						for (const key of keysAtGeneration) internallyMarkedOutbox.delete(key);
					}
				}

				const remainingUploads =
					!pullOnly &&
					(!startedWithDownloadsDrained ||
						(!writesAccepted && (outgoing.length > 0 || deleteSlots.length > 0)) ||
						changed.filter((record) => !quotaBlockedKeys.has(record.key)).length > outgoing.length);
				const pendingDeletes =
					downloadsDrained &&
					planDeletableKeys({
						recordIds,
						notes: mergedNotes,
						labels: mergedLabels,
						boards: mergedBoards,
						tombstones: appliedTombstoneMaps,
						pullOnly,
						catchUpComplete: true
					}).length > 0;
				hasMore = syncRoundHasMore({
					remoteHasMore: response.data.hasMore === true,
					remainingUploads,
					pendingDeletes
				});
			}

			if (syncCancelled()) return { success: false, error: 'Sync was cancelled' };
			if (poisonCount > 0) {
				this.lastError = `Skipped ${poisonCount} unreadable sync record${poisonCount === 1 ? '' : 's'}`;
			} else if (quotaBlockedKeys.size > 0) {
				this.lastError = 'Some records exceed the account storage quota';
			} else {
				this.lastError = null;
			}
			this.lastSync = Date.now();
			this.saveStatus();
			return {
				success: true,
				notes: mergedNotes,
				labels: mergedLabels,
				boards: mergedBoards,
				tombstones: mergedTombstones,
				labelTombstones: mergedLabelTombstones,
				boardTombstones: mergedBoardTombstones
			};
		} catch (err) {
			if (syncCancelled()) return { success: false, error: 'Sync was cancelled' };
			return this.fail({
				success: false,
				error:
					err instanceof Error ? `Encrypted sync failed: ${err.message}` : 'Encrypted sync failed'
			});
		} finally {
			if (indicate) this.progress = null;
			if (indicate) this.onSyncEnd?.();
		}
	}

	private fail(result: SyncResult): SyncResult {
		this.lastError = result.error || 'Sync failed';
		return { success: false, error: this.lastError };
	}

	consumeCurrentStateBootstrapRequest(): boolean {
		const requested = this.bootstrapRequested;
		this.bootstrapRequested = false;
		return requested;
	}

	async needsCurrentStateBootstrap(): Promise<boolean> {
		if (!this.account) return false;
		const baseline = await getSyncState<Record<string, string>>(
			syncControlKeys(this.account.accountId).baseline
		).catch(() => undefined);
		return !baseline || Object.keys(baseline).length === 0;
	}

	async committedRevision(): Promise<number | null> {
		if (!this.account) return null;
		const cursor = await getSyncState<number>(syncControlKeys(this.account.accountId).cursor).catch(
			() => undefined
		);
		return Number.isSafeInteger(cursor) && Number(cursor) >= 0 ? Number(cursor) : null;
	}

	async clearAccountControlPlane(accountId: string): Promise<void> {
		const keys = syncControlKeys(accountId);
		await Promise.all([
			deleteSyncState(keys.cursor),
			deleteSyncState(keys.baseline),
			deleteSyncState(keys.recordIds),
			deleteSyncState(keys.migration)
		]);
	}

	/** Adopt a name received from this account's encrypted profile record. */
	private applySyncedProfileName(name: string): void {
		const trimmed = name.trim().slice(0, 60);
		const profile = this.activeProfile;
		if (!profile || !trimmed || profile.name === trimmed) return;
		const updated = { ...profile, name: trimmed };
		this.profiles = this.profiles.map((entry) => (entry.id === profile.id ? updated : entry));
		void saveProfile(updated).catch((err) =>
			console.error('[sync] could not store the synced profile name:', err)
		);
	}

	async logout(): Promise<void> {
		const accountId = this.account?.accountId;
		const profile = this.activeProfile;
		this.account = null;
		this.lastError = null;
		this.progress = null;
		this.usage = null;
		setLastActiveProfileId(null);
		if (accountId) void this.clearAccountControlPlane(accountId);
		if (profile) {
			await removeProfileRecord(profile.id).catch((err) =>
				console.error('[sync] could not remove the signed-out profile:', err)
			);
			this.profiles = this.profiles.filter((entry) => entry.id !== profile.id);
		}
	}

	async deleteCloudAccount(): Promise<{ success: boolean; error?: string }> {
		if (!this.account) return { success: false, error: 'Sync is not set up on this device' };
		try {
			const response = await fetch('/api/sync/account', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					accountId: this.account.accountId,
					authSecret: this.account.authSecret
				})
			});
			if (!response.ok) {
				const data = (await response.json().catch(() => ({}))) as { error?: unknown };
				return {
					success: false,
					error: typeof data.error === 'string' ? data.error : 'Could not delete synced data'
				};
			}
			await this.logout();
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Network error'
			};
		}
	}
}

export const syncStore = new SyncStore();
