import { Field, Input, Segmented } from '@crewhall/ui';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useBootstrap } from '@/lib/useBranding';

/**
 * A link's own icon instead of the site's favicon (LinkItem.iconUrl), for single link cards and
 * group rows alike. A server without the `quick.linkEdit` capability stores neither the icon
 * nor a new address, so those fields stay hidden there.
 */
export function useLinkEditCapability(): boolean {
  const capabilities = useBootstrap().data?.server?.capabilities;
  return !capabilities || capabilities.includes('quick.linkEdit');
}

/** An icon address the server stores: https only, 2048 characters at most. */
export function isHttpsUrl(v: string): boolean {
  if (!v || v.length > 2048) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface LinkIconState {
  mode: 'auto' | 'custom';
  setMode: (m: 'auto' | 'custom') => void;
  raw: string;
  setRaw: (v: string) => void;
  /** The icon to store: the custom address, or '' for the favicon. */
  icon: string;
  ok: boolean;
}

export function useLinkIcon(initial: string | null | undefined): LinkIconState {
  const [mode, setMode] = useState<'auto' | 'custom'>(initial ? 'custom' : 'auto');
  const [raw, setRaw] = useState(initial ?? '');
  const icon = mode === 'custom' ? raw.trim() : '';
  return { mode, setMode, raw, setRaw, icon, ok: mode === 'auto' || isHttpsUrl(icon) };
}

export function LinkIconField({ state }: { state: LinkIconState }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      <span className="text-cap font-semibold">{t('quick.editLink.icon')}</span>
      <Segmented
        aria-label={t('quick.editLink.icon')}
        value={state.mode}
        onValueChange={state.setMode}
        options={[
          { value: 'auto', label: t('quick.editLink.iconAuto') },
          { value: 'custom', label: t('quick.editLink.iconCustom') },
        ]}
      />
      {state.mode === 'custom' ? (
        <Field
          label={t('quick.editLink.iconUrl')}
          error={state.icon && !state.ok ? t('quick.editLink.iconHttps') : undefined}
        >
          <Input
            value={state.raw}
            onChange={(e) => state.setRaw(e.target.value)}
            inputMode="url"
            placeholder="https://"
          />
        </Field>
      ) : null}
    </div>
  );
}
