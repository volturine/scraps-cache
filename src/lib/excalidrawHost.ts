import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ExcalidrawPackage from '@excalidraw/excalidraw/dist/excalidraw.production.min.js';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types/types';
import type { CanvasElement, CanvasScene } from './canvasAttachment';

const { Excalidraw, exportToCanvas, getCommonBounds } = ExcalidrawPackage;

export interface ExcalidrawHost {
	destroy(): void;
	snapshot(): CanvasScene;
	thumbnail(): Promise<{ dataUrl: string; width: number; height: number }>;
}

interface HostOptions {
	initialScene?: CanvasScene;
	dark: boolean;
	readOnly?: boolean;
}

const SAVED_ELEMENT_TYPES = new Set([
	'rectangle',
	'diamond',
	'ellipse',
	'line',
	'arrow',
	'freedraw',
	'text'
]);

function canvasToDataUrl(canvas: HTMLCanvasElement): Promise<string> {
	return new Promise((resolve, reject) => {
		const read = (blob: Blob | null) => {
			if (!blob) {
				canvas.toBlob(readPng, 'image/png');
				return;
			}
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error ?? new Error('Could not read canvas preview.'));
			reader.readAsDataURL(blob);
		};
		const readPng = (blob: Blob | null) => {
			if (blob) {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(reader.error ?? new Error('Could not read canvas preview.'));
				reader.readAsDataURL(blob);
				return;
			}
			reject(new Error('Could not create a canvas preview.'));
		};
		canvas.toBlob(read, 'image/webp', 0.82);
	});
}

function sceneElements(elements: CanvasElement[]): ExcalidrawElement[] {
	return elements as unknown as ExcalidrawElement[];
}

export function mountExcalidraw(node: HTMLElement, options: HostOptions): Promise<ExcalidrawHost> {
	return new Promise((resolve) => {
		let root: Root | null = createRoot(node);
		let elements: readonly ExcalidrawElement[] = sceneElements(
			options.initialScene?.elements ?? []
		);
		let appState = (options.initialScene?.appState ?? {}) as Partial<AppState>;
		let files: BinaryFiles = {};

		const buildHost = (): ExcalidrawHost => ({
			destroy() {
				root?.unmount();
				root = null;
			},
			snapshot() {
				return {
					elements: elements as unknown as CanvasElement[],
					appState: appState as Record<string, unknown>
				};
			},
			async thumbnail() {
				if (elements.length === 0) throw new Error('Draw something before saving the canvas.');
				const canvas = await exportToCanvas({
					elements,
					appState: {
						...appState,
						exportBackground: true,
						exportWithDarkMode: false
					},
					files,
					maxWidthOrHeight: 480,
					exportPadding: 20
				});
				const [minX, minY, maxX, maxY] = getCommonBounds(elements);
				return {
					dataUrl: await canvasToDataUrl(canvas),
					width: Math.max(1, Math.round(maxX - minX)),
					height: Math.max(1, Math.round(maxY - minY))
				};
			}
		});

		root.render(
			React.createElement(Excalidraw, {
				initialData: options.initialScene
					? {
							elements: sceneElements(options.initialScene.elements),
							appState: options.initialScene.appState as Partial<AppState>,
							files: {}
						}
					: undefined,
				excalidrawAPI: () => resolve(buildHost()),
				onChange: (nextElements, nextAppState, nextFiles) => {
					elements = nextElements.filter((element) => SAVED_ELEMENT_TYPES.has(element.type));
					appState = nextAppState;
					files = Object.keys(nextFiles).length === 0 ? nextFiles : {};
				},
				autoFocus: true,
				detectScroll: false,
				handleKeyboardGlobally: true,
				langCode: 'en',
				theme: options.dark ? 'dark' : 'light',
				viewModeEnabled: options.readOnly ?? false,
				validateEmbeddable: false,
				renderEmbeddable: () => null,
				onLinkOpen: (_element, event) => event.preventDefault(),
				UIOptions: {
					canvasActions: {
						changeViewBackgroundColor: true,
						clearCanvas: !options.readOnly,
						export: false,
						loadScene: false,
						saveToActiveFile: false,
						toggleTheme: false,
						saveAsImage: false
					},
					tools: { image: false }
				}
			})
		);
	});
}
