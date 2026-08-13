const TYPE_SIZE: Record<number, number> = {
	1: 1, // BYTE
	2: 1, // ASCII
	3: 2, // SHORT
	4: 4, // LONG
	5: 8, // RATIONAL
	7: 1, // UNDEFINED
	9: 4, // SLONG
	10: 8 // SRATIONAL
};

type Candidate = {
	bytes: Uint8Array;
	width: number;
	height: number;
};

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
	let offset = 2;
	while (offset + 8 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		while (bytes[offset] === 0xff) offset += 1;
		const marker = bytes[offset++];
		if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
		if (offset + 2 > bytes.length) break;
		const length = (bytes[offset] << 8) | bytes[offset + 1];
		if (length < 2 || offset + length > bytes.length) break;
		if (
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf)
		) {
			return {
				height: (bytes[offset + 3] << 8) | bytes[offset + 4],
				width: (bytes[offset + 5] << 8) | bytes[offset + 6]
			};
		}
		offset += length;
	}
	return { width: 0, height: 0 };
}

/** Extract the largest JPEG preview declared by a TIFF/DNG container. */
export function extractDngJpeg(source: ArrayBuffer | Uint8Array): Uint8Array {
	const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
	if (bytes.length < 16) throw new Error('DNG file is too small');

	const order = String.fromCharCode(bytes[0], bytes[1]);
	const littleEndian = order === 'II';
	if (!littleEndian && order !== 'MM') throw new Error('Invalid DNG byte order');

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16 = (offset: number): number => {
		if (offset < 0 || offset + 2 > bytes.length) throw new Error('Invalid DNG offset');
		return view.getUint16(offset, littleEndian);
	};
	const u32 = (offset: number): number => {
		if (offset < 0 || offset + 4 > bytes.length) throw new Error('Invalid DNG offset');
		return view.getUint32(offset, littleEndian);
	};
	if (u16(2) !== 42) throw new Error('Invalid DNG/TIFF header');

	function valuesAt(entryOffset: number): number[] {
		const type = u16(entryOffset + 2);
		const count = u32(entryOffset + 4);
		const typeSize = TYPE_SIZE[type];
		if (!typeSize || count > 100_000) return [];
		const byteLength = count * typeSize;
		const start = byteLength <= 4 ? entryOffset + 8 : u32(entryOffset + 8);
		if (start < 0 || start + byteLength > bytes.length) return [];
		const values: number[] = [];
		for (let index = 0; index < count; index += 1) {
			const offset = start + index * typeSize;
			if (type === 1 || type === 7) values.push(bytes[offset]);
			else if (type === 3) values.push(u16(offset));
			else if (type === 4) values.push(u32(offset));
		}
		return values;
	}

	const queue = [u32(4)];
	const visited = new Set<number>();
	const candidates: Candidate[] = [];

	function addCandidates(offsets: number[], lengths: number[]): void {
		for (let index = 0; index < Math.min(offsets.length, lengths.length); index += 1) {
			const offset = offsets[index];
			const length = lengths[index];
			if (
				offset < 0 ||
				length < 4 ||
				offset + length > bytes.length ||
				bytes[offset] !== 0xff ||
				bytes[offset + 1] !== 0xd8
			)
				continue;
			const jpeg = bytes.slice(offset, offset + length);
			const { width, height } = jpegDimensions(jpeg);
			candidates.push({ bytes: jpeg, width, height });
		}
	}

	while (queue.length > 0 && visited.size < 128) {
		const ifdOffset = queue.shift() ?? 0;
		if (ifdOffset <= 0 || ifdOffset + 2 > bytes.length || visited.has(ifdOffset)) continue;
		visited.add(ifdOffset);
		const count = u16(ifdOffset);
		if (count > 4096 || ifdOffset + 2 + count * 12 + 4 > bytes.length) continue;

		const tags = new Map<number, number[]>();
		for (let index = 0; index < count; index += 1) {
			const entryOffset = ifdOffset + 2 + index * 12;
			const tag = u16(entryOffset);
			tags.set(tag, valuesAt(entryOffset));
		}

		addCandidates(tags.get(513) ?? [], tags.get(514) ?? []);
		addCandidates(tags.get(273) ?? [], tags.get(279) ?? []);
		addCandidates(tags.get(324) ?? [], tags.get(325) ?? []);

		for (const child of [...(tags.get(330) ?? []), ...(tags.get(34665) ?? [])]) {
			if (child > 0) queue.push(child);
		}
		const nextIfd = u32(ifdOffset + 2 + count * 12);
		if (nextIfd > 0) queue.push(nextIfd);
	}

	if (candidates.length === 0) {
		throw new Error('This DNG does not contain a browser-compatible JPEG image');
	}
	candidates.sort((a, b) => {
		const areaDifference = b.width * b.height - a.width * a.height;
		return areaDifference || b.bytes.length - a.bytes.length;
	});
	return candidates[0].bytes;
}

export function isDngFile(file: Pick<File, 'name' | 'type'>): boolean {
	return file.type.toLowerCase() === 'image/dng' || /\.dng$/i.test(file.name);
}

export function jpegName(name: string): string {
	return /\.dng$/i.test(name) ? name.replace(/\.dng$/i, '.jpg') : `${name}.jpg`;
}
