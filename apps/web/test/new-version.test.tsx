import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewVersionBanner } from '@/components/common/NewVersionBanner';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { hasNewVersion, mainBundle, runningBundle } from '@/lib/newVersion';

/** "Yeni sürüm hazır · Yenile" (the desktop app stayed on an old web app for days). */

const built = (hash: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/main-${hash}.js"></script>` +
  `<link rel="modulepreload" crossorigin href="/assets/vendor-x.js"></head><body></body></html>`;

const page = (html: string) => ({ ok: true, text: async () => html }) as unknown as Response;

describe('main bundle of index.html', () => {
  it('is the hashed module script of a build', () => {
    expect(mainBundle(built('abc123'))).toBe('/assets/main-abc123.js');
  });

  it('is nothing on the dev server (no hashed bundle)', () => {
    expect(mainBundle('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
    expect(mainBundle('<html></html>')).toBeNull();
  });
});

describe('hasNewVersion', () => {
  it('says yes only when the server serves another bundle', async () => {
    expect(await hasNewVersion('/assets/main-abc123.js', async () => page(built('abc123')))).toBe(
      false,
    );
    expect(await hasNewVersion('/assets/main-abc123.js', async () => page(built('def456')))).toBe(
      true,
    );
  });

  it('says no on errors, odd answers and on the dev server', async () => {
    const fail = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await hasNewVersion('/assets/main-abc123.js', fail)).toBe(false);
    expect(
      await hasNewVersion('/assets/main-abc123.js', async () => ({ ok: false }) as Response),
    ).toBe(false);
    expect(await hasNewVersion('/assets/main-abc123.js', async () => page('<html></html>'))).toBe(
      false,
    );
    expect(await hasNewVersion(null, async () => page(built('def456')))).toBe(false);
  });
});

describe('NewVersionBanner', () => {
  let script: HTMLScriptElement;
  const reload = vi.fn();
  beforeEach(() => {
    script = document.createElement('script');
    script.type = 'module';
    script.setAttribute('src', '/assets/main-abc123.js');
    document.head.append(script);
    vi.stubGlobal('location', { ...window.location, reload });
  });
  afterEach(() => {
    script.remove();
    vi.unstubAllGlobals();
    reload.mockReset();
  });

  it('appears when the window comes back and the server has a new version; Yenile reloads', async () => {
    expect(runningBundle()).toBe('/assets/main-abc123.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => page(built('def456'))),
    );
    render(
      <I18nProvider locale="tr">
        <NewVersionBanner />
      </I18nProvider>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText('Yeni sürüm hazır')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Yenile' }));
    expect(reload).toHaveBeenCalled();
  });

  it('stays hidden while the server serves the same version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => page(built('abc123'))),
    );
    render(
      <I18nProvider locale="tr">
        <NewVersionBanner />
      </I18nProvider>,
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Yeni sürüm hazır')).toBeNull();
  });
});
