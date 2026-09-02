import { cloudflareBindings } from './env';
import { batch, execute, type SqlStatement } from './d1';

export type DbClient = {
	execute(statement: string | SqlStatement): ReturnType<typeof execute>;
	batch(statements: SqlStatement[], mode?: 'read' | 'write'): ReturnType<typeof batch>;
};

export type Db = {
	readonly relay: DbClient;
	readonly ops: DbClient;
	readonly ready: Promise<void>;
};

function client(): DbClient {
	return {
		execute: (statement) => execute(cloudflareBindings().SCRAPSCACHE_DB, statement),
		batch: (statements) => batch(cloudflareBindings().SCRAPSCACHE_DB, statements)
	};
}

let singleton: Db | undefined;

export function getDb(): Db {
	if (!singleton) {
		const shared = client();
		singleton = {
			relay: shared,
			ops: shared,
			ready: shared.execute('SELECT 1').then(() => undefined)
		};
	}
	return singleton;
}

export function closeDb(): void {
	singleton = undefined;
}

export async function getMeta(db: Db, key: string): Promise<string | null> {
	await db.ready;
	const row = (await db.ops.execute({ sql: 'SELECT value FROM meta WHERE key = ?', args: [key] }))
		.rows[0] as { value?: string } | undefined;
	return row?.value ?? null;
}

export async function setMeta(db: Db, key: string, value: string): Promise<void> {
	await db.ready;
	await db.ops.execute({
		sql: `INSERT INTO meta(key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		args: [key, value]
	});
}

export async function setMetaIfAbsent(db: Db, key: string, value: string): Promise<string> {
	await db.ready;
	const row = (
		await db.ops.execute({
			sql: `INSERT INTO meta(key, value) VALUES (?, ?)
				ON CONFLICT(key) DO UPDATE SET value = meta.value
				RETURNING value`,
			args: [key, value]
		})
	).rows[0] as { value: string };
	return row.value;
}
