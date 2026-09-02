import { env as dynamicEnv } from '$env/dynamic/private';

/**
 * Get a secret from environment variables.
 * On Cloudflare Workers, secrets are only accessible via the `env` object from bindings,
 * not via `$env/dynamic/private`. This default version falls back to dynamic env.
 */
export function getSecret(key: string): string | undefined {
	return dynamicEnv[key];
}
