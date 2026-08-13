type HttpMetric = { count: number; durationMs: number };

const http = new Map<string, HttpMetric>();
let rateLimited = 0;
let syncRequests = 0;
let syncUploadEnvelopes = 0;
let syncDeleteSlots = 0;
let sqliteBusy = 0;
let reminderWakesSent = 0;
let reminderWakesGone = 0;

function routeLabel(pathname: string): string {
	if (pathname.startsWith('/api/sync/delta')) return '/api/sync/delta';
	if (pathname.startsWith('/api/sync/push/')) return '/api/sync/push/*';
	if (pathname.startsWith('/api/sync/pair/')) return '/api/sync/pair/*';
	if (pathname.startsWith('/api/sync/')) return '/api/sync/*';
	if (pathname.startsWith('/health/')) return pathname;
	if (pathname === '/metrics') return '/metrics';
	return 'app';
}

export function recordHttpRequest(pathname: string, status: number, durationMs: number): void {
	const key = `${routeLabel(pathname)}\u0000${status}`;
	const metric = http.get(key) ?? { count: 0, durationMs: 0 };
	metric.count += 1;
	metric.durationMs += durationMs;
	http.set(key, metric);
}

export function recordRateLimit(): void {
	rateLimited += 1;
}

export function recordSyncBatch(uploadCount: number, deleteCount: number): void {
	syncRequests += 1;
	syncUploadEnvelopes += uploadCount;
	syncDeleteSlots += deleteCount;
}

export function recordSqliteBusy(): void {
	sqliteBusy += 1;
}

export function recordReminderWake(result: 'sent' | 'gone'): void {
	if (result === 'sent') reminderWakesSent += 1;
	else reminderWakesGone += 1;
}

export function recordSqliteError(error: unknown): void {
	if (
		error instanceof Error &&
		(error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked'))
	)
		recordSqliteBusy();
}

function line(name: string, value: number, labels = ''): string {
	return `${name}${labels ? `{${labels}}` : ''} ${Number.isFinite(value) ? value : 0}`;
}

export function renderMetrics(
	backup: {
		lastAttemptAt: number;
		lastSuccessAt: number;
		failures: number;
		durationMs: number;
	},
	usage: { accounts: number; envelopeCount: number; ciphertextBytes: number }
): string {
	const lines = [
		'# TYPE shard_http_requests_total counter',
		'# TYPE shard_http_request_duration_milliseconds_sum counter'
	];
	for (const [key, metric] of http) {
		const [route, status] = key.split('\u0000');
		const labels = `route=${JSON.stringify(route)},status=${JSON.stringify(status)}`;
		lines.push(line('shard_http_requests_total', metric.count, labels));
		lines.push(line('shard_http_request_duration_milliseconds_sum', metric.durationMs, labels));
	}
	lines.push(
		'# TYPE shard_rate_limited_total counter',
		line('shard_rate_limited_total', rateLimited),
		'# TYPE shard_sync_requests_total counter',
		line('shard_sync_requests_total', syncRequests),
		line('shard_sync_upload_envelopes_total', syncUploadEnvelopes),
		line('shard_sync_delete_slots_total', syncDeleteSlots),
		line('shard_sqlite_busy_total', sqliteBusy),
		line('shard_sync_accounts', usage.accounts),
		line('shard_sync_envelopes', usage.envelopeCount),
		line('shard_sync_ciphertext_bytes', usage.ciphertextBytes),
		line('shard_backup_last_attempt_timestamp_seconds', backup.lastAttemptAt / 1000),
		line('shard_backup_last_success_timestamp_seconds', backup.lastSuccessAt / 1000),
		line('shard_backup_failures_total', backup.failures),
		line('shard_backup_duration_milliseconds', backup.durationMs),
		'# TYPE shard_reminder_wakes_sent_total counter',
		line('shard_reminder_wakes_sent_total', reminderWakesSent),
		line('shard_reminder_wakes_gone_total', reminderWakesGone)
	);
	return `${lines.join('\n')}\n`;
}
