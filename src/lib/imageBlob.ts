/** Convert data URLs ↔ Blob for IndexedDB (Safari handles Blob better than huge strings). */

/** Decode a data URL without fetch() — large iPhone photos can fail fetch(data:) / hit clone issues. */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
	if (!dataUrl.startsWith('data:')) {
		const res = await fetch(dataUrl);
		return res.blob();
	}

	const comma = dataUrl.indexOf(',');
	if (comma < 0) throw new Error('Invalid data URL');
	const header = dataUrl.slice(5, comma); // after "data:"
	const payload = dataUrl.slice(comma + 1);
	const mime = header.split(';')[0] || 'application/octet-stream';
	const isBase64 = /;base64/i.test(header);

	if (isBase64) {
		const binary = atob(payload);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return new Blob([bytes], { type: mime });
	}

	return new Blob([decodeURIComponent(payload)], { type: mime });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error('Could not read image blob'));
		reader.readAsDataURL(blob);
	});
}

export function formatStorageError(err: unknown): string {
	if (err instanceof DOMException) {
		if (err.name === 'QuotaExceededError') {
			return 'Storage full on this device — free space or remove old notes/attachments.';
		}
		if (err.name === 'AbortError') {
			return 'The browser stopped the local storage write. Keep Scraps Cache open and retry; if it repeats, free device storage.';
		}
		if (err.name === 'DataCloneError') {
			return 'Browser could not store this data — refresh and try again.';
		}
		return err.message || err.name;
	}
	if (err instanceof Error) return err.message;
	return 'Unknown storage error';
}
