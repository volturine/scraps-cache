import { getRequestEvent } from '$app/server';
import type { D1Database, DurableObjectNamespace, R2Bucket } from '@cloudflare/workers-types';

export type CloudflareBindings = {
	SCRAPSCACHE_DB: D1Database;
	SCRAPSCACHE_ENVELOPES: R2Bucket;
	ACCOUNT_COORDINATOR: DurableObjectNamespace;
	ACCOUNT_MCP_SESSION?: DurableObjectNamespace;
	SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES?: string;
	SCRAPSCACHE_CF_ACCESS_TEAM_DOMAIN?: string;
	SCRAPSCACHE_CF_ACCESS_AUD?: string;
	SCRAPSCACHE_CF_ACCESS_EMAIL?: string;
};

export function cloudflareBindings(): CloudflareBindings {
	const bindings = (getRequestEvent().platform as { env?: unknown } | undefined)?.env;
	if (!bindings) throw new Error('Cloudflare platform bindings are unavailable');
	return bindings as unknown as CloudflareBindings;
}
