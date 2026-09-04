import type { DurableObjectState } from '@cloudflare/workers-types';
import type { CloudflareBindings } from '../src/lib/server/cloudflare/env';
import { batch, execute } from '../src/lib/server/cloudflare/d1';
import {
	MAX_SYNC_MUTATIONS_PER_REQUEST,
	type SyncEnvelopeUpload,
	type SyncEnvelopeDeletion,
	type SyncResult
} from '../src/lib/server/syncStore';

type SyncInput = {
	accountId: string;
	cursor: number;
	uploads: SyncEnvelopeUpload[];
	deletions: SyncEnvelopeDeletion[];
	downloadLimit?: number;
};

type EnvelopeRow = {
	slot: string;
	seq: number;
	id: string;
	ciphertext: string;
	r2_key: string;
};

type QuotaRow = {
	max_bytes: number | null;
};

const DEFAULT_MAX_ACCOUNT_BYTES = 50 * 1024 * 1024;
const DEFAULT_DOWNLOAD_LIMIT = 500;
const MAX_DOWNLOAD_LIMIT = 2_000;

export class AccountCoordinator {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: CloudflareBindings
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'POST' && url.pathname === '/sync') {
			const body = (await request.json()) as SyncInput;
			return this.sync(body);
		}
		if (request.method === 'POST' && url.pathname === '/delete-account') {
			const { accountId } = (await request.json()) as { accountId: string };
			return this.deleteAccount(accountId);
		}
		if (request.method === 'POST' && url.pathname === '/check-quota') {
			const { accountId, additionalBytes } = (await request.json()) as {
				accountId: string;
				additionalBytes: number;
			};
			return this.checkQuota(accountId, additionalBytes);
		}
		return new Response('Not found', { status: 404 });
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
			{ sql: 'DELETE FROM reminder_wake_deliveries WHERE account_id = ?', args: [accountId] },
			{ sql: 'DELETE FROM mcp_revocations WHERE account_id = ?', args: [accountId] }
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

		if (!account) {
			return Response.json({ error: 'Account not found' }, { status: 404 });
		}

		let { nextSeq, envelopeCount, ciphertextBytes } = account;
		const now = Date.now();
		const stagingKeys: string[] = [];

		try {
			if (input.uploads.length + input.deletions.length > MAX_SYNC_MUTATIONS_PER_REQUEST) {
				return Response.json(
					{ error: `Mutation batch exceeds limit of ${MAX_SYNC_MUTATIONS_PER_REQUEST}` },
					{ status: 400 }
				);
			}

			// Pre-flight quota check for uploads
			let uploadBytesDelta = 0;
			for (const u of input.uploads) {
				uploadBytesDelta += new TextEncoder().encode(u.ciphertext).byteLength;
			}
			const quotaLimit = await this.resolveMaxBytes(input.accountId);
			if (ciphertextBytes + uploadBytesDelta > quotaLimit) {
				return Response.json(
					{ error: `Storage quota exceeded (${quotaLimit} bytes limit)` },
					{ status: 413 }
				);
			}

			// Stage new uploads into R2 under pending/ prefix
			const stagedUploads: Array<SyncEnvelopeUpload & { r2Key: string; byteLength: number }> = [];
			for (const u of input.uploads) {
				const byteLength = new TextEncoder().encode(u.ciphertext).byteLength;
				const r2Key = `accounts/${input.accountId}/envelopes/${u.slot}/${u.id}`;
				stagingKeys.push(r2Key);
				await this.env.SCRAPSCACHE_ENVELOPES.put(r2Key, u.ciphertext, {
					customMetadata: { accountId: input.accountId, slot: u.slot, id: u.id }
				});
				stagedUploads.push({ ...u, r2Key, byteLength });
			}

			// Atomic metadata update in D1
			const d1Statements: Array<{ sql: string; args: unknown[] }> = [];

			for (const u of stagedUploads) {
				const seq = nextSeq++;
				// Slot-conflict: find existing envelope if any
				const existing = (
					await execute(db, {
						sql: 'SELECT id, ciphertext_bytes AS bytes FROM envelopes WHERE account_id = ? AND slot = ?',
						args: [input.accountId, u.slot]
					})
				).rows[0] as { id: string; bytes: number } | undefined;

				if (existing) {
					if (u.expectedId !== null && existing.id !== u.expectedId) {
						// Conflict: abort and discard staged objects
						await Promise.all(stagingKeys.map((k) => this.env.SCRAPSCACHE_ENVELOPES.delete(k)));
						return Response.json(
							{
								error: `Slot conflict on ${u.slot}: expected ${u.expectedId}, found ${existing.id}`
							},
							{ status: 409 }
						);
					}
					ciphertextBytes -= existing.bytes;
					envelopeCount -= 1;
				}

				ciphertextBytes += u.byteLength;
				envelopeCount += 1;

				d1Statements.push({
					sql: `INSERT INTO envelopes (account_id, slot, seq, id, r2_key, ciphertext_bytes, created_at)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(account_id, slot) DO UPDATE SET
							seq = excluded.seq,
							id = excluded.id,
							r2_key = excluded.r2_key,
							ciphertext_bytes = excluded.ciphertext_bytes,
							created_at = excluded.created_at`,
					args: [input.accountId, u.slot, seq, u.id, u.r2Key, u.byteLength, now]
				});
			}

			for (const d of input.deletions) {
				const existing = (
					await execute(db, {
						sql: 'SELECT id, r2_key AS r2Key, ciphertext_bytes AS bytes FROM envelopes WHERE account_id = ? AND slot = ?',
						args: [input.accountId, d.slot]
					})
				).rows[0] as { id: string; r2Key: string; bytes: number } | undefined;

				if (existing && (d.expectedId === null || existing.id === d.expectedId)) {
					ciphertextBytes -= existing.bytes;
					envelopeCount -= 1;
					d1Statements.push({
						sql: 'DELETE FROM envelopes WHERE account_id = ? AND slot = ?',
						args: [input.accountId, d.slot]
					});
					d1Statements.push({
						sql: `INSERT INTO deleted_envelopes (account_id, slot, id, r2_key, deleted_at)
							VALUES (?, ?, ?, ?, ?)`,
						args: [input.accountId, d.slot, existing.id, existing.r2Key, now]
					});
				}
			}

			d1Statements.push({
				sql: `UPDATE accounts SET
					next_seq = ?, envelope_count = ?, ciphertext_bytes = ?,
					updated_at = ?, last_seen_at = ?
					WHERE account_id = ?`,
				args: [nextSeq, envelopeCount, ciphertextBytes, now, now, input.accountId]
			});

			await batch(db, d1Statements);

			// Download delta
			const downloadLimit = Math.min(
				input.downloadLimit ?? DEFAULT_DOWNLOAD_LIMIT,
				MAX_DOWNLOAD_LIMIT
			);
			const envelopeRows = (
				await execute(db, {
					sql: `SELECT slot, seq, id, r2_key
						FROM envelopes
						WHERE account_id = ? AND seq > ?
						ORDER BY seq ASC LIMIT ?`,
					args: [input.accountId, input.cursor, downloadLimit + 1]
				})
			).rows as unknown as Array<{ slot: string; seq: number; id: string; r2_key: string }>;

			const hasMore = envelopeRows.length > downloadLimit;
			const deltaRows = hasMore ? envelopeRows.slice(0, downloadLimit) : envelopeRows;

			// Fetch ciphertexts from R2 in parallel
			const envelopes = await Promise.all(
				deltaRows.map(async (row) => {
					const obj = await this.env.SCRAPSCACHE_ENVELOPES.get(row.r2_key);
					const ciphertext = obj ? await obj.text() : '';
					return { slot: row.slot, seq: row.seq, id: row.id, ciphertext };
				})
			);

			const result: SyncResult = {
				envelopes,
				nextCursor: nextSeq,
				hasMore,
				usage: {
					storageBytes: ciphertextBytes,
					maxBytes: quotaLimit,
					envelopeCount
				}
			};

			return Response.json(result);
		} catch (err) {
			await Promise.all(stagingKeys.map((k) => this.env.SCRAPSCACHE_ENVELOPES.delete(k)));
			throw err;
		}
	}

	private async resolveMaxBytes(accountId: string): Promise<number> {
		const row = (
			await execute(this.env.SCRAPSCACHE_DB, {
				sql: 'SELECT max_bytes FROM account_quotas WHERE account_id = ?',
				args: [accountId]
			})
		).rows[0] as QuotaRow | undefined;

		if (row && typeof row.max_bytes === 'number' && row.max_bytes > 0) {
			return row.max_bytes;
		}

		const envLimit = Number(this.env.SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES);
		return Number.isFinite(envLimit) && envLimit > 0 ? envLimit : DEFAULT_MAX_ACCOUNT_BYTES;
	}

	private async checkQuota(accountId: string, additionalBytes: number): Promise<Response> {
		const account = (
			await execute(this.env.SCRAPSCACHE_DB, {
				sql: 'SELECT ciphertext_bytes AS bytes FROM accounts WHERE account_id = ?',
				args: [accountId]
			})
		).rows[0] as { bytes: number } | undefined;

		const current = account?.bytes ?? 0;
		const max = await this.resolveMaxBytes(accountId);
		const allowed = current + additionalBytes <= max;
		return Response.json({ allowed, currentBytes: current, maxBytes: max });
	}
}
