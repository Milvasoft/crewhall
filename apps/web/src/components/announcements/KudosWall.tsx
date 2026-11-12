import { KUDOS_LIMITS, type CelebrationSettings, type KudosBadge } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
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
import { EmojiPicker } from '@/components/chat/EmojiPicker';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import {
  badgeName,
  celebrationSettingsQuery,
  kudosBadgesQuery,
  kudosKeys,
} from '@/lib/announcements/kudos';
import { conversationsQuery } from '@/lib/chat/queries';
import { useChatEnabled } from '@/lib/chat/enabled';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { AnnouncementTabs, CelebrationsList, KudosDialog, KudosList } from './Kudos';

/** Duyurular › Teşekkür duvarı: every card, newest first, with the celebrations beside it. */
export function KudosWall() {
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  const [settings, setSettings] = useState(false);
  const badges = useQuery(kudosBadgesQuery);
  const manage = badges.data?.permissions.manage ?? false;

  return (
    <Workspace
      crumbs={[{ label: t('announcements.title') }, { label: t('announcements.kudos.title') }]}
    >
      <AnnouncementTabs current="kudos" />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <h1 className="m-0 text-wtitle font-bold">{t('announcements.kudos.title')}</h1>
          <span className="text-cap text-fg2">{t('announcements.kudos.subtitle')}</span>
        </div>
        <div className="ml-auto flex gap-2">
          {manage ? (
            <Button variant="out" size="sm" onClick={() => setSettings(true)}>
              <Icon name="settings" size={15} />
              {t('announcements.kudos.settings.open')}
            </Button>
          ) : null}
          <Button variant="pri" size="sm" onClick={() => setSending(true)}>
            <Icon name="sparkle" size={15} />
            {t('announcements.kudos.send')}
          </Button>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <KudosList />
        <aside
          aria-label={t('announcements.kudos.celebrations.title')}
          className="flex flex-col gap-2 self-start rounded-2xl bg-surface p-4 shadow-line"
        >
          <h2 className="m-0 text-[14px] font-bold">
            {t('announcements.kudos.celebrations.title')}
          </h2>
          <CelebrationsList />
        </aside>
      </div>
      {sending ? <KudosDialog open onOpenChange={setSending} /> : null}
      {settings ? <KudosSettingsDialog open onOpenChange={setSettings} /> : null}
    </Workspace>
  );
}

const NO_CHANNEL = 'none';

/** Org admins: the badges (rename, archive, add) and the celebration channel. */
function KudosSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const chatOn = useChatEnabled();
  const badges = useQuery(kudosBadgesQuery);
  const settings = useQuery(celebrationSettingsQuery);
  const convs = useQuery({ ...conversationsQuery, enabled: chatOn });
  const channels = (convs.data ?? []).filter(
    (c) => (c.type === 'group' || c.type === 'space') && !c.archivedAt,
  );
  const [emoji, setEmoji] = useState('🌟');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: kudosKeys.badges });
      void qc.invalidateQueries({ queryKey: kudosKeys.settings });
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };
  const patchBadge = (b: KudosBadge, body: { name?: string | null; archived?: boolean }) =>
    run(() => api.call('updateKudosBadge', { params: { badgeId: b.id }, body }));
  const patchSettings = (body: Partial<Omit<CelebrationSettings, 'permissions'>>) =>
    run(() => api.call('updateCelebrationSettings', { body }));
  const s = settings.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={560}>
        <DialogHeader
          title={t('announcements.kudos.settings.title')}
          description={t('announcements.kudos.settings.hint')}
        />
        <div className="flex max-h-[65vh] flex-col gap-5 overflow-y-auto">
          <section
            aria-label={t('announcements.kudos.settings.badges')}
            className="flex flex-col gap-1"
          >
            <h3 className="m-0 pb-1 text-cap font-bold">
              {t('announcements.kudos.settings.badges')}
            </h3>
            {(badges.data?.items ?? []).map((b) => (
              <BadgeRow
                key={b.id}
                b={b}
                busy={busy}
                onRename={(v) => void patchBadge(b, { name: v })}
                onArchive={(v) => void patchBadge(b, { archived: v })}
              />
            ))}
            <form
              className="mt-1 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                void run(async () => {
                  await api.call('createKudosBadge', { body: { emoji, name: name.trim() } });
                  setName('');
                });
              }}
            >
              <EmojiPicker onPick={setEmoji} align="start">
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('announcements.kudos.settings.badgeEmoji')}
                >
                  <span className="text-[18px]">{emoji}</span>
                </IconButton>
              </EmojiPicker>
              <Input
                value={name}
                maxLength={KUDOS_LIMITS.badgeNameChars}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('announcements.kudos.settings.newBadge')}
                aria-label={t('announcements.kudos.settings.newBadge')}
                containerClassName="flex-1"
              />
              <Button type="submit" size="sm" variant="out" disabled={busy || !name.trim()}>
                {t('announcements.kudos.settings.add')}
              </Button>
            </form>
          </section>
          {s ? (
            <section
              aria-label={t('announcements.kudos.settings.channel')}
              className="flex flex-col gap-2.5"
            >
              <h3 className="m-0 text-cap font-bold">
                {t('announcements.kudos.settings.channel')}
              </h3>
              <p className="m-0 text-xs text-fg2">
                {t('announcements.kudos.settings.channelHint')}
              </p>
              <Select
                value={s.channelId ?? NO_CHANNEL}
                disabled={busy || !chatOn}
                onValueChange={(v) =>
                  void patchSettings({ channelId: v === NO_CHANNEL ? null : v })
                }
              >
                <SelectTrigger aria-label={t('announcements.kudos.settings.channel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CHANNEL}>
                    {t('announcements.kudos.settings.noChannel')}
                  </SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(['birthdays', 'anniversaries', 'kudos'] as const).map((k) => (
                <label key={k} className="flex items-center gap-2.5 text-cap">
                  <Switch
                    checked={s[k]}
                    disabled={busy || !s.channelId}
                    onCheckedChange={(v) => void patchSettings({ [k]: v })}
                    aria-label={t(`announcements.kudos.settings.post.${k}`)}
                  />
                  {t(`announcements.kudos.settings.post.${k}`)}
                </label>
              ))}
            </section>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="gh" onClick={() => onOpenChange(false)}>
            {t('common.actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BadgeRow({
  b,
  busy,
  onRename,
  onArchive,
}: {
  b: KudosBadge;
  busy: boolean;
  onRename: (name: string | null) => void;
  onArchive: (archived: boolean) => void;
}) {
  const { t } = useI18n();
  const shown = badgeName(t, b);
  const [draft, setDraft] = useState(shown);
  const commit = () => {
    const v = draft.trim();
    if (v === shown) return;
    // Emptying a ready badge's name brings its translated default back.
    if (!v) {
      if (b.key) onRename(null);
      else setDraft(shown);
      return;
    }
    onRename(v);
  };
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span aria-hidden="true" className="w-7 text-center text-[18px]">
        {b.emoji}
      </span>
      <Input
        value={draft}
        maxLength={KUDOS_LIMITS.badgeNameChars}
        disabled={busy}
        aria-label={t('announcements.kudos.settings.badgeName', { name: shown })}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        containerClassName="flex-1 h-8"
      />
      <label className="flex items-center gap-1.5 text-xs text-fg2">
        <Switch
          checked={!b.archived}
          disabled={busy}
          onCheckedChange={(v) => onArchive(!v)}
          aria-label={t('announcements.kudos.settings.badgeActive', { name: shown })}
        />
        {t('announcements.kudos.settings.active')}
      </label>
    </div>
  );
}
