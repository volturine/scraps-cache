import { describe, expect, it, vi } from 'vitest';

vi.mock('@sveltejs/adapter-node', () => ({
	default: () => ({ name: 'adapter-node', adapt: vi.fn() })
}));
vi.mock('@sveltejs/adapter-cloudflare', () => ({
	default: () => ({ name: 'adapter-cloudflare', adapt: vi.fn() })
}));
vi.mock('@sveltejs/vite-plugin-svelte', () => ({ vitePreprocess: () => ({}) }));

const { default: config } = await import('../../../svelte.config.js');

describe('SvelteKit security configuration', () => {
	it('delegates form-origin enforcement to the route-aware server hook', () => {
		expect(config.kit?.csrf?.trustedOrigins).toEqual(['*']);
	});
});
