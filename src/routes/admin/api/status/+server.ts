import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getOperatorSnapshot } from '$lib/server/operatorMonitor';

export const GET: RequestHandler = async () =>
	json(await getOperatorSnapshot(), { headers: { 'cache-control': 'no-store' } });
