import { beforeEach } from 'vitest';

// jsdom has no dialog.showModal/close — components only need open/close
// semantics. Shared setupFile for the vitest component project (#80).
beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute('open', '');
	};
	HTMLDialogElement.prototype.close = function () {
		this.removeAttribute('open');
		this.dispatchEvent(new Event('close'));
	};
});
