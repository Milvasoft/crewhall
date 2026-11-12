/** Clears a copied secret, but only if the clipboard still holds it (design 8.6). */
chrome.runtime.onMessage.addListener((message: { t?: string; value?: string }, _sender, respond) => {
  if (message.t !== 'offscreen.clear') return false;
  const box = document.getElementById('box') as HTMLTextAreaElement;
  box.value = '';
  box.focus();
  document.execCommand('paste');
  if (box.value === message.value) {
    box.value = ' ';
    box.select();
    document.execCommand('copy');
  }
  box.value = '';
  respond(null);
  return false;
});
