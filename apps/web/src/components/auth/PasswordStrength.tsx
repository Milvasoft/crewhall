import { cn, Icon } from '@crewhall/ui';
import { useI18n } from '@/lib/i18n/I18nContext';

export const MIN_PASSWORD = 12;

/**
 * Length matters, character classes are not required (doc 01 · 1.8). The leak check runs on
 * the server; here we score length, variety and personal info. 0..4.
 */
export function passwordScore(password: string, personal: string[] = []): number {
  if (!password) return 0;
  const lower = password.toLocaleLowerCase('tr');
  if (personal.some((p) => p.length >= 3 && lower.includes(p.toLocaleLowerCase('tr')))) return 1;
  let score = password.length >= MIN_PASSWORD ? 2 : password.length >= 8 ? 1 : 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) =>
    r.test(password),
  ).length;
  if (password.length >= 16 || (password.length >= MIN_PASSWORD && classes >= 3)) score++;
  if (password.length >= 20) score++;
  return Math.min(4, score);
}

export function personalParts(email?: string, name?: string): string[] {
  const parts = [...(name ?? '').split(/\s+/)];
  if (email) parts.push(email.split('@')[0] ?? '');
  return parts.filter((p) => p.length >= 3);
}

export function PasswordStrength({
  password,
  email,
  name,
  showRules = true,
}: {
  password: string;
  email?: string;
  name?: string;
  showRules?: boolean;
}) {
  const { t } = useI18n();
  const personal = personalParts(email, name);
  const score = passwordScore(password, personal);
  const long = password.length >= MIN_PASSWORD;
  const noPersonal =
    password.length > 0 &&
    !personal.some((p) => password.toLocaleLowerCase('tr').includes(p.toLocaleLowerCase('tr')));
  const label = ['veryWeak', 'weak', 'fair', 'good', 'strong'][score] as
    'veryWeak' | 'weak' | 'fair' | 'good' | 'strong';
  const color = score <= 1 ? 'bg-danger' : score === 2 ? 'bg-warning' : 'bg-success';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={cn('h-1 flex-1 rounded-[9px] bg-bg2', i < score && color)} />
        ))}
      </div>
      {password ? (
        <span className="text-xs text-fg2" aria-live="polite">
          <b className="font-semibold text-fg">{t(`auth.password.strength.${label}`)}</b>
        </span>
      ) : null}
      {showRules ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          <Rule ok={long}>
            {t('auth.password.ruleLength', { min: MIN_PASSWORD, count: password.length })}
          </Rule>
          <Rule ok={noPersonal}>{t('auth.password.rulePersonal')}</Rule>
        </ul>
      ) : null}
    </div>
  );
}

function Rule({ ok, children }: { ok: boolean; children: string }) {
  return (
    <li
      className={cn('flex items-center gap-2 text-[12.5px] leading-4', ok ? 'text-fg' : 'text-fg2')}
    >
      <Icon name={ok ? 'checkC' : 'minus'} size={14} className={ok ? 'text-success' : 'text-fg3'} />
      {children}
    </li>
  );
}
