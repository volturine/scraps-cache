import adapterNode from '@sveltejs/adapter-node';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

function nodeAdapter() {
	const adapter = adapterNode();
	return {
		...adapter,
		async adapt(/** @type {import('@sveltejs/kit').Builder} */ builder) {
			const warn = console.warn;
			console.warn = (...args) => {
				// adapter-node reports SvelteKit's tree-shaken no-op virtual env chunk as empty when SSR
				// is disabled. The adapter's real env entry is still emitted, so this warning is not actionable.
				if (args.length === 1 && args[0] === 'Generated an empty chunk: "chunks/env.js".') return;
				warn(...args);
			};
			try {
				await adapter.adapt(builder);
			} finally {
				console.warn = warn;
			}
		}
	};
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// Self-hosted Node builds are the default; DEPLOY_TARGET=cloudflare builds the Workers bundle.
		adapter:
			process.env.DEPLOY_TARGET === 'cloudflare'
				? adapterCloudflare({ config: 'cf/wrangler.svelte.jsonc' })
				: nodeAdapter(),
		csrf: {
			// The route-aware check in hooks.server.ts preserves the default protection while
			// allowing originless OAuth clients to call only the token endpoint.
			trustedOrigins: ['*']
		},
		csp: {
			mode: 'nonce',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self', 'unsafe-inline'],
				'connect-src': ['self'],
				'img-src': ['self', 'data:', 'blob:'],
				'media-src': ['self', 'data:', 'blob:'],
				'font-src': ['self'],
				// Chrome's PDF viewer treats an iframe PDF as a plugin, so blob
				// frames need both frame-src and object-src. Third-party frames
				// stay blocked.
				'frame-src': ['self', 'blob:'],
				'object-src': ['self', 'blob:'],
				'base-uri': ['none'],
				'form-action': ['self'],
				'frame-ancestors': ['none']
			}
		}
	}
};

export default config;
