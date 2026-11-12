import { type AppLocale, LOCALES } from '@crewhall/i18n';
import {
  Avatar,
  cn,
  CrewhallMark,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  type IconName,
} from '@crewhall/ui';
import { type Appearance } from '@crewhall/ui/theme';
import { type ReactNode } from 'react';
import { BrandScene } from '@/components/auth/BrandScene';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useTheme } from '@/lib/theme/ThemeContext';
import { useBootstrap } from '@/lib/useBranding';

/**
 * Split layout for every screen outside the app shell (doc 01): 520px tenant brand panel
 * on the left, form column on the right. `aside` replaces the brand body (setup wizard steps).
 */
export function AuthLayout({
  children,
  footer,
  aside,
  topRight,
  wide,
}: {
  children: ReactNode;
  footer?: ReactNode;
  aside?: ReactNode;
  /** Replaces the language/theme controls (e.g. signed-in account on forced 2FA). */
  topRight?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen w-full bg-bg text-fg">
      <BrandPanel>{aside}</BrandPanel>
      <main className="flex min-w-0 flex-1 flex-col px-7 pt-[22px] pb-[26px]">
        <div className="flex h-9 shrink-0 items-center justify-end gap-2">
          {topRight ?? (
            <>
              <LanguageMenu />
              <AppearanceSwitch />
            </>
          )}
        </div>
        <div
          className={cn(
            'mx-auto my-auto flex w-full flex-col gap-[18px] py-8',
            wide ? 'max-w-[440px]' : 'max-w-[380px]',
          )}
        >
          {children}
        </div>
        {footer ? (
          <div className="shrink-0 text-center text-[12.5px] leading-[18px] text-fg3">{footer}</div>
        ) : null}
      </main>
    </div>
  );
}

