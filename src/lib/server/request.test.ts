import { describe, expect, it } from 'vitest';
import { InvalidRequestBody, readJsonBody } from './request';

describe('readJsonBody', () => {
	it('parses JSON within the byte limit', async () => {
		const request = new Request('https://example.test', {
			method: 'POST',
			body: JSON.stringify({ value: 42 })
		});

		await expect(readJsonBody(request, 1_024)).resolves.toEqual({ value: 42 });
	});

	it('rejects declared and streamed bodies above the limit', async () => {
		const declared = new Request('https://example.test', {
			method: 'POST',
			headers: { 'content-length': '1000' },
			body: '{}'
		});
		await expect(readJsonBody(declared, 10)).rejects.toBeInstanceOf(InvalidRequestBody);

		const streamed = new Request('https://example.test', {
			method: 'POST',
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"value":"too large"}'));
					controller.close();
				}
			}),
			duplex: 'half'
		} as RequestInit);
		await expect(readJsonBody(streamed, 10)).rejects.toBeInstanceOf(InvalidRequestBody);
	});

	it('rejects malformed JSON', async () => {
		const request = new Request('https://example.test', { method: 'POST', body: '{' });
		await expect(readJsonBody(request, 100)).rejects.toBeInstanceOf(InvalidRequestBody);
	});
});
