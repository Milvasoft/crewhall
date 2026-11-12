import '@fontsource-variable/nunito';
import './styles.css';
import { CrewhallMark, Icon, type IconName } from '@crewhall/ui';
import { StrictMode, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { getConnection, type Connection } from '../shared/storage';
import { t } from '../shared/i18n';

export function mount(node: ReactNode) {
  const apply = (dark: boolean) => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  apply(media.matches);
  media.addEventListener('change', (e) => apply(e.matches));
  createRoot(document.getElementById('root')!).render(<StrictMode>{node}</StrictMode>);
}

export function useConnection() {
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined);
  useEffect(() => {
    void getConnection().then(setConnection);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes.connection) void getConnection().then(setConnection);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return connection;
}

/** Loads on mount and when `deps` change; a late answer for old deps is dropped. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({
    loading: true,
  });
  const seq = useRef(0);
  const run = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    load().then(
      (data) => {
        if (mine === seq.current) setState({ data, loading: false });
      },
      (error: unknown) => {
        if (mine === seq.current) setState({ error, loading: false });
      },
    );
  }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run };
}

export function Brand({ aside }: { aside?: ReactNode }) {
  return (
    <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
      <CrewhallMark size={22} />
      <span className="min-w-0 flex-1 truncate text-sm font-bold">Crewhall</span>
      {aside}
    </header>
  );
}

export function IconAction({
  icon,
  label,
  onClick,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-fg2 hover:bg-bg2 hover:text-fg"
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

export function SelectBox({
  value,
  onChange,
  label,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 w-full rounded-lg border border-line bg-bg2 px-3 text-sm text-fg outline-none focus:border-line2 disabled:opacity-50"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Notice({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex flex-col gap-2 rounded-lg p-2.5 text-xs ${tone === 'error' ? 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger' : 'bg-bg2 text-fg2'}`}
    >
      {children}
    </div>
  );
}

export const openOptions = () => void chrome.runtime.openOptionsPage();

export function NeedsConnection() {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <CrewhallMark size={40} />
      <p className="m-0 text-sm font-bold">{t('connect.title')}</p>
      <p className="m-0 text-xs text-fg2">{t('connect.body')}</p>
      <button
        type="button"
        onClick={openOptions}
        className="h-9 cursor-pointer rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg"
      >
        {t('connect.action')}
      </button>
    </div>
  );
}
