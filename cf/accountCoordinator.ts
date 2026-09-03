import type { D1Database, DurableObjectState, R2Bucket } from '@cloudflare/workers-types';
import { batch, execute, type SqlStatement } from '../src/lib/server/cloudflare/d1';

type Env = {
	SCRAPSCACHE_DB: D1Database;
	SCRAPSCACHE_ENVELOPES: R2Bucket;
};

type Upload = { id: string; slot: string; ciphertext: string; expectedId?: string | null };
type Deletion = { id: string; slot: string };
type EnvelopeRow = {
	seq: number;
	id: string;
	slot: string;
	r2Key: string;
	ciphertextBytes: number;
};
type SyncInput = {
	accountId: string;
	cursor: number;
	uploads: Upload[];
	deletions: Deletion[];
	downloadLimit: number;
	maxAccountBytes: number;
};

const STORAGE_OVERHEAD_BYTES = 512;
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function accountPrefix(accountId: string): Promise<string> {
	return hex(await crypto.subtle.digest('SHA-256', encoder.encode(accountId)));
}

async function ciphertext(env: Env, row: EnvelopeRow): Promise<string> {
	const object = await env.SCRAPSCACHE_ENVELOPES.get(row.r2Key);
	if (!object) throw new Error('Encrypted envelope object is missing');
	return object.text();
}

async function hydrated(env: Env, rows: EnvelopeRow[]) {
	return Promise.all(
		rows.map(async (row) => ({
			seq: row.seq,
			id: row.id,
			slot: row.slot,
			ciphertext: await ciphertext(env, row)
		}))
	);
}

