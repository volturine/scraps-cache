import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	bytesToGigabytes,
	DEFAULT_MAX_ACCOUNT_BYTES,
	parseMaxAccountBytes,
	parseRetentionInactiveDays,
	staleBeforeMs
} from './operatorConfig';

type WranglerVars = { SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES?: string };
type WranglerConfig = {
	vars?: WranglerVars;
	env?: Record<string, { vars?: WranglerVars }>;
};

function composeFallback(source: string): string {
	const match = source.match(
		/SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES: "\$\{SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES:-(\d+)\}"/
	);
	if (!match) throw new Error('Compose fallback for SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES is missing');
	return match[1];
}

describe('operator config', () => {
	it('treats missing or non-positive retention days as disabled', () => {
		expect(parseRetentionInactiveDays(undefined)).toBe(0);
		expect(parseRetentionInactiveDays('0')).toBe(0);
		expect(parseRetentionInactiveDays('-3')).toBe(0);
		expect(parseRetentionInactiveDays('365')).toBe(365);
	});

	it('reports decimal gigabytes and a retention cutoff only when enabled', () => {
		expect(bytesToGigabytes(1_500_000_000)).toBe(1.5);
		expect(bytesToGigabytes(1_000_000)).toBe(0.001);
		expect(staleBeforeMs(0, 1_000)).toBeNull();
		expect(staleBeforeMs(2, 2 * 24 * 60 * 60 * 1000)).toBe(0);
	});

	it('falls back to the shared 100 MB account quota', () => {
		expect(DEFAULT_MAX_ACCOUNT_BYTES).toBe(100_000_000);
		expect(parseMaxAccountBytes(undefined)).toBe(DEFAULT_MAX_ACCOUNT_BYTES);
		expect(parseMaxAccountBytes('0')).toBe(DEFAULT_MAX_ACCOUNT_BYTES);
		expect(parseMaxAccountBytes('200000000')).toBe(200_000_000);
	});

	it('keeps self-host and Workers default account quotas aligned', () => {
		const expected = String(DEFAULT_MAX_ACCOUNT_BYTES);
		const example = readFileSync('docker/.env.example', 'utf8');
		expect(example).toMatch(new RegExp(`^SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES=${expected}$`, 'm'));

		expect(composeFallback(readFileSync('docker/compose.yaml', 'utf8'))).toBe(expected);
		expect(composeFallback(readFileSync('docker/compose.dev.yaml', 'utf8'))).toBe(expected);

		const wrangler = JSON.parse(readFileSync('wrangler.jsonc', 'utf8')) as WranglerConfig;
		expect(wrangler.vars?.SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES).toBe(expected);
		const environments = Object.entries(wrangler.env ?? {});
		expect(environments.length).toBeGreaterThan(0);
		expect(
			Object.fromEntries(
				environments.map(([name, env]) => [name, env.vars?.SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES])
			)
		).toEqual(Object.fromEntries(environments.map(([name]) => [name, expected])));
	});
});
