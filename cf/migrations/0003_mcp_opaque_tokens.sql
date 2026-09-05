CREATE TABLE IF NOT EXISTS mcp_tokens (
	token_hash TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	wrapped_sync_key TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_tokens_account ON mcp_tokens(account_id);
DROP TABLE IF EXISTS mcp_revocations;
