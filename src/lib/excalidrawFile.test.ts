import { describe, expect, it } from 'vitest';
import {
	cleanCanvasName,
	convertExcalidrawFileToCanvas,
	isExcalidrawFile,
	isExcalidrawFileName,
	parseExcalidrawScene
} from './excalidrawFile';
import { CANVAS_MIME, decodeCanvasAttachment } from './canvasAttachment';

describe('Excalidraw file detection', () => {
	it('identifies excalidraw file extensions', () => {
		expect(isExcalidrawFileName('diagram.excalidraw')).toBe(true);
		expect(isExcalidrawFileName('my-plan.excalidraw.json')).toBe(true);
		expect(isExcalidrawFileName('sketch.excalidraw.png')).toBe(true);
		expect(isExcalidrawFileName('drawing.excalidraw.svg')).toBe(true);
		expect(isExcalidrawFileName('UPPERCASE.EXCALIDRAW')).toBe(true);

		expect(isExcalidrawFileName('photo.png')).toBe(false);
		expect(isExcalidrawFileName('document.pdf')).toBe(false);
		expect(isExcalidrawFileName('data.json')).toBe(false);
		expect(isExcalidrawFileName('vector.svg')).toBe(false);
	});

	it('detects excalidraw files by extension or mime', async () => {
		const excalidrawFile = new File(['{}'], 'scene.excalidraw', {
			type: 'application/octet-stream'
		});
		expect(await isExcalidrawFile(excalidrawFile)).toBe(true);

		const mimeFile = new File(['{}'], 'data.bin', {
			type: 'application/vnd.excalidraw+json'
		});
		expect(await isExcalidrawFile(mimeFile)).toBe(true);

		const textFile = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
		expect(await isExcalidrawFile(textFile)).toBe(false);
	});

	it('detects excalidraw files by JSON content', async () => {
		const jsonScene = JSON.stringify({
			type: 'excalidraw',
			version: 2,
			source: 'https://excalidraw.com',
			elements: []
		});
		const jsonFile = new File([jsonScene], 'export.json', { type: 'application/json' });
		expect(await isExcalidrawFile(jsonFile)).toBe(true);

		const elementsOnlyJson = JSON.stringify({
			elements: [{ id: '1', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 }]
		});
		const elementsFile = new File([elementsOnlyJson], 'drawing.json', {
			type: 'application/json'
		});
		expect(await isExcalidrawFile(elementsFile)).toBe(true);

		const regularJson = JSON.stringify({ name: 'package', version: '1.0.0' });
		const normalJsonFile = new File([regularJson], 'package.json', {
			type: 'application/json'
		});
		expect(await isExcalidrawFile(normalJsonFile)).toBe(false);
	});

	it('detects excalidraw scenes embedded in SVG files', async () => {
		const svgWithPayload = `
			<svg xmlns="http://www.w3.org/2000/svg">
				<!-- payload-type:application/vnd.excalidraw+json -->
				<!-- payload-version:2 -->
				<!-- payload-start -->ewogICJ0eXBlIjogImV4Y2FsaWRyYXciCn0=<!-- payload-end -->
				<rect width="100" height="100" />
			</svg>
		`;
		const svgFile = new File([svgWithPayload], 'diagram.svg', { type: 'image/svg+xml' });
		expect(await isExcalidrawFile(svgFile)).toBe(true);

		const plainSvg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10" /></svg>';
		const plainSvgFile = new File([plainSvg], 'icon.svg', { type: 'image/svg+xml' });
		expect(await isExcalidrawFile(plainSvgFile)).toBe(false);
	});
});

describe('Excalidraw canvas name cleaning', () => {
	it('extracts clean names from various excalidraw file names', () => {
		expect(cleanCanvasName('Architecture.excalidraw')).toBe('Architecture');
		expect(cleanCanvasName('Sprint Plan 2026.excalidraw.json')).toBe('Sprint Plan 2026');
		expect(cleanCanvasName('flow-diagram.excalidraw.png')).toBe('flow-diagram');
		expect(cleanCanvasName('UI Mockup.excalidraw.svg')).toBe('UI Mockup');
		expect(cleanCanvasName('raw-scene.json')).toBe('raw-scene');
		expect(cleanCanvasName('.excalidraw')).toBe('Canvas');
		expect(cleanCanvasName('   ')).toBe('Canvas');
	});
});

describe('Excalidraw parsing and conversion', () => {
	const validExcalidrawContent = JSON.stringify({
		type: 'excalidraw',
		version: 2,
		source: 'https://excalidraw.com',
		elements: [
			{
				id: 'rect-1',
				type: 'rectangle',
				x: 50,
				y: 60,
				width: 200,
				height: 100,
				strokeColor: '#e03131',
				backgroundColor: '#ffc9c9',
				isDeleted: false
			},
			{
				id: 'deleted-1',
				type: 'rectangle',
				x: 0,
				y: 0,
				width: 50,
				height: 50,
				isDeleted: true
			}
		],
		appState: {
			viewBackgroundColor: '#fafafa',
			gridSize: 20
		},
		files: {}
	});

	it('parses excalidraw scenes and filters deleted elements', async () => {
		const file = new File([validExcalidrawContent], 'Architecture Diagram.excalidraw');
		const { scene, name } = await parseExcalidrawScene(file, file.name);

		expect(name).toBe('Architecture Diagram');
		expect(scene.elements).toHaveLength(1);
		expect(scene.elements[0].id).toBe('rect-1');
		expect(scene.appState.viewBackgroundColor).toBe('#fafafa');
	});

	it('rejects empty excalidraw files with a clear error message', async () => {
		const emptyContent = JSON.stringify({
			type: 'excalidraw',
			version: 2,
			elements: []
		});
		const file = new File([emptyContent], 'empty.excalidraw');
		await expect(parseExcalidrawScene(file, file.name)).rejects.toThrow(
			'This Excalidraw file contains no drawings.'
		);
	});

	it('transforms an excalidraw file into a canvas attachment with our integration', async () => {
		const file = new File([validExcalidrawContent], 'Sprint Planning.excalidraw');
		const attachment = await convertExcalidrawFileToCanvas(file);

		expect(attachment.mime).toBe(CANVAS_MIME);
		expect(attachment.name).toBe('Sprint Planning');
		expect(attachment.thumbUrl).toBeTruthy();
		expect(attachment.dataUrl).toBeTruthy();
		expect(attachment.contentHash).toBeTruthy();

		// Verify the converted attachment can be decoded natively by CanvasEditor
		const decoded = await decodeCanvasAttachment(attachment);
		expect(decoded.elements).toHaveLength(1);
		expect(decoded.elements[0].id).toBe('rect-1');
		expect(decoded.appState.viewBackgroundColor).toBe('#fafafa');
	});
});
