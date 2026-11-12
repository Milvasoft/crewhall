import { type FederationSettings, type SharedChannel } from '@crewhall/shared';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Radio,
  RadioGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { ConfirmDialog, useConfirm } from '@/components/mcp/parts';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { federationKeys, sharedChannelsQuery } from '@/lib/federation/queries';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';

type Settings = NonNullable<FederationSettings['sharedChannels']>;

const tone = (s: SharedChannel['status']) =>
  s === 'active' ? 'ok' : s === 'pending' || s === 'invited' ? 'warn' : undefined;

/**
 * Yönetim › Federasyon › Paylaşılan kanallar (kararlar.md 2026-10-29): the switch, who may
 * invite, the file limit, and every share: invites to answer, channels to leave or close.
 */
export function SharedChannelsCard({
  settings,
  onSave,
  saving,
}: {
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  saving: boolean;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const shares = useQuery({ ...sharedChannelsQuery, enabled: settings.enabled });
  const [accepting, setAccepting] = useState<SharedChannel | null>(null);
  const [maxFile, setMaxFile] = useState(String(settings.maxFileMb));
  const ending = useConfirm<SharedChannel>();
  const fail = (e: unknown) => toast.error(t(errorKey(e)));
  const refresh = () => void qc.invalidateQueries({ queryKey: federationKeys.shares });

  const decline = useMutation({
    mutationFn: (s: SharedChannel) =>
      api.call('declineSharedChannel', { params: { shareId: s.id } }),
    onSuccess: () => {
      refresh();
      toast(t('federation.shared.declined'));
    },
    onError: fail,
  });
  const end = useMutation({
    mutationFn: (s: SharedChannel) => api.call('endSharedChannel', { params: { shareId: s.id } }),
    onSuccess: () => {
      ending.close();
      refresh();
      toast(t('federation.shared.ended'));
    },
    onError: fail,
  });

  const mb = Number(maxFile);
  const mbOk = Number.isInteger(mb) && mb >= 1 && mb <= 1024;
  const items = shares.data?.items ?? [];

  return (
    <SettingsCard title={t('federation.shared.title')} className="xl:col-span-2">
      <p className="m-0 text-cap text-fg2">{t('federation.shared.hint')}</p>
      <SettingsRow
        label={t('federation.shared.enable')}
        description={t('federation.shared.enableHint')}
      >
        <Switch
          aria-label={t('federation.shared.enable')}
          checked={settings.enabled}
          disabled={saving}
          onCheckedChange={(enabled) => onSave({ enabled })}
        />
      </SettingsRow>
      {settings.enabled ? (
        <>
          <SettingsRow label={t('federation.shared.whoCanInvite')}>
            <RadioGroup
              value={settings.whoCanInvite}
              onValueChange={(v) => onSave({ whoCanInvite: v as Settings['whoCanInvite'] })}
              className="flex flex-col gap-1.5"
            >
              {(['admins', 'managers'] as const).map((v) => (
                <label key={v} className="flex items-center gap-2 text-cap">
                  <Radio value={v} disabled={saving} />
                  {t(`federation.shared.inviters.${v}`)}
                </label>
              ))}
            </RadioGroup>
          </SettingsRow>
          <SettingsRow
            label={t('federation.shared.maxFile')}
            description={t('federation.shared.maxFileHint')}
          >
            <span className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={1024}
                value={maxFile}
                onChange={(e) => setMaxFile(e.target.value)}
                aria-label={t('federation.shared.maxFile')}
                className="w-24"
              />
              <Button
                size="sm"
                variant="out"
                disabled={!mbOk || mb === settings.maxFileMb || saving}
                onClick={() => onSave({ maxFileMb: mb })}
              >
                {t('common.actions.save')}
              </Button>
            </span>
          </SettingsRow>
          {items.length === 0 ? (
            <p className="m-0 text-cap text-fg2">{t('federation.shared.empty')}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {items.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line py-3 first:border-t-0"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2">
                      <span className="text-cap font-semibold">#{s.channelName}</span>
                      <Badge tone={tone(s.status)}>
                        {t(`federation.shared.status.${s.status}`)}
                      </Badge>
                      <Badge plain>{t(`federation.shared.role.${s.role}`)}</Badge>
                    </span>
                    <span className="text-xs text-fg2">
                      {[
                        s.invitedBy
                          ? t('federation.shared.from', {
                              org: s.orgName ?? s.domain,
                              name: s.invitedBy,
                            })
                          : t('federation.shared.fromUnknown', { org: s.orgName ?? s.domain }),
                        s.domain,
                        s.expiresAt
                          ? t('federation.shared.expires', {
                              date: formatDate(s.expiresAt, locale),
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  {s.conversationId && s.status === 'active' ? (
                    <Button size="sm" variant="gh" asChild>
                      <Link
                        to="/chat/c/$conversationId"
                        params={{ conversationId: s.conversationId }}
                      >
                        {t('federation.shared.open')}
                      </Link>
                    </Button>
                  ) : null}
                  {s.role === 'guest' && s.status === 'pending' ? (
                    <>
                      <Button size="sm" variant="pri" onClick={() => setAccepting(s)}>
                        {t('federation.shared.accept')}
                      </Button>
                      <Button
                        size="sm"
                        variant="out"
                        loading={decline.isPending && decline.variables?.id === s.id}
                        onClick={() => decline.mutate(s)}
                      >
                        {t('federation.shared.decline')}
                      </Button>
                    </>
                  ) : null}
                  {s.status === 'active' || s.status === 'invited' ? (
                    <Button size="sm" variant="dng" onClick={() => ending.ask(s)}>
                      {s.role === 'guest'
                        ? t('federation.shared.leave')
                        : s.status === 'invited'
                          ? t('federation.shared.withdraw')
                          : t('federation.shared.remove')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      {accepting ? (
        <AcceptDialog
          share={accepting}
          onClose={() => setAccepting(null)}
          onDone={() => {
            setAccepting(null);
            refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={ending.target !== null}
        onOpenChange={(o) => !o && ending.close()}
        title={
          ending.target?.role === 'guest'
            ? t('federation.shared.leave')
            : t('federation.shared.remove')
        }
        body={
          ending.target?.role === 'guest'
            ? t('federation.shared.leaveConfirm', { name: ending.target.channelName })
            : t('federation.shared.removeConfirm', {
                org: ending.target?.orgName ?? ending.target?.domain ?? '',
                name: ending.target?.channelName ?? '',
              })
        }
        confirm={
          ending.target?.role === 'guest'
            ? t('federation.shared.leave')
            : t('federation.shared.remove')
        }
        pending={end.isPending}
        onConfirm={() => ending.target && end.mutate(ending.target)}
      />
    </SettingsCard>
  );
}

/** "Kabul et": the space the channel joins, and its local name. */
function AcceptDialog({
  share,
  onClose,
  onDone,
}: {
  share: SharedChannel;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const spaces = useSpaces();
  const shared = spaces.items.filter((s) => s.kind === 'shared');
  const [spaceId, setSpaceId] = useState('');
  const [name, setName] = useState(share.channelName);
  const chosen = spaceId || shared[0]?.id || '';
  const accept = useMutation({
    mutationFn: () =>
      api.call('acceptSharedChannel', {
        params: { shareId: share.id },
        body: { spaceId: chosen, ...(name.trim() ? { name: name.trim() } : {}) },
      }),
    onSuccess: () => {
      toast(t('federation.shared.accepted', { name: name.trim() || share.channelName }));
      onDone();
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={460}>
        <DialogHeader
          icon="globe"
          title={t('federation.shared.acceptTitle')}
          description={t('federation.shared.acceptHint')}
        />
        <Field label={t('federation.shared.space')}>
          <Select value={chosen} onValueChange={setSpaceId}>
            <SelectTrigger aria-label={t('federation.shared.space')}>
              <SelectValue placeholder={t('federation.shared.space')} />
            </SelectTrigger>
            <SelectContent>
              {shared.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('federation.shared.name')}>
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="pri"
            loading={accept.isPending}
            disabled={!chosen}
            onClick={() => accept.mutate()}
          >
            {t('federation.shared.accept')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
