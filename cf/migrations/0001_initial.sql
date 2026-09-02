CREATE TABLE accounts (
	account_id TEXT PRIMARY KEY,
	credential_hash TEXT NOT NULL,
	next_seq INTEGER NOT NULL DEFAULT 0,
	envelope_count INTEGER NOT NULL DEFAULT 0,
	ciphertext_bytes INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL
);
CREATE INDEX accounts_last_seen_at ON accounts(last_seen_at);

CREATE TABLE envelopes (
	account_id TEXT NOT NULL,
	slot TEXT NOT NULL,
	seq INTEGER NOT NULL,
	id TEXT NOT NULL,
	r2_key TEXT NOT NULL,
	ciphertext_bytes INTEGER NOT NULL,
	PRIMARY KEY (account_id, slot),
	UNIQUE (account_id, id),
	FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX envelopes_account_seq ON envelopes(account_id, seq);

CREATE TABLE deleted_envelopes (
	account_id TEXT NOT NULL,
	slot TEXT NOT NULL,
	id TEXT NOT NULL,
	r2_key TEXT NOT NULL,
	ciphertext_bytes INTEGER NOT NULL,
	deleted_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, slot),
	FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX deleted_envelopes_deleted_at ON deleted_envelopes(deleted_at);

CREATE TABLE pending_envelopes (
	account_id TEXT NOT NULL,
	id TEXT NOT NULL,
	r2_key TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, id)
);
CREATE INDEX pending_envelopes_created_at ON pending_envelopes(created_at);

CREATE TABLE account_quotas (
	account_id TEXT PRIMARY KEY,
	max_bytes INTEGER NOT NULL CHECK(max_bytes > 0),
	FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE rate_buckets (
	bucket_key TEXT PRIMARY KEY,
	tokens REAL NOT NULL,
	updated_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	last_allowed INTEGER NOT NULL
);
CREATE INDEX rate_buckets_last_seen ON rate_buckets(last_seen_at);

CREATE TABLE auth_challenges (
	challenge_id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	challenge TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX auth_challenges_expires ON auth_challenges(expires_at);
CREATE INDEX auth_challenges_account ON auth_challenges(account_id);

CREATE TABLE auth_sessions (
	token_hash TEXT PRIMARY KEY,
	account_id TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX auth_sessions_account ON auth_sessions(account_id);

CREATE TABLE pairing_sessions (
	id TEXT PRIMARY KEY,
	code_tag TEXT NOT NULL,
	role TEXT NOT NULL,
	public_key TEXT NOT NULL,
	peer_id TEXT,
	grant_ciphertext TEXT,
	expires_at INTEGER NOT NULL
);
CREATE INDEX pairing_sessions_code_tag ON pairing_sessions(code_tag);
CREATE INDEX pairing_sessions_expires ON pairing_sessions(expires_at);
CREATE TRIGGER pair_participants
AFTER UPDATE OF peer_id ON pairing_sessions
WHEN OLD.peer_id IS NULL AND NEW.peer_id IS NOT NULL
BEGIN
	UPDATE pairing_sessions SET peer_id = NEW.id WHERE id = NEW.peer_id AND peer_id IS NULL;
END;

CREATE TABLE reminder_push_devices (
	account_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	endpoint TEXT NOT NULL UNIQUE,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, device_id)
);
CREATE INDEX reminder_push_devices_device ON reminder_push_devices(device_id);
CREATE INDEX reminder_push_devices_account ON reminder_push_devices(account_id);

CREATE TABLE reminder_wakes (
	account_id TEXT NOT NULL,
	wake_id TEXT NOT NULL,
	fire_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, wake_id)
);
CREATE INDEX reminder_wakes_due ON reminder_wakes(fire_at);

CREATE TABLE reminder_wake_revisions (
	account_id TEXT PRIMARY KEY,
	revision INTEGER NOT NULL
);

CREATE TABLE reminder_wake_deliveries (
	account_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	wake_id TEXT NOT NULL,
	claimed_at INTEGER,
	delivered_at INTEGER,
	PRIMARY KEY (account_id, device_id, wake_id)
);
CREATE INDEX reminder_wake_deliveries_account ON reminder_wake_deliveries(account_id);
