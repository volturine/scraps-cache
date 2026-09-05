DROP TABLE IF EXISTS mcp_tokens;
CREATE TABLE mcp_tokens (
	token_hash TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	client_id TEXT NOT NULL,
	wrapped_sync_key TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX mcp_tokens_account ON mcp_tokens(account_id);
CREATE UNIQUE INDEX mcp_tokens_account_client ON mcp_tokens(account_id, client_id);
