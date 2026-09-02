import { createClient, type Client, type Transaction } from '@libsql/client/web';
import { env } from '$env/dynamic/private';

/** Server-side storage split: the relay DB holds account-scoped sync state worth
 * backing up (credentials, ciphertext envelopes); the ops DB holds disposable
 * high-churn operational state (rate limits, auth sessions, pairing rendezvous,
 * wake queue, operator config). */
export type Db = {
	readonly relay: Client;
	readonly ops: Client;
	/** Resolves once both schemas exist; rejects (and retries on next access) while unreachable. */
	readonly ready: Promise<void>;
};

export type DbClients = { relay: Client; ops: Client };

const RELAY_DDL = `
	CREATE TABLE IF NOT EXISTS accounts (
		account_id TEXT PRIMARY KEY,
		credential_hash TEXT NOT NULL,
		next_seq INTEGER NOT NULL DEFAULT 0,
		envelope_count INTEGER NOT NULL DEFAULT 0,
		ciphertext_bytes INTEGER NOT NULL DEFAULT 0,
		wake_revision INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS accounts_last_seen_at ON accounts(last_seen_at);
	CREATE TABLE IF NOT EXISTS envelopes (
		account_id TEXT NOT NULL,
		slot TEXT NOT NULL,
		seq INTEGER NOT NULL,
		id TEXT NOT NULL,
		ciphertext TEXT NOT NULL,
		PRIMARY KEY (account_id, slot),
		UNIQUE (account_id, id),
		FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS envelopes_account_seq
		ON envelopes(account_id, seq);
	CREATE TABLE IF NOT EXISTS account_quotas (
		account_id TEXT PRIMARY KEY,
		max_bytes INTEGER NOT NULL CHECK(max_bytes > 0),
		FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
	);
	CREATE TABLE IF NOT EXISTS deleted_envelopes (
		account_id TEXT NOT NULL,
		slot TEXT NOT NULL,
		id TEXT NOT NULL,
		ciphertext TEXT NOT NULL,
		deleted_at INTEGER NOT NULL,
		PRIMARY KEY (account_id, slot),
		FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS deleted_envelopes_deleted_at
		ON deleted_envelopes(deleted_at);
`;

const OPS_DDL = `
	CREATE TABLE IF NOT EXISTS meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS rate_buckets (
		bucket_key TEXT PRIMARY KEY,
		tokens REAL NOT NULL,
		updated_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL,
		last_allowed INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS rate_buckets_last_seen ON rate_buckets(last_seen_at);
	CREATE TABLE IF NOT EXISTS auth_challenges (
		challenge_id TEXT PRIMARY KEY,
		account_id TEXT NOT NULL,
		challenge TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS auth_challenges_expires ON auth_challenges(expires_at);
	CREATE INDEX IF NOT EXISTS auth_challenges_account ON auth_challenges(account_id);
	CREATE TABLE IF NOT EXISTS auth_sessions (
		token_hash TEXT PRIMARY KEY,
		account_id TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions(expires_at);
	CREATE INDEX IF NOT EXISTS auth_sessions_account ON auth_sessions(account_id);
	CREATE TABLE IF NOT EXISTS pairing_sessions (
		id TEXT PRIMARY KEY,
		code_tag TEXT NOT NULL,
		role TEXT NOT NULL,
		public_key TEXT NOT NULL,
		peer_id TEXT,
		grant_ciphertext TEXT,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS pairing_sessions_code_tag ON pairing_sessions(code_tag);
	CREATE INDEX IF NOT EXISTS pairing_sessions_expires ON pairing_sessions(expires_at);
	CREATE TABLE IF NOT EXISTS reminder_push_devices (
		account_id TEXT NOT NULL,
		device_id TEXT NOT NULL,
		endpoint TEXT NOT NULL UNIQUE,
		p256dh TEXT NOT NULL,
		auth TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (account_id, device_id)
	);
	CREATE INDEX IF NOT EXISTS reminder_push_devices_device
		ON reminder_push_devices(device_id);
	CREATE INDEX IF NOT EXISTS reminder_push_devices_account
		ON reminder_push_devices(account_id);
	CREATE TABLE IF NOT EXISTS reminder_wakes (
		account_id TEXT NOT NULL,
		wake_id TEXT NOT NULL,
		fire_at INTEGER NOT NULL,
		PRIMARY KEY (account_id, wake_id)
	);
	CREATE INDEX IF NOT EXISTS reminder_wakes_due ON reminder_wakes(fire_at);
	CREATE TABLE IF NOT EXISTS reminder_wake_deliveries (
		account_id TEXT NOT NULL,
		device_id TEXT NOT NULL,
		wake_id TEXT NOT NULL,
		claimed_at INTEGER NOT NULL,
		delivered_at INTEGER,
		PRIMARY KEY (account_id, device_id, wake_id)
	);
	CREATE INDEX IF NOT EXISTS reminder_wake_deliveries_account
		ON reminder_wake_deliveries(account_id);
`;

/** Wrap pre-built clients (any libsql transport) with lazy idempotent schema setup. */
export function createDb(clients: DbClients): Db {
	let schema: Promise<void> | undefined;
	return {
		relay: clients.relay,
		ops: clients.ops,
		get ready(): Promise<void> {
			schema ??= (async () => {
				try {
					await clients.relay.executeMultiple(RELAY_DDL);
					await clients.ops.executeMultiple(OPS_DDL);
				} catch (error) {
					schema = undefined;
					throw error;
				}
			})();
			return schema;
		}
	};
}

function dbUrl(value: string | undefined, fallback: string, name: string): string {
	const url = value?.trim() || fallback;
	if (!/^https?:\/\//i.test(url)) {
		throw new Error(`${name} must be an http:// or https:// libSQL/sqld URL`);
	}
	return url;
}

let singleton: Db | undefined;

/** Process/isolate-scoped clients from environment configuration. */
export function getDb(): Db {
	singleton ??= createDb({
		relay: createClient({
			url: dbUrl(
				env.SCRAPSCACHE_RELAY_DB_URL,
				'http://127.0.0.1:8080/relay',
				'SCRAPSCACHE_RELAY_DB_URL'
			),
			authToken: env.SCRAPSCACHE_RELAY_DB_AUTH_TOKEN || undefined
		}),
		ops: createClient({
			url: dbUrl(env.SCRAPSCACHE_OPS_DB_URL, 'http://127.0.0.1:8080/ops', 'SCRAPSCACHE_OPS_DB_URL'),
			authToken: env.SCRAPSCACHE_OPS_DB_AUTH_TOKEN || undefined
		})
	});
	return singleton;
}

export function closeDb(): void {
	singleton?.relay.close();
	singleton?.ops.close();
	singleton = undefined;
}

export async function withTxn<T>(
	client: Client,
	body: (tx: Transaction) => Promise<T>
): Promise<T> {
	const tx = await client.transaction();
	try {
		const result = await body(tx);
		await tx.commit();
		return result;
	} catch (error) {
		await tx.rollback().catch(() => undefined);
		throw error;
	}
}

export async function getMeta(db: Db, key: string): Promise<string | null> {
	await db.ready;
	const result = await db.ops.execute({
		sql: 'SELECT value FROM meta WHERE key = ?',
		args: [key]
	});
	return (result.rows[0] as unknown as { value: string } | undefined)?.value ?? null;
}

export async function setMeta(db: Db, key: string, value: string): Promise<void> {
	await db.ready;
	await db.ops.execute({
		sql: 'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
		args: [key, value]
	});
}
