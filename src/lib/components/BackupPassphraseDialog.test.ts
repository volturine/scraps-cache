import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import BackupPassphraseDialog from './BackupPassphraseDialog.svelte';

function dispatchPointerDown(target: Element): MouseEvent {
	const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	return event;
}

describe('BackupPassphraseDialog', () => {
	it('focuses the passphrase caret without allowing native viewport panning', () => {
		render(BackupPassphraseDialog, {
			props: {
				mode: 'import',
				onSubmit: vi.fn(),
				onClose: vi.fn()
			}
		});
		const input = document.body.querySelector('input[type="password"]') as HTMLInputElement;
		input.value = 'secret passphrase';

		const pointerDown = dispatchPointerDown(input);

		expect(pointerDown.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(input);
		expect(input.selectionStart).toBe(input.value.length);
		expect(input.selectionEnd).toBe(input.value.length);
	});
});
