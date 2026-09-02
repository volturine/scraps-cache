import { cloudflareBindings } from './env';

/**
 * Get a secret from environment variables.
 * On Cloudflare Workers, secrets are only accessible via the `env` object from bindings.
 */
export function getSecret(key: string): string | undefined {
	const bindings = cloudflareBindings();
	const value = (bindings as Record<string, unknown>)[key];
	if (typeof value === 'string' && value.length > 0) return value;
	return undefined;
}
