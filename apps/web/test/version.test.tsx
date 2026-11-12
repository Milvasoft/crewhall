import { Toaster } from '@crewhall/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInfoPlugin, buildValues } from '../buildInfoPlugin';
import { readBuildInfo, shortCommit } from '@/lib/buildInfo';
import { hasNewVersion } from '@/lib/newVersion';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** "Did the deploy arrive?": Hesabım › Hakkında and Ctrl K say which version is running. */

const COMMIT = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const SERVER_COMMIT = 'f00dbabe0123456789abcdef0123456789abcdef';
const BUILT_AT = '2026-11-05T09:30:00.000Z';

const tag = (id: string, commit = COMMIT, at = BUILT_AT) =>
  `<meta name="crewhall-build" content="${id}" data-commit="${commit}" data-built-at="${at}">`;

function setBuild(id: string) {
  document.head.insertAdjacentHTML('beforeend', tag(id));
}

const clearBuild = () => document.querySelector('meta[name="crewhall-build"]')?.remove();

afterEach(clearBuild);

describe('build values', () => {
  it('take the number and commit from CI', () => {
    const git = vi.fn(() => 'from-git');
    const at = new Date(BUILT_AT);
    expect(buildValues({ BUILD_ID: '4821', BUILD_COMMIT: COMMIT }, git, at)).toEqual({
      id: '4821',
      commit: COMMIT,
      builtAt: BUILT_AT,
    });
    expect(git).not.toHaveBeenCalled();
  });

  it('fall back to git for the commit, and have no number outside CI', () => {
    expect(buildValues({ BUILD_ID: '', BUILD_COMMIT: '' }, () => 'from-git')).toMatchObject({
      id: null,
      commit: 'from-git',
    });
    expect(buildValues({}, () => null)).toMatchObject({ id: null, commit: null });
  });

  it('reach the page through the tag the plugin writes', () => {
    const plugin = buildInfoPlugin({ id: '4821', commit: COMMIT, builtAt: BUILT_AT });
    const transform = plugin.transformIndexHtml as unknown as () => {
      attrs: Record<string, string>;
    }[];
    const { attrs } = transform()[0]!;
    const meta = document.createElement('meta');
    for (const [k, v] of Object.entries(attrs)) meta.setAttribute(k, v);
    document.head.append(meta);
    expect(readBuildInfo()).toEqual({ id: '4821', commit: COMMIT, builtAt: BUILT_AT });
  });

  it('are nothing on a page without the tag', () => {
    expect(readBuildInfo()).toBeNull();
  });
});

describe('new version, with the build number', () => {
  const bundle = '/assets/main-abc123.js';
  const page = (meta: string) =>
    ({
      ok: true,
      text: async () =>
        `<!doctype html><html><head>${meta}<script type="module" src="${bundle}"></script></head></html>`,
    }) as unknown as Response;
  const running = { id: '4821', commit: COMMIT, builtAt: BUILT_AT };

  it('is there when the same bundle comes from another build', async () => {
    expect(await hasNewVersion(bundle, async () => page(tag('4822')), running)).toBe(true);
  });

  it('is not there for the same build', async () => {
    expect(await hasNewVersion(bundle, async () => page(tag('4821')), running)).toBe(false);
  });

  it('is not there when either side has no tag', async () => {
    expect(await hasNewVersion(bundle, async () => page(''), running)).toBe(false);
    expect(await hasNewVersion(bundle, async () => page(tag('4822')), null)).toBe(false);
  });
});

describe('Hesabım › Hakkında', () => {
  beforeEach(() => setBuild('4821'));
  afterEach(() => {
    delete window.crewhallDesktop;
  });

  const shortDate = /5 Kas 2026 \d\d:\d\d/;

  it('shows the build of this page and of the server; a click copies the details', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/about');
    render(<Toaster />);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: /Sürüm bilgisini kopyala/ });
    expect(button).toHaveTextContent(`Crewhall 4821 · ${shortCommit(COMMIT)} ·`);
    expect(button).toHaveTextContent(shortDate);
    await within(button).findByText(`Sunucu ${shortCommit(SERVER_COMMIT)} · API 1`);

    await user.click(button);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        `Crewhall 4821 · ${COMMIT} · ${BUILT_AT}\nSunucu ${SERVER_COMMIT} · 4821 · API 1`,
      ),
    );
    expect(await screen.findByText('Sürüm bilgisi kopyalandı')).toBeInTheDocument();
  });

  it('adds the app version on desktop', async () => {
    window.crewhallDesktop = { isDesktop: true, platform: 'win32', version: '0.9.3' };
    signedInAs(USER.bugra);
    renderApp('/account/about');
    expect(await screen.findByText('Masaüstü 0.9.3')).toBeInTheDocument();
  });

  it('says so on a page without a build number', async () => {
    clearBuild();
    signedInAs(USER.bugra);
    renderApp('/account/about');
    const button = await screen.findByRole('button', { name: /Sürüm bilgisini kopyala/ });
    expect(button).toHaveTextContent('Crewhall geliştirme');
    expect(button).not.toHaveTextContent('null');
  });
});

describe('Ctrl K', () => {
  beforeEach(() => setBuild('4821'));

  it('finds the version by the word and copies it', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    const user = userEvent.setup();
    await screen.findByRole('navigation', { name: 'Modüller' });
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Komut paleti' });
    await user.type(within(dialog).getByRole('combobox'), 'sürüm');
    const option = await within(dialog).findByRole('option', { name: /Sürüm.*Crewhall 4821/ });
    await within(dialog).findByText(/Sunucu f00dbab · API 1/);
    expect(within(dialog).getByRole('option', { name: /Hakkında/ })).toBeInTheDocument();
    await user.click(option);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toContain(`Crewhall 4821 · ${COMMIT}`),
    );
  });
});
