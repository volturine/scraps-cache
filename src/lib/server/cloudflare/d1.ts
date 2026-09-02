import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

export type SqlArgs = readonly (string | number | null | ArrayBuffer)[];
export type SqlStatement = { sql: string; args?: SqlArgs };
export type SqlResult = { rows: Record<string, unknown>[]; rowsAffected: number };

function prepared(db: D1Database, statement: SqlStatement): D1PreparedStatement {
	const query = db.prepare(statement.sql);
	return statement.args?.length ? query.bind(...statement.args) : query;
}

function result(value: D1Result): SqlResult {
	return {
		rows: value.results as Record<string, unknown>[],
		rowsAffected: value.meta.changes ?? 0
	};
}

export async function execute(
	db: D1Database,
	statement: string | SqlStatement
): Promise<SqlResult> {
	return result(
		await prepared(db, typeof statement === 'string' ? { sql: statement } : statement).run()
	);
}

export async function batch(db: D1Database, statements: SqlStatement[]): Promise<SqlResult[]> {
	if (statements.length === 0) return [];
	return (await db.batch(statements.map((statement) => prepared(db, statement)))).map(result);
}
