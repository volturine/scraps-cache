import type { LinkPreview } from './linkPreview';

// Core domain types for Scraps Cache notes.

export type NoteColor =
	| 'default'
	| 'red'
	| 'orange'
	| 'yellow'
	| 'green'
	| 'teal'
	| 'blue'
	| 'darkblue'
	| 'purple'
	| 'pink'
	| 'brown'
	| 'gray';

export interface NoteImage {
	id: string;
	mime: string;
	/**
	 * Full attachment bytes as a data URL when loaded into memory.
	 * Empty while only the resident thumbnail is held for grid/list display.
	 */
	dataUrl: string;
	/** Small always-resident preview for photos and editable canvases. */
	thumbUrl?: string;
	name?: string;
	createdAt: number;
	/** Decoded image dimensions or drawing content bounds. */
	width?: number;
	height?: number;
	/** Stored attachment bytes, excluding data-URL overhead. */
	byteSize?: number;
	/** SHA-256 of the stored data URL, retained when full bytes leave memory. */
	contentHash?: string;
	/** Attachment encoding recipe used to produce the stored bytes. */
	encodingVersion?: number;
}

/** Alias for clarity; same shape as NoteImage (wire field remains `images`). */
export type NoteAttachment = NoteImage;

/** Per-field write times for last-write-wins merge. Missing keys fall back to `updatedAt`. */
export type NoteFieldTimes = {
	title?: number;
	body?: number;
	color?: number;
	pinned?: number;
	archived?: number;
	trashed?: number;
	reminder?: number;
	labels?: number;
	images?: number;
	linkPreviews?: number;
};

export type NoteField = keyof NoteFieldTimes;

export interface Note {
	id: string;
	title: string;
	/** Plain text body. Supports `[ ]` / `[x]` checklist lines and `- ` bullet lines. */
	body: string;
	/** Attachments (photos, files, and canvases). `images` is the canonical note field. */
	images?: NoteImage[];
	/** Saved link metadata so previews remain rich after a note is saved or synced. */
	linkPreviews?: LinkPreview[];
	color: NoteColor;
	pinned: boolean;
	archived: boolean;
	trashed: boolean;
	trashedAt: number | null;
	createdAt: number;
	updatedAt: number;
	reminder: number | null; // epoch ms
	labels: string[]; // label ids
	fieldTimes?: NoteFieldTimes;
}

export interface Label {
	id: string;
	name: string;
	createdAt: number;
	/** Changes on rename; used for deterministic offline/cloud conflict resolution. */
	updatedAt: number;
}

/** Map of color -> hex used by Scraps Cache. */
export const NOTE_COLORS: Record<NoteColor, string> = {
	default: '#ffffff',
	red: '#f28b82',
	orange: '#f6aea0',
	yellow: '#f7d875',
	green: '#b3e2a1',
	teal: '#98e9d9',
	blue: '#a9d5f4',
	darkblue: '#9bb8f3',
	purple: '#c6b3f2',
	pink: '#f9c2d8',
	brown: '#d6c5b0',
	gray: '#f0f0f0'
};

/** Ordered list for the palette popover. */
export const NOTE_COLOR_ORDER: NoteColor[] = [
	'default',
	'red',
	'orange',
	'yellow',
	'green',
	'teal',
	'blue',
	'darkblue',
	'purple',
	'pink',
	'brown',
	'gray'
];

export const NOTE_DARK_COLORS: Record<NoteColor, string> = {
	default: '#1f1f1f',
	red: '#5a3636',
	orange: '#5a4a3f',
	yellow: '#5a5240',
	green: '#3a4a3a',
	teal: '#2f4a4a',
	blue: '#2f3a4f',
	darkblue: '#2d3850',
	purple: '#3d3756',
	pink: '#4f3e4e',
	brown: '#4f4a44',
	gray: '#3c3c3c'
};
