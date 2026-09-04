import type { RequestHandler } from './$types';
import { protectedResourceMetadata } from '$lib/server/mcp/oauthMetadata';

export const GET: RequestHandler = ({ url }) => protectedResourceMetadata(url.origin);
