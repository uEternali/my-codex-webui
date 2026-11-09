export function createConfirmDialog(dialog) {
  const titleNode = dialog.querySelector('[data-confirm-title]');
  const messageNode = dialog.querySelector('[data-confirm-message]');
  const confirmButton = dialog.querySelector('[value="confirm"]');
  const cancelButton = dialog.querySelector('[value="cancel"]');
  let pending = false;

  return function confirmAction({ title, message, confirmLabel }) {
    // Do not replace a confirmation that is already awaiting an answer.
    if (pending || dialog.open) return Promise.resolve(false);
    pending = true;
    titleNode.textContent = title;
    messageNode.textContent = message;
    confirmButton.textContent = confirmLabel;
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {
      const closed = () => {
        pending = false;
        resolve(dialog.returnValue === 'confirm');
      };
      dialog.addEventListener('close', closed, { once: true });
      try {
        dialog.showModal();
        cancelButton.focus();
      } catch {
        dialog.removeEventListener('close', closed);
        pending = false;
        resolve(false);
      }
    });
  };
}
