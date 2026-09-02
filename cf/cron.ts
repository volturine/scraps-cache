type AppService = {
	fetch(request: Request): Promise<Response>;
};

type Env = {
	APP: AppService;
	SCRAPSCACHE_TICK_SECRET?: string;
};

type ScheduledContext = {
	waitUntil(promise: Promise<unknown>): void;
};

async function tick(env: Env): Promise<void> {
	const response = await env.APP.fetch(
		new Request('https://scrapscache.internal/api/cron/tick', {
			method: 'POST',
			headers: { authorization: `Bearer ${env.SCRAPSCACHE_TICK_SECRET ?? ''}` }
		})
	);
	if (!response.ok) {
		console.error(
			JSON.stringify({
				level: 'error',
				event: 'cron_tick_failed',
				status: response.status
			})
		);
		throw new Error(`Cron tick failed with HTTP ${response.status}`);
	}
}

export default {
	scheduled(_controller: unknown, env: Env, context: ScheduledContext): void {
		context.waitUntil(tick(env));
	}
};
