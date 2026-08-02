import Database from 'better-sqlite3';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'shard-restore-smoke-'));
const sourcePath = join(root, 'source.sqlite');
const snapshotPath = join(root, 'snapshot.sqlite');
const restoredDirectory = join(root, 'restored');
const restoredPath = join(restoredDirectory, 'sync.sqlite');

try {
	const source = new Database(sourcePath);
	source.pragma('journal_mode = WAL');
	source.exec(`
		CREATE TABLE accounts (
			account_id TEXT PRIMARY KEY,
			credential_hash TEXT NOT NULL
		);
		INSERT INTO accounts(account_id, credential_hash)
		VALUES ('restore-smoke-account', 'restore-smoke-credential');
	`);
	await source.backup(snapshotPath);
	source.close();

	const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
	if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok') {
		throw new Error('Snapshot integrity check failed');
	}
	snapshot.close();

	await mkdir(restoredDirectory);
	await copyFile(snapshotPath, restoredPath);
	const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
	const row = restored.prepare(
		'SELECT credential_hash FROM accounts WHERE account_id = ?'
	).get('restore-smoke-account');
	if (row?.credential_hash !== 'restore-smoke-credential') {
		throw new Error('Restored credentials do not match the snapshot');
	}
	if (restored.pragma('integrity_check', { simple: true }) !== 'ok') {
		throw new Error('Restored database integrity check failed');
	}
	restored.close();
	console.log('SQLite online-backup restore smoke test passed');
} finally {
	await rm(root, { recursive: true, force: true });
}