export class AccountCoordinator {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env
	) {}

	fetch(request: Request): Promise<Response> {
		return this.state.blockConcurrencyWhile(async () => {
			if (request.method !== 'POST') {
				return Response.json({ error: 'Not found' }, { status: 404 });
			}
			const path = new URL(request.url).pathname;
			if (path === '/sync') return this.sync((await request.json()) as SyncInput);
			if (path === '/delete') {
				return this.deleteAccount(
					String(((await request.json()) as { accountId?: unknown }).accountId)
				);
			}
			return Response.json({ error: 'Not found' }, { status: 404 });
		});
	}

	private async deleteAccount(accountId: string): Promise<Response> {
		const keys = (
			await execute(this.env.SCRAPSCACHE_DB, {
				sql: `SELECT r2_key AS r2Key FROM envelopes WHERE account_id = ?
					UNION SELECT r2_key FROM deleted_envelopes WHERE account_id = ?
					UNION SELECT r2_key FROM pending_envelopes WHERE account_id = ?`,
				args: [accountId, accountId, accountId]
			})
		).rows.map(({ r2Key }) => String(r2Key));
		const results = await batch(this.env.SCRAPSCACHE_DB, [
			{ sql: 'DELETE FROM accounts WHERE account_id = ?', args: [accountId] },
			{ sql: 'DELETE FROM pending_envelopes WHERE account_id = ?', args: [accountId] },
			{ sql: 'DELETE FROM reminder_push_devices WHERE account_id = ?', args: [accountId] },
			{ sql: 'DELETE FROM reminder_wakes WHERE account_id = ?', args: [accountId] },
			{ sql: 'DELETE FROM reminder_wake_revisions WHERE account_id = ?', args: [accountId] },
			{ sql: 'DELETE FROM reminder_wake_deliveries WHERE account_id = ?', args: [accountId] }
		]);
		await Promise.all(keys.map((key) => this.env.SCRAPSCACHE_ENVELOPES.delete(key)));
		return Response.json({ deleted: results[0]?.rowsAffected === 1 });
	}

	private async sync(input: SyncInput): Promise<Response> {
		const { SCRAPSCACHE_DB: db } = this.env;
		const account = (
			await execute(db, {
				sql: `SELECT next_seq AS nextSeq, envelope_count AS envelopeCount,
					ciphertext_bytes AS ciphertextBytes
				 FROM accounts WHERE account_id = ?`,
				args: [input.accountId]
			})
		).rows[0] as { nextSeq: number; envelopeCount: number; ciphertextBytes: number } | undefined;
		if (!account) return Response.json({ error: 'Sync account does not exist' }, { status: 404 });

		const quota = (
			await execute(db, {
				sql: 'SELECT max_bytes AS maxBytes FROM account_quotas WHERE account_id = ?',
				args: [input.accountId]
			})
		).rows[0] as { maxBytes: number } | undefined;
		const maxBytes = quota?.maxBytes ?? input.maxAccountBytes;
		let envelopeCount = account.envelopeCount;
		let ciphertextBytes = account.ciphertextBytes;
		const storageBytes = (activeCount = envelopeCount, activeBytes = ciphertextBytes) =>
			activeBytes + activeCount * STORAGE_OVERHEAD_BYTES;
		const usage = () => ({
			envelopeCount,
			ciphertextBytes,
			storageBytes: storageBytes(),
			maxBytes
		});
		const now = Date.now();

		if (input.cursor > account.nextSeq) {
			await execute(db, {
				sql: 'UPDATE accounts SET last_seen_at = ? WHERE account_id = ?',
				args: [now, input.accountId]
			});
			return Response.json({
				cursor: 0,
				envelopes: [],
				conflicts: [],
				hasMore: false,
				reset: true,
				writesAccepted: false,
				usage: usage()
			});
		}

		const page = (
			await execute(db, {
				sql: `SELECT seq, id, slot, r2_key AS r2Key, ciphertext_bytes AS ciphertextBytes
				 FROM envelopes WHERE account_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
				args: [input.accountId, input.cursor, input.downloadLimit + 1]
			})
		).rows as EnvelopeRow[];
		const hasMore = page.length > input.downloadLimit;
		const remote = hasMore ? page.slice(0, input.downloadLimit) : page;
		if (remote.length > 0) {
			await execute(db, {
				sql: 'UPDATE accounts SET last_seen_at = ? WHERE account_id = ?',
				args: [now, input.accountId]
			});
			return Response.json({
				cursor: remote.at(-1)?.seq ?? input.cursor,
				envelopes: await hydrated(this.env, remote),
				conflicts: [],
				hasMore,
				reset: false,
				writesAccepted: input.uploads.length === 0 && input.deletions.length === 0,
				usage: usage()
			});
		}

		const slots = [...new Set([...input.uploads, ...input.deletions].map(({ slot }) => slot))];
		const currentRows = slots.length
			? ((
					await execute(db, {
						sql: `SELECT seq, id, slot, r2_key AS r2Key, ciphertext_bytes AS ciphertextBytes
						 FROM envelopes WHERE account_id = ? AND slot IN (${slots.map(() => '?').join(', ')})`,
						args: [input.accountId, ...slots]
					})
				).rows as EnvelopeRow[])
			: [];
		const currentBySlot = new Map(currentRows.map((row) => [row.slot, row]));
		const conflicts = input.uploads
			.map((upload) => ({ upload, current: currentBySlot.get(upload.slot) }))
			.filter(
				(value): value is { upload: Upload; current: EnvelopeRow } =>
					!!value.current &&
					value.current.id !== value.upload.id &&
					value.current.id !== (value.upload.expectedId ?? null)
			)
			.map(({ current }) => current);
		if (conflicts.length > 0) {
			await execute(db, {
				sql: 'UPDATE accounts SET last_seen_at = ? WHERE account_id = ?',
				args: [now, input.accountId]
			});
			return Response.json({
				cursor: Math.max(input.cursor, account.nextSeq),
				envelopes: [],
				conflicts: await hydrated(this.env, conflicts),
				hasMore: false,
				reset: false,
				writesAccepted: false,
				usage: usage()
			});
		}

		const knownIds = input.uploads.length
			? new Set(
					(
						await execute(db, {
							sql: `SELECT id FROM envelopes WHERE account_id = ? AND id IN (${input.uploads
								.map(() => '?')
								.join(', ')})`,
							args: [input.accountId, ...input.uploads.map(({ id }) => id)]
						})
					).rows.map(({ id }) => String(id))
				)
			: new Set<string>();
		const acceptedUploads = input.uploads.filter(({ id }) => {
			if (knownIds.has(id)) return false;
			knownIds.add(id);
			return true;
		});
		const prefix = await accountPrefix(input.accountId);
		const objectKeys = new Map(
			acceptedUploads.map(({ id }) => [id, `v1/${prefix}/${crypto.randomUUID()}`] as const)
		);
		if (acceptedUploads.length > 0) {
			await batch(
				db,
				acceptedUploads.map(({ id }) => ({
					sql: `INSERT OR REPLACE INTO pending_envelopes(account_id, id, r2_key, created_at)
						VALUES (?, ?, ?, ?)`,
					args: [input.accountId, id, objectKeys.get(id)!, now]
				}))
			);
			await Promise.all(
				acceptedUploads.map((upload) =>
					this.env.SCRAPSCACHE_ENVELOPES.put(objectKeys.get(upload.id)!, upload.ciphertext)
				)
			);
		}

		const statements: SqlStatement[] = [];
		const obsoleteObjects: string[] = [];
		for (const deletion of input.deletions) {
			const removed = currentBySlot.get(deletion.slot);
			if (!removed || removed.id !== deletion.id) continue;
			statements.push(
				{
					sql: `INSERT OR REPLACE INTO deleted_envelopes(
						account_id, slot, id, r2_key, ciphertext_bytes, deleted_at
					) VALUES (?, ?, ?, ?, ?, ?)`,
					args: [
						input.accountId,
						removed.slot,
						removed.id,
						removed.r2Key,
						removed.ciphertextBytes,
						now
					]
				},
				{
					sql: 'DELETE FROM envelopes WHERE account_id = ? AND slot = ? AND id = ?',
					args: [input.accountId, removed.slot, removed.id]
				}
			);
			envelopeCount -= 1;
			ciphertextBytes -= removed.ciphertextBytes;
			currentBySlot.delete(deletion.slot);
		}

		let sequence = account.nextSeq;
		for (const upload of acceptedUploads) {
			const prior = currentBySlot.get(upload.slot);
			const projectedCount = envelopeCount + (prior ? 0 : 1);
			const projectedBytes =
				ciphertextBytes + upload.ciphertext.length - (prior?.ciphertextBytes ?? 0);
			const projectedStorage = storageBytes(projectedCount, projectedBytes);
			if (projectedStorage > maxBytes && projectedStorage >= storageBytes()) {
				await batch(
					db,
					acceptedUploads.map(({ id }) => ({
						sql: 'DELETE FROM pending_envelopes WHERE account_id = ? AND id = ?',
						args: [input.accountId, id]
					}))
				);
				await Promise.all(
					acceptedUploads.map(({ id }) =>
						this.env.SCRAPSCACHE_ENVELOPES.delete(objectKeys.get(id)!)
					)
				);
				return Response.json({ error: 'quota' }, { status: 507 });
			}
			sequence += 1;
			statements.push({
				sql: `INSERT INTO envelopes(account_id, slot, seq, id, r2_key, ciphertext_bytes)
					VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(account_id, slot) DO UPDATE SET
						seq = excluded.seq, id = excluded.id,
						r2_key = excluded.r2_key, ciphertext_bytes = excluded.ciphertext_bytes`,
				args: [
					input.accountId,
					upload.slot,
					sequence,
					upload.id,
					objectKeys.get(upload.id)!,
					upload.ciphertext.length
				]
			});
			statements.push({
				sql: 'DELETE FROM pending_envelopes WHERE account_id = ? AND id = ?',
				args: [input.accountId, upload.id]
			});
			if (prior && prior.r2Key !== objectKeys.get(upload.id)) obsoleteObjects.push(prior.r2Key);
			envelopeCount = projectedCount;
			ciphertextBytes = projectedBytes;
			currentBySlot.set(upload.slot, {
				seq: sequence,
				id: upload.id,
				slot: upload.slot,
				r2Key: objectKeys.get(upload.id)!,
				ciphertextBytes: upload.ciphertext.length
			});
		}
		statements.push({
			sql: `UPDATE accounts SET next_seq = ?, envelope_count = ?, ciphertext_bytes = ?,
				updated_at = ?, last_seen_at = ? WHERE account_id = ?`,
			args: [sequence, envelopeCount, ciphertextBytes, now, now, input.accountId]
		});
		await batch(db, statements);
		await Promise.all(obsoleteObjects.map((key) => this.env.SCRAPSCACHE_ENVELOPES.delete(key)));

		return Response.json({
			cursor: Math.max(input.cursor, sequence),
			envelopes: [],
			conflicts: [],
			hasMore: false,
			reset: false,
			writesAccepted: true,
			usage: usage()
		});
	}
}
