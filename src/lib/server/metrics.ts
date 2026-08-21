type HttpMetric = { count: number; durationMs: number };

const http = new Map<string, HttpMetric>();
let rateLimited = 0;
let syncRequests = 0;
let syncUploadEnvelopes = 0;
let syncDeleteSlots = 0;
let sqliteBusy = 0;
let reminderWakesSent = 0;
let reminderWakesGone = 0;
let reminderWakesFailed = 0;

function routeLabel(pathname: string): string {
	if (pathname.startsWith('/api/sync/delta')) return '/api/sync/delta';
	if (pathname.startsWith('/api/sync/push/')) return '/api/sync/push/*';
	if (pathname.startsWith('/api/sync/pair/')) return '/api/sync/pair/*';
	if (pathname.startsWith('/api/sync/')) return '/api/sync/*';
	if (pathname.startsWith('/api/admin/')) return '/api/admin/*';
	if (pathname.startsWith('/health/')) return '/health/*';
	if (pathname === '/metrics') return '/metrics';
	return 'app';
}

export type ProcessActivity = {
	syncRequests: number;
	syncUploadEnvelopes: number;
	syncDeleteSlots: number;
	rateLimited: number;
	sqliteBusy: number;
	reminderWakesSent: number;
	reminderWakesGone: number;
	reminderWakesFailed: number;
};

export function processActivity(): ProcessActivity {
	return {
		syncRequests,
		syncUploadEnvelopes,
		syncDeleteSlots,
		rateLimited,
		sqliteBusy,
		reminderWakesSent,
		reminderWakesGone,
		reminderWakesFailed
	};
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

export function recordReminderWake(result: 'sent' | 'gone' | 'failed'): void {
	if (result === 'sent') reminderWakesSent += 1;
	else if (result === 'gone') reminderWakesGone += 1;
	else reminderWakesFailed += 1;
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
	usage: {
		accounts: number;
		envelopeCount: number;
		ciphertextBytes: number;
		gigabytes?: number;
		activeByWindowDays?: Record<string, number>;
		staleAccounts?: number;
	},
	retention?: {
		enabled: boolean;
		inactiveDays: number;
		lastRunAt: number;
		deletedAccountsTotal: number;
	}
): string {
	const lines = [
		'# TYPE scraps-cache_http_requests_total counter',
		'# TYPE scraps-cache_http_request_duration_milliseconds_sum counter'
	];
	for (const [key, metric] of http) {
		const [route, status] = key.split('\u0000');
		const labels = `route=${JSON.stringify(route)},status=${JSON.stringify(status)}`;
		lines.push(line('scraps-cache_http_requests_total', metric.count, labels));
		lines.push(
			line('scraps-cache_http_request_duration_milliseconds_sum', metric.durationMs, labels)
		);
	}
	lines.push(
		'# TYPE scraps-cache_rate_limited_total counter',
		line('scraps-cache_rate_limited_total', rateLimited),
		'# TYPE scraps-cache_sync_requests_total counter',
		line('scraps-cache_sync_requests_total', syncRequests),
		'# TYPE scraps-cache_sync_upload_envelopes_total counter',
		line('scraps-cache_sync_upload_envelopes_total', syncUploadEnvelopes),
		'# TYPE scraps-cache_sync_delete_slots_total counter',
		line('scraps-cache_sync_delete_slots_total', syncDeleteSlots),
		'# TYPE scraps-cache_sqlite_busy_total counter',
		line('scraps-cache_sqlite_busy_total', sqliteBusy),
		'# TYPE scraps-cache_sync_accounts gauge',
		line('scraps-cache_sync_accounts', usage.accounts),
		'# TYPE scraps-cache_sync_envelopes gauge',
		line('scraps-cache_sync_envelopes', usage.envelopeCount),
		'# TYPE scraps-cache_sync_ciphertext_bytes gauge',
		line('scraps-cache_sync_ciphertext_bytes', usage.ciphertextBytes),
		'# TYPE scraps-cache_sync_storage_gigabytes gauge',
		line('scraps-cache_sync_storage_gigabytes', usage.gigabytes ?? 0),
		'# TYPE scraps-cache_sync_stale_accounts gauge',
		line('scraps-cache_sync_stale_accounts', usage.staleAccounts ?? 0)
	);
	if (usage.activeByWindowDays) {
		lines.push('# TYPE scraps-cache_sync_accounts_active gauge');
		for (const [windowDays, count] of Object.entries(usage.activeByWindowDays)) {
			lines.push(
				line(
					'scraps-cache_sync_accounts_active',
					count,
					`window_days=${JSON.stringify(windowDays)}`
				)
			);
		}
	}
	if (retention) {
		lines.push(
			'# TYPE scraps-cache_retention_enabled gauge',
			line('scraps-cache_retention_enabled', retention.enabled ? 1 : 0),
			'# TYPE scraps-cache_retention_inactive_days gauge',
			line('scraps-cache_retention_inactive_days', retention.inactiveDays),
			'# TYPE scraps-cache_retention_last_run_timestamp_seconds gauge',
			line('scraps-cache_retention_last_run_timestamp_seconds', retention.lastRunAt / 1000),
			'# TYPE scraps-cache_retention_deleted_accounts_total counter',
			line('scraps-cache_retention_deleted_accounts_total', retention.deletedAccountsTotal)
		);
	}
	lines.push(
		'# TYPE scraps-cache_backup_last_attempt_timestamp_seconds gauge',
		line('scraps-cache_backup_last_attempt_timestamp_seconds', backup.lastAttemptAt / 1000),
		'# TYPE scraps-cache_backup_last_success_timestamp_seconds gauge',
		line('scraps-cache_backup_last_success_timestamp_seconds', backup.lastSuccessAt / 1000),
		'# TYPE scraps-cache_backup_failures_total counter',
		line('scraps-cache_backup_failures_total', backup.failures),
		'# TYPE scraps-cache_backup_duration_milliseconds gauge',
		line('scraps-cache_backup_duration_milliseconds', backup.durationMs),
		'# TYPE scraps-cache_reminder_wakes_sent_total counter',
		line('scraps-cache_reminder_wakes_sent_total', reminderWakesSent),
		'# TYPE scraps-cache_reminder_wakes_gone_total counter',
		line('scraps-cache_reminder_wakes_gone_total', reminderWakesGone),
		'# TYPE scraps-cache_reminder_wakes_failed_total counter',
		line('scraps-cache_reminder_wakes_failed_total', reminderWakesFailed)
	);
	return `${lines.join('\n')}\n`;
}
