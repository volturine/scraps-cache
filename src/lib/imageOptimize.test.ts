import { describe, expect, it } from 'vitest';
import { fitImageDimensions, imageOptimizationRecipe, optimizedImageName } from './imageOptimize';

describe('image optimization geometry', () => {
	it('fits landscape and portrait images without upscaling', () => {
		expect(fitImageDimensions(6000, 4000)).toEqual({ width: 2560, height: 1707 });
		expect(fitImageDimensions(3000, 5000)).toEqual({ width: 1536, height: 2560 });
		expect(fitImageDimensions(800, 600)).toEqual({ width: 800, height: 600 });
	});

	it('rejects invalid dimensions', () => {
		expect(() => fitImageDimensions(0, 100)).toThrow('invalid dimensions');
		expect(() => fitImageDimensions(Number.NaN, 100)).toThrow('invalid dimensions');
	});

	it('uses a privacy-preserving re-encoded filename', () => {
		expect(optimizedImageName('holiday.HEIC')).toBe('holiday.webp');
		expect(optimizedImageName('image')).toBe('image.webp');
	});

	it('uses a text-legible compressed size and a larger HD recipe', () => {
		const compressed = imageOptimizationRecipe('compressed');
		const hd = imageOptimizationRecipe('hd');
		expect(compressed.maxLongEdge).toBeGreaterThanOrEqual(1600);
		expect(compressed.maxLongEdge).toBeLessThan(hd.maxLongEdge);
		expect(compressed.targetBytes).toBeLessThan(hd.targetBytes);
		expect(compressed.encodingVersion).not.toBe(hd.encodingVersion);
	});
});
