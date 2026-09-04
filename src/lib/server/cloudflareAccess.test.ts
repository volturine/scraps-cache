import { describe, expect, it, vi } from 'vitest';
import { authenticateCloudflareAdmin, type CloudflareAccessConfig } from './cloudflareAccess';

const config: CloudflareAccessConfig = {
	teamDomain: 'https://scraps.cloudflareaccess.com',
	audience: 'access-audience',
	adminEmail: 'owner@example.com'
};

function request(token = 'signed-token'): Request {
	return new Request('https://scrapscache.com/admin', {
		headers: { 'Cf-Access-Jwt-Assertion': token }
	});
}

describe('Cloudflare Access admin authentication', () => {
	it('fails closed when configuration or the signed assertion is missing', async () => {
		const verify = vi.fn(async () => ({ email: 'owner@example.com' }));
		await expect(
			authenticateCloudflareAdmin(request(), { ...config, audience: '' }, verify)
		).resolves.toBeNull();
		await expect(
			authenticateCloudflareAdmin(new Request('https://scrapscache.com/admin'), config, verify)
		).resolves.toBeNull();
		expect(verify).not.toHaveBeenCalled();
	});

	it('accepts only the configured email after token verification', async () => {
		const verify = vi.fn(async () => ({ email: 'OWNER@example.com' }));
		await expect(authenticateCloudflareAdmin(request(), config, verify)).resolves.toBe(
			'owner@example.com'
		);
		expect(verify).toHaveBeenCalledWith('signed-token', config);

		verify.mockResolvedValueOnce({ email: 'someone@example.com' });
		await expect(authenticateCloudflareAdmin(request(), config, verify)).resolves.toBeNull();
	});

	it('rejects invalid team domains and failed signature verification', async () => {
		const verify = vi.fn(async () => {
			throw new Error('bad signature');
		});
		await expect(authenticateCloudflareAdmin(request(), config, verify)).resolves.toBeNull();
		await expect(
			authenticateCloudflareAdmin(
				request(),
				{ ...config, teamDomain: 'https://attacker.example' },
				verify
			)
		).resolves.toBeNull();
	});
});
