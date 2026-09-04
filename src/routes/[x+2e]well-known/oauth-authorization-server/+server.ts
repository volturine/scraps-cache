import type { RequestHandler } from './$types';
import { authorizationServerMetadata } from '$lib/server/mcp/oauthMetadata';

export const GET: RequestHandler = ({ url }) => authorizationServerMetadata(url.origin);
