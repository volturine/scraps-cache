import { handleMcpGet, handleMcpPost, handleMcpOptions } from '$lib/server/mcp/http';

export const GET = handleMcpGet;
export const POST = handleMcpPost;
export const OPTIONS = handleMcpOptions;
