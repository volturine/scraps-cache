import { describe, expect, it, vi } from 'vitest';
import { OAUTH_BROWSER_ORIGINS } from '$lib/mcp/oauth';

vi.mock('@sveltejs/adapter-node', () => ({
	default: () => ({ name: 'adapter-node', adapt: vi.fn() })
}));
vi.mock('@sveltejs/adapter-cloudflare', () => ({
	default: () => ({ name: 'adapter-cloudflare', adapt: vi.fn() })
}));
vi.mock('@sveltejs/vite-plugin-svelte', () => ({ vitePreprocess: () => ({}) }));

const { default: config } = await import('../../../svelte.config.js');

describe('SvelteKit security configuration', () => {
	it('trusts only registered browser OAuth origins for Kit CSRF', () => {
		expect(config.kit?.csrf?.trustedOrigins).toEqual([...OAUTH_BROWSER_ORIGINS]);
		expect(config.kit?.csrf?.trustedOrigins).not.toContain('*');
	});
});
