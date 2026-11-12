import { Toaster } from '@crewhall/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { formsMockState } from '@/mocks/forms';
import { USER, type MockState } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const FORM = '0190f0a0-0000-7000-8000-00000000f001';
const FORM_TITLE = 'Ekim teknik buluşması';
const RULE = '0190f0a0-0000-7000-8000-00000000a001';
const RULE_NAME = 'Yeni yanıtta bana haber ver';
const forms = () => formsMockState(db()).forms;
const rules = () =>
  (db() as MockState & { automations?: { rules: { name: string; enabled: boolean }[] } })
    .automations?.rules ?? [];

/** The sidebar row of a form: the link that is also a right-click trigger. */
async function sidebarForm(title = FORM_TITLE) {
  await waitFor(() =>
    expect(
      screen
        .getAllByRole('link', { name: new RegExp(title) })
        .some((l) => l.hasAttribute('data-state')),
    ).toBe(true),
  );
  return screen
    .getAllByRole('link', { name: new RegExp(title) })
    .find((l) => l.hasAttribute('data-state'))!;
}

async function menuOf(el: Element) {
  fireEvent.contextMenu(el);
  return screen.findByRole('menu');
}

const labels = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((i) => i.textContent?.trim());

describe('forms › right-click menu', () => {
  it('lists the editor actions and opens the results', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/forms/milvasoft');
    const user = userEvent.setup();
    const menu = await menuOf(await sidebarForm());
    expect(labels(menu)).toEqual([
      'Aç',
      'Sonuçlar (3)',
      'Yanıt sayfasını aç',
      'Bağlantıyı kopyala',
      'Yeniden adlandır',
      'Kopyasını oluştur',
      'Formu sil',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Sonuçlar (3)' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/forms/f/${FORM}/results`));
  });

  it('copies the public answer link of a public form', async () => {
    signedInAs(USER.bugra);
    forms()[0]!.settings.access = 'public';
    renderApp('/forms/milvasoft');
    render(<Toaster />);
    const user = userEvent.setup();
    const menu = await menuOf(await sidebarForm());
    await user.click(within(menu).getByRole('menuitem', { name: 'Bağlantıyı kopyala' }));
    expect(await screen.findByText('Link kopyalandı')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toMatch(/\/f\/buluşma-2026$/);
  });

  it('makes a copy of the form with its questions and opens it', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/forms/milvasoft');
    const user = userEvent.setup();
    const menu = await menuOf(await sidebarForm());
    await user.click(within(menu).getByRole('menuitem', { name: 'Kopyasını oluştur' }));
    await waitFor(() =>
      expect(forms().some((f) => f.title === `${FORM_TITLE} (kopya)`)).toBe(true),
    );
    const copy = forms().find((f) => f.title === `${FORM_TITLE} (kopya)`)!;
    expect(copy.fields).toHaveLength(forms()[0]!.fields.length);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/forms/f/${copy.id}`));
  });

  it('renames from the menu and deletes after confirming', async () => {
    signedInAs(USER.bugra);
    renderApp('/forms/milvasoft');
    const user = userEvent.setup();
    await user.click(
      within(await menuOf(await sidebarForm())).getByRole('menuitem', {
        name: 'Yeniden adlandır',
      }),
    );
    const input = await screen.findByRole('textbox', { name: 'Form adı' });
    await user.clear(input);
    await user.type(input, 'Kasım buluşması{Enter}');
    await waitFor(() => expect(forms()[0]!.title).toBe('Kasım buluşması'));

    await user.click(
      within(await menuOf(await sidebarForm('Kasım buluşması'))).getByRole('menuitem', {
        name: 'Formu sil',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: '“Kasım buluşması” silinsin mi?' });
    // Nothing is gone before confirming.
    expect(forms()).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Formu sil' }));
    await waitFor(() => expect(forms()).toHaveLength(0));
  });

  it('renames with a double click on the title and the editor follows', async () => {
    signedInAs(USER.bugra);
    renderApp(`/forms/f/${FORM}`);
    const user = userEvent.setup();
    await screen.findByDisplayValue(FORM_TITLE);
    await user.dblClick(within(await sidebarForm()).getByText(FORM_TITLE));
    const input = await screen.findByRole('textbox', { name: 'Form adı' });
    await user.clear(input);
    await user.type(input, 'Yeni ad{Enter}');
    await waitFor(() => expect(forms()[0]!.title).toBe('Yeni ad'));
    expect(await screen.findByDisplayValue('Yeni ad')).toBeInTheDocument();
    // The editor took the new title: nothing left to save.
    expect(screen.getByRole('button', { name: 'Kaydedildi' })).toBeDisabled();
  });

  it('offers "new form" on the empty area', async () => {
    signedInAs(USER.bugra);
    renderApp('/forms/milvasoft');
    const user = userEvent.setup();
    await sidebarForm();
    const empty = await menuOf(screen.getByText('Formlar', { selector: '.eyebrow' }));
    expect(labels(empty)).toEqual(['Yeni form']);
    await user.click(within(empty).getByRole('menuitem', { name: 'Yeni form' }));
    expect(await screen.findByRole('dialog', { name: 'Yeni form' })).toBeInTheDocument();
  });

  it('gives a space viewer only answering and the link', async () => {
    signedInAs(USER.burak);
    renderApp('/forms/milvasoft');
    const menu = await menuOf(await sidebarForm());
    expect(labels(menu)).toEqual(['Aç', 'Bağlantıyı kopyala']);
  });
});

describe('automations › right-click menu', () => {
  const ruleRow = async () =>
    (await screen.findByText(RULE_NAME, { selector: 'main *' })).closest('li')!;

  it('pauses a rule from its menu', async () => {
    signedInAs(USER.bugra);
    renderApp('/automations/milvasoft');
    render(<Toaster />);
    const user = userEvent.setup();
    const menu = await menuOf(await ruleRow());
    expect(labels(menu)).toEqual([
      'Aç',
      'Çalıştırma geçmişi',
      'Duraklat',
      'Yeniden adlandır',
      'Kuralı sil',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Duraklat' }));
    await waitFor(() => expect(rules()[0]!.enabled).toBe(false));
    expect(await screen.findByText('Kural duraklatıldı')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: `${RULE_NAME} kuralını aç ya da kapat` }),
    ).not.toBeChecked();
    // Paused: the menu now offers to turn it back on.
    expect(labels(await menuOf(await ruleRow()))).toContain('Etkinleştir');
  });

  it('opens the run history of a rule', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/automations/milvasoft');
    const user = userEvent.setup();
    await user.click(
      within(await menuOf(await ruleRow())).getByRole('menuitem', { name: 'Çalıştırma geçmişi' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(`/automations/rule/${RULE}`));
    expect(router.state.location.hash).toBe('runs');
    expect(await screen.findByRole('button', { name: /^Geçmiş/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('renames from the menu and deletes after confirming', async () => {
    signedInAs(USER.bugra);
    renderApp('/automations/milvasoft');
    const user = userEvent.setup();
    await user.click(
      within(await menuOf(await ruleRow())).getByRole('menuitem', { name: 'Yeniden adlandır' }),
    );
    const input = await screen.findByRole('textbox', { name: 'Kural adı' });
    await user.clear(input);
    await user.type(input, 'PDF gelince haber ver{Enter}');
    await waitFor(() => expect(rules()[0]!.name).toBe('PDF gelince haber ver'));

    const row = (await screen.findByText('PDF gelince haber ver', { selector: 'main *' })).closest(
      'li',
    )!;
    await user.click(within(await menuOf(row)).getByRole('menuitem', { name: 'Kuralı sil' }));
    const dialog = await screen.findByRole('dialog');
    expect(rules()).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Kuralı sil' }));
    await waitFor(() => expect(rules()).toHaveLength(0));
  });

  it('offers "new rule" on the empty area', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/automations/milvasoft');
    const user = userEvent.setup();
    await ruleRow();
    const empty = await menuOf(screen.getByRole('heading', { level: 1 }));
    expect(labels(empty)).toEqual(['Yeni kural']);
    await user.click(within(empty).getByRole('menuitem', { name: 'Yeni kural' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/automations/milvasoft/new'));
  });

  it('hides managing a rule from space editors', async () => {
    signedInAs(USER.can);
    renderApp('/automations/milvasoft');
    expect(labels(await menuOf(await ruleRow()))).toEqual(['Aç', 'Çalıştırma geçmişi']);
  });
});
