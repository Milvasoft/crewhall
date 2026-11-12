import {
  encryptShare,
  newShareKey,
  shareFragment,
  sharePayloadOf,
  totpSourceOf,
  wipe,
  type ItemPayload,
} from '@crewhall/crypto';
import { paths, type VaultShare } from '@crewhall/shared';
import {
  Button,
  CheckboxRow,
  Dialog,
  DialogContent,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Segmented,
  Spinner,
  Tooltip,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, idempotencyKey } from '@/lib/api';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { policyQuery, sharesQuery, vaultKeys } from '@/lib/vault/api';
import type { DecryptedItem } from '@/lib/vault/items';
import { errorMessage } from './errors';
import { useCopy, type AccessRef } from './fields';

const HOURS = [1, 24, 24 * 7, 24 * 30] as const;
const VIEWS = [1, 3, 5, 10, 20] as const;

/** The public page; the key goes after '#', which browsers never send to a server. */
export const shareUrl = (token: string, key: Uint8Array) =>
  `${window.location.origin}${paths.vaultShare(token)}#${shareFragment(key)}`;

/**
 * One-time share link (roadmap 20): the item is encrypted again here under a fresh key that only
 * the link carries. The link is shown once; the list below shows live links of this item.
 */
export function ShareDialog({
  open,
  onOpenChange,
  d,
  payload,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  d: DecryptedItem;
  payload: ItemPayload;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const copy = useCopy();
  const policy = useQuery(policyQuery);
  const shares = useQuery({ ...sharesQuery(d.item.id), enabled: open });
  const maxHours = policy.data?.shareMaxHours ?? 24;
  const maxViews = policy.data?.shareMaxViews ?? 1;
  const hourOptions = HOURS.filter((h) => h <= maxHours);
  const viewOptions = VIEWS.filter((v) => v <= maxViews);
  const [hours, setHours] = useState<number>(24);
  const [views, setViews] = useState<number>(1);
  const [withTotp, setWithTotp] = useState(false);
  const [withNotes, setWithNotes] = useState(true);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access: AccessRef = { vaultId: d.vault.id, itemId: d.item.id };
  const hasTotp = Boolean(totpSourceOf(payload));
  const pickedHours = hourOptions.includes(hours as never) ? hours : (hourOptions.at(-1) ?? 1);
  const pickedViews = viewOptions.includes(views as never) ? views : (viewOptions.at(-1) ?? 1);

  const create = async () => {
    setBusy(true);
    setError(null);
    const key = newShareKey();
    try {
      const enc = encryptShare(
        key,
        sharePayloadOf(payload, { includeTotp: withTotp, includeNotes: withNotes }),
      );
      const created = await api.call('vaultCreateShare', {
        params: { itemId: d.item.id },
        body: { ...enc, expiresInHours: pickedHours, maxViews: pickedViews },
        idempotencyKey: idempotencyKey(),
      });
      setLink(shareUrl(created.token!, key));
      void qc.invalidateQueries({ queryKey: vaultKeys.shares(d.item.id) });
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      wipe(key);
      setBusy(false);
    }
  };

  const revoke = async (s: VaultShare) => {
    setError(null);
    try {
      await api.call('vaultRevokeShare', { params: { shareId: s.id } });
      void qc.invalidateQueries({ queryKey: vaultKeys.shares(d.item.id) });
    } catch (e) {
      setError(errorMessage(e, t));
    }
  };

  const close = (v: boolean) => {
    if (!v) setLink(null);
    onOpenChange(v);
  };

  const hourLabel = (h: number) =>
    h < 24 ? t('vault.share.hours', { n: h }) : t('vault.share.days', { n: h / 24 });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent width={540}>
        <DialogHeader
          icon="link"
          title={t('vault.share.title')}
          description={t('vault.share.body')}
        />
        {policy.data && !policy.data.shareLinks ? (
          <p role="note" className="text-sm text-fg2">
            {t('vault.share.disabled')}
          </p>
        ) : link ? (
          <div className="flex flex-col gap-3">
            <Field label={t('vault.share.link')}>
              <div className="flex items-center gap-2">
                <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                <Tooltip content={t('vault.copy')}>
                  <IconButton
                    aria-label={`${t('vault.copy')}: ${t('vault.share.link')}`}
                    tone="plain"
                    shape="sq"
                    onClick={() => void copy(link, 'vault.share.link', access, 'share_link')}
                  >
                    <Icon name="copy" size={16} />
                  </IconButton>
                </Tooltip>
              </div>
            </Field>
            <p className="text-xs text-fg2">
              {t('vault.share.onceHint', { hours: hourLabel(pickedHours), views: pickedViews })}
            </p>
            <Button variant="out" onClick={() => setLink(null)}>
              {t('vault.share.another')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Field label={t('vault.share.expires')}>
              <Segmented
                aria-label={t('vault.share.expires')}
                value={String(pickedHours)}
                onValueChange={(v) => setHours(Number(v))}
                options={hourOptions.map((h) => ({ value: String(h), label: hourLabel(h) }))}
              />
            </Field>
            <Field label={t('vault.share.views')}>
              <Segmented
                aria-label={t('vault.share.views')}
                value={String(pickedViews)}
                onValueChange={(v) => setViews(Number(v))}
                options={viewOptions.map((v) => ({ value: String(v), label: String(v) }))}
              />
            </Field>
            {hasTotp ? (
              <CheckboxRow checked={withTotp} onCheckedChange={(v) => setWithTotp(v === true)}>
                {t('vault.share.includeTotp')}
              </CheckboxRow>
            ) : null}
            {payload.notes ? (
              <CheckboxRow checked={withNotes} onCheckedChange={(v) => setWithNotes(v === true)}>
                {t('vault.share.includeNotes')}
              </CheckboxRow>
            ) : null}
            <p className="text-xs text-fg3">{t('vault.share.zeroKnowledge')}</p>
            <Button loading={busy} onClick={() => void create()}>
              <Icon name="link" size={15} />
              {t('vault.share.create')}
            </Button>
          </div>
        )}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <section className="flex flex-col gap-2" aria-label={t('vault.share.active')}>
          <span className="eyebrow">{t('vault.share.active')}</span>
          {shares.isPending ? <Spinner /> : null}
          {shares.data && !shares.data.length ? (
            <p className="text-sm text-fg3">{t('vault.share.none')}</p>
          ) : null}
          <ul className="flex flex-col divide-y divide-line">
            {shares.data?.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm">
                    {t('vault.share.row', {
                      views: s.views,
                      max: s.maxViews,
                      date: `${formatDate(s.expiresAt, locale)} ${formatTime(s.expiresAt, locale)}`,
                    })}
                  </span>
                  {s.createdBy ? (
                    <span className="text-xs text-fg3">
                      {t('vault.share.by', {
                        name: s.createdBy.name,
                        date: formatDate(s.createdAt, locale),
                      })}
                    </span>
                  ) : null}
                </span>
                <Button size="xs" variant="out" onClick={() => void revoke(s)}>
                  {t('vault.share.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      </DialogContent>
    </Dialog>
  );
}
