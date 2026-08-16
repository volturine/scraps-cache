export type VerticalRect = { top: number; bottom: number };

const TEXT_STYLE_PROPERTIES = [
	'border-bottom-width',
	'border-left-width',
	'border-right-width',
	'border-top-width',
	'box-sizing',
	'font-family',
	'font-size',
	'font-style',
	'font-variant',
	'font-weight',
	'letter-spacing',
	'line-height',
	'overflow-wrap',
	'padding-bottom',
	'padding-left',
	'padding-right',
	'padding-top',
	'tab-size',
	'text-align',
	'text-indent',
	'text-transform',
	'word-break',
	'word-spacing'
] as const;

/** Measure the viewport position of the active line in a textarea. */
export function textareaCaretRect(textarea: HTMLTextAreaElement): VerticalRect {
	const fieldRect = textarea.getBoundingClientRect();
	const style = getComputedStyle(textarea);
	const mirror = document.createElement('div');
	mirror.setAttribute('aria-hidden', 'true');
	mirror.style.position = 'fixed';
	mirror.style.visibility = 'hidden';
	mirror.style.pointerEvents = 'none';
	mirror.style.overflow = 'hidden';
	mirror.style.whiteSpace = 'pre-wrap';
	mirror.style.left = `${fieldRect.left}px`;
	mirror.style.top = `${fieldRect.top}px`;
	mirror.style.width = `${fieldRect.width}px`;
	for (const property of TEXT_STYLE_PROPERTIES) {
		mirror.style.setProperty(property, style.getPropertyValue(property));
	}

	mirror.append(document.createTextNode(textarea.value.slice(0, textarea.selectionStart ?? 0)));
	const marker = document.createElement('span');
	marker.textContent = '\u200b';
	mirror.append(marker);
	document.body.append(mirror);

	const markerRect = marker.getBoundingClientRect();
	const mirrorRect = mirror.getBoundingClientRect();
	const parsedLineHeight = Number.parseFloat(style.lineHeight);
	const lineHeight =
		markerRect.height ||
		(Number.isFinite(parsedLineHeight)
			? parsedLineHeight
			: (Number.parseFloat(style.fontSize) || 16) * 1.2);
	const top = fieldRect.top + markerRect.top - mirrorRect.top - textarea.scrollTop;
	mirror.remove();
	return { top, bottom: top + lineHeight };
}

export function scrollTopForReveal(
	scrollTop: number,
	target: VerticalRect,
	viewport: VerticalRect,
	padding = 12
): number {
	if (target.top < viewport.top + padding) {
		return Math.max(0, scrollTop + target.top - viewport.top - padding);
	}
	if (target.bottom > viewport.bottom - padding) {
		return Math.max(0, scrollTop + target.bottom - viewport.bottom + padding);
	}
	return scrollTop;
}

export function revealEditorField(scroller: HTMLElement, field: HTMLElement, padding = 12): void {
	const target =
		field instanceof HTMLTextAreaElement ? textareaCaretRect(field) : field.getBoundingClientRect();
	const viewport = scroller.getBoundingClientRect();
	scroller.scrollTop = scrollTopForReveal(scroller.scrollTop, target, viewport, padding);
}
