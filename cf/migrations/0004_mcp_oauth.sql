CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
	code_hash TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	wrapped_sync_key TEXT NOT NULL,
	client_id TEXT NOT NULL,
	redirect_uri TEXT NOT NULL,
	code_challenge TEXT NOT NULL,
	resource TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_oauth_codes_account ON mcp_oauth_codes(account_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_codes_expires ON mcp_oauth_codes(expires_at);
