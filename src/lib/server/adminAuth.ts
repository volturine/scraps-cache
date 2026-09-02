import { timingSafeEqual } from 'node:crypto';
import { getSecret } from '$lib/server/env';

export function timingSafeStringEqual(left: string, right: string): boolean {
	const leftBuf = Buffer.from(left);
	const rightBuf = Buffer.from(right);
	const length = Math.max(leftBuf.length, rightBuf.length, 1);
	const paddedLeft = Buffer.alloc(length);
	const paddedRight = Buffer.alloc(length);
	leftBuf.copy(paddedLeft);
	rightBuf.copy(paddedRight);
	return timingSafeEqual(paddedLeft, paddedRight) && leftBuf.length === rightBuf.length;
}

export function isAdminAuthorized(
	request: Request,
	expected = getSecret('SCRAPSCACHE_ADMIN_TOKEN')
): boolean {
	if (!expected) return false;
	return timingSafeStringEqual(request.headers.get('authorization') ?? '', `Bearer ${expected}`);
}

export function unauthorizedAdminResponse(): Response {
	return new Response('Not found\n', { status: 404 });
}
