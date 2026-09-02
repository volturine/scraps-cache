// @ts-expect-error the adapter emits this entry at build time
import worker from '../.svelte-kit/cloudflare/_worker.js';

type FetchHandler = (
	request: Request,
	env: Record<string, unknown>,
	ctx: unknown
) => Promise<Response>;

const sveltekit = worker as { fetch: FetchHandler };

export default {
	fetch: (request: Request, env: Record<string, unknown>, ctx: unknown) =>
		sveltekit.fetch(request, env, ctx),
	scheduled: async (
		_controller: unknown,
		env: Record<string, unknown>,
		ctx: { waitUntil(promise: Promise<unknown>): void }
	) => {
		const request = new Request('https://cron.internal/api/cron/tick', {
			method: 'POST',
			headers: { authorization: `Bearer ${env.SCRAPSCACHE_TICK_SECRET ?? ''}` }
		});
		const response = await sveltekit.fetch(request, env, ctx);
		if (!response.ok) {
			console.error(
				JSON.stringify({
					level: 'error',
					event: 'cron_tick_failed',
					status: response.status
				})
			);
		}
	}
};
