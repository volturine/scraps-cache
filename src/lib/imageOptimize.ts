const MAX_LONG_EDGE = 2560;
const TARGET_BYTES = 4 * 1024 * 1024;
const INITIAL_QUALITY = 0.82;
const MIN_QUALITY = 0.68;
const ENCODING_VERSION = 1;

export type OptimizedImage = {
	blob: Blob;
	width: number;
	height: number;
	byteSize: number;
	encodingVersion: number;
};

type Drawable = CanvasImageSource & { width: number; height: number; close?: () => void };

export function fitImageDimensions(
	width: number,
	height: number,
	maxLongEdge = MAX_LONG_EDGE
): { width: number; height: number } {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new Error('Image has invalid dimensions');
	}
	const scale = Math.min(1, maxLongEdge / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => blob ? resolve(blob) : reject(new Error('Browser could not encode this image')),
			'image/webp',
			quality
		);
	});
}

async function loadWithImageElement(source: Blob): Promise<Drawable> {
	const url = URL.createObjectURL(source);
	try {
		const image = new Image();
		image.decoding = 'async';
		const loaded = new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error('Browser could not decode this image'));
		});
		image.src = url;
		await loaded;
		return image as Drawable;
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function loadDrawable(source: Blob): Promise<Drawable> {
	if (typeof createImageBitmap === 'function') {
		return await createImageBitmap(source, { imageOrientation: 'from-image' }) as Drawable;
	}
	return loadWithImageElement(source);
}

/**
 * Re-encode a browser-decodable image before persistence.
 * Canvas output removes source metadata, including embedded GPS/EXIF blocks.
 */
export async function optimizeImageBlob(source: Blob): Promise<OptimizedImage> {
	const drawable = await loadDrawable(source);
	try {
		let dimensions = fitImageDimensions(drawable.width, drawable.height);
		let quality = INITIAL_QUALITY;
		let encoded: Blob | null = null;

		for (let attempt = 0; attempt < 8; attempt++) {
			const canvas = document.createElement('canvas');
			canvas.width = dimensions.width;
			canvas.height = dimensions.height;
			const context = canvas.getContext('2d', { alpha: true });
			if (!context) throw new Error('Browser image processing is unavailable');
			context.imageSmoothingEnabled = true;
			context.imageSmoothingQuality = 'high';
			context.drawImage(drawable, 0, 0, dimensions.width, dimensions.height);
			encoded = await canvasBlob(canvas, quality);
			canvas.width = 1;
			canvas.height = 1;
			if (encoded.size <= TARGET_BYTES) break;

			if (quality > MIN_QUALITY) {
				quality = Math.max(MIN_QUALITY, quality - 0.05);
			} else {
				dimensions = fitImageDimensions(
					Math.max(1, Math.round(dimensions.width * 0.82)),
					Math.max(1, Math.round(dimensions.height * 0.82)),
					Math.max(dimensions.width, dimensions.height)
				);
			}
		}

		if (!encoded) throw new Error('Browser could not encode this image');
		return {
			blob: encoded,
			width: dimensions.width,
			height: dimensions.height,
			byteSize: encoded.size,
			encodingVersion: ENCODING_VERSION
		};
	} finally {
		drawable.close?.();
	}
}

export function optimizedImageName(name: string): string {
	const stem = name.replace(/\.[^.]+$/, '') || 'image';
	return `${stem}.webp`;
}
