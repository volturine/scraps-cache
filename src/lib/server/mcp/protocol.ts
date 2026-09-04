import { MCP_TOOLS, type McpSession } from './engine';

export type JsonRpcRequest = {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
};

export async function handleJsonRpcMessage(
	session: McpSession,
	message: unknown
): Promise<JsonRpcResponse | null> {
	if (!message || typeof message !== 'object') {
		return {
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, message: 'Invalid Request: payload must be an object' }
		};
	}

	const req = message as JsonRpcRequest;
	if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
		return {
			jsonrpc: '2.0',
			id: req.id ?? null,
			error: { code: -32600, message: 'Invalid Request: missing jsonrpc version or method' }
		};
	}

	const id = req.id ?? null;

	// Notifications have no id and expect no response
	if (req.method === 'notifications/initialized') {
		return null;
	}

	session.touch();

	try {
		switch (req.method) {
			case 'initialize': {
				return {
					jsonrpc: '2.0',
					id,
					result: {
						protocolVersion: '2024-11-05',
						capabilities: {
							tools: {},
							resources: {}
						},
						serverInfo: {
							name: 'scrapscache-mcp',
							version: '1.0.0'
						}
					}
				};
			}

			case 'ping': {
				return {
					jsonrpc: '2.0',
					id,
					result: {}
				};
			}

			case 'tools/list': {
				return {
					jsonrpc: '2.0',
					id,
					result: {
						tools: MCP_TOOLS
					}
				};
			}

			case 'tools/call': {
				const params = req.params as
					{ name?: string; arguments?: Record<string, unknown> } | undefined;
				if (!params || typeof params.name !== 'string') {
					return {
						jsonrpc: '2.0',
						id,
						error: { code: -32602, message: 'Invalid params: missing tool name' }
					};
				}

				try {
					const toolResult = await session.callTool(params.name, params.arguments || {});
					return {
						jsonrpc: '2.0',
						id,
						result: {
							content: [
								{
									type: 'text',
									text:
										typeof toolResult === 'string'
											? toolResult
											: JSON.stringify(toolResult, null, 2)
								}
							],
							isError: false
						}
					};
				} catch (err: unknown) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					return {
						jsonrpc: '2.0',
						id,
						result: {
							content: [
								{
									type: 'text',
									text: `Error executing tool "${params.name}": ${errorMessage}`
								}
							],
							isError: true
						}
					};
				}
			}

			case 'resources/list': {
				const resources = await session.listResources();
				return {
					jsonrpc: '2.0',
					id,
					result: resources
				};
			}

			case 'resources/read': {
				const params = req.params as { uri?: string } | undefined;
				if (!params || typeof params.uri !== 'string') {
					return {
						jsonrpc: '2.0',
						id,
						error: { code: -32602, message: 'Invalid params: missing resource uri' }
					};
				}
				const resourceContent = await session.readResource(params.uri);
				return {
					jsonrpc: '2.0',
					id,
					result: resourceContent
				};
			}

			default: {
				return {
					jsonrpc: '2.0',
					id,
					error: { code: -32601, message: `Method "${req.method}" not found` }
				};
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return {
			jsonrpc: '2.0',
			id,
			error: { code: -32603, message }
		};
	}
}
