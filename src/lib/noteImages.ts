import { uid } from './utils';
import type { NoteImage } from './types';
import { extractDngJpeg, isDngFile, jpegName } from './dngCanonical';
import { dataUrlToBlob } from './imageBlob';
import { makeImageThumbDataUrl } from './imageThumb';
import { optimizeImageBlob, optimizedImageName, type ImageQuality } from './imageOptimize';
import { sha256 } from './syncHash';

/** Browser-renderable image (preview / fullscreen). Excludes raw DNG before convert. */
export function isImageMime(mime: string): boolean {
	const m = (mime || '').toLowerCase();
	if (!m.startsWith('image/')) return false;
	if (m.includes('dng') || m === 'image/tiff' || m === 'image/x-adobe-dng') return false;
	return true;
}

export function isImageAttachment(att: Pick<NoteImage, 'mime'>): boolean {
	return isImageMime(att.mime);
}

/** Approximate byte size from a data URL (for UI only). */
export function dataUrlByteLength(dataUrl: string): number {
	const i = dataUrl.indexOf(',');
	const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
	return Math.floor((b64.length * 3) / 4);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileIconLabel(mime: string, name?: string): string {
	const m = (mime || '').toLowerCase();
	const ext = (name?.split('.').pop() || '').toLowerCase();
	if (m.includes('pdf') || ext === 'pdf') return 'PDF';
	if (m.includes('zip') || m.includes('compressed') || ext === 'zip' || ext === 'rar') return 'ZIP';
	if (m.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac'].includes(ext)) return 'AUD';
	if (m.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(ext)) return 'VID';
	if (m.includes('sheet') || m.includes('excel') || ['xls', 'xlsx', 'csv'].includes(ext))
		return 'XLS';
	if (m.includes('word') || ['doc', 'docx'].includes(ext)) return 'DOC';
	if (m.includes('text') || ['txt', 'md', 'json'].includes(ext)) return 'TXT';
	return (ext || 'FILE').slice(0, 4).toUpperCase();
}

/**
 * Store any file as a note attachment (data URL).
 * DNG → embedded JPEG for preview; photos keep full bytes plus a small thumb; non-images as-is.
 * No size cap (same as photos).
 */
export async function fileToNoteImage(file: File, imageQuality: ImageQuality): Promise<NoteImage> {
	let image: Blob = file;
	let mime = file.type || 'application/octet-stream';
	let name = file.name;
	if (isDngFile(file)) {
		const jpeg = Uint8Array.from(extractDngJpeg(await file.arrayBuffer()));
		image = new Blob([jpeg.buffer], { type: 'image/jpeg' });
		mime = 'image/jpeg';
		name = jpegName(file.name);
	} else if (!mime || mime === 'application/octet-stream') {
		const ext = name.split('.').pop()?.toLowerCase();
		const byExt: Record<string, string> = {
			pdf: 'application/pdf',
			txt: 'text/plain',
			md: 'text/markdown',
			json: 'application/json',
			csv: 'text/csv',
			yaml: 'text/yaml',
			yml: 'text/yaml',
			zip: 'application/zip',
			png: 'image/png',
			jpg: 'image/jpeg',
			jpeg: 'image/jpeg',
			webp: 'image/webp',
			gif: 'image/gif',
			heic: 'image/heic',
			mp3: 'audio/mpeg',
			mp4: 'video/mp4'
		};
		if (ext && byExt[ext]) mime = byExt[ext];
	}
	let optimized:
		{ width: number; height: number; byteSize: number; encodingVersion: number } | undefined;
	if (isImageMime(mime)) {
		try {
			const result = await optimizeImageBlob(image, imageQuality);
			image = result.blob;
			mime = 'image/webp';
			name = optimizedImageName(name);
			optimized = {
				width: result.width,
				height: result.height,
				byteSize: result.byteSize,
				encodingVersion: result.encodingVersion
			};
		} catch {
			// Keep an undecodable image as an ordinary downloadable attachment.
			mime = 'application/octet-stream';
		}
	}
	const dataUrl = await readBlobAsDataUrl(image);
	const contentHash = await sha256(dataUrl);
	const thumbUrl = isImageMime(mime)
		? ((await makeImageThumbDataUrl(dataUrl)) ?? undefined)
		: undefined;
	return {
		id: uid(),
		mime,
		dataUrl,
		...(thumbUrl ? { thumbUrl } : {}),
		name,
		createdAt: Date.now(),
		contentHash,
		...(optimized ?? { byteSize: image.size })
	};
}

/** Drop full bytes from memory while keeping the small resident thumb (and IDB full blob). */
export function stripFullImageBytes(image: NoteImage): NoteImage {
	if (!isImageMime(image.mime)) return image;
	if (!image.dataUrl) return image;
	return { ...image, dataUrl: '' };
}

export function isInlinePreviewable(att: Pick<NoteImage, 'mime'>): boolean {
	const mime = att.mime.toLowerCase();
	return (
		mime === 'application/pdf' ||
		mime.startsWith('text/') ||
		mime === 'application/json' ||
		mime === 'application/yaml' ||
		mime === 'application/x-yaml' ||
		mime.startsWith('audio/') ||
		mime.startsWith('video/')
	);
}

/** Open an unsupported attachment through the platform save/share flow. */
export async function openAttachment(att: NoteImage): Promise<void> {
	const blob = await dataUrlToBlob(att.dataUrl);
	const name = att.name?.trim() || 'attachment';
	const mime = att.mime || blob.type || 'application/octet-stream';
	const file = new File([blob], name, { type: mime });

	if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function') {
		try {
			if (navigator.canShare({ files: [file] })) {
				await navigator.share({ files: [file], title: name });
				return;
			}
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') return;
		}
	}

	const url = URL.createObjectURL(blob);
	const revoke = () => {
		try {
			URL.revokeObjectURL(url);
		} catch {
			/* ignore */
		}
	};

	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(revoke, 60_000);
}

function readBlobAsDataUrl(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
		reader.readAsDataURL(file);
	});
}
