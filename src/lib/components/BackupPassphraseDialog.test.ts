import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import BackupPassphraseDialog from './BackupPassphraseDialog.svelte';

function dispatchPointerDown(target: Element): MouseEvent {
	const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	return event;
}

describe('BackupPassphraseDialog', () => {
	it('leaves passphrase pointer focus and caret placement to the browser', () => {
		render(BackupPassphraseDialog, {
			props: {
				mode: 'import',
				onSubmit: vi.fn(),
				onClose: vi.fn()
			}
		});
		const input = document.body.querySelector('input[type="password"]') as HTMLInputElement;
		const pointerDown = dispatchPointerDown(input);

		expect(pointerDown.defaultPrevented).toBe(false);
		expect(input.classList.contains('bg-transparent')).toBe(false);
	});
});
