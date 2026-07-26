import { json } from '@sveltejs/kit';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { RequestHandler } from './$types';
import type { LinkPreview } from '$lib/linkPreview';

/** Stop reading once we have the document head (OG/Twitter/title/icons live here). */
const HEAD_END_RE = /<\/head>/i;
const BROWSER_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 3;
const MAX_HEAD_BYTES = 256 * 1024;

function isBlockedIp(address: string): boolean {
	if (isIP(address) === 4) {
		const [a, b] = address.split('.').map(Number);
		return a === 0 || a === 10 || a === 127 || a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168);
	}

	const normalized = address.toLowerCase();
	if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
	const ipv4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	return ipv4Mapped ? isBlockedIp(ipv4Mapped[1]) : false;
}

async function safeHttpUrl(value: string): Promise<URL> {
	const url = new URL(value);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP(S) links can be previewed');
	if (url.username || url.password || url.hostname === 'localhost' || url.hostname.endsWith('.local')) {
		throw new Error('This link cannot be previewed');
	}

	const addresses = await lookup(url.hostname, { all: true, verbatim: true });
	if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
		throw new Error('This link cannot be previewed');
	}
	return url;
}

/** Read HTML until </head>, with a hard cap against unbounded or malicious responses. */
async function readHtmlHead(response: Response): Promise<string> {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let html = '';
	let receivedBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > MAX_HEAD_BYTES) {
				await reader.cancel();
				throw new Error('Page head is too large');
			}
			html += decoder.decode(value, { stream: true });
			if (HEAD_END_RE.test(html)) {
				try {
					await reader.cancel();
				} catch {
					// ignore cancel races
				}
				break;
			}
		}
		html += decoder.decode();
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// already released after cancel
		}
	}
	return html;
}

function decodeHtml(value: string): string {
	return value
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&#(x[\da-f]+|\d+);/gi, (_, entity: string) => String.fromCodePoint(
			entity[0].toLowerCase() === 'x' ? Number.parseInt(entity.slice(1), 16) : Number.parseInt(entity, 10)
		));
}

function attribute(tag: string, name: string): string | null {
	const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
	return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function metaContent(html: string, key: string): string | null {
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		const property = attribute(tag, 'property')?.toLowerCase();
		const name = attribute(tag, 'name')?.toLowerCase();
		if (property === key || name === key) return attribute(tag, 'content');
	}
	return null;
}

function cleanText(value: string | null | undefined, limit: number): string | undefined {
	if (!value) return undefined;
	const text = decodeHtml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
	return text ? text.slice(0, limit) : undefined;
}

function absoluteHttpUrl(value: string | null, base: URL): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(decodeHtml(value), base);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function iconScore(rel: string, sizes: string | null): number {
	const r = rel.toLowerCase();
	let score = 0;
	if (r.includes('apple-touch-icon')) score += 40;
	else if (r === 'icon' || r.includes('shortcut')) score += 30;
	else if (r.includes('alternate') && r.includes('icon')) score += 20;
	else if (r.includes('fluid-icon')) score += 10;
	else if (r.includes('mask-icon')) score += 5;
	else if (r.includes('icon')) score += 15;

	if (sizes) {
		const dims = sizes.toLowerCase().match(/(\d+)x(\d+)/g) ?? [];
		const maxDim = dims.reduce((best, pair) => {
			const [w, h] = pair.split('x').map(Number);
			return Math.max(best, w || 0, h || 0);
		}, 0);
		score += Math.min(maxDim, 256) / 8;
	}
	return score;
}

function pageIcon(html: string, pageUrl: URL): string | undefined {
	const candidates = (html.match(/<link\b[^>]*>/gi) ?? [])
		.map((tag) => ({
			rel: attribute(tag, 'rel') ?? '',
			href: attribute(tag, 'href'),
			sizes: attribute(tag, 'sizes'),
			type: attribute(tag, 'type')?.toLowerCase() ?? ''
		}))
		.filter(({ rel, href, type }) => !!href && rel.toLowerCase().includes('icon') && !type.includes('xml'));

	candidates.sort((a, b) => iconScore(b.rel, b.sizes) - iconScore(a.rel, a.sizes));
	const best = candidates[0]?.href;
	return absoluteHttpUrl(best ?? '/favicon.ico', pageUrl);
}

function parsePreview(html: string, pageUrl: URL, originalUrl: string): LinkPreview {
	const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
	const title = cleanText(
		metaContent(html, 'og:title') ?? metaContent(html, 'twitter:title') ?? titleTag,
		160
	);
	// Hostname-as-title is a failed unfurl — do not return/persist it.
	if (!title || title.toLowerCase() === pageUrl.hostname.toLowerCase() || title.toLowerCase() === pageUrl.hostname.replace(/^www\./, '').toLowerCase()) {
		throw new Error('Page has no usable title');
	}

	const description = cleanText(
		metaContent(html, 'og:description') ?? metaContent(html, 'twitter:description') ?? metaContent(html, 'description'),
		240
	);
	const image = absoluteHttpUrl(metaContent(html, 'og:image') ?? metaContent(html, 'twitter:image'), pageUrl);
	const icon = pageIcon(html, pageUrl);
	const hostname = pageUrl.hostname.replace(/^www\./, '');

	return {
		// Keep the URL the note extracted so client Map keys stay stable across redirects.
		url: originalUrl,
		hostname,
		title,
		...(description ? { description } : {}),
		...(image ? { image } : {}),
		...(icon ? { icon } : {})
	};
}

export const GET: RequestHandler = async ({ url, fetch }) => {
	const supplied = url.searchParams.get('url');
	if (!supplied || supplied.length > 2_048) return json({ error: 'A valid link is required' }, { status: 400 });

	try {
		const originalUrl = new URL(supplied).href;
		let pageUrl = await safeHttpUrl(supplied);
		for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
			const response = await fetch(pageUrl, {
				redirect: 'manual',
				signal: AbortSignal.timeout(10_000),
				headers: {
					accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
					'accept-language': 'en-US,en;q=0.9',
					'user-agent': BROWSER_UA
				}
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				if (!location || redirect === MAX_REDIRECTS) throw new Error('Too many redirects');
				pageUrl = await safeHttpUrl(new URL(location, pageUrl).href);
				continue;
			}
			if (!response.ok) throw new Error(`The page returned ${response.status}`);
			const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
			if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
				throw new Error('The link is not an HTML page');
			}
			return json(parsePreview(await readHtmlHead(response), pageUrl, originalUrl), {
				headers: { 'cache-control': 'public, max-age=3600' }
			});
		}
		throw new Error('Too many redirects');
	} catch (error) {
		console.warn('[link-preview]', error instanceof Error ? error.message : error);
		return json({ error: 'Preview unavailable' }, { status: 422 });
	}
};
