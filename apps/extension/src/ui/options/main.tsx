import { paths } from '@crewhall/shared';
import { Button, CheckboxRow, CrewhallMark, Field, Input } from '@crewhall/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { api, normalizeOrigin, signIn } from '../../shared/api';
import { errorText, t } from '../../shared/i18n';
import { send } from '../../shared/messages';
import {
  clearConnection,
  getSettings,
  setConnection,
  updateSettings,
  type Connection,
  type Settings,
} from '../../shared/storage';
import { mount, Notice, useConnection } from '../shell';

const EVERY_SITE = ['https://*/*', 'http://*/*'];

function Connect() {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const origin = normalizeOrigin(address);
    if (!origin) {
      setError(t('options.badAddress'));
      return;
    }
    setBusy(true);
    setError(null);
    // Must be the first call of the click: Chrome only shows the question during a user gesture.
    chrome.permissions
      .request({ origins: [`${origin}/*`] })
      .then(async (granted) => {
        if (!granted) throw new Error('denied');
        await setConnection(await signIn(origin));
      })
      .catch((err: unknown) => {
        setError((err as { code?: string }).code ? errorText(err) : t('options.connectFailed'));
      })
      .finally(() => setBusy(false));
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field label={t('options.address')} hint={t('options.addressHint')}>
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="crewhall.example.com"
          autoFocus
        />
      </Field>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button variant="pri" type="submit" loading={busy} disabled={!address.trim()}>
        {t('options.connect')}
      </Button>
    </form>
  );
}

function Connected({ connection }: { connection: Connection }) {
  const disconnect = async () => {
    // End this browser's session on the server too; leaving works even when that fails.
    await (async () => {
      const client = await api();
      const { items } = await client.call('listSessions');
      const current = items.find((s) => s.current);
      if (current) await client.call('revokeSession', { params: { sessionId: current.id } });
    })().catch(() => undefined);
    await send('vault.lock', {}).catch(() => undefined);
    await clearConnection();
    await chrome.permissions.remove({ origins: [`${connection.origin}/*`] }).catch(() => undefined);
  };
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-sm font-bold">{connection.userName}</p>
        <p className="m-0 truncate text-xs text-fg2">
          {connection.email} · {connection.orgName || connection.origin}
        </p>
      </div>
      <Button variant="out" size="sm" onClick={() => void disconnect()}>
        {t('options.disconnect')}
      </Button>
    </div>
  );
}

function Features({ connection }: { connection: Connection }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [chromeOff, setChromeOff] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getSettings().then(setSettings);
    void chrome.permissions.contains({ permissions: ['privacy'] }).then(async (has) => {
      if (!has) return setChromeOff(false);
      const { value } = await chrome.privacy.services.passwordSavingEnabled.get({});
      setChromeOff(value === false);
    });
  }, []);

  if (!settings) return null;

  const change = async (patch: Partial<Settings>) => {
    setSettings(await updateSettings(patch));
    await send('features.sync', {}).catch(() => undefined);
  };

  const toggleVault = (on: boolean) => {
    setError(null);
    if (!on) {
      void change({ vault: false });
      void send('vault.lock', {}).catch(() => undefined);
      void chrome.permissions.remove({ origins: EVERY_SITE, permissions: ['clipboardRead'] });
      return;
    }
    chrome.permissions
      .request({ origins: EVERY_SITE, permissions: ['clipboardRead'] })
      .then((granted) => {
        if (granted) void change({ vault: true });
        else setError(t('options.vaultDenied'));
      })
      .catch(() => setError(t('options.vaultDenied')));
  };

  const toggleChrome = (off: boolean) => {
    chrome.permissions
      .request({ permissions: ['privacy'] })
      .then(async (granted) => {
        if (!granted) return;
        await chrome.privacy.services.passwordSavingEnabled.set({ value: !off });
        setChromeOff(off);
      })
      .catch(() => undefined);
  };

  const importUrl = new URL(paths.vaultImport(), connection.origin).href;

  return (
    <div className="flex flex-col gap-3">
      <CheckboxRow checked={settings.vault} onCheckedChange={(v) => toggleVault(v === true)}>
        {t('options.vault')}
      </CheckboxRow>
      <p className="m-0 pl-[26px] text-xs text-fg3">{t('options.vaultHint')}</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {settings.vault ? (
        <>
          <CheckboxRow checked={settings.capture} onCheckedChange={(v) => void change({ capture: v === true })}>
            {t('options.capture')}
          </CheckboxRow>
          {chromeOff !== null ? (
            <CheckboxRow checked={chromeOff} onCheckedChange={(v) => toggleChrome(v === true)}>
              {t('options.chromeOff')}
            </CheckboxRow>
          ) : null}
          <div className="rounded-lg bg-bg2 p-3 text-xs text-fg2">
            <p className="m-0 mb-1 font-bold text-fg">{t('options.importTitle')}</p>
            <p className="m-0 mb-2">{t('options.importBody')}</p>
            <a href={importUrl} target="_blank" rel="noreferrer" className="font-semibold text-fg underline">
              {t('options.importAction')}
            </a>
          </div>
          {settings.neverHosts.length ? (
            <div className="flex flex-col gap-1 text-xs">
              <p className="m-0 font-bold">{t('options.neverTitle')}</p>
              {settings.neverHosts.map((host) => (
                <div key={host} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-fg2">{host}</span>
                  <Button
                    variant="gh"
                    size="sm"
                    onClick={() => void change({ neverHosts: settings.neverHosts.filter((h) => h !== host) })}
                  >
                    {t('options.remove')}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      <CheckboxRow checked={settings.badge} onCheckedChange={(v) => void change({ badge: v === true })}>
        {t('options.badge')}
      </CheckboxRow>
    </div>
  );
}

function Options() {
  const connection = useConnection();
  if (connection === undefined) return null;
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <header className="flex items-center gap-3">
        <CrewhallMark size={32} />
        <h1 className="m-0 text-lg font-bold">{t('options.title')}</h1>
      </header>
      <section className="flex flex-col gap-3 rounded-xl border border-line p-4">
        <h2 className="m-0 text-sm font-bold">{t('options.connection')}</h2>
        {connection ? <Connected connection={connection} /> : <Connect />}
      </section>
      {connection ? (
        <section className="flex flex-col gap-3 rounded-xl border border-line p-4">
          <h2 className="m-0 text-sm font-bold">{t('options.features')}</h2>
          <Features connection={connection} />
        </section>
      ) : null}
      <p className="m-0 text-center text-xs text-fg3">
        {t('options.shortcut', { keys: 'Ctrl+Shift+L' })} · {t('options.omnibox')} ·{' '}
        {chrome.runtime.getManifest().version}
      </p>
    </main>
  );
}

mount(<Options />);
