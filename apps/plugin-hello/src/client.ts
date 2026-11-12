import { connect, type Theme } from '@crewhall/plugin-sdk/bridge';

/**
 * The page inside Crewhall's iframe. It talks to Crewhall only through the bridge: who and
 * where we are, a session token for our own server, toasts and the card height.
 */
const $ = (id: string) => document.getElementById(id)!;

function applyTheme(theme: Theme) {
  document.body.classList.toggle('dark', theme.scheme === 'dark');
  document.documentElement.style.setProperty('--accent', theme.accent);
}

const bridge = await connect();
const { context } = bridge;
applyTheme(context.theme);
bridge.onTheme(applyTheme);

$('hello').textContent = `Merhaba ${context.user.name}`;
$('where').textContent =
  context.placement === 'card'
    ? `${context.org.name} · bugün ${new Date().toLocaleDateString(context.locale)}`
    : `${context.org.name} kurumunda, "${context.entryId}" sekmesindesin.`;

const button = $('whoami') as HTMLButtonElement;
button.hidden = context.placement === 'card';
button.addEventListener('click', async () => {
  const token = await bridge.getToken();
  const res = await fetch('/api/whoami', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'crewhall-installation': context.installationId },
  });
  const out = $('out');
  out.hidden = false;
  out.textContent = JSON.stringify(await res.json(), null, 2);
  await bridge.toast(res.ok ? 'Sunucu seni tanıdı' : 'Doğrulanamadı', res.ok ? 'info' : 'error');
});

if (context.placement === 'card') {
  await bridge.resize(document.body.scrollHeight);
}
