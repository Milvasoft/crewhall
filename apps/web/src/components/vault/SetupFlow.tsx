import { Button, Checkbox, cn, Field, Icon, IconButton, Input } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import {
  commitVaultSetup,
  prepareVaultSetup,
  vaultKeys,
  type PreparedSetup,
} from '@/lib/vault/api';
import { copySecret } from '@/lib/vault/clipboard';
import { errorMessage } from './errors';
import { useStrengthModule, StrengthBar } from './strength';

/**
 * First-run setup (design 8.1-8.2): vault password with on-device strength checks, then the
 * recovery key shown once. Keys are uploaded only after "Kaydettim".
 */
export function SetupFlow() {
  const { t } = useI18n();
  const [prepared, setPrepared] = useState<PreparedSetup | null>(null);
  const step = prepared ? 2 : 1;
  return (
    <Workspace crumbs={[{ label: t('vault.title') }, { label: t('vault.setup.crumb') }]}>
      <div className="mx-auto flex w-full max-w-[1040px] flex-wrap items-start justify-center gap-6 py-6">
        <section className="flex w-full max-w-[520px] flex-col gap-5 rounded-4xl bg-surface p-7 shadow-line">
          <Stepper step={step} />
          {prepared ? (
            <RecoveryStep prepared={prepared} onBack={() => setPrepared(null)} />
          ) : (
            <PasswordStep onDone={setPrepared} />
          )}
        </section>
        {step === 1 ? <HowItWorks /> : <WhereToKeep />}
      </div>
    </Workspace>
  );
}

function Stepper({ step }: { step: number }) {
  const { t } = useI18n();
  const steps = [
    t('vault.setup.stepPassword'),
    t('vault.setup.stepRecovery'),
    t('vault.setup.stepReady'),
  ];
  return (
    <ol className="flex items-center gap-2 text-xs font-medium text-fg3">
      {steps.map((label, i) => (
        <li
          key={label}
          className="flex min-w-0 flex-1 items-center gap-2"
          aria-current={i + 1 === step ? 'step' : undefined}
        >
          <span
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold shadow-line2',
              i + 1 < step && 'bg-success text-white shadow-none',
              i + 1 === step && 'bg-fg text-bg shadow-none',
            )}
          >
            {i + 1 < step ? <Icon name="check" size={12} /> : i + 1}
          </span>
          <span className={cn('truncate', i + 1 === step && 'text-fg')}>{label}</span>
          {i < 2 ? <span className="h-px flex-1 bg-line" /> : null}
        </li>
      ))}
    </ol>
  );
}

function PasswordStep({ onDone }: { onDone: (p: PreparedSetup) => void }) {
  const { t } = useI18n();
  const me = useMe();
  const strength = useStrengthModule();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputs = [me?.user.email ?? '', me?.user.name ?? ''];
  const result = strength?.vaultPasswordChecks(password, inputs);
  const ok = Boolean(result?.ok) && password === again;

  const submit = async () => {
    if (!me || !ok) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await prepareVaultSetup(me.user.id, password));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const rule = (pass: boolean | undefined, label: string) => (
    <li className={cn('flex items-center gap-2 text-sm', pass ? 'text-fg' : 'text-fg2')}>
      <Icon name={pass ? 'checkC' : 'x'} size={15} className={pass ? 'text-success' : 'text-fg3'} />
      {label}
    </li>
  );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <h1 className="text-h font-semibold">{t('vault.setup.title')}</h1>
        <p className="text-sm text-fg2">{t('vault.setup.body')}</p>
      </div>
      <Field label={t('vault.setup.password')}>
        <Input
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          trailing={
            <IconButton
              aria-label={show ? t('vault.hide') : t('vault.show')}
              tone="plain"
              size="xs"
              onClick={() => setShow((v) => !v)}
            >
              <Icon name={show ? 'eyeOff' : 'eye'} size={16} />
            </IconButton>
          }
        />
      </Field>
      <StrengthBar password={password} inputs={inputs} />
      <ul className="flex flex-col gap-1.5">
        {rule(result?.checks.length, t('vault.setup.ruleLength'))}
        {rule(password ? result?.checks.noPersonalInfo : false, t('vault.setup.rulePersonal'))}
        {rule(password ? result?.checks.notLeaked : false, t('vault.setup.ruleLeaked'))}
      </ul>
      <Field
        label={t('vault.setup.again')}
        error={again && again !== password ? t('vault.setup.mismatch') : undefined}
      >
        <Input
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
      </Field>
      <p className="flex items-start gap-2 rounded-lg bg-bg2 p-3 text-sm text-fg2">
        <Icon name="info" size={16} className="mt-0.5 shrink-0" />
        {t('vault.setup.tip')}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="pri" full disabled={!ok} loading={busy}>
        {t('vault.setup.continue')}
        <Icon name="arrowR" size={16} />
      </Button>
    </form>
  );
}

