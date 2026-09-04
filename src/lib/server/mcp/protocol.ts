import { MCP_TOOLS, type McpSession } from './engine';

const MCP_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const LATEST_MCP_PROTOCOL_VERSION = '2025-11-25';

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
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
	if (Array.isArray(message)) {
		if (message.length === 0) {
			return {
				jsonrpc: '2.0',
				id: null,
				error: { code: -32600, message: 'Invalid Request: empty batch' }
			};
		}
		const responses: Array<JsonRpcResponse | null> = [];
		for (const item of message) {
			responses.push(await session.runExclusive(() => handleSingleJsonRpcMessage(session, item)));
		}
		const nonNull = responses.filter((r): r is JsonRpcResponse => r !== null);
		return nonNull.length > 0 ? nonNull : null;
	}
	return session.runExclusive(() => handleSingleJsonRpcMessage(session, message));
}

async function handleSingleJsonRpcMessage(
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

	// Notifications in JSON-RPC 2.0 have no 'id' member and MUST NOT receive a response
	if (req.id === undefined) {
		session.touch();
		return null;
	}

	const id = req.id;

	session.touch();

	try {
		switch (req.method) {
			case 'initialize': {
				const requestedProtocolVersion = req.params?.protocolVersion;
				return {
					jsonrpc: '2.0',
					id,
					result: {
						protocolVersion:
							typeof requestedProtocolVersion === 'string' &&
							MCP_PROTOCOL_VERSIONS.has(requestedProtocolVersion)
								? requestedProtocolVersion
								: LATEST_MCP_PROTOCOL_VERSION,
						capabilities: {
							tools: {},
							resources: {}
						},
						serverInfo: {
							name: 'scrapscache-mcp',
							version: '1.0.0'
						},
						instructions:
							'Scrapscache personal encrypted notes vault. Use search_notes to find notes by keyword or label, list_notes to see recent notes, open_note to view full note details and checklists, and create_note/update_note to manage notes.'
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

				try {
					const content = await session.readResource(params.uri);
					return {
						jsonrpc: '2.0',
						id,
						result: content
					};
				} catch (err: unknown) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					return {
						jsonrpc: '2.0',
						id,
						error: { code: -32603, message: errorMessage }
					};
				}
			}

			default:
				return {
					jsonrpc: '2.0',
					id,
					error: { code: -32601, message: `Method not found: ${req.method}` }
				};
		}
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		return {
			jsonrpc: '2.0',
			id,
			error: { code: -32603, message: `Internal error: ${errorMessage}` }
		};
	}
}
