import { Button, Icon, Input, Spinner } from '@crewhall/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { errorText, t } from '../../shared/i18n';
import { isSafeForFilling } from '../../shared/match';
import { send, type CapturePrompt, type VaultEntry, type VaultState } from '../../shared/messages';
import { IconAction, Notice, openOptions, useLoad } from '../shell';

const usable = (tab: chrome.tabs.Tab | null) => (tab?.url?.startsWith('http') ? tab.url : null);

async function copySecret(value: string) {
  await navigator.clipboard.writeText(value);
  await send('clipboard.clearLater', { value });
}

function Unlock({ onDone }: { onDone: (s: VaultState) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await send('vault.unlock', { password }));
    } catch (err) {
      setError(errorText(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-3 p-4" onSubmit={(e) => void submit(e)}>
      <p className="m-0 text-sm font-bold">{t('vault.unlockTitle')}</p>
      <p className="m-0 text-xs text-fg2">{t('vault.unlockBody')}</p>
      <Input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={t('vault.password')}
        aria-label={t('vault.password')}
        autoComplete="off"
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button variant="pri" type="submit" loading={busy} disabled={!password}>
        {t('vault.unlock')}
      </Button>
    </form>
  );
}

function Totp({ itemId }: { itemId: string }) {
  const [code, setCode] = useState<{ code: string; remaining: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      void send('vault.totp', { itemId }).then((c) => alive && setCode(c), () => undefined);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [itemId]);
  if (!code) return null;
  return (
    <span className="font-mono text-xs text-fg2" title={t('vault.totp')}>
      {code.code} · {code.remaining}
    </span>
  );
}

function Row({
  entry,
  canFill,
  onFill,
  onCopy,
}: {
  entry: VaultEntry;
  canFill: boolean;
  onFill: () => void;
  onCopy: (field: 'username' | 'password' | 'totp') => void;
}) {
  const login = entry.type === 'login';
  return (
    <li className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{entry.name}</span>
        <span className="flex items-center gap-2">
          <span className="truncate text-xs text-fg3">{entry.username || entry.host}</span>
          {entry.hasTotp ? <Totp itemId={entry.id} /> : null}
        </span>
      </span>
      {login ? (
        <>
          {canFill && entry.matches ? (
            <Button variant="pri" size="sm" onClick={onFill}>
              {t('vault.fill')}
            </Button>
          ) : null}
          {entry.username ? (
            <IconAction icon="user" label={t('vault.copyUsername')} onClick={() => onCopy('username')} />
          ) : null}
          <IconAction icon="key" label={t('vault.copyPassword')} onClick={() => onCopy('password')} />
          {entry.hasTotp ? (
            <IconAction icon="clock" label={t('vault.copyTotp')} onClick={() => onCopy('totp')} />
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function Generator({ activeTab, onMessage }: { activeTab: chrome.tabs.Tab | null; onMessage: (m: string) => void }) {
  const [length, setLength] = useState(20);
  const [value, setValue] = useState('');

  useEffect(() => {
    void send('vault.generate', { options: { length } }).then((r) => setValue(r.value));
  }, [length]);

  const fill = async () => {
    if (activeTab?.id === undefined) return;
    await copySecret(value);
    const r = await send('vault.fillGenerated', { value, tabId: activeTab.id });
    onMessage(t(`vault.fillResult.${r}`));
    if (r === 'filled') window.close();
  };

  return (
    <div className="flex flex-col gap-2 border-t border-line p-3">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-bg2 px-2 py-1.5 font-mono text-xs">{value}</code>
        <IconAction
          icon="refresh"
          label={t('vault.regenerate')}
          onClick={() => void send('vault.generate', { options: { length } }).then((r) => setValue(r.value))}
        />
        <IconAction
          icon="copy"
          label={t('vault.copy')}
          onClick={() => {
            void copySecret(value).then(() => onMessage(t('vault.copied')));
          }}
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-fg2">
        {t('vault.length', { n: length })}
        <input
          type="range"
          min={8}
          max={64}
          value={length}
          onChange={(e) => setLength(Number(e.target.value))}
          className="min-w-0 flex-1 accent-[var(--accent)]"
        />
      </label>
      <Button variant="out" size="sm" onClick={() => void fill()}>
        {t('vault.fillGenerated')}
      </Button>
    </div>
  );
}

function PendingSave({ tabId, onDone }: { tabId: number; onDone: () => void }) {
  const { data } = useLoad<CapturePrompt | null>(() => send('capture.prompt', { tabId }), [tabId]);
  if (!data || data.mode === 'locked') return null;
  return (
    <div className="m-3 mb-0 flex items-center gap-2 rounded-lg bg-bg2 p-2.5">
      <span className="min-w-0 flex-1 text-xs">
        {t(data.mode === 'update' ? 'capture.updateQuestion' : 'capture.saveQuestion', { host: data.host })}
      </span>
      <Button
        variant="pri"
        size="sm"
        onClick={() => void send('capture.save', { tabId, id: data.id }).then(onDone)}
      >
        {t(data.mode === 'update' ? 'capture.update' : 'capture.save')}
      </Button>
    </div>
  );
}

export function VaultPanel({ enabled, activeTab }: { enabled: boolean; activeTab: chrome.tabs.Tab | null }) {
  const state = useLoad(() => send('vault.state', {}), []);
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [q, setQ] = useState('');
  const [showGenerator, setShowGenerator] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isOpen = unlocked ?? state.data?.unlocked ?? false;
  const pageUrl = usable(activeTab);
  const list = useLoad(
    () => (isOpen ? send('vault.list', { pageUrl }) : Promise.resolve<VaultEntry[]>([])),
    [isOpen, pageUrl],
  );

  const shown = useMemo(() => {
    const term = q.trim().toLocaleLowerCase('tr');
    const all = list.data ?? [];
    if (!term) return all.filter((e) => e.matches || e.favorite).concat(all.filter((e) => !e.matches && !e.favorite)).slice(0, 100);
    return all
      .filter((e) => [e.name, e.username, e.host].some((v) => v.toLocaleLowerCase('tr').includes(term)))
      .slice(0, 100);
  }, [list.data, q]);

  if (!enabled) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="m-0 text-sm font-bold">{t('vault.offTitle')}</p>
        <p className="m-0 text-xs text-fg2">{t('vault.offBody')}</p>
        <Button variant="pri" onClick={openOptions}>
          {t('vault.turnOn')}
        </Button>
      </div>
    );
  }
  if (state.loading && !state.data) return <Spinner className="m-auto my-8" />;
  if (state.error) return <div className="p-4"><Notice tone="error">{errorText(state.error)}</Notice></div>;
  if (state.data?.setUp === false) {
    return (
      <div className="p-4">
        <p className="m-0 text-xs text-fg2">{t('vault.notSetUp')}</p>
      </div>
    );
  }
  if (!isOpen) return <Unlock onDone={(s) => setUnlocked(s.unlocked)} />;

  const canFill = Boolean(activeTab?.id !== undefined && pageUrl && isSafeForFilling(pageUrl));

  const fill = async (itemId: string) => {
    if (activeTab?.id === undefined) return;
    try {
      const r = await send('vault.fill', { itemId, tabId: activeTab.id });
      if (r === 'filled') window.close();
      else setMessage(t(`vault.fillResult.${r}`));
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  const copy = async (itemId: string, field: 'username' | 'password' | 'totp') => {
    try {
      const { value } = await send('vault.secret', { itemId, field });
      await copySecret(value);
      setMessage(t('vault.copied'));
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {activeTab?.id !== undefined ? <PendingSave tabId={activeTab.id} onDone={list.reload} /> : null}
      <div className="flex items-center gap-1.5 p-3 pb-2">
        <Input
          icon="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('vault.search')}
          aria-label={t('vault.search')}
          className="min-w-0 flex-1"
          autoFocus
        />
        <IconAction icon="dice" label={t('vault.generate')} onClick={() => setShowGenerator((v) => !v)} />
        <IconAction
          icon="lock"
          label={t('vault.lock')}
          onClick={() => void send('vault.lock', {}).then(() => setUnlocked(false))}
        />
      </div>
      {pageUrl && !canFill ? (
        <p className="mx-3 mb-2 flex items-center gap-1.5 text-xs text-warning">
          <Icon name="alert" size={13} />
          {t('vault.insecurePage')}
        </p>
      ) : null}
      {message ? <p role="status" className="mx-3 mb-2 text-xs text-fg2">{message}</p> : null}
      <ul className="m-0 min-h-24 flex-1 list-none overflow-y-auto px-1 pb-2">
        {list.loading && !list.data ? <Spinner className="m-auto my-6 block" /> : null}
        {shown.map((entry) => (
          <Row
            key={entry.id}
            entry={entry}
            canFill={canFill}
            onFill={() => void fill(entry.id)}
            onCopy={(field) => void copy(entry.id, field)}
          />
        ))}
        {list.data && !shown.length ? (
          <li className="p-4 text-center text-xs text-fg3">{t('vault.empty')}</li>
        ) : null}
      </ul>
      {showGenerator ? <Generator activeTab={activeTab} onMessage={setMessage} /> : null}
    </div>
  );
}
