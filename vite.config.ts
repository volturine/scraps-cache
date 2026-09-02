import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const cloudflareModules = new Map([
	['$lib/server/syncStore', './src/lib/server/cloudflare/syncStore.ts'],
	['$lib/server/pairingSessions', './src/lib/server/cloudflare/pairingSessions.ts'],
	['$lib/server/db', './src/lib/server/cloudflare/db.ts']
]);
const cloudflareResolvedModules = new Map(
	[...cloudflareModules].map(([source, target]) => [
		fileURLToPath(new URL(source.replace('$lib', './src/lib') + '.ts', import.meta.url)),
		fileURLToPath(new URL(target, import.meta.url))
	])
);

const cloudflarePlatform = {
	name: 'scrapscache-cloudflare-platform',
	enforce: 'pre' as const,
	resolveId(source: string) {
		if (process.env.DEPLOY_TARGET !== 'cloudflare') return null;
		const target = cloudflareModules.get(source);
		if (target) return fileURLToPath(new URL(target, import.meta.url));
		return cloudflareResolvedModules.get(source) ?? null;
	},
	load(id: string) {
		if (process.env.DEPLOY_TARGET !== 'cloudflare') return null;
		const target = cloudflareResolvedModules.get(id);
		return target ? `export * from ${JSON.stringify(target)};` : null;
	}
};

export default defineConfig({
	plugins: [cloudflarePlatform, tailwindcss(), sveltekit()],
	server: {
		watch: {
			// Don't reload the page when the sync server writes to sync-data/.
			ignored: ['**/sync-data/**']
		}
	},
	resolve: {
		conditions: ['browser']
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
		environment: 'jsdom',
		globals: true,
		setupFiles: ['src/tests/setup.ts']
	}
});
