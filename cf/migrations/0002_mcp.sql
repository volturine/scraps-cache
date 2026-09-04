CREATE TABLE IF NOT EXISTS mcp_revocations (
	account_id TEXT PRIMARY KEY,
	revoked_before INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_revocations_account ON mcp_revocations(account_id);
