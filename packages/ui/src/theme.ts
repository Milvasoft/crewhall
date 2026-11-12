/**
 * Web runtime theming: turns the org theme (bootstrap / publishTheme) into CSS variables and
 * applies the user's appearance choice. Mobile uses deriveColors from ./tokens instead.
 */
import {
  colors,
  cssVarName,
  deriveColors,
  radiusScale,
  type ColorScheme,
  type ColorTokens,
  type ThemeModeInput,
} from './tokens';

export interface OrgThemeInput {
  light: ThemeModeInput;
  dark: ThemeModeInput;
  radius: keyof typeof radiusScale;
  density: 'compact' | 'comfortable';
}

export type Appearance = 'system' | 'light' | 'dark';

const STYLE_ID = 'crewhall-org-theme';

function varsBlock(t: ColorTokens): string {
  return (Object.keys(cssVarName) as (keyof ColorTokens)[])
    .map((k) => `${cssVarName[k]}:${t[k]};`)
    .join('');
}

/** CSS text with the derived tokens for both schemes. */
export function buildThemeCss(theme: OrgThemeInput): string {
  const light = deriveColors('light', theme.light);
  const dark = deriveColors('dark', theme.dark);
  // `html` raises specificity above the preset's :root / [data-theme] rules, which may be
  // injected after this tag (Vite dev). Nested dark scopes (e.g. a dark panel) follow too.
  return (
    `html:root{${varsBlock(light)}--radius-scale:${radiusScale[theme.radius]};}` +
    `html[data-theme="dark"],html [data-theme="dark"]{${varsBlock(dark)}}`
  );
}

/** Inject (or replace) the org theme style tag and set density on <html>. */
export function applyOrgTheme(theme: OrgThemeInput, doc: Document = document): void {
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement('style');
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  el.textContent = buildThemeCss(theme);
  doc.documentElement.dataset.density = theme.density;
}

export function resolveScheme(appearance: Appearance, prefersDark: boolean): ColorScheme {
  if (appearance === 'system') return prefersDark ? 'dark' : 'light';
  return appearance;
}

/** Set `data-theme` on <html> so the dark tokens apply. */
export function applyScheme(scheme: ColorScheme, doc: Document = document): void {
  doc.documentElement.dataset.theme = scheme;
  doc.documentElement.style.colorScheme = scheme;
}

export { colors };
