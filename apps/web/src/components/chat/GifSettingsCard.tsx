import { GifKeyTier, GifRating, type GifTestResult } from '@crewhall/shared';
import {
  Badge,
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { bootstrapQuery } from '@/lib/queries';
import { useI18n } from '@/lib/i18n/I18nContext';

const gifSettingsKey = ['org', 'gif'] as const;

/**
 * Yönetim › Entegrasyonlar › GIF (GIPHY): the org's own key (written, never shown back),
 * on/off, rating and language, and a test that asks GIPHY for trending GIFs.
 */
export function GifSettingsCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data: s } = useQuery({
    queryKey: gifSettingsKey,
    queryFn: () => api.call('getGifSettings'),
  });
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<GifTestResult | null>(null);
  if (!s) return null;

  const save = async (body: Parameters<typeof api.call<'updateGifSettings'>>[1]['body']) => {
    setBusy(true);
    try {
      qc.setQueryData(gifSettingsKey, await api.call('updateGifSettings', { body }));
      // The chat.gif capability follows the setting.
      void qc.invalidateQueries({ queryKey: bootstrapQuery.queryKey });
      toast(t('chat.gif.admin.saved'));
      return true;
    } catch (e) {
      toast.error(t(errorKey(e)));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    try {
      setTest(await api.call('testGifSettings'));
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={t('chat.gif.admin.title')}
      className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-line"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-bg2 text-[13px] font-black">
          GIF
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 text-sub font-semibold">{t('chat.gif.admin.title')}</h2>
          <span className="text-xs text-fg2">{t('chat.gif.admin.hint')}</span>
        </div>
        <Badge tone={s.active ? 'ok' : 'default'}>
          {t(s.active ? 'chat.gif.admin.active' : 'chat.gif.admin.inactive')}
        </Badge>
      </div>
      <label className="flex items-center gap-2 text-cap font-semibold">
        <Switch
          checked={s.enabled}
          disabled={busy}
          aria-label={t('chat.gif.admin.enabled')}
          onCheckedChange={(v) => void save({ enabled: v })}
        />
        {t('chat.gif.admin.enabled')}
      </label>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) void save({ apiKey: key.trim() }).then((ok) => ok && setKey(''));
        }}
      >
        <Field
          label={t('chat.gif.admin.key')}
          hint={
            s.apiKey.set
              ? t('chat.gif.admin.keySet', { key: s.apiKey.hint ?? '' })
              : t('chat.gif.admin.keyMissing')
          }
          className="min-w-[240px] flex-1"
        >
          <Input
            type="password"
            autoComplete="off"
            value={key}
            placeholder={s.apiKey.set ? '••••••••' : ''}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="out" disabled={busy || key.trim().length < 10}>
          {t('chat.gif.admin.saveKey')}
        </Button>
        {s.apiKey.set ? (
          <Button
            type="button"
            variant="gh"
            disabled={busy}
            onClick={() => void save({ apiKey: null })}
          >
            {t('chat.gif.admin.removeKey')}
          </Button>
        ) : null}
      </form>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('chat.gif.admin.rating')} className="w-[200px]">
          <Select value={s.rating} onValueChange={(v) => void save({ rating: GifRating.parse(v) })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GifRating.options.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(`chat.gif.admin.ratings.${r}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('chat.gif.admin.tier')} className="w-[220px]">
          <Select
            value={s.keyTier}
            onValueChange={(v) => void save({ keyTier: GifKeyTier.parse(v) })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GifKeyTier.options.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`chat.gif.admin.tiers.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('chat.gif.admin.lang')} className="w-[120px]">
          <Select value={s.lang} onValueChange={(v) => void save({ lang: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['tr', 'en', 'de', 'fr', 'es', 'ar'].map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Button
          type="button"
          variant="out"
          className="ml-auto"
          disabled={busy || !s.apiKey.set}
          onClick={() => void runTest()}
        >
          {t('chat.gif.admin.test')}
        </Button>
      </div>
      {test ? (
        <p
          role="status"
          className={test.ok ? 'm-0 text-cap text-success' : 'm-0 text-cap text-danger'}
        >
          {test.ok
            ? t('chat.gif.admin.testOk', { count: test.count })
            : t('chat.gif.admin.testFailed', { error: test.error ?? '' })}
        </p>
      ) : null}
      <p className="m-0 text-cap text-fg2" aria-label={t('chat.gif.admin.usageLabel')}>
        {s.usage.limit === null
          ? t('chat.gif.admin.usageUnlimited', { count: s.usage.used })
          : t('chat.gif.admin.usage', {
              count: s.usage.used,
              total: s.usage.limit,
              n: Math.max(0, s.usage.limit - s.usage.used),
            })}
      </p>
      <p className="m-0 text-xs text-fg3">{t('chat.gif.admin.terms')}</p>
    </section>
  );
}
