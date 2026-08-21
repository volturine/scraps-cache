import { describe, expect, it } from 'vitest';
import { recordHttpRequest, renderMetrics } from './metrics';

describe('renderMetrics', () => {
	it('emits anonymous storage, activity, and retention gauges', () => {
		const body = renderMetrics(
			{ lastAttemptAt: 2_000, lastSuccessAt: 2_000, failures: 0, durationMs: 5 },
			{
				accounts: 4,
				envelopeCount: 8,
				ciphertextBytes: 1_500_000_000,
				gigabytes: 1.5,
				activeByWindowDays: { '1': 1, '7': 3 },
				staleAccounts: 2
			},
			{ enabled: true, inactiveDays: 365, lastRunAt: 2_000, deletedAccountsTotal: 0 }
		);
		expect(body).toContain('scraps-cache_sync_storage_gigabytes 1.5');
		expect(body).toContain('scraps-cache_sync_stale_accounts 2');
		expect(body).toContain('scraps-cache_sync_accounts_active{window_days="1"} 1');
		expect(body).toContain('scraps-cache_retention_enabled 1');
		expect(body).toContain('scraps-cache_retention_inactive_days 365');
		expect(body).not.toMatch(/account-[a-z0-9]+|credential/i);
	});

	it('declares a TYPE for every emitted metric family', () => {
		recordHttpRequest('/health/live', 200, 1);
		const body = renderMetrics(
			{ lastAttemptAt: 2_000, lastSuccessAt: 2_000, failures: 0, durationMs: 5 },
			{
				accounts: 4,
				envelopeCount: 8,
				ciphertextBytes: 16,
				activeByWindowDays: { '7': 3 },
				staleAccounts: 2
			},
			{ enabled: true, inactiveDays: 365, lastRunAt: 2_000, deletedAccountsTotal: 0 }
		);
		const families = new Set(
			[...body.matchAll(/^(?:# TYPE ([\w]+)|([\w]+)(?:\{.*\})? \d)/gm)]
				.map((match) => match[1] ?? match[2])
				.filter((name) => name.startsWith('scraps-cache_'))
		);
		const typed = new Set([...body.matchAll(/^# TYPE ([\w]+) /gm)].map((match) => match[1]));
		expect(typed).toEqual(families);
		expect(body).not.toContain('route="/health/live"');
	});
});
