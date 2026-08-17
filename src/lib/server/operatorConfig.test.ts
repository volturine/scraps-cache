import { describe, expect, it } from 'vitest';
import { bytesToGigabytes, parseRetentionInactiveDays, staleBeforeMs } from './operatorConfig';

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
});
