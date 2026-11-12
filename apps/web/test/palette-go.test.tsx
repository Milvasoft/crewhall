import { MODULE_KEYS, type ModuleKey } from '@crewhall/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canOpenRoute,
  ROUTE_BY_ID,
  ROUTE_CATALOG,
  routeOfPath,
  type RouteViewer,
} from '@/lib/routes/catalog';
import { clearRecentRoutes } from '@/lib/routes/recent';
import { fold, matchScore } from '@/lib/routes/search';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const viewer = (patch: Partial<RouteViewer> = {}): RouteViewer => ({
  role: 'owner',
  modules: new Set<ModuleKey>(MODULE_KEYS),
  can: () => true,
  ...patch,
});

/** Best catalogue pages for a query, as "Parent › Label" ids. */
function best(query: string, labels: Record<string, string>) {
  return ROUTE_CATALOG.map((r) => ({
    id: r.id,
    s: matchScore(query, {
      label: labels[r.id] ?? r.id,
      crumb: 'parent' in r ? labels[r.parent] : undefined,
      keywords: r.keywords,
    }),
  }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.id);
}

const LABELS: Record<string, string> = {
  account: 'Hesabım',
  'account.approvals': 'Onay bekleyenler',
  'account.security': 'Güvenlik',
  admin: 'Yönetim',
  'admin.ai': 'Yapay zekâ',
  'admin.stats': 'İstatistikler',
  'admin.mail': 'Posta sunucusu',
  'admin.security': 'Güvenlik',
};

describe('route catalogue', () => {
  it('matches without caring about Turkish letters or case', () => {
    expect(fold('İstatistikler ŞĞÇÖÜ ıâ')).toBe('istatistikler sgcou ia');
    expect(fold('Yapay zekâ')).toHaveLength('Yapay zekâ'.length);
    expect(best('onay', LABELS)[0]).toBe('account.approvals');
    expect(best('yapay', LABELS)[0]).toBe('admin.ai');
    expect(best('yapay zeka', LABELS)[0]).toBe('admin.ai');
    expect(best('ISTATISTIK', LABELS)[0]).toBe('admin.stats');
    expect(best('guvenlik', LABELS)).toEqual(
      expect.arrayContaining(['account.security', 'admin.security']),
    );
    // Synonyms, in both languages.
    expect(best('approval', LABELS)[0]).toBe('account.approvals');
    expect(best('smtp', LABELS)).toContain('admin.mail');
    expect(best('llm', LABELS)[0]).toBe('admin.ai');
    // Small typos still find the page; unrelated words find nothing.
    expect(best('istatstk', LABELS)[0]).toBe('admin.stats');
    expect(best('yol harita', LABELS)).toEqual([]);
  });

  it('lists only what the person may open', () => {
    const ids = (v: RouteViewer) =>
      ROUTE_CATALOG.filter((r) => canOpenRoute(r, v)).map((r) => r.id);
    const member = ids(viewer({ role: 'member' }));
    expect(member).toContain('account.approvals');
    expect(member.some((id) => id.startsWith('admin'))).toBe(false);
    expect(ids(viewer({ role: 'guest' }))).not.toContain('mail');
    // Module off: its pages (and their Yönetim page) go.
    const noAi = ids(viewer({ modules: new Set(MODULE_KEYS.filter((m) => m !== 'ai')) }));
    expect(noAi).not.toContain('admin.ai');
    expect(noAi).toContain('admin.general');
    // Permission and install admin.
    expect(ids(viewer({ can: (a) => a !== 'org.view_stats' }))).not.toContain('admin.stats');
    expect(ids(viewer())).not.toContain('admin.backups');
    expect(ids(viewer({ installAdmin: true }))).toContain('admin.backups');
  });

  it('knows which page a location belongs to', () => {
    expect(routeOfPath('/admin/members/abc')).toBe('admin.members');
    expect(routeOfPath('/account/profile')).toBe('account.profile');
    expect(routeOfPath('/account/approvals/123')).toBe('account.approvals');
    expect(routeOfPath('/drive/milvasoft')).toBe('drive');
    expect(routeOfPath('/')).toBe('home');
    expect(ROUTE_BY_ID['admin.ai'].path).toBe('/admin/ai');
  });
});

async function openPalette(path = '/') {
  const { router } = renderApp(path);
  const user = userEvent.setup();
  await screen.findByRole('navigation', { name: 'Modüller' });
  await user.keyboard('{Control>}k{/Control}');
  const dialog = await screen.findByRole('dialog', { name: 'Komut paleti' });
  return { user, dialog, router, input: within(dialog).getByRole('combobox') };
}

describe('Ctrl K › Git', () => {
  beforeEach(() => {
    clearRecentRoutes();
    localStorage.removeItem('crewhall.recentRoutes');
  });

  it('"onay" goes to Onay bekleyenler; pages come first while typing', async () => {
    signedInAs(USER.bugra);
    const { user, dialog, input, router } = await openPalette();
    await user.type(input, 'onay');
    const groups = within(dialog).getAllByRole('group');
    expect(groups[0]).toHaveAccessibleName('Sayfalar ve ayarlar');
    const first = within(groups[0]!).getAllByRole('option')[0]!;
    expect(first).toHaveTextContent('Onay bekleyenler');
    expect(first).toHaveTextContent('Hesabım');
    await user.click(first);
    await waitFor(() => expect(router.state.location.pathname).toBe('/account/approvals'));
  });

  it('"yapay" finds Yönetim › Yapay zekâ for admins, not for members', async () => {
    signedInAs(USER.bugra);
    const { user, dialog, input } = await openPalette();
    await user.type(input, 'yapay');
    const option = await within(dialog).findByRole('option', { name: /Yapay zekâ.*Yönetim/ });
    expect(option).toBeInTheDocument();
  });

  it('members do not see Yönetim pages', async () => {
    signedInAs(USER.burak);
    const { user, dialog, input } = await openPalette();
    await user.type(input, 'yapay');
    expect(within(dialog).queryByRole('option', { name: /Yönetim/ })).toBeNull();
    await user.clear(input);
    await user.type(input, 'üyeler');
    expect(within(dialog).queryByRole('option', { name: /Üyeler/ })).toBeNull();
  });

  it('a switched-off module leaves its pages out', async () => {
    db().org!.settings.modules = { mail: false };
    signedInAs(USER.bugra);
    const { user, dialog, input } = await openPalette();
    await user.type(input, 'smtp');
    expect(within(dialog).queryByRole('option', { name: /Posta sunucusu/ })).toBeNull();
    expect(within(dialog).getByRole('option', { name: /Bildirim gönderimi/ })).toBeInTheDocument();
  });

  it('empty, it shows the recently visited pages and shortcuts; "/" narrows to pages', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/admin/stats');
    await screen.findByRole('navigation', { name: 'Modüller' });
    await act(() => router.navigate({ to: '/account/security' }));
    await act(() => router.navigate({ to: '/' }));
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Komut paleti' });
    const recent = within(dialog).getByRole('group', { name: 'Son gidilenler' });
    const names = within(recent)
      .getAllByRole('option')
      .map((o) => o.textContent);
    // Newest first; the page one is on (home) is left out.
    expect(names[0]).toMatch(/Güvenlik.*Hesabım/);
    expect(names[1]).toMatch(/İstatistikler.*Yönetim/);
    expect(names.join()).not.toMatch(/Ana sayfa/);
    expect(within(dialog).getByRole('group', { name: 'Kısayollar' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Kişiler' })).toBeNull();

    // A recent page ranks above an equally good match.
    await user.type(within(dialog).getByRole('combobox'), 'güvenlik');
    const pages = within(dialog).getByRole('group', { name: 'Sayfalar ve ayarlar' });
    expect(within(pages).getAllByRole('option')[0]).toHaveTextContent(/Güvenlik.*Hesabım/);

    await user.clear(within(dialog).getByRole('combobox'));
    await user.type(within(dialog).getByRole('combobox'), '/tema');
    const groups = within(dialog).getAllByRole('group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveAccessibleName('Sayfalar ve ayarlar');
    expect(within(groups[0]!).getByRole('option', { name: /Tema.*Yönetim/ })).toBeInTheDocument();
  });
});
