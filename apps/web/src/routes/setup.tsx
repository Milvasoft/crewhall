import { type OrgRole, type SpaceColor } from '@crewhall/shared';
import {
  Button,
  cn,
  Field,
  Icon,
  Input,
  Progress,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SpaceBadge,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import { AuthLayout, Notice } from '@/components/auth/AuthLayout';
import { MIN_PASSWORD, PasswordStrength } from '@/components/auth/PasswordStrength';
import { EmailChips, guestAddresses, isEmail } from '@/components/common/EmailChips';
import { InviteLinkList, type InviteLink } from '@/components/common/InviteLinkList';
import { ColorPicker, SHARED_COLORS } from '@/components/spaces/ColorPicker';
import { api, isApiError } from '@/lib/api';
import { signInEmail } from '@/lib/auth/auth';
import { setPendingIdentity } from '@/lib/auth/pending';
import { useI18n } from '@/lib/i18n/I18nContext';
import { bootstrapQuery } from '@/lib/queries';
import { useBootstrap } from '@/lib/useBranding';

export const Route = createFileRoute('/setup')({
  validateSearch: z.object({ step: z.coerce.number().int().min(1).max(4).optional() }),
  component: SetupPage,
});

type Step = 1 | 2 | 3 | 4;

interface OrgForm {
  name: string;
  slug: string;
  locale: 'tr' | 'en';
  token: string;
}
interface OwnerForm {
  name: string;
  email: string;
  password: string;
}
interface SpaceDraft {
  name: string;
  color: SpaceColor;
}
type InviteDraft = { email: string; role: Exclude<OrgRole, 'owner'> }[];

function slugify(v: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' };
  return v
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşü]/g, (c) => map[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * First-run wizard (doc 01 · 1.10-1.13). Everything is sent in one setup request at the end;
 * the owner then signs in and goes to the forced 2FA enrolment (1.14).
 */
function SetupPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: boot } = useBootstrap();
  const [step, setStep] = useState<Step>(1);
  const [org, setOrg] = useState<OrgForm>({ name: '', slug: '', locale, token: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [owner, setOwner] = useState<OwnerForm>({ name: '', email: '', password: '' });
  const [spaces, setSpaces] = useState<SpaceDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [links, setLinks] = useState<InviteLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokenRequired = Boolean(boot?.setup?.tokenRequired);

  useEffect(() => {
    void navigate({ to: '/setup', search: { step }, replace: true });
  }, [step, navigate]);

  useEffect(() => {
    // An installed server has nothing to set up (unless we just finished it here).
    if (boot && !boot.needsSetup && !done) void navigate({ to: '/login', replace: true });
  }, [boot, done, navigate]);

  async function submit(invites: InviteDraft) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.call('setup', {
        body: {
          ...(org.token.trim() ? { setupToken: org.token.trim() } : {}),
          org: { name: org.name.trim(), slug: org.slug, defaultLocale: org.locale },
          owner: { name: owner.name.trim(), email: owner.email.trim(), password: owner.password },
          spaces: spaces.map((sp, i) => ({
            name: sp.name.trim(),
            color: sp.color,
            isDefault: i === 0,
          })),
          invitations: invites,
        },
      });
      setDone(true);
      const res = await signInEmail({
        email: owner.email.trim(),
        password: owner.password,
        rememberMe: true,
      });
      if (!res.ok) throw new Error('sign-in failed');
      setPendingIdentity({ email: owner.email.trim(), name: owner.name.trim() });
      await qc.invalidateQueries({ queryKey: bootstrapQuery.queryKey });
      const urls = result.invitations ?? [];
      // Without SMTP the invitations are links the owner shares by hand (1.13).
      if (urls.length && boot?.auth.emailEnabled === false) setLinks(urls);
      else await navigate({ to: '/security/2fa-setup', search: { from: 'setup' } });
    } catch (e) {
      if (isApiError(e, 'setup_token_invalid')) {
        setStep(1);
        setError(t('errors.setup_token_invalid'));
      } else {
        setError(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal'));
      }
    } finally {
      setBusy(false);
    }
  }

  const summaries: Record<Step, string | undefined> = {
    1: org.name ? `${org.name} · ${org.slug}` : undefined,
    2: owner.name || undefined,
    3: spaces.length ? spaces.map((sp) => sp.name).join(', ') : undefined,
    4: undefined,
  };

  if (links) {
    return (
      <AuthLayout wide aside={<WizardAside step={5} summaries={summaries} />}>
        <InviteLinks
          links={links}
          onContinue={() => void navigate({ to: '/security/2fa-setup', search: { from: 'setup' } })}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout wide aside={<WizardAside step={step} summaries={summaries} />}>
      <StepHeader step={step} />
      {error ? <Notice tone="error">{error}</Notice> : null}
      {step === 1 ? (
        <StepOrg
          value={org}
          tokenRequired={tokenRequired}
          onChange={(v) => {
            setOrg(slugTouched ? v : { ...v, slug: slugify(v.name) });
          }}
          onSlugTouched={() => setSlugTouched(true)}
          onNext={() => {
            setError(null);
            setStep(2);
          }}
        />
      ) : null}
      {step === 2 ? (
        <StepOwner
          value={owner}
          onChange={setOwner}
          onBack={() => setStep(1)}
          onNext={() => {
            setSpaces((sp) => (sp.length ? sp : [{ name: org.name.trim(), color: 's1' }]));
            setStep(3);
          }}
        />
      ) : null}
      {step === 3 ? (
        <StepSpaces
          value={spaces}
          onChange={setSpaces}
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
        />
      ) : null}
      {step === 4 ? (
        <StepInvite
          ownerEmail={owner.email}
          busy={busy}
          onBack={() => setStep(3)}
          onFinish={(inv) => void submit(inv)}
        />
      ) : null}
    </AuthLayout>
  );
}

/** Invitation links to copy when SMTP is not configured (doc 01 · 1.13). */
function InviteLinks({ links, onContinue }: { links: InviteLink[]; onContinue: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[26px] leading-8 font-bold tracking-[-.02em]">
          {t('setup.links.title')}
        </h1>
        <p className="m-0 text-sm text-fg2">{t('setup.links.subtitle')}</p>
      </div>
      <InviteLinkList links={links} />
      <Button variant="pri" full onClick={onContinue}>
        {t('common.actions.continue')}
      </Button>
    </>
  );
}

function StepHeader({ step }: { step: Step }) {
  const { t } = useI18n();
  const keys = { 1: 'org', 2: 'owner', 3: 'spaces', 4: 'invite' } as const;
  const k = keys[step];
  return (
    <div className="flex flex-col gap-3">
      <span className="text-cap text-fg2">
        {t('setup.stepOf', { step, total: 4 })} · {t(`setup.eta.${k}`)}
      </span>
      <Progress value={(step / 4) * 100} label={t('setup.stepOf', { step, total: 4 })} />
      <div className="mt-2 flex flex-col gap-1.5">
        <h1 className="m-0 text-[26px] leading-8 font-bold tracking-[-.02em]">
          {t(`setup.${k}.title`)}
        </h1>
        <p className="m-0 text-sm text-fg2">{t(`setup.${k}.subtitle`)}</p>
      </div>
    </div>
  );
}

function WizardAside({
  step,
  summaries,
}: {
  step: Step | 5;
  summaries: Record<Step, string | undefined>;
}) {
  const { t } = useI18n();
  const { data: boot } = useBootstrap();
  const checks = boot?.setup?.checks;
  const items: { n: Step; key: 'org' | 'owner' | 'spaces' | 'invite' }[] = [
    { n: 1, key: 'org' },
    { n: 2, key: 'owner' },
    { n: 3, key: 'spaces' },
    { n: 4, key: 'invite' },
  ];
  return (
    <>
      <span className="relative mt-6 text-xs text-fg3">{t('setup.badge')}</span>
      <ol className="relative m-0 mt-9 flex list-none flex-col gap-1 p-0">
        {items.map((it) => {
          const done = it.n < step;
          const on = it.n === step;
          return (
            <li
              key={it.n}
              aria-current={on ? 'step' : undefined}
              className={cn(
                'flex items-start gap-3 rounded-lg p-3',
                on && 'bg-surface shadow-line',
              )}
            >
              <span
                className={cn(
                  'flex size-[26px] shrink-0 items-center justify-center rounded-full text-xs font-semibold text-fg3 shadow-[inset_0_0_0_1.5px_var(--line2)]',
                  done && 'bg-fg text-bg shadow-none',
                  on && 'text-fg shadow-[inset_0_0_0_2px_var(--accent)]',
                )}
              >
                {done ? <Icon name="check" size={14} strokeWidth={2.6} /> : it.n}
              </span>
              <span className="flex min-w-0 flex-col">
                <span
                  className={cn('text-sm font-semibold', !done && !on && 'font-medium text-fg2')}
                >
                  {t(`setup.${it.key}.short`)}
                </span>
                <span className="truncate text-[12.5px] leading-[17px] text-fg2">
                  {done && summaries[it.n] ? summaries[it.n] : t(`setup.${it.key}.hint`)}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {checks ? (
        <div className="relative mt-auto mb-4 flex flex-col gap-[7px] rounded-lg bg-surface p-3.5 shadow-line">
          <span className="eyebrow">{t('setup.checks.title')}</span>
          {(['database', 'storage', 'smtp'] as const).map((k) => (
            <span key={k} className="flex items-center gap-2 text-[12.5px] leading-4 text-fg2">
              <i
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  checks[k] ? 'bg-success' : k === 'smtp' ? 'bg-warning' : 'bg-danger',
                )}
              />
              <span className="flex-1">{t(`setup.checks.${k}`)}</span>
              <span className="text-fg3">
                {checks[k] ? t('setup.checks.ok') : t('setup.checks.missing')}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

function Nav({
  onBack,
  next,
  nextDisabled,
  busy,
  extra,
}: {
  onBack?: () => void;
  next: ReactNode;
  nextDisabled?: boolean;
  busy?: boolean;
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="mt-2 flex items-center justify-between gap-2">
      {onBack ? (
        <Button variant="gh" onClick={onBack}>
          <Icon name="arrowL" size={18} />
          {t('common.actions.back')}
        </Button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">
        {extra}
        <Button type="submit" variant="pri" disabled={nextDisabled} loading={busy}>
          {next}
        </Button>
      </div>
    </div>
  );
}

function StepOrg({
  value,
  tokenRequired,
  onChange,
  onSlugTouched,
  onNext,
}: {
  value: OrgForm;
  tokenRequired: boolean;
  onChange: (v: OrgForm) => void;
  onSlugTouched: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const slugOk = /^[a-z0-9-]{2,40}$/.test(value.slug);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onNext();
      }}
    >
      {tokenRequired ? (
        <Field label={t('setup.org.token')} hint={t('setup.org.tokenHint')}>
          <Input
            icon="key"
            value={value.token}
            onChange={(e) => onChange({ ...value, token: e.target.value })}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ) : null}
      <Field label={t('setup.org.name')}>
        <Input
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          autoFocus
          maxLength={80}
        />
      </Field>
      <Field
        label={t('setup.org.slug')}
        hint={t('setup.org.slugHint')}
        error={value.slug && !slugOk ? t('setup.org.slugInvalid') : undefined}
      >
        <Input
          value={value.slug}
          className="font-mono"
          onChange={(e) => {
            onSlugTouched();
            onChange({ ...value, slug: e.target.value.toLowerCase() });
          }}
        />
      </Field>
      <Field label={t('setup.org.locale')}>
        <Segmented
          aria-label={t('setup.org.locale')}
          value={value.locale}
          onValueChange={(l) => onChange({ ...value, locale: l })}
          options={[
            { value: 'tr', label: t('prefs.languages.tr') },
            { value: 'en', label: t('prefs.languages.en') },
          ]}
        />
      </Field>
      <Nav
        next={t('common.actions.continue')}
        nextDisabled={!value.name.trim() || !slugOk || (tokenRequired && !value.token.trim())}
      />
    </form>
  );
}

function StepOwner({
  value,
  onChange,
  onBack,
  onNext,
}: {
  value: OwnerForm;
  onChange: (v: OwnerForm) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { t, rich } = useI18n();
  const valid =
    value.name.trim().length > 0 &&
    isEmail(value.email.trim()) &&
    value.password.length >= MIN_PASSWORD;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (valid) onNext();
      }}
    >
      <Field label={t('auth.fields.name')}>
        <Input
          icon="user"
          autoComplete="name"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          autoFocus
        />
      </Field>
      <Field label={t('auth.fields.email')}>
        <Input
          icon="mail"
          type="email"
          autoComplete="username"
          value={value.email}
          onChange={(e) => onChange({ ...value, email: e.target.value })}
        />
      </Field>
      <Field label={t('auth.fields.password')}>
        <Input
          icon="lock"
          type="password"
          autoComplete="new-password"
          value={value.password}
          onChange={(e) => onChange({ ...value, password: e.target.value })}
        />
      </Field>
      <PasswordStrength password={value.password} email={value.email} name={value.name} />
      <Notice tone="info" icon="shield">
        {rich('setup.owner.note')}
      </Notice>
      <Nav onBack={onBack} next={t('common.actions.continue')} nextDisabled={!valid} />
    </form>
  );
}

function StepSpaces({
  value,
  onChange,
  onBack,
  onNext,
}: {
  value: SpaceDraft[];
  onChange: (v: SpaceDraft[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const valid = value.length > 0 && value.every((s) => s.name.trim());

  function update(i: number, patch: Partial<{ name: string; color: SpaceColor }>) {
    onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function addRow() {
    const used = new Set(value.map((s) => s.color));
    const color = SHARED_COLORS.find((c) => !used.has(c)) ?? 's1';
    onChange([...value, { name: '', color }]);
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (valid) onNext();
      }}
    >
      {value.map((s, i) => (
        <div
          key={i}
          className="flex h-12 items-center gap-3 rounded-lg bg-bg2 pr-2 pl-3 focus-within:bg-surface focus-within:shadow-[inset_0_0_0_1.5px_var(--fg)]"
        >
          <SpaceBadge color={s.color} name={s.name || '?'} size="sm" />
          <input
            aria-label={t('spaces.name')}
            value={s.name}
            onChange={(e) => update(i, { name: e.target.value })}
            autoFocus={i === value.length - 1 && !s.name}
            maxLength={60}
            className="h-full min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none placeholder:font-normal placeholder:text-fg3 focus-visible:shadow-none"
            placeholder={t('setup.spaces.placeholder')}
          />
          {i === 0 ? (
            <span className="rounded-xs px-2 py-0.5 text-tag font-semibold text-fg2 shadow-line2">
              {t('setup.spaces.default')}
            </span>
          ) : null}
          <ColorPicker value={s.color} onChange={(c) => update(i, { color: c })} size={16} />
          {value.length > 1 ? (
            <button
              type="button"
              aria-label={t('common.actions.delete')}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="flex size-7 items-center justify-center rounded-sm text-fg3 hover:bg-bg2 hover:text-fg"
            >
              <Icon name="x" size={15} />
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="flex h-10 items-center gap-2 self-start rounded-md px-2 text-sm font-medium text-fg2 hover:bg-bg2 hover:text-fg"
      >
        <Icon name="plus" size={16} />
        {t('setup.spaces.add')}
      </button>
      <Nav
        onBack={onBack}
        next={t('setup.spaces.submit', { count: value.length })}
        nextDisabled={!valid}
      />
    </form>
  );
}

function StepInvite({
  ownerEmail,
  busy,
  onBack,
  onFinish,
}: {
  ownerEmail: string;
  busy: boolean;
  onBack: () => void;
  onFinish: (v: InviteDraft) => void;
}) {
  const { t } = useI18n();
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<'member' | 'admin' | 'guest'>('member');
  const domain = ownerEmail.split('@')[1];
  const domains = domain ? [domain] : [];
  const guests = guestAddresses(emails, domains);
  const valid = emails.length > 0 && emails.every(isEmail);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        // Addresses outside the owner's domain are invited as guests (1.13).
        if (valid) {
          onFinish(
            emails.map((email) => ({ email, role: guests.includes(email) ? 'guest' : role })),
          );
        }
      }}
    >
      <Field label={t('setup.invite.emails', { count: emails.length })}>
        <EmailChips value={emails} onChange={setEmails} orgDomains={domains} />
      </Field>
      {guests.length ? (
        <Notice tone="warn">{t('invite.guestNote', { emails: guests.join(', ') })}</Notice>
      ) : null}
      <Field label={t('invite.orgRole')}>
        <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">{t('common.roles.org.member')}</SelectItem>
            <SelectItem value="admin">{t('common.roles.org.admin')}</SelectItem>
            <SelectItem value="guest">{t('common.roles.org.guest')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Nav
        onBack={onBack}
        next={t('setup.invite.submit')}
        nextDisabled={!valid}
        busy={busy}
        extra={
          <Button variant="gh" disabled={busy} onClick={() => onFinish([])}>
            {t('setup.invite.skip')}
          </Button>
        }
      />
    </form>
  );
}
