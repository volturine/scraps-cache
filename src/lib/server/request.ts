export class InvalidRequestBody extends Error {}

/**
 * Parse JSON without allowing a chunked request to grow without bound before validation.
 * `Request.json()` cannot enforce a byte limit while streaming.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
	const declaredBytes = Number(request.headers.get('content-length'));
	if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
		throw new InvalidRequestBody('Request body is too large');
	}
	if (!request.body) throw new InvalidRequestBody('Request body is required');

	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel();
				throw new InvalidRequestBody('Request body is too large');
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}

	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new InvalidRequestBody('Request body must be valid JSON');
	}
}
