import { describe, expect, it } from 'vitest';
import { extractDngJpeg, isDngFile, jpegName } from './dngCanonical';

function jpeg(width: number, height: number): Uint8Array {
	return Uint8Array.from([
		0xff,
		0xd8,
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x03,
		0x01,
		0x11,
		0x00,
		0x02,
		0x11,
		0x00,
		0x03,
		0x11,
		0x00,
		0xff,
		0xd9
	]);
}

function dng(littleEndian: boolean, previews: Uint8Array[]): Uint8Array {
	const ifdCount = previews.length * 2;
	const ifdSize = 2 + ifdCount * 12 + 4;
	const jpegStart = 8 + ifdSize;
	const total = Math.max(16, jpegStart + previews.reduce((sum, image) => sum + image.length, 0));
	const bytes = new Uint8Array(total);
	const view = new DataView(bytes.buffer);
	bytes[0] = littleEndian ? 0x49 : 0x4d;
	bytes[1] = bytes[0];
	view.setUint16(2, 42, littleEndian);
	view.setUint32(4, 8, littleEndian);
	view.setUint16(8, ifdCount, littleEndian);

	let offset = jpegStart;
	previews.forEach((image, index) => {
		const offsetEntry = 10 + index * 24;
		view.setUint16(offsetEntry, 513, littleEndian);
		view.setUint16(offsetEntry + 2, 4, littleEndian);
		view.setUint32(offsetEntry + 4, 1, littleEndian);
		view.setUint32(offsetEntry + 8, offset, littleEndian);
		const lengthEntry = offsetEntry + 12;
		view.setUint16(lengthEntry, 514, littleEndian);
		view.setUint16(lengthEntry + 2, 4, littleEndian);
		view.setUint32(lengthEntry + 4, 1, littleEndian);
		view.setUint32(lengthEntry + 8, image.length, littleEndian);
		bytes.set(image, offset);
		offset += image.length;
	});
	return bytes;
}

describe('extractDngJpeg', () => {
	it.each([true, false])(
		'extracts the largest declared preview (littleEndian=%s)',
		(littleEndian) => {
			const small = jpeg(320, 240);
			const large = jpeg(4032, 3024);
			expect(extractDngJpeg(dng(littleEndian, [small, large]))).toEqual(large);
		}
	);

	it('rejects a TIFF without a declared JPEG', () => {
		expect(() => extractDngJpeg(dng(true, []))).toThrow(/JPEG/);
	});
});

describe('DNG normalization metadata', () => {
	it('recognizes MIME types and extensions', () => {
		expect(isDngFile({ name: 'IMG_0012.DNG', type: '' })).toBe(true);
		expect(isDngFile({ name: 'photo', type: 'image/dng' })).toBe(true);
		expect(isDngFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false);
		expect(jpegName('IMG_0012.DNG')).toBe('IMG_0012.jpg');
	});
});
