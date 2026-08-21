import { describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns/promises';
import { isHttpsEndpoint, isPublicEndpoint } from './pushWakes';

const resolve = vi.fn<[], Promise<LookupAddress[]>>();

/**
 * Issue #87: literal-level checks cannot see DNS answers. Registration-time
 * validation must resolve the hostname and reject any private answer.
 */
describe('push endpoint resolution-time validation', () => {
	it('still rejects private literals and accepts public ones without a lookup', async () => {
		expect(await isPublicEndpoint('https://127.0.0.1/push', resolve)).toBe(false);
		expect(await isPublicEndpoint('https://169.254.169.254/push', resolve)).toBe(false);
		expect(await isPublicEndpoint('https://2130706433/push', resolve)).toBe(false);
		expect(resolve).not.toHaveBeenCalled();
		resolve.mockResolvedValue([{ address: '93.184.216.34' }]);
		expect(await isPublicEndpoint('https://push.example.com/sub', resolve)).toBe(true);
	});

	it('rejects hostnames whose DNS answers point at private space', async () => {
		resolve.mockResolvedValue([{ address: '10.0.0.5' }]);
		await expect(isPublicEndpoint('https://metadata.attacker.example/push', resolve)).resolves.toBe(
			false
		);

		resolve.mockResolvedValue([{ address: '2001:db8::1' }, { address: '192.168.1.1' }]);
		await expect(isPublicEndpoint('https://mixed.attacker.example/push', resolve)).resolves.toBe(
			false
		);
	});

	it('accepts hostnames that resolve only to public addresses', async () => {
		resolve.mockResolvedValue([{ address: '93.184.216.34' }, { address: '2606:2800::1' }]);
		await expect(isPublicEndpoint('https://rebind.attacker.example/push', resolve)).resolves.toBe(
			true
		);
	});

	it('rejects unresolvable hostnames', async () => {
		resolve.mockRejectedValue(Object.assign(new Error('queryA ESERVFAIL'), { code: 'ESERVFAIL' }));
		await expect(isPublicEndpoint('https://nx.attacker.example/push', resolve)).resolves.toBe(
			false
		);
	});

	it('keeps the literal shape checks', () => {
		expect(isHttpsEndpoint('http://push.example.com/sub')).toBe(false);
		expect(isHttpsEndpoint('https://user:pass@push.example.com/sub')).toBe(false);
	});
});
