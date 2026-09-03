import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import AttachmentFullscreen from './AttachmentFullscreen.svelte';
import type { NoteImage } from '$lib/types';

function pdfAttachment(partial: Partial<NoteImage> = {}): NoteImage {
	return {
		id: 'pdf-1',
		mime: 'application/pdf',
		name: 'doc.pdf',
		dataUrl: `data:application/pdf;base64,${btoa('%PDF-1.4')}`,
		createdAt: 1,
		...partial
	};
}

describe('AttachmentFullscreen PDF viewer', () => {
	it('renders a PDF blob in an unsandboxed iframe', async () => {
		render(AttachmentFullscreen, {
			props: {
				attachment: pdfAttachment(),
				onClose: () => {}
			}
		});

		const iframe = await waitFor(() => {
			const node = document.body.querySelector('iframe');
			expect(node).toBeTruthy();
			return node as HTMLIFrameElement;
		});

		expect(iframe.getAttribute('sandbox')).toBeNull();
		expect(iframe.getAttribute('src')).toMatch(/^blob:/);
		expect(iframe.getAttribute('title')).toBe('doc.pdf');
	});

	it('shows an error when the PDF bytes are missing', async () => {
		render(AttachmentFullscreen, {
			props: {
				attachment: pdfAttachment({ dataUrl: '' }),
				onClose: () => {}
			}
		});

		await waitFor(() => {
			expect(document.body.textContent).toContain('Could not open this attachment.');
		});
		expect(document.body.querySelector('iframe')).toBeNull();
	});
});
