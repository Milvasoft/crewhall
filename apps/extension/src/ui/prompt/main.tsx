import { Button, CrewhallMark } from '@crewhall/ui';
import { useEffect, useState } from 'react';
import { errorText, t } from '../../shared/i18n';
import { send } from '../../shared/messages';
import { mount, SelectBox, useLoad } from '../shell';

/**
 * The browser's own report that this frame is really on screen, unobscured and untransformed. A
 * page can make the frame transparent under its own button to steal the click; then this is false
 * and the buttons stay off (the same question is also in the toolbar popup).
 */
function useReallyVisible(holdMs = 500) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1] as IntersectionObserverEntry & { isVisible?: boolean };
        clearTimeout(timer);
        if (last.isVisible) timer = setTimeout(() => setVisible(true), holdMs);
        else setVisible(false);
      },
      { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
    );
    observer.observe(document.body);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [holdMs]);
  return visible;
}

/** Runs in an extension frame on the page: the page cannot read it, and it never gets the password. */
function Prompt() {
  const { data, loading } = useLoad(() => send('capture.prompt', {}), []);
  const [vaultId, setVaultId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = useReallyVisible();

  const close = (never = false) => void send('capture.dismiss', { never });
  if (loading) return null;
  if (!data) {
    close();
    return null;
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await send('capture.save', { id: data.id, ...(vaultId ? { vaultId } : {}) });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const question =
    data.mode === 'update'
      ? t('capture.updateQuestion', { host: data.host })
      : data.mode === 'locked'
        ? t('capture.lockedQuestion', { host: data.host })
        : t('capture.saveQuestion', { host: data.host });

  return (
    <div className="flex h-screen flex-col gap-2.5 bg-surface p-3">
      <div className="flex items-start gap-2">
        <CrewhallMark size={20} />
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[13px] font-bold">{question}</p>
          {data.username ? <p className="m-0 truncate text-xs text-fg2">{data.username}</p> : null}
        </div>
      </div>
      {data.mode === 'new' && data.vaults.length > 1 ? (
        <SelectBox
          label={t('capture.vault')}
          value={vaultId || (data.vaults[0]?.id ?? '')}
          onChange={setVaultId}
          options={data.vaults.map((v) => ({ value: v.id, label: v.name ?? t('capture.personalVault') }))}
        />
      ) : null}
      {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
      <div className="mt-auto flex items-center gap-2">
        <Button variant="gh" size="sm" disabled={!visible} onClick={() => close(true)}>
          {t('capture.never')}
        </Button>
        <span className="flex-1" />
        <Button variant="out" size="sm" onClick={() => close()}>
          {t('capture.notNow')}
        </Button>
        {data.mode === 'locked' ? (
          <Button variant="pri" size="sm" disabled={!visible} onClick={() => void send('capture.openUnlock', {})}>
            {t('capture.openVault')}
          </Button>
        ) : (
          <Button variant="pri" size="sm" loading={busy} disabled={!visible} onClick={() => void save()}>
            {t(data.mode === 'update' ? 'capture.update' : 'capture.save')}
          </Button>
        )}
      </div>
    </div>
  );
}

mount(<Prompt />);