function RecoveryStep({ prepared, onBack }: { prepared: PreparedSetup; onBack: () => void }) {
  const { t } = useI18n();
  const me = useMe();
  const qc = useQueryClient();
  const [saved, setSaved] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = prepared.setup.recoveryKey;
  const fileName = `crewhall-recovery-${(me?.user.email ?? 'vault').replace(/[^a-z0-9@._-]/gi, '')}-${new Date().toISOString().slice(0, 10)}.txt`;

  const download = () => {
    const text = `${t('vault.recovery.fileTitle')}\n${me?.user.email ?? ''}\n\n${key}\n\n${t('vault.recovery.fileHint')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded(true);
  };

  const print = () => {
    const w = window.open('', '_blank', 'width=600,height=400');
    if (!w) return;
    const pre = w.document.createElement('pre');
    pre.textContent = `${t('vault.recovery.fileTitle')}\n${me?.user.email ?? ''}\n\n${key}`;
    pre.style.font = '18px monospace';
    w.document.body.appendChild(pre);
    w.print();
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await commitVaultSetup(prepared);
      await qc.invalidateQueries({ queryKey: vaultKeys.all });
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-h font-semibold">{t('vault.recovery.title')}</h1>
        <p className="text-sm text-fg2">{t('vault.recovery.body')}</p>
      </div>
      <div
        className="grid grid-cols-4 gap-2 rounded-xl bg-bg2 p-4 font-mono text-[17px] font-semibold tracking-wider"
        aria-label={t('vault.recovery.keyLabel')}
      >
        {key.split(' ').map((g, i) => (
          <span key={i} className="text-center">
            {g}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={downloaded ? 'default' : 'out'} onClick={download}>
          <Icon name={downloaded ? 'check' : 'download'} size={15} />
          {downloaded ? t('vault.recovery.downloaded') : t('vault.recovery.download')}
        </Button>
        <Button size="sm" variant="out" onClick={print}>
          <Icon name="file" size={15} />
          {t('vault.recovery.print')}
        </Button>
        <Button
          size="sm"
          variant="out"
          onClick={() =>
            void copySecret(key, t('vault.recovery.keyLabel'), 30).catch(() => undefined)
          }
        >
          <Icon name="copy" size={15} />
          {t('vault.copy')}
        </Button>
      </div>
      <p className="flex items-start gap-2 rounded-lg bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-3 text-sm text-fg">
        <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-warning" />
        {t('vault.recovery.notInVault')}
      </p>
      <label className="flex cursor-pointer items-center gap-2.5 text-sm">
        <Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
        {t('vault.recovery.saved')}
      </label>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button variant="gh" onClick={onBack} disabled={busy}>
          {t('vault.back')}
        </Button>
        <Button
          variant="pri"
          className="flex-1"
          disabled={!saved}
          loading={busy}
          onClick={() => void finish()}
        >
          {t('vault.recovery.open')}
        </Button>
      </div>
    </div>
  );
}

function Side({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="flex w-full max-w-[400px] flex-col gap-4 rounded-4xl bg-surface p-6 shadow-line">
      <span className="eyebrow">{title}</span>
      {children}
    </aside>
  );
}

function HowItWorks() {
  const { t } = useI18n();
  const box = (title: string, rows: [string, string][], muted?: boolean) => (
    <div className={cn('flex flex-1 flex-col gap-2 rounded-xl p-3 shadow-line', muted && 'bg-bg2')}>
      <span className="text-sm font-semibold">{title}</span>
      {rows.map(([icon, label]) => (
        <span key={label} className="flex items-center gap-2 text-xs text-fg2">
          <Icon name={icon as 'lock'} size={14} />
          {label}
        </span>
      ))}
    </div>
  );
  return (
    <Side title={t('vault.how.title')}>
      <div className="flex gap-2">
        {box(t('vault.how.device'), [
          ['key', t('vault.how.password')],
          ['zap', t('vault.how.kdf')],
          ['eye', t('vault.how.plain')],
          ['search', t('vault.how.index')],
        ])}
        {box(
          t('vault.how.server'),
          [
            ['lock', t('vault.how.items')],
            ['shield', t('vault.how.wrapped')],
            ['key', t('vault.how.publicKey')],
            ['x', t('vault.how.noPassword')],
          ],
          true,
        )}
      </div>
      <p className="text-sm text-fg2">{t('vault.how.cost')}</p>
      <span className="flex items-center gap-2 text-sm text-fg2">
        <Icon name="shield" size={15} />
        {t('vault.how.twoFactor')}
      </span>
      <span className="flex items-center gap-2 text-sm text-fg2">
        <Icon name="finger" size={15} />
        {t('vault.how.passkeyLater')}
      </span>
    </Side>
  );
}

function WhereToKeep() {
  const { t } = useI18n();
  const tip = (title: string, body: string) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-sm text-fg2">{body}</span>
    </div>
  );
  return (
    <Side title={t('vault.keep.title')}>
      {tip(t('vault.keep.printTitle'), t('vault.keep.printBody'))}
      {tip(t('vault.keep.usbTitle'), t('vault.keep.usbBody'))}
      {tip(t('vault.keep.envelopeTitle'), t('vault.keep.envelopeBody'))}
      <p className="flex items-start gap-2 text-sm text-fg2">
        <Icon name="info" size={15} className="mt-0.5 shrink-0" />
        {t('vault.keep.admins')}
      </p>
    </Side>
  );
}
