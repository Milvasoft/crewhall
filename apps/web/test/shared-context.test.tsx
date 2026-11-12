import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * H1: a route chunk that gets its own copy of the i18n or theme module (dev server hot
 * update or re-optimization, or a tab mixing two deployments) must still find the
 * providers mounted above the router.
 */
describe('app-wide contexts across module copies', () => {
  it('a second copy of the i18n module reads the provider of the first', async () => {
    const first = await import('@/lib/i18n/I18nContext');
    vi.resetModules();
    const second = await import('@/lib/i18n/I18nContext');
    expect(second.useI18n).not.toBe(first.useI18n);

    function LatePage() {
      const { t } = second.useI18n();
      return <p>{t('boards.toolbar.addCard')}</p>;
    }
    render(
      <first.I18nProvider locale="tr">
        <LatePage />
      </first.I18nProvider>,
    );
    expect(screen.getByText('Kart ekle')).toBeInTheDocument();
  });

  it('a second copy of the theme module reads the provider of the first', async () => {
    const first = await import('@/lib/theme/ThemeContext');
    vi.resetModules();
    const second = await import('@/lib/theme/ThemeContext');
    expect(second.useTheme).not.toBe(first.useTheme);

    function LatePage() {
      const theme = second.useTheme();
      return <p>{typeof theme.scheme === 'string' ? 'tema var' : 'yok'}</p>;
    }
    render(
      <first.ThemeProvider>
        <LatePage />
      </first.ThemeProvider>,
    );
    expect(screen.getByText('tema var')).toBeInTheDocument();
  });
});
