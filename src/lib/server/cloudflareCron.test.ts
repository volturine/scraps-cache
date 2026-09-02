import { afterEach, describe, expect, it, vi } from 'vitest';
import cronWorker from '../../../cf/cron';

afterEach(() => vi.restoreAllMocks());

function invokeScheduled(response: Response): Promise<unknown> {
	let task: Promise<unknown> | undefined;
	cronWorker.scheduled(
		undefined,
		{
			APP: { fetch: vi.fn().mockResolvedValue(response) },
			SCRAPSCACHE_TICK_SECRET: 'test-secret'
		},
		{
			waitUntil(promise) {
				task = promise;
			}
		}
	);
	if (!task) throw new Error('Scheduled handler did not register its task');
	return task;
}

describe('Cloudflare scheduled worker', () => {
	it('resolves the scheduled task after a successful app tick', async () => {
		await expect(invokeScheduled(new Response(null, { status: 204 }))).resolves.toBeUndefined();
	});

	it('rejects the scheduled task after a failed app tick', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(invokeScheduled(new Response(null, { status: 503 }))).rejects.toThrow(
			'Cron tick failed with HTTP 503'
		);
		expect(error).toHaveBeenCalledOnce();
		const logged = String(error.mock.calls[0]?.[0]);
		expect(logged).toContain('"event":"cron_tick_failed"');
		expect(logged).toContain('"status":503');
		expect(logged).not.toContain('test-secret');
	});
});
