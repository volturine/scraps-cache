const HTTP_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Legacy metadata shape retained only so older notes/backups can be read safely. */
export type LinkPreview = {
	url: string;
	hostname: string;
	title: string;
	description?: string;
	image?: string;
	icon?: string;
};

export type LocalLinkCard = {
	url: string;
	hostname: string;
	path: string;
	badge: string;
};

function cleanUrl(raw: string): string {
	return raw.replace(/[.,!?;:]+$/, '').replace(/\)+$/, '');
}

/** Stable cache key for a link (strip hash; keep path/query so pages differ). */
export function normalizePreviewUrl(value: string): string | null {
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		url.hash = '';
		return url.href;
	} catch {
		return null;
	}
}

/** Returns unique HTTP(S) URLs in the order they appear in a note. */
export function extractHttpUrls(text: string): string[] {
	const urls: string[] = [];
	const seen = new Set<string>();

	for (const match of text.matchAll(HTTP_URL_RE)) {
		const value = cleanUrl(match[0]);
		const href = normalizePreviewUrl(value);
		if (!href || seen.has(href)) continue;
		seen.add(href);
		urls.push(href);
	}

	return urls;
}

/** Legacy validation used only while normalizing older backup data. */
export function isUsableLinkPreview(preview: LinkPreview | null | undefined): preview is LinkPreview {
	if (!preview?.title) return false;
	const host = preview.hostname?.toLowerCase?.() ?? '';
	const title = preview.title.trim().toLowerCase();
	if (!title) return false;
	if (host && (title === host || title === `www.${host}`)) {
		return Boolean(preview.image || preview.icon);
	}
	return true;
}

/** Build a deterministic card from the URL alone. This function never performs I/O. */
export function localLinkCard(value: string): LocalLinkCard | null {
	const normalized = normalizePreviewUrl(value);
	if (!normalized) return null;
	const parsed = new URL(normalized);
	const hostname = parsed.hostname.replace(/^www\./i, '');
	const pathAndQuery = `${parsed.pathname}${parsed.search}`;
	const path = pathAndQuery === '/' ? '' : pathAndQuery;
	const label = hostname.split('.').filter(Boolean).at(0) ?? hostname;
	const badge = Array.from(label)[0]?.toLocaleUpperCase() || '↗';
	return { url: normalized, hostname, path, badge };
}
