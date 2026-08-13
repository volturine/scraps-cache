import { describe, expect, it } from 'vitest';
import { extractHttpUrls, localLinkCard, normalizePreviewUrl } from './linkPreview';

describe('extractHttpUrls', () => {
	it('returns distinct HTTP(S) links in their note order', () => {
		expect(
			extractHttpUrls(
				'Read https://example.com/a then http://example.org/b. Again: https://example.com/a'
			)
		).toEqual(['https://example.com/a', 'http://example.org/b']);
	});

	it('does not treat checklist syntax or bare domains as previews', () => {
		expect(extractHttpUrls('[ ] example.com\n[x] https://docs.example.com/guide')).toEqual([
			'https://docs.example.com/guide'
		]);
	});

	it('does not cap the number of distinct links', () => {
		const body = [1, 2, 3, 4, 5].map((n) => `https://example.com/${n}`).join('\n');
		expect(extractHttpUrls(body)).toHaveLength(5);
	});
});

describe('normalizePreviewUrl', () => {
	it('strips hash but keeps path so pages stay distinct', () => {
		expect(normalizePreviewUrl('https://github.com/org/repo#readme')).toBe(
			'https://github.com/org/repo'
		);
		expect(normalizePreviewUrl('https://github.com/org/other')).toBe(
			'https://github.com/org/other'
		);
	});
});

describe('localLinkCard', () => {
	it('derives a useful card without fetching remote metadata', () => {
		expect(localLinkCard('https://www.github.com/org/repo?tab=readme#top')).toEqual({
			url: 'https://www.github.com/org/repo?tab=readme',
			hostname: 'github.com',
			path: '/org/repo?tab=readme',
			badge: 'G'
		});
	});
});