function BrandPanel({ children }: { children?: ReactNode }) {
  const { t, locale } = useI18n();
  const { branding, theme } = useBootstrap();
  const login = theme.login;
  const custom = login.texts[locale];
  const image = login.source === 'image' ? (login.darkImageUrl ?? login.imageUrl) : null;
  const logo = branding.logoDarkUrl ?? branding.logoLightUrl;

  return (
    <aside
      data-theme="dark"
      className="relative hidden w-[520px] shrink-0 flex-col overflow-hidden bg-graphite px-11 pt-9 pb-[30px] text-fg lg:flex"
      style={
        image
          ? {
              backgroundImage: `linear-gradient(rgba(20,21,22,.4), rgba(20,21,22,.4)), url(${image})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : {
              backgroundImage:
                'radial-gradient(90% 60% at 60% 46%, rgba(251,196,25,.07), transparent 70%)',
            }
      }
    >
      <div className="relative flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {logo ? (
            <img
              src={logo}
              alt={branding.orgName}
              className="h-[52px] max-w-[200px] object-contain"
            />
          ) : (
            <>
              {branding.markUrl ? (
                <img src={branding.markUrl} alt="" className="size-10 rounded-[11px]" />
              ) : (
                <span className="flex size-10 items-center justify-center text-white">
                  <CrewhallMark size={34} />
                </span>
              )}
              <span className="truncate text-[19px] leading-[22px] font-bold tracking-[-.01em]">
                {branding.orgName}
              </span>
            </>
          )}
        </div>
        {branding.showPoweredBy ? (
          <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-white/[.07] pr-2.5 pl-[5px] text-tag font-semibold whitespace-nowrap text-white/70">
            <CrewhallMark size={17} className="text-white" />
            {t('auth.brand.poweredBy')}
          </span>
        ) : null}
      </div>

      {children ?? (
        <>
          <div className="relative -mx-11 flex min-h-0 flex-1 items-center justify-center">
            {login.source === 'scene' ? <BrandScene markUrl={branding.markUrl} /> : null}
          </div>
          <div className="relative flex flex-col gap-2.5">
            <h2 className="m-0 text-[30px] leading-9 font-bold tracking-[-.025em]">
              {custom ? (
                custom
              ) : (
                <>
                  {t('auth.brand.titleLead', { org: branding.orgName })}
                  <br />
                  <em className="text-[#FBC419] not-italic">{t('auth.brand.titleAccent')}</em>
                </>
              )}
            </h2>
            <p className="m-0 max-w-[380px] text-[14.5px] leading-[22px] text-fg2">
              {t('auth.brand.description')}
            </p>
          </div>
          <div className="relative mt-[26px] flex items-center gap-2 text-xs text-fg3">
            <span>
              © {new Date().getFullYear()} {branding.orgName}
            </span>
          </div>
        </>
      )}
    </aside>
  );
}

export function LanguageMenu({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-[9px] px-2.5 text-cap font-medium text-fg2 hover:bg-bg2 hover:text-fg',
          className,
        )}
        aria-label={t('prefs.language')}
      >
        <Icon name="globe" size={15} />
        {t(`prefs.languages.${locale}`)}
        <Icon name="chevD" size={15} />
      </MenuTrigger>
      <MenuContent align="end" className="min-w-[160px]">
        {LOCALES.map((l: AppLocale) => (
          <MenuItem key={l} onSelect={() => setLocale(l)} icon={l === locale ? 'check' : undefined}>
            {t(`prefs.languages.${l}`)}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

const APPEARANCES: { value: Appearance; icon: IconName }[] = [
  { value: 'light', icon: 'sun' },
  { value: 'dark', icon: 'moon' },
  { value: 'system', icon: 'monitor' },
];

/** Three-way pill (sun / moon / monitor) next to the language menu. */
export function AppearanceSwitch() {
  const { appearance, setAppearance } = useTheme();
  const { t } = useI18n();
  return (
    <div
      role="radiogroup"
      aria-label={t('prefs.theme')}
      className="flex gap-0.5 rounded-full bg-bg2 p-[3px]"
    >
      {APPEARANCES.map((a) => {
        const on = appearance === a.value;
        return (
          <button
            key={a.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={t(`prefs.appearance.${a.value}`)}
            onClick={() => setAppearance(a.value)}
            className={cn(
              'flex h-[26px] w-[30px] items-center justify-center rounded-full text-fg3 hover:text-fg',
              on && 'bg-surface text-fg shadow-sm dark:bg-capsule',
            )}
          >
            <Icon name={a.icon} size={15} />
          </button>
        );
      })}
    </div>
  );
}

// ---- small building blocks shared by the auth screens ----

export function AuthHeading({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="m-0 text-[26px] leading-8 font-bold tracking-[-.02em]">{title}</h1>
      {subtitle ? <p className="m-0 text-sm text-fg2">{subtitle}</p> : null}
    </div>
  );
}

export function Notice({
  tone,
  icon,
  children,
  className,
}: {
  tone: 'error' | 'info' | 'warn';
  icon?: IconName;
  children: ReactNode;
  className?: string;
}) {
  const styles = {
    error: 'bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] [&>svg]:text-danger',
    info: 'bg-bg2 [&>svg]:text-fg2',
    warn: 'bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] [&>svg]:text-warning',
  }[tone];
  const fallback: IconName = tone === 'info' ? 'info' : 'alert';
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(
        'flex items-start gap-2.5 rounded-lg px-3.5 py-3 text-[13.5px] leading-[19px] text-fg',
        styles,
        className,
      )}
    >
      <Icon name={icon ?? fallback} size={18} className="mt-px" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function OrDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs font-medium text-fg3 before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
      {children}
    </div>
  );
}

/** "Signed in as" row with a change action (doc 01 · 1.3). */
export function WhoRow({
  name,
  email,
  action,
}: {
  name?: string | null;
  email: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-12 items-center gap-2.5 rounded-lg bg-bg2 pr-1.5 pl-2">
      <Avatar name={name || email} size="md" className="bg-surface" />
      <div className="flex min-w-0 flex-1 flex-col">
        {name ? <span className="truncate text-sm font-semibold">{name}</span> : null}
        <span className={cn('truncate', name ? 'text-xs text-fg2' : 'text-sm font-semibold')}>
          {email}
        </span>
      </div>
      {action}
    </div>
  );
}

export const linkClass =
  'cursor-pointer text-[13px] leading-[18px] font-medium whitespace-nowrap text-fg underline decoration-line2 underline-offset-[3px] hover:decoration-fg';
