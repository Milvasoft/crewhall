import { queryKeys } from '@crewhall/api-client';
import { type OrgRole } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  Field,
  Radio,
  RadioGroup,
  toast,
  DatePicker,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { EmailChips, guestAddresses, isEmail } from '@/components/common/EmailChips';
import { InviteLinkList, type InviteLink } from '@/components/common/InviteLinkList';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { api, idempotencyKey, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { endOfDay, pickerDate } from '@/components/identity/GuestBadge';
import { useBootstrap } from '@/lib/useBranding';

type InviteRole = Exclude<OrgRole, 'owner'>;

/**
 * Invite people (doc 09 · 9.7). Addresses outside the org's email domain are invited as guests.
 * Only the org owner may invite admins.
 */
export function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      {open ? <InviteForm onClose={onClose} /> : null}
    </Dialog>
  );
}

const pickerTomorrow = () => pickerDate(new Date(Date.now() + 86_400_000).toISOString());

function InviteForm({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { me, role: myRole } = usePermissions();
  const spaces = useQuery(spacesQuery());
  const shared = (spaces.data?.items ?? []).filter((s) => s.kind === 'shared');
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<InviteRole>('member');
  // Default spaces are joined on accept anyway; only the extra ones are sent.
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  // Guests: role in the chosen spaces and an optional end date (roadmap 13).
  const [guestRole, setGuestRole] = useState<'viewer' | 'editor'>('viewer');
  const [guestUntil, setGuestUntil] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<InviteLink[] | null>(null);
  const emailEnabled = useBootstrap().data?.auth.emailEnabled !== false;
  // The org email domain setting is not in the contract yet; the inviter's domain is the hint.
  const domain = me?.user.email.split('@')[1];
  const domains = domain ? [domain] : [];
  const guests = guestAddresses(emails, domains);
  const anyGuest = role === 'guest' || guests.length > 0;
  // Guests see only the spaces they are invited to: at least one is needed.
  const guestNeedsSpace = anyGuest && spaceIds.length === 0;
  const valid = emails.length > 0 && emails.every(isEmail) && !guestNeedsSpace;

  const send = useMutation({
    mutationFn: async () => {
      let ok = 0;
      const failed: string[] = [];
      const urls: InviteLink[] = [];
      for (const email of emails) {
        try {
          const inv = await api.call('createInvitation', {
            body:
              guests.includes(email) || role === 'guest'
                ? {
                    email,
                    role: 'guest',
                    spaceIds,
                    spaceRole: guestRole,
                    ...(guestUntil ? { memberExpiresAt: endOfDay(guestUntil) } : {}),
                  }
                : { email, role, spaceIds },
            idempotencyKey: idempotencyKey(),
          });
          if (inv.url) urls.push({ email, url: inv.url });
          ok++;
        } catch (e) {
          failed.push(isApiError(e) ? `${email}: ${t(`errors.${e.code}`)}` : email);
        }
      }
      return { ok, failed, urls };
    },
    onSuccess: async ({ ok, failed, urls }) => {
      await qc.invalidateQueries({ queryKey: queryKeys.invitations });
      if (ok) toast(t('invite.sent', { count: ok }));
      if (failed.length) setError(failed.join(' · '));
      // No SMTP: the links are the only way the invitees get in.
      if (!emailEnabled && urls.length) setLinks(urls);
      else if (!failed.length) onClose();
    },
  });

  if (links) {
    return (
      <DialogContent width={520}>
        <DialogHeader
          icon="link"
          title={t('invite.linksTitle')}
          description={t('invite.linksBody')}
        />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <InviteLinkList links={links} />
        <div className="flex justify-end">
          <Button variant="pri" onClick={onClose}>
            {t('common.actions.close')}
          </Button>
        </div>
      </DialogContent>
    );
  }

  return (
    <DialogContent width={520}>
      <DialogHeader icon="userPlus" title={t('invite.title')} />
      <Field label={t('invite.emails')}>
        <EmailChips value={emails} onChange={setEmails} orgDomains={domains} />
      </Field>
      {guests.length ? (
        <Notice tone="warn">{t('invite.guestNote', { emails: guests.join(', ') })}</Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label={t('invite.orgRole')}>
        <RadioGroup
          value={role}
          onValueChange={(v) => setRole(v as InviteRole)}
          className="flex gap-4"
          aria-label={t('invite.orgRole')}
        >
          {(['member', 'admin', 'guest'] as const).map((r) => {
            const disabled = r === 'admin' && myRole !== 'owner';
            return (
              <label
                key={r}
                className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
              >
                <Radio value={r} disabled={disabled} />
                {r === 'admin' ? t('invite.orgAdmin') : t(`common.roles.org.${r}`)}
              </label>
            );
          })}
        </RadioGroup>
      </Field>
      <Field label={t('invite.spaces')}>
        <div className="flex flex-col rounded-xl px-3 shadow-line">
          {shared.map((s) => {
            // Guests skip the default spaces: only the ticked ones count for them.
            const locked = Boolean(s.isDefault) && !anyGuest;
            const checked = locked || spaceIds.includes(s.id);
            return (
              <label
                key={s.id}
                className="flex h-11 cursor-pointer items-center gap-3 border-b border-line last:border-b-0"
              >
                <Checkbox
                  checked={checked}
                  disabled={locked}
                  onCheckedChange={(v) =>
                    setSpaceIds((ids) =>
                      v === true ? [...ids, s.id] : ids.filter((x) => x !== s.id),
                    )
                  }
                />
                <SpaceAvatar space={s} size="sm" />
                <span className="flex-1 text-sm font-medium">
                  {s.name}
                  {locked ? (
                    <span className="ml-2 text-xs font-normal text-fg2">
                      {t('invite.defaultSpace')}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-fg3">
                  {t('spaces.memberCount', { count: s.memberCount })}
                </span>
              </label>
            );
          })}
        </div>
      </Field>
      {anyGuest ? (
        <Field label={t('identity.guest.settings')}>
          <div className="flex flex-col gap-3 rounded-xl p-3 shadow-line">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t('identity.guest.spaceRole')}</span>
              <RadioGroup
                value={guestRole}
                onValueChange={(v) => setGuestRole(v as 'viewer' | 'editor')}
                className="flex gap-4"
                aria-label={t('identity.guest.spaceRole')}
              >
                {(['viewer', 'editor'] as const).map((r) => (
                  <label key={r} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Radio value={r} />
                    {t(`common.roles.space.${r}`)}
                  </label>
                ))}
              </RadioGroup>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex flex-col">
                <span className="text-sm">{t('identity.guest.endDate')}</span>
                <span className="text-xs text-fg2">{t('identity.guest.endDateHint')}</span>
              </span>
              <DatePicker
                value={guestUntil}
                onChange={setGuestUntil}
                min={pickerTomorrow()}
                placeholder={t('identity.guest.noEnd')}
                aria-label={t('identity.guest.endDate')}
              />
            </div>
            {guestNeedsSpace ? (
              <span className="text-xs text-warning">{t('identity.guest.needsSpace')}</span>
            ) : null}
          </div>
        </Field>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-fg2">{t('invite.validity')}</span>
        <div className="flex gap-2">
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="pri"
            disabled={!valid}
            loading={send.isPending}
            onClick={() => send.mutate()}
          >
            {t('invite.send', { count: emails.length })}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}
