import { queryKeys } from '@crewhall/api-client';
import { DEFAULT_THEME, OrgTheme, type ThemeMode as ThemeModeSchema } from '@crewhall/shared';
import {
  Badge,
  Button,
  cn,
  Icon,
  Segmented,
  Skeleton,
  SpaceDot,
  Switch,
  Tag,
  toast,
} from '@crewhall/ui';
import {
  autoDarkAccent,
  autoFixContrast,
  autoSurface,
  checkContrast,
  cssVarName,
  deriveColors,
  spaceColors,
  type ColorScheme,
  type ColorTokens,
  type ContrastCheck,
} from '@crewhall/ui/tokens';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useBlocker } from '@tanstack/react-router';
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { type z } from 'zod';
import { PageHeader, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { themeQuery } from '@/lib/queries';
import { applyPublishedTheme } from '@/lib/theme/ThemeContext';

export const Route = createFileRoute('/_app/admin/theme')({
  component: ThemePage,
});

type ThemeMode = z.infer<typeof ThemeModeSchema>;
type Draft = Omit<OrgTheme, 'version'>;

function withoutVersion(t: OrgTheme): Draft {
  return { light: t.light, dark: t.dark, radius: t.radius, density: t.density, login: t.login };
}
type Auto = { lightSurface: boolean; darkSurface: boolean; darkAccent: boolean };

const PRESETS: {
  id: 'milva' | 'neutral' | 'ocean' | 'forest';
  light: ThemeMode;
  dark: ThemeMode;
}[] = [
  { id: 'milva', light: DEFAULT_THEME.light, dark: DEFAULT_THEME.dark },
  {
    id: 'neutral',
    light: { bg: '#F7F7F6', surface: '#FFFFFF', accent: '#141516' },
    dark: { bg: '#0E0F0F', surface: '#151617', accent: '#F5F5F5' },
  },
  {
    id: 'ocean',
    light: { bg: '#F5F7FA', surface: '#FFFFFF', accent: '#2563EB' },
    dark: { bg: '#0B1220', surface: '#111A2B', accent: '#60A5FA' },
  },
  {
    id: 'forest',
    light: { bg: '#F5F7F4', surface: '#FFFFFF', accent: '#15803D' },
    dark: { bg: '#0C120E', surface: '#121A15', accent: '#4ADE80' },
  },
];

const HEX = /^#[0-9a-fA-F]{6}$/;
const same = (a: ThemeMode, b: ThemeMode) =>
  a.bg.toUpperCase() === b.bg.toUpperCase() &&
  a.surface.toUpperCase() === b.surface.toUpperCase() &&
  a.accent.toUpperCase() === b.accent.toUpperCase();

/** Org theme: presets, per-scheme colors, derived tokens, contrast gate, live preview (doc 09 · 9.3). */
function ThemePage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const theme = useQuery(themeQuery);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [auto, setAuto] = useState<Auto>({
    lightSurface: true,
    darkSurface: true,
    darkAccent: false,
  });
  const fileRef = useRef<HTMLInputElement>(null);

  // Seed the draft once the data arrives (state adjusted during render, no effect).
  if (theme.data && !draft) setDraft(withoutVersion(theme.data));

  const published = theme.data;
  const dirty = Boolean(
    published &&
    draft &&
    (!same(published.light, draft.light) ||
      !same(published.dark, draft.dark) ||
      published.radius !== draft.radius ||
      published.density !== draft.density),
  );

  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm(t('admin.leaveUnsaved')),
    enableBeforeUnload: () => dirty,
  });

  const tokens = useMemo(
    () =>
      draft
        ? { light: deriveColors('light', draft.light), dark: deriveColors('dark', draft.dark) }
        : null,
    [draft],
  );
  const checks = useMemo(
    () =>
      tokens ? { light: checkContrast(tokens.light), dark: checkContrast(tokens.dark) } : null,
    [tokens],
  );
  const failures = checks
    ? [...checks.light, ...checks.dark].filter((c) => c.level === 'fail').length
    : 0;

  const publish = useMutation({
    mutationFn: (d: Draft) => api.call('publishTheme', { body: d }),
    onSuccess: async (next) => {
      qc.setQueryData(queryKeys.theme, next);
      applyPublishedTheme(next);
      await qc.invalidateQueries({ queryKey: queryKeys.bootstrap });
      toast(t('admin.theme.published', { version: next.version }));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  function setColor(scheme: ColorScheme, key: keyof ThemeMode, value: string) {
    setDraft((d) => {
      if (!d) return d;
      const mode = { ...d[scheme], [key]: value };
      const next = { ...d, [scheme]: mode };
      if (HEX.test(value)) {
        if (key === 'bg' && (scheme === 'light' ? auto.lightSurface : auto.darkSurface)) {
          next[scheme] = { ...mode, surface: autoSurface(scheme, value) };
        }
        if (scheme === 'light' && key === 'accent' && auto.darkAccent) {
          next.dark = { ...next.dark, accent: autoDarkAccent(value) };
        }
      }
      return next;
    });
  }

  function applyPreset(id: (typeof PRESETS)[number]['id']) {
    const p = PRESETS.find((x) => x.id === id);
    if (p && draft) setDraft({ ...draft, light: { ...p.light }, dark: { ...p.dark } });
  }

  function fix(scheme: ColorScheme, c: ContrastCheck) {
    if (!draft || !tokens) return;
    if (c.pair === 'accentTextBg' && scheme === 'dark') {
      setColor('dark', 'accent', autoFixContrast(draft.dark.accent, tokens.dark.bg));
    }
  }

  function exportJson() {
    if (!draft) return;
    const blob = new Blob(
      [JSON.stringify({ version: published?.version ?? 0, ...draft }, null, 2)],
      {
        type: 'application/json',
      },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'theme.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importJson(file: File) {
    try {
      const parsed = OrgTheme.safeParse({
        version: 0,
        ...(JSON.parse(await file.text()) as object),
      });
      if (!parsed.success) throw new Error('invalid');
      setDraft(withoutVersion(parsed.data));
      toast(t('admin.theme.imported'));
    } catch {
      toast(t('admin.theme.importInvalid'));
    }
  }

  const activePreset = draft
    ? PRESETS.find((p) => same(p.light, draft.light) && same(p.dark, draft.dark))?.id
    : undefined;

  return (
    <Workspace
      crumbs={[
        { label: t('admin.title') },
        { label: t('admin.groups.brand') },
        {
          label: (
            <span className="flex items-center gap-2">
              {t('admin.nav.theme')}
              {dirty ? <Tag>{t('admin.theme.draft')}</Tag> : null}
            </span>
          ),
        },
      ]}
    >
      <PageHeader
        title={t('admin.theme.title')}
        subtitle={t('admin.theme.subtitle')}
        actions={
          <>
            <Button
              variant="gh"
              size="sm"
              onClick={() =>
                draft &&
                setDraft({
                  ...draft,
                  ...{
                    light: DEFAULT_THEME.light,
                    dark: DEFAULT_THEME.dark,
                    radius: 'md',
                    density: 'comfortable',
                  },
                })
              }
            >
              {t('admin.theme.reset')}
            </Button>
            <Button variant="gh" size="sm" onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={16} />
              {t('admin.theme.import')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importJson(f);
                e.target.value = '';
              }}
            />
            <Button variant="gh" size="sm" onClick={exportJson}>
              <Icon name="download" size={16} />
              {t('admin.theme.export')}
            </Button>
            {failures ? (
              <Badge tone="danger">{t('admin.theme.issues', { count: failures })}</Badge>
            ) : null}
            <Button
              variant="pri"
              size="sm"
              disabled={!dirty || failures > 0}
              loading={publish.isPending}
              onClick={() => draft && publish.mutate(draft)}
            >
              {t('admin.publish')}
            </Button>
          </>
        }
      />
      {!draft || !tokens || !checks ? (
        <Skeleton className="h-96 w-full rounded-2xl" />
      ) : (
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            <SettingsCard
              title={t('admin.theme.presets')}
              aside={<span className="text-xs text-fg3">{t('admin.theme.presetsHint')}</span>}
            >
              <div className="grid grid-cols-5 gap-2.5 pb-3">
                {PRESETS.map((p) => (
                  <PresetCard
                    key={p.id}
                    preset={p}
                    on={activePreset === p.id}
                    label={t(`admin.theme.preset.${p.id}`)}
                    onClick={() => applyPreset(p.id)}
                  />
                ))}
                <div
                  className={cn(
                    'flex flex-col gap-1.5 rounded-xl p-2',
                    activePreset ? 'shadow-line' : 'shadow-[inset_0_0_0_2px_var(--fg)]',
                  )}
                >
                  <div className="flex h-12 overflow-hidden rounded-md">
                    <span className="flex-1" style={{ background: draft.light.bg }} />
                    <span className="flex-1" style={{ background: draft.dark.bg }} />
                  </div>
                  <span className="text-xs font-semibold">{t('admin.theme.preset.custom')}</span>
                </div>
              </div>
            </SettingsCard>

            <SettingsCard title={t('admin.theme.colors')}>
              <div className="grid grid-cols-[1fr_minmax(0,1.3fr)_minmax(0,1.3fr)] items-center gap-x-4 gap-y-3 pb-4">
                <span />
                <span className="flex items-center gap-1.5 text-xs text-fg2">
                  <Icon name="sun" size={14} />
                  {t('admin.theme.light')}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-fg2">
                  <Icon name="moon" size={14} />
                  {t('admin.theme.dark')}
                </span>
                {(['bg', 'surface', 'accent'] as const).map((key) => (
                  <ColorRow
                    key={key}
                    label={t(`admin.theme.token.${key}`)}
                    token={`--${key}`}
                    light={draft.light[key]}
                    dark={draft.dark[key]}
                    autoLight={key === 'surface' ? auto.lightSurface : undefined}
                    autoDark={
                      key === 'surface'
                        ? auto.darkSurface
                        : key === 'accent'
                          ? auto.darkAccent
                          : undefined
                    }
                    onLight={(v) => setColor('light', key, v)}
                    onDark={(v) => setColor('dark', key, v)}
                    onAutoLight={(v) => {
                      setAuto((a) => ({ ...a, lightSurface: v }));
                      if (v) setColor('light', 'surface', autoSurface('light', draft.light.bg));
                    }}
                    onAutoDark={(v) => {
                      if (key === 'surface') {
                        setAuto((a) => ({ ...a, darkSurface: v }));
                        if (v) setColor('dark', 'surface', autoSurface('dark', draft.dark.bg));
                      } else {
                        setAuto((a) => ({ ...a, darkAccent: v }));
                        if (v) setColor('dark', 'accent', autoDarkAccent(draft.light.accent));
                      }
                    }}
                  />
                ))}
                <span className="flex flex-col">
                  <span className="text-cap font-semibold">{t('admin.theme.derived')}</span>
                  <span className="font-mono text-[11px] text-fg3">oklch</span>
                </span>
                <DerivedStrip tokens={tokens.light} />
                <DerivedStrip tokens={tokens.dark} />
              </div>
            </SettingsCard>

            <SettingsCard
              title={t('admin.theme.contrast')}
              aside={<span className="text-xs text-fg3">{t('admin.theme.contrastHint')}</span>}
            >
              <table className="mb-2 w-full text-[13.5px]">
                <thead>
                  <tr className="text-left text-xs text-fg2">
                    <th className="py-2 font-medium" />
                    <th className="py-2 font-medium">{t('admin.theme.light')}</th>
                    <th className="py-2 font-medium">{t('admin.theme.dark')}</th>
                  </tr>
                </thead>
                <tbody>
                  {checks.light.map((c, i) => {
                    const d = checks.dark[i] as ContrastCheck;
                    return (
                      <tr key={c.pair} className="border-t border-line">
                        <td className="py-2 font-semibold">{t(`admin.theme.pair.${c.pair}`)}</td>
                        <td className="py-2">
                          <ContrastBadge check={c} />
                        </td>
                        <td className="py-2">
                          <ContrastBadge check={d} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {(['light', 'dark'] as const).flatMap((scheme) =>
                checks[scheme]
                  .filter((c) => c.level === 'fail')
                  .map((c) => (
                    <div
                      key={`${scheme}-${c.pair}`}
                      className="mb-3 flex flex-col gap-2 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] p-3.5"
                    >
                      <span className="flex items-center gap-2 text-cap font-semibold">
                        <Icon name="alert" size={16} className="text-danger" />
                        {t('admin.theme.failTitle', {
                          scheme: t(`admin.theme.${scheme}`),
                          pair: t(`admin.theme.pair.${c.pair}`),
                        })}
                      </span>
                      <span className="text-xs text-fg2">
                        {t('admin.theme.failBody', { ratio: c.ratio })}
                      </span>
                      {c.pair === 'accentTextBg' && scheme === 'dark' ? (
                        <Button
                          size="xs"
                          variant="inv"
                          className="self-start"
                          onClick={() => fix(scheme, c)}
                        >
                          {t('admin.theme.autofix')}
                        </Button>
                      ) : (
                        <span className="text-xs text-fg2">{t('admin.theme.fixManually')}</span>
                      )}
                    </div>
                  )),
              )}
            </SettingsCard>
          </div>

          <div className="flex w-full shrink-0 flex-col gap-4 xl:w-[340px]">
            <SettingsCard
              title={t('admin.theme.livePreview')}
              aside={<span className="text-xs text-fg3">{t('admin.theme.livePreviewHint')}</span>}
            >
              <div className="grid grid-cols-2 gap-2.5 pb-3.5">
                <MiniShell scheme="light" tokens={tokens.light} />
                <MiniShell scheme="dark" tokens={tokens.dark} />
              </div>
            </SettingsCard>
            <SettingsCard title={t('admin.theme.shape')}>
              <SettingsRow
                label={t('admin.theme.radius')}
                description={t('admin.theme.radiusHint')}
              >
                <Segmented
                  size="sm"
                  aria-label={t('admin.theme.radius')}
                  value={draft.radius}
                  onValueChange={(radius) => setDraft({ ...draft, radius })}
                  options={[
                    { value: 'sm', label: t('admin.theme.radiusSharp') },
                    { value: 'md', label: t('admin.theme.radiusDefault') },
                    { value: 'lg', label: t('admin.theme.radiusSoft') },
                  ]}
                />
              </SettingsRow>
              <SettingsRow
                label={t('admin.theme.density')}
                description={t('admin.theme.densityHint')}
              >
                <Segmented
                  size="sm"
                  aria-label={t('admin.theme.density')}
                  value={draft.density}
                  onValueChange={(density) => setDraft({ ...draft, density })}
                  options={[
                    { value: 'comfortable', label: t('prefs.density.comfortable') },
                    { value: 'compact', label: t('prefs.density.compact') },
                  ]}
                />
              </SettingsRow>
            </SettingsCard>
            <SettingsCard title={t('admin.theme.versions')}>
              <SettingsRow
                label={
                  <span className="flex items-center gap-2">
                    <Badge tone="ok">{t('admin.theme.live')}</Badge>v{published?.version ?? 0}
                  </span>
                }
              />
            </SettingsCard>
          </div>
        </div>
      )}
    </Workspace>
  );
}

function PresetCard({
  preset,
  on,
  label,
  onClick,
}: {
  preset: (typeof PRESETS)[number];
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'flex flex-col gap-1.5 rounded-xl p-2 text-left',
        on ? 'shadow-[inset_0_0_0_2px_var(--fg)]' : 'shadow-line hover:shadow-line2',
      )}
    >
      <div className="flex h-12 overflow-hidden rounded-md">
        <span className="flex flex-1 items-end p-1.5" style={{ background: preset.light.bg }}>
          <i className="h-1.5 w-5 rounded-full" style={{ background: preset.light.accent }} />
        </span>
        <span className="flex flex-1 items-end p-1.5" style={{ background: preset.dark.bg }}>
          <i className="h-1.5 w-5 rounded-full" style={{ background: preset.dark.accent }} />
        </span>
      </div>
      <span className="text-xs font-semibold">{label}</span>
    </button>
  );
}

function ColorRow({
  label,
  token,
  light,
  dark,
  autoLight,
  autoDark,
  onLight,
  onDark,
  onAutoLight,
  onAutoDark,
}: {
  label: string;
  token: string;
  light: string;
  dark: string;
  autoLight?: boolean;
  autoDark?: boolean;
  onLight: (v: string) => void;
  onDark: (v: string) => void;
  onAutoLight: (v: boolean) => void;
  onAutoDark: (v: boolean) => void;
}) {
  return (
    <>
      <span className="flex flex-col">
        <span className="text-cap font-semibold">{label}</span>
        <span className="font-mono text-[11px] text-fg3">{token}</span>
      </span>
      <HexInput
        value={light}
        onChange={onLight}
        auto={autoLight}
        onAuto={onAutoLight}
        label={`${label} light`}
      />
      <HexInput
        value={dark}
        onChange={onDark}
        auto={autoDark}
        onAuto={onAutoDark}
        label={`${label} dark`}
      />
    </>
  );
}

function HexInput({
  value,
  onChange,
  auto,
  onAuto,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  auto?: boolean;
  onAuto: (v: boolean) => void;
  label: string;
}) {
  const { t } = useI18n();
  // Typing passes through invalid states (#1D...); only complete colors reach the draft.
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setText(value);
  }
  const valid = HEX.test(text);
  function commit(next: string) {
    const v = next.toUpperCase();
    setText(v);
    if (HEX.test(v)) onChange(v);
  }
  return (
    <div className="flex items-center gap-2">
      <label
        className="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-sm shadow-line2"
        style={{ background: HEX.test(value) ? value : 'transparent' }}
      >
        <input
          type="color"
          aria-label={label}
          value={HEX.test(value) ? value.toLowerCase() : '#000000'}
          onChange={(e) => commit(e.target.value)}
          disabled={auto}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <input
        aria-label={`${label} hex`}
        value={text}
        onChange={(e) => commit(e.target.value)}
        disabled={auto}
        aria-invalid={!valid || undefined}
        className={cn(
          'h-8 w-[100px] min-w-0 rounded-sm bg-bg2 px-2 font-mono text-cap text-fg outline-none focus:bg-surface focus:shadow-[inset_0_0_0_1.5px_var(--fg)] disabled:text-fg3',
          !valid && 'shadow-[inset_0_0_0_1.5px_var(--danger)]',
        )}
      />
      {auto !== undefined ? (
        <span className="flex items-center gap-1.5 text-xs text-fg2">
          <Switch
            aria-label={`${label} ${t('admin.theme.auto')}`}
            checked={auto}
            onCheckedChange={onAuto}
            className="scale-75"
          />
          {t('admin.theme.auto')}
        </span>
      ) : null}
    </div>
  );
}

const STRIP: (keyof ColorTokens)[] = [
  'bg2',
  'line2',
  'fg',
  'fg2',
  'fg3',
  'accentFg',
  'accentText',
  'accent10',
];

function DerivedStrip({ tokens }: { tokens: ColorTokens }) {
  return (
    <div className="flex flex-wrap gap-1">
      {STRIP.map((k) => (
        <span key={k} className="flex flex-col items-center gap-0.5">
          <span
            className="size-5 rounded-[5px] shadow-line2"
            style={{ background: tokens[k] }}
            title={`${cssVarName[k]} ${tokens[k]}`}
          />
          <span className="font-mono text-[9px] text-fg3">
            {k.replace('accent', 'a').slice(0, 4)}
          </span>
        </span>
      ))}
    </div>
  );
}

function ContrastBadge({ check }: { check: ContrastCheck }) {
  const { t, locale } = useI18n();
  const ratio = check.ratio.toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US', {
    minimumFractionDigits: 1,
  });
  if (check.level === 'fail') {
    return <Badge tone="danger">{t('admin.theme.failed', { ratio })}</Badge>;
  }
  return <Badge tone="ok">{`${check.level} · ${ratio}:1`}</Badge>;
}

/** A tiny shell painted with the draft tokens, independent of the current theme. */
function MiniShell({ scheme, tokens }: { scheme: ColorScheme; tokens: ColorTokens }) {
  const { t } = useI18n();
  const style = Object.fromEntries(
    (Object.keys(cssVarName) as (keyof ColorTokens)[]).map((k) => [cssVarName[k], tokens[k]]),
  ) as CSSProperties;
  const s = spaceColors[scheme];
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-[11px] text-fg2">
        <Icon name={scheme === 'light' ? 'sun' : 'moon'} size={12} />
        {t(`admin.theme.${scheme}`)}
        <span className="ml-auto font-mono text-fg3">{tokens.bg}</span>
      </span>
      <div
        data-theme={scheme}
        style={style}
        className="flex flex-col gap-1.5 overflow-hidden rounded-lg bg-bg p-2 text-fg shadow-line2"
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold">{t('home.eyebrow')}</span>
          <span className="rounded-[5px] bg-accent px-1.5 text-[9px] leading-4 font-semibold text-accent-fg">
            + {t('admin.theme.card')}
          </span>
        </div>
        <div className="flex gap-1 text-[8.5px]">
          <span className="rounded-[4px] bg-surface px-1 font-semibold">{t('home.mine')}</span>
          <span className="flex items-center gap-0.5 text-fg2">
            <SpaceDot color="s1" className="size-1" />M
          </span>
          <span className="text-fg2" style={{ color: s.s2 }}>
            ●
          </span>
        </div>
        {['D', 'S', 'P'].map((l) => (
          <div key={l} className="flex items-center gap-1 rounded-[5px] bg-surface p-1">
            <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-bg2 text-[7px] font-bold">
              {l}
            </span>
            <span className="h-1 w-8 rounded-full bg-fg3/40" />
          </div>
        ))}
        <span className="text-[8.5px] text-fg2">
          <b className="rounded-[3px] bg-accent10 px-0.5 font-semibold text-accent-text">
            @{t('admin.theme.mention')}
          </b>
        </span>
        <span className="h-1 overflow-hidden rounded-full bg-bg2">
          <i className="block h-full w-2/3 bg-accent" />
        </span>
      </div>
    </div>
  );
}
