import adapterNode from '@sveltejs/adapter-node';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAUTH_BROWSER_ORIGINS } from './src/lib/mcp/oauth.ts';
import { withOriginlessOAuthTokenStamp } from './src/lib/server/mcp/oauthCsrf.ts';

function injectOriginlessOAuthTokenSkip() {
	const chunkDir = path.join('build', 'server', 'chunks');
	const targets = fs
		.readdirSync(chunkDir)
		.filter((name) => name.endsWith('.js'))
		.map((name) => path.join(chunkDir, name))
		.filter((file) =>
			fs.readFileSync(file, 'utf8').includes('const response = await server.respond(request,')
		);
	if (targets.length !== 1) {
		throw new Error(
			`expected one adapter-node handler chunk to stamp OAuth CSRF, found ${targets.length}`
		);
	}
	fs.copyFileSync(
		fileURLToPath(new URL('./src/lib/server/mcp/oauthCsrf.ts', import.meta.url)),
		path.join(chunkDir, 'oauthCsrf.ts')
	);
	fs.writeFileSync(targets[0], withOriginlessOAuthTokenStamp(fs.readFileSync(targets[0], 'utf8')));
}

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
				injectOriginlessOAuthTokenSkip();
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
			// Browser OAuth clients that POST the token endpoint from a page.
			// Originless server/native clients are stamped on that route only.
			trustedOrigins: [...OAUTH_BROWSER_ORIGINS]
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
