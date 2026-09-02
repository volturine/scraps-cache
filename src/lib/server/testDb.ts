import { createClient, type Client } from '@libsql/client/node';
import { createDb, type Db } from './db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanups: (() => void)[] = [];

export function testDb(): Db {
	const dir = mkdtempSync(join(tmpdir(), 'scraps-test-'));
	cleanups.push(() => rmSync(dir, { recursive: true }));
	const relay = createClient({ url: 'file:' + join(dir, 'relay.db') });
	const ops = createClient({ url: 'file:' + join(dir, 'ops.db') });
	return createDb({ relay, ops });
}

export function cleanupTestDbs(): void {
	while (cleanups.length > 0) {
		cleanups.pop()!();
	}
}
