// Client-side account, sync status, and real transfer progress for full-size photo backups.

import type { KanbanBoard } from '$lib/kanban';
import type { Label, Note, NoteImage } from '$lib/types';
import { mergeKanbanBoards } from '$lib/kanban';
import { mergeLabelLists, mergeNoteLists } from '$lib/noteMerge';
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
	clearSyncOutbox,
	getSyncOutboxKeys,
	getSyncState,
	markSyncOutbox,
	setSyncState
} from '$lib/db/idb';

const LS_SYNC_KEY = 'gkc-sync-account';
const LS_SYNC_STATUS_KEY = 'gkc-sync-status';

export interface SyncAccount {
	syncKey: string;
	accountId: string;
	authSecret: string;
	pairingCode: string;
}

export type StartedDeviceLink = { id: string; expiresAt: number; role: 'existing' | 'new'; syncCode: string; pake: { ephemeralSecret: string; share: string } };
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
};

function mergeTombstoneMaps(local: Record<string, number>, remote: unknown): Record<string, number> {
	if (!remote || typeof remote !== 'object') return local;
	const merged = { ...local };
	for (const [id, timestamp] of Object.entries(remote as Record<string, unknown>)) {
		const value = Number(timestamp) || 0;
		if (value > (merged[id] || 0)) merged[id] = value;
	}
	return merged;
}

class SyncStore {
	account = $state<SyncAccount | null>(null);
	lastSync = $state(0);
	lastError = $state<string | null>(null);
	progress = $state<SyncProgress | null>(null);
	usage = $state<SyncUsage | null>(null);
	private bootstrapRequested = false;

	// Non-reactive callbacks avoid re-rendering the note grid for cloud feedback.
	onSyncStart: (() => void) | null = null;
	onSyncEnd: (() => void) | null = null;
	/** Registered by the central data store so board edits share its debounced sync. */
	onLocalDataChange: (() => void) | null = null;

	constructor() {
		if (typeof localStorage === 'undefined') return;
		try {
			const rawAccount = localStorage.getItem(LS_SYNC_KEY);
			if (rawAccount) {
				const parsed: unknown = JSON.parse(rawAccount);
				if (isSyncAccount(parsed)) this.account = identityFromSyncKey(parsed.syncKey);
				else localStorage.removeItem(LS_SYNC_KEY);
			}
			const rawStatus = localStorage.getItem(LS_SYNC_STATUS_KEY);
			if (rawStatus) this.lastSync = Number((JSON.parse(rawStatus) as SyncStatus).lastSync) || 0;
		} catch (err) {
			console.error('[sync] could not restore local status:', err);
		}
	}

	get isLoggedIn(): boolean {
		return this.account !== null;
	}

	requestAutoSync(keys: Iterable<string> = []): void {
		void markSyncOutbox(keys).catch((err) => console.error('[sync] could not persist outbox:', err));
		this.onLocalDataChange?.();
	}

	private saveAccount(): void {
		if (typeof localStorage === 'undefined') return;
		try {
			if (this.account) localStorage.setItem(LS_SYNC_KEY, JSON.stringify(this.account));
			else localStorage.removeItem(LS_SYNC_KEY);
		} catch (err) {
			console.error('[sync] could not save account:', err);
		}
	}

