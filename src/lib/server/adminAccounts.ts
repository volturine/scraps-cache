import { getSyncStore, type AccountUsage } from '$lib/server/syncStore';
import { getMcpAccessStore, type McpAccountAccess } from '$lib/server/mcp/accessStore';
import { getMcpTokenStore } from '$lib/server/mcp/tokenStore';
import { getMcpOAuthStore } from '$lib/server/mcp/oauthStore';
import { endMcpSessions } from '$lib/server/mcp/liveSessions';

export type ManagedAccount = {
	usage: AccountUsage;
	mcp: McpAccountAccess;
};

export async function getManagedAccount(accountId: string): Promise<ManagedAccount | null> {
	const usage = await getSyncStore().getAccountUsage(accountId);
	if (!usage) return null;
	return { usage, mcp: await getMcpAccessStore().get(accountId) };
}

export async function enableAccountMcp(accountId: string): Promise<ManagedAccount | null> {
	if (!(await getSyncStore().getAccountUsage(accountId))) return null;
	await getMcpAccessStore().enable(accountId);
	return getManagedAccount(accountId);
}

export async function disableAccountMcp(
	accountId: string,
	platform: unknown
): Promise<ManagedAccount | null> {
	if (!(await getSyncStore().getAccountUsage(accountId))) return null;
	await getMcpAccessStore().disable(accountId);
	const tokenHashes = await getMcpTokenStore().revokeAccount(accountId);
	await getMcpOAuthStore().revokeAccountCodes(accountId);
	await endMcpSessions(accountId, tokenHashes, platform);
	return getManagedAccount(accountId);
}
