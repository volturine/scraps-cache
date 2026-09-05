import { env } from '$env/dynamic/private';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export type CloudflareAccessConfig = {
	teamDomain: string;
	audience: string;
	adminEmail: string;
};

type VerifyAccessToken = (token: string, config: CloudflareAccessConfig) => Promise<JWTPayload>;

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function configuredAccess(): CloudflareAccessConfig {
	return {
		teamDomain: env.SCRAPSCACHE_CF_ACCESS_TEAM_DOMAIN ?? '',
		audience: env.SCRAPSCACHE_CF_ACCESS_AUD ?? '',
		adminEmail: env.SCRAPSCACHE_CF_ACCESS_EMAIL ?? ''
	};
}

function validTeamDomain(value: string): string | null {
	try {
		const url = new URL(value);
		if (
			url.protocol !== 'https:' ||
			!url.hostname.endsWith('.cloudflareaccess.com') ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			return null;
		}
		return url.origin;
	} catch {
		return null;
	}
}

async function verifyAccessToken(
	token: string,
	config: CloudflareAccessConfig
): Promise<JWTPayload> {
	const issuer = validTeamDomain(config.teamDomain);
	if (!issuer) throw new Error('Invalid Cloudflare Access team domain');
	let keySet = keySets.get(issuer);
	if (!keySet) {
		keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
		keySets.set(issuer, keySet);
	}
	return (
		await jwtVerify(token, keySet, {
			algorithms: ['RS256'],
			issuer,
			audience: config.audience
		})
	).payload;
}

export async function authenticateCloudflareAdmin(
	request: Request,
	config = configuredAccess(),
	verify: VerifyAccessToken = verifyAccessToken
): Promise<string | null> {
	const teamDomain = validTeamDomain(config.teamDomain);
	const adminEmail = config.adminEmail.trim().toLowerCase();
	if (!teamDomain || !config.audience.trim() || !adminEmail) return null;
	const token = request.headers.get('cf-access-jwt-assertion');
	if (!token) return null;
	try {
		const payload = await verify(token, { ...config, teamDomain });
		const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
		return email === adminEmail ? email : null;
	} catch {
		return null;
	}
}
