import { describe, expect, it } from 'vitest';
import { isHttpsEndpoint } from './pushWakes';

/**
 * Issue #87: `isHttpsEndpoint` validates the hostname string only. A hostname
 * the attacker controls DNS for passes validation regardless of the address
 * it resolves to, so resolution-time SSRF (rebinding, private DNS answers,
 * *.local) is not covered by the literal-IP checks.
 */
describe('push endpoint validation vs DNS resolution', () => {
	it('accepts attacker-controlled hostnames without checking what they resolve to', () => {
		// Literal forms are correctly rejected (verified separately):
		expect(isHttpsEndpoint('https://127.0.0.1/push')).toBe(false);
		expect(isHttpsEndpoint('https://169.254.169.254/push')).toBe(false);
		expect(isHttpsEndpoint('https://2130706433/push')).toBe(false);

		// But a name that resolves to those same addresses at send time is
		// indistinguishable from a benign hostname to this filter.
		expect(isHttpsEndpoint('https://metadata.attacker.example/push')).toBe(true);
		expect(isHttpsEndpoint('https://rebind.attacker.example/push')).toBe(true);
		expect(isHttpsEndpoint('https://internal.corp.local/push')).toBe(true);
	});
});
