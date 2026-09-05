import { getMcpSessionManager } from './sessionManager';

type McpNamespace = {
	idFromName: (name: string) => unknown;
	get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
};

export async function endMcpSessions(
	accountId: string,
	tokenHashes: string[],
	platform: unknown
): Promise<void> {
	const namespace = (platform as { env?: { ACCOUNT_MCP_SESSION?: McpNamespace } } | undefined)?.env
		?.ACCOUNT_MCP_SESSION;
	if (!namespace) {
		getMcpSessionManager().removeAccountSessions(accountId);
		return;
	}
	await Promise.allSettled(
		tokenHashes.map((tokenHash) =>
			namespace
				.get(namespace.idFromName(tokenHash))
				.fetch(new Request('https://mcp-session/revoke', { method: 'DELETE' }))
		)
	);
}