	private saveStatus(): void {
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(LS_SYNC_STATUS_KEY, JSON.stringify({ lastSync: this.lastSync }));
		} catch (err) {
			console.error('[sync] could not save status:', err);
		}
	}

	async register(): Promise<{ success: boolean; error?: string }> {
		const account = createSyncIdentity();
		try {
			const res = await fetch('/api/sync/register', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ accountId: account.accountId, authSecret: account.authSecret })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) return { success: false, error: typeof data.error === 'string' ? data.error : 'Registration failed' };
			this.account = account;
			this.lastError = null;
			this.saveAccount();
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : 'Network error' };
		}
	}

	async startDeviceLink(input: string): Promise<{ success: boolean; link?: StartedDeviceLink; error?: string }> {
		return this.startRendezvous('new', input);
	}

	async startExistingDeviceLink(): Promise<{ success: boolean; link?: StartedDeviceLink; error?: string }> {
		if (!this.account) return { success: false, error: 'Sync is not set up on this device' };
		return this.startRendezvous('existing', this.account.pairingCode);
	}

	private async startRendezvous(role: 'existing' | 'new', input: string): Promise<{ success: boolean; link?: StartedDeviceLink; error?: string }> {
		try {
			const requestKey = createPairingRequestKey(input);
			const res = await fetch('/api/sync/pair/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codeTag: pairingCodeTag(input), role, publicKey: requestKey.share }) });
			const data = await res.json().catch(() => ({}));
			if (!res.ok || typeof data.id !== 'string' || typeof data.expiresAt !== 'number') return { success: false, error: typeof data.error === 'string' ? data.error : 'Could not start device rendezvous' };
			return { success: true, link: { id: data.id, expiresAt: data.expiresAt, role, syncCode: input, pake: requestKey } };
		} catch (err) { return { success: false, error: err instanceof Error ? err.message : 'Could not start device rendezvous' }; }
	}

	async pollDeviceLink(link: StartedDeviceLink): Promise<{ success: boolean; linked?: boolean; matched?: boolean; expired?: boolean; error?: string }> {
		try {
			const res = await fetch('/api/sync/pair/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: link.id }) });
			const data = await res.json().catch(() => ({})) as Partial<LinkPoll>;
			if (!res.ok) return { success: false, error: 'Could not check device rendezvous' };
			if (data.state === 'waiting') return { success: true };
			if (data.state === 'expired' || data.state === 'not-found') return { success: true, expired: true };
			if (data.state === 'matched' && typeof data.peerPublicKey === 'string') {
				if (link.role === 'new') return { success: true, matched: true };
				if (!this.account) return { success: false, error: 'Sync is not set up on this device' };
				const grant = sealSyncKeyForPeer(this.account.syncKey, this.account.pairingCode, link.pake, data.peerPublicKey);
				const sent = await fetch('/api/sync/pair/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: link.id, grant }) });
				return sent.ok ? { success: true, linked: true } : { success: false, error: 'Could not deliver encrypted sync key' };
			}
			if (data.state !== 'connected' || !data.grant || typeof data.grant !== 'object') return { success: false, error: 'Invalid device rendezvous response' };
			if (link.role !== 'new') return { success: true, linked: true };
			const grant = data.grant as { existingPublicKey?: unknown; ciphertext?: unknown };
			if (typeof grant.ciphertext !== 'string') return { success: false, error: 'Invalid encrypted sync key' };
			this.account = identityFromSyncKey(openSyncKeyFromPeer(link.syncCode, link.pake, data.peerPublicKey ?? '', { ciphertext: grant.ciphertext })); this.lastError = null; this.saveAccount();
			return { success: true, linked: true };
		} catch (err) { return { success: false, error: err instanceof Error ? err.message : 'Could not complete device rendezvous' }; }
	}

	private sendSyncRequest(path: string, payload: string, uploadBytes: number, indicate: boolean): Promise<SyncResult> {
		return new Promise((resolve) => {
			const xhr = new XMLHttpRequest();
			xhr.open('POST', path);
			// Pairing expires in 60 seconds; photo/data sync must be allowed to finish.
		xhr.timeout = 0;
			xhr.setRequestHeader('Content-Type', 'application/json');

			if (indicate) {
				this.progress = { phase: 'upload', loadedBytes: 0, totalBytes: uploadBytes };
				xhr.upload.onprogress = (event) => {
					this.progress = {
						phase: 'upload', loadedBytes: event.loaded,
						totalBytes: event.lengthComputable ? event.total : uploadBytes
					};
				};
				xhr.upload.onloadend = () => {
					this.progress = { phase: 'download', loadedBytes: 0, totalBytes: null };
				};
				xhr.onprogress = (event) => {
					this.progress = {
						phase: 'download', loadedBytes: event.loaded,
						totalBytes: event.lengthComputable ? event.total : null
					};
				};
			}

			xhr.onload = () => {
				let data: Record<string, unknown> = {};
				try { data = JSON.parse(xhr.responseText || '{}') as Record<string, unknown>; } catch { /* handled below */ }
				if (xhr.status < 200 || xhr.status >= 300) {
					resolve({ success: false, error: typeof data.error === 'string' ? data.error : `Sync request failed (${xhr.status})` });
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

	/** End-to-end encrypted per-record delta log. The server only relays opaque envelopes. */
	async sync(
		notes: Note[], labels: Label[], tombstones: Record<string, number> = {}, labelTombstones: Record<string, number> = {},
		boards: KanbanBoard[] = [], boardTombstones: Record<string, number> = {}, indicate = false
	): Promise<SyncResult> {
		if (!this.account) return { success: false, error: 'Not linked' };
		if (indicate) this.onSyncStart?.();
		try {
			const ATTACHMENT_UPLOAD_BUDGET = 2;
			const DOWNLOAD_LIMIT = 12;
			const MAX_ROUNDS = 40;
			const cursorKey = `gkc-sync-cursor:${this.account.accountId}`;
			const baselineKey = `gkc-sync-record-fingerprints:${this.account.accountId}`;
			const migrationKey = `gkc-sync-slot-migration:${this.account.accountId}`;
			const recordIdsKey = `gkc-sync-record-ids:${this.account.accountId}`;
			const fullReconcileKey = `gkc-sync-full-reconcile:${this.account.accountId}`;
			// Legacy accounts get one compaction pass after their source device has every
			// attachment available. This repacks append-only historical ciphertext once.
			const storedMigration = await getSyncState<boolean>(migrationKey).catch(() => undefined);
			const migratingLegacy = storedMigration == null
				? localStorage.getItem(migrationKey) !== 'done'
				: !storedMigration;

			let baseline: Record<string, string> = {};
			try {
				const durable = await getSyncState<unknown>(baselineKey);
				const stored: unknown = durable ?? JSON.parse(localStorage.getItem(baselineKey) || '{}');
				if (stored && typeof stored === 'object' && !Array.isArray(stored)) baseline = Object.fromEntries(
					Object.entries(stored).filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
				);
			} catch { /* first sync or a malformed local baseline: re-send local records once */ }
			let recordIds = await getSyncState<Record<string, string>>(recordIdsKey).catch(() => undefined) ?? {};
			if (!recordIds || typeof recordIds !== 'object' || Array.isArray(recordIds)) recordIds = {};
			const outboxSnapshotAt = Date.now();
			const outboxKeys = new Set(await getSyncOutboxKeys().catch(() => []));
			const lastFullReconcile = Number(await getSyncState<number>(fullReconcileKey).catch(() => 0)) || 0;
			const fullReconcile = migratingLegacy
				|| Object.keys(baseline).length === 0
				|| Date.now() - lastFullReconcile >= 24 * 60 * 60 * 1000;

			let mergedNotes = notes, mergedLabels = labels, mergedBoards = boards;
			let mergedTombstones = { ...tombstones }, mergedLabelTombstones = { ...labelTombstones }, mergedBoardTombstones = { ...boardTombstones };
			const attachments = new Map<string, NoteImage>();
			for (const note of notes) {
				for (const image of note.images ?? []) {
					if (image.dataUrl?.length) attachments.set(image.id, image);
				}
			}

			let cursor = Number(
				await getSyncState<number>(cursorKey).catch(() => undefined)
					?? localStorage.getItem(cursorKey)
			) || 0;
			let hasMore = true;
			let migrationUploadsComplete = false;
			const acknowledgedOutbox = new Set<string>();
			for (let round = 0; round < MAX_ROUNDS && hasMore; round++) {
				const currentRecords = await buildSyncRecords(
					mergedNotes,
					mergedLabels,
					mergedBoards,
					mergedTombstones,
					mergedLabelTombstones,
					mergedBoardTombstones,
					fullReconcile ? undefined : outboxKeys
				);
				const changed = migratingLegacy
					? currentRecords.filter((record) => baseline[record.key] !== record.fingerprint)
					: changedRecords(currentRecords, baseline);
				const nonAttachments = changed.filter((record) => record.payload.kind !== 'attachment');
				const changedAttachments = changed.filter((record) => record.payload.kind === 'attachment');
				// Photo bytes move in small fractions so initial/device syncs stay interactive.
				const outgoing = [...nonAttachments, ...changedAttachments.slice(0, ATTACHMENT_UPLOAD_BUDGET)];
				const sentRecordKeys = new Set(outgoing.map((record) => record.key));
				const sentIds = new Set<string>();
				const sentRecordIds = new Map<string, string>();
				const outbound = await Promise.all(outgoing.map(async (record: SyncRecord) => {
					const id = randomOpaqueId();
					sentIds.add(id);
					sentRecordIds.set(record.key, id);
					// Keyed, non-reversible slot token: relay can replace old ciphertext but cannot
					// infer whether this is a note, attachment, board, or its plaintext identity.
					const slot = await sha256(`${this.account!.syncKey}\u0000${record.key}`);
					return { id, slot, ciphertext: encryptSyncPayload(this.account!.syncKey, record.payload) };
				}));
				// Determine existence without serializing or hashing the full account.
				const currentKeys = new Set<string>();
				for (const note of mergedNotes) {
					if ((mergedTombstones[note.id] || 0) >= note.updatedAt) continue;
					currentKeys.add(`note:${note.id}`);
					for (const image of note.images ?? []) currentKeys.add(`attachment:${image.id}`);
				}
				for (const label of mergedLabels) {
					if ((mergedLabelTombstones[label.id] || 0) < label.updatedAt) currentKeys.add(`label:${label.id}`);
				}
				for (const board of mergedBoards) {
					if ((mergedBoardTombstones[board.id] || 0) < board.updatedAt) currentKeys.add(`board:${board.id}`);
				}
				for (const id of Object.keys(mergedTombstones)) currentKeys.add(`note-tombstone:${id}`);
				for (const id of Object.keys(mergedLabelTombstones)) currentKeys.add(`label-tombstone:${id}`);
				for (const id of Object.keys(mergedBoardTombstones)) currentKeys.add(`board-tombstone:${id}`);
				const deletableKeys = Object.keys(recordIds).filter((key) => {
					if (currentKeys.has(key)) return false;
					if (key.startsWith('note:')) return !!mergedTombstones[key.slice('note:'.length)];
					if (key.startsWith('label:')) return !!mergedLabelTombstones[key.slice('label:'.length)];
					if (key.startsWith('board:')) return !!mergedBoardTombstones[key.slice('board:'.length)];
					if (key.startsWith('attachment:')) {
						const attachmentId = key.slice('attachment:'.length);
						return !mergedNotes.some((note) =>
							(note.images ?? []).some((image) => image.id === attachmentId)
						);
					}
					return false;
				}).slice(0, 500);
				const deleteSlots = await Promise.all(deletableKeys.map(async (key) => ({
					id: recordIds[key],
					slot: await sha256(`${this.account!.syncKey}\u0000${key}`)
				})));
				const payload = JSON.stringify({
					accountId: this.account.accountId,
					authSecret: this.account.authSecret,
					cursor,
					limit: DOWNLOAD_LIMIT,
					envelopes: outbound,
					deleteSlots
				});
				const response = await this.sendSyncRequest('/api/sync/delta', payload, new Blob([payload]).size, indicate);
				if (!response.success || !response.data) return this.fail(response);
					const remoteUsage = response.data.usage;
					if (remoteUsage && typeof remoteUsage === 'object') {
						const candidate = remoteUsage as Partial<SyncUsage>;
						if ([candidate.ciphertextBytes, candidate.envelopeCount, candidate.maxBytes, candidate.maxEnvelopes]
							.every((value) => typeof value === 'number' && Number.isFinite(value))) {
							this.usage = candidate as SyncUsage;
						}
					}
					for (const key of deletableKeys) delete recordIds[key];
					for (const [key, id] of sentRecordIds) recordIds[key] = id;
					for (const key of sentRecordKeys) acknowledgedOutbox.add(key);
					for (const key of deletableKeys) acknowledgedOutbox.add(key);
					if (response.data.reset === true) {
					// The relay was deliberately reset while this device retained a baseline.
					// Ask the notes store to reload full attachments before its retry.
					this.bootstrapRequested = true;
					baseline = {};
						cursor = 0;
						continue;
				}

				const pendingNotes: Note[] = [];
				const remoteFingerprints: Record<string, string> = {};
				const applyPayload = (record: SyncRecordPayload) => {
					switch (record.kind) {
						case 'attachment':
							attachments.set(record.value.id, attachmentToImage(record.value));
							break;
						case 'note':
							pendingNotes.push(hydrateNoteImages(record.value, attachments));
							break;
						case 'label': mergedLabels = mergeLabelLists(mergedLabels, [record.value]); break;
						case 'board': mergedBoards = mergeKanbanBoards(mergedBoards, [record.value], mergedBoardTombstones); break;
						case 'note-tombstone': mergedTombstones = mergeTombstoneMaps(mergedTombstones, { [record.id]: record.deletedAt }); break;
						case 'label-tombstone': mergedLabelTombstones = mergeTombstoneMaps(mergedLabelTombstones, { [record.id]: record.deletedAt }); break;
						case 'board-tombstone': mergedBoardTombstones = mergeTombstoneMaps(mergedBoardTombstones, { [record.id]: record.deletedAt }); break;
					}
				};
				const envelopes = Array.isArray(response.data.envelopes) ? response.data.envelopes : [];
				for (const envelope of envelopes) {
					if (!envelope || typeof envelope !== 'object') throw new Error('Invalid encrypted sync envelope');
					const id = typeof (envelope as { id?: unknown }).id === 'string' ? (envelope as { id: string }).id : '';
					if (id && sentIds.has(id)) continue;
					if (typeof (envelope as { ciphertext?: unknown }).ciphertext !== 'string') throw new Error('Invalid encrypted sync envelope');
					const remote = decryptSyncPayload(this.account.syncKey, (envelope as { ciphertext: string }).ciphertext);
					const decodedRecords = isSyncRecordPayload(remote) ? [remote] : await legacySnapshotPayloads(remote);
					if (!decodedRecords) throw new Error('Invalid encrypted sync record');
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
						acknowledgedOutbox.add(key);
					}
				}
				if (pendingNotes.length) {
					mergedNotes = mergeNoteLists(mergedNotes, pendingNotes.map((note) => hydrateNoteImages(note, attachments)));
				}
				mergedNotes = mergedNotes.map((note) => hydrateNoteImages(note, attachments));

					if (typeof response.data.cursor === 'number') {
						cursor = response.data.cursor;
					}

				// Advance baseline only for records actually uploaded this round, plus merged state for non-attachments.
				const nextBaseline = { ...baseline };
				for (const record of currentRecords) {
					if (record.payload.kind === 'attachment' && !sentRecordKeys.has(record.key)) continue;
					nextBaseline[record.key] = record.fingerprint;
				}
				for (const [key, fingerprint] of Object.entries(remoteFingerprints)) {
					nextBaseline[key] = fingerprint;
				}
				// Preserve attachment baselines while full bytes are not in memory (thumb-only local state).
				for (const [key, fingerprint] of Object.entries(baseline)) {
					if (!key.startsWith('attachment:')) continue;
					const attachmentId = key.slice('attachment:'.length);
					const stillReferenced = mergedNotes.some((note) => (note.images ?? []).some((image) => image.id === attachmentId));
					if (stillReferenced && !(key in nextBaseline)) nextBaseline[key] = fingerprint;
				}
				for (const key of Object.keys(nextBaseline)) {
					if (key.startsWith('attachment:')) {
						const attachmentId = key.slice('attachment:'.length);
						const stillReferenced = mergedNotes.some((note) => (note.images ?? []).some((image) => image.id === attachmentId));
						if (!stillReferenced) delete nextBaseline[key];
						continue;
					}
					if (!currentKeys.has(key) && !sentRecordKeys.has(key)) delete nextBaseline[key];
					}
					baseline = nextBaseline;

					const remainingUploads = changedAttachments.length > ATTACHMENT_UPLOAD_BUDGET;
					if (migratingLegacy && !remainingUploads && changed.length === 0) {
						migrationUploadsComplete = true;
					}
				// Bootstrap writes every current slotted record once; subsequent syncs remain incremental.
					hasMore = response.data.hasMore === true || remainingUploads || (migratingLegacy && !migrationUploadsComplete);
				}

				if (hasMore) {
					return this.fail({ success: false, error: 'Encrypted sync needs another pass' });
				}
				// Commit progress only with the fully merged result. A failed later page must
				// be retried from the last cursor whose data the notes store already applied.
				await Promise.all([
					setSyncState(cursorKey, cursor),
					setSyncState(baselineKey, baseline),
					setSyncState(recordIdsKey, recordIds),
					clearSyncOutbox(acknowledgedOutbox, outboxSnapshotAt),
					...(fullReconcile ? [setSyncState(fullReconcileKey, Date.now())] : []),
					...(migratingLegacy && migrationUploadsComplete
						? [setSyncState(migrationKey, true)]
						: [])
				]);
				localStorage.removeItem(cursorKey);
				localStorage.removeItem(baselineKey);
				if (migratingLegacy && migrationUploadsComplete) localStorage.removeItem(migrationKey);
				this.lastSync = Date.now(); this.lastError = null; this.saveStatus();
			return { success: true, notes: mergedNotes, labels: mergedLabels, boards: mergedBoards, tombstones: mergedTombstones, labelTombstones: mergedLabelTombstones, boardTombstones: mergedBoardTombstones };
		} catch (err) { return this.fail({ success: false, error: err instanceof Error ? `Encrypted sync failed: ${err.message}` : 'Encrypted sync failed' }); }
		finally { if (indicate) this.progress = null; if (indicate) this.onSyncEnd?.(); }
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
		if (!this.account || typeof localStorage === 'undefined') return false;
		const key = `gkc-sync-slot-migration:${this.account.accountId}`;
		const durable = await getSyncState<boolean>(key).catch(() => undefined);
		return durable == null ? localStorage.getItem(key) !== 'done' : !durable;
	}

	logout(): void {
		this.account = null;
		this.lastError = null;
		this.progress = null;
		this.usage = null;
		this.saveAccount();
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
				const data = await response.json().catch(() => ({})) as { error?: unknown };
				return {
					success: false,
					error: typeof data.error === 'string' ? data.error : 'Could not delete synced data'
				};
			}
			this.logout();
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Network error'
			};
		}
	}

	/** Restore client sync identity from a full device backup. */
	restoreFromBackup(sync: null | { syncKey: string; lastSync?: number }): void {
		if (!sync?.syncKey) {
			this.logout();
			return;
		}
		try {
			this.account = identityFromSyncKey(sync.syncKey);
			this.lastSync = Number(sync.lastSync) || 0;
			this.lastError = null;
			this.saveAccount();
			this.saveStatus();
		} catch {
			this.logout();
		}
	}
}

export const syncStore = new SyncStore();
