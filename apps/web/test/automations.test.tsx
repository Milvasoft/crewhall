import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { USER, type MockState } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const RULE = '0190f0a0-0000-7000-8000-00000000a001';
const rules = () =>
  (
    db() as MockState & {
      automations?: {
        rules: { name: string; trigger: { type: string }; actions: { type: string }[] }[];
      };
    }
  ).automations?.rules ?? [];

describe('automations (roadmap 17)', () => {
  it('lists the space rules with their last run', async () => {
    signedInAs(USER.bugra);
    renderApp('/automations/milvasoft');
    expect((await screen.findAllByText('Yeni yanıtta bana haber ver')).length).toBeGreaterThan(0);
    expect(screen.getByText('Dosya yüklendi → Bildirim gönder')).toBeInTheDocument();
    expect(screen.getByText('Başarılı')).toBeInTheDocument();
  });

  it('builds a rule from the catalog: trigger, condition and action', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/automations/milvasoft/new');
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Kural adı');
    await user.clear(name);
    await user.type(name, 'Gelen deploy hatası');
    await user.click(screen.getByRole('combobox', { name: 'Tetikleyici' }));
    // The calendar's trigger is available (roadmap 14 registers it).
    expect(screen.getByRole('option', { name: /^Etkinlik yaklaştı/ })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('option', { name: 'Webhook geldi' }));
    await user.click(screen.getByRole('button', { name: 'Koşul ekle' }));
    const value = screen.getByLabelText('Değer');
    await user.type(value, 'failed');
    await user.click(screen.getByRole('button', { name: /Eylem ekle/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Bildirim gönder' }));
    await user.click(screen.getByRole('checkbox', { name: 'Mert Aydın' }));
    await user.type(screen.getByRole('textbox', { name: 'Mesaj *' }), 'Deploy düştü: ');
    await user.click(screen.getByRole('button', { name: 'Değişken ekle' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Gelen veri değişkenini ekle' }));
    expect(screen.getByRole('textbox', { name: 'Mesaj *' })).toHaveValue('Deploy düştü: {{body}}');
    await user.click(screen.getByRole('button', { name: 'Kuralı oluştur' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/automations\/rule\//));
    const created = rules().find((r) => r.name === 'Gelen deploy hatası')!;
    expect(created.trigger.type).toBe('webhook.received');
    expect(created.actions.map((a) => a.type)).toEqual(['notify.users']);
    // The incoming webhook address is shown on the rule page.
    const hook = (await screen.findByLabelText('Gelen webhook adresi')) as HTMLInputElement;
    expect(hook.value).toContain('/api/automations/hooks/');
  });

  it('names form answers in the variable menu and tells chats apart', async () => {
    signedInAs(USER.bugra);
    renderApp('/automations/milvasoft/new');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Tetikleyici' }));
    await user.click(screen.getByRole('option', { name: 'Form yanıtı geldi' }));
    await user.click(screen.getByRole('combobox', { name: 'Hangi form *' }));
    await user.click(await screen.findByRole('option', { name: 'Ekim teknik buluşması' }));
    await user.click(screen.getByRole('button', { name: /Eylem ekle/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sohbete yaz' }));
    // Same-named chats carry their type and who is in them.
    await user.click(screen.getByRole('combobox', { name: 'Sohbet *' }));
    const options = await screen.findAllByRole('option');
    expect(options.some((o) => /kişi|Space sohbeti/.test(o.textContent ?? ''))).toBe(true);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Değişken ekle' }));
    expect(
      await screen.findByRole('menuitem', { name: 'Yanıt · Hangi ekiptesin? değişkenini ekle' }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('menuitem', { name: 'Tüm yanıtlar (Soru: cevap) değişkenini ekle' }),
    );
    expect(screen.getByRole('textbox', { name: 'Mesaj *' })).toHaveValue('{{answers}}');
  });

  it('runs a rule now and shows it in the history', async () => {
    signedInAs(USER.bugra);
    renderApp(`/automations/rule/${RULE}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Yeni yanıtta bana haber ver' });
    await user.click(screen.getByRole('button', { name: 'Şimdi dene' }));
    const history = await screen.findByText('Deneme');
    expect(history).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows.some((r) => within(r).queryByText('Deneme'))).toBe(true);
  });

  it('keeps rules read-only for space editors', async () => {
    signedInAs(USER.elif);
    renderApp(`/automations/rule/${RULE}`);
    await screen.findByRole('heading', { name: 'Yeni yanıtta bana haber ver' });
    expect(screen.queryByRole('button', { name: 'Şimdi dene' })).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Kural adı')).toBeDisabled();
  });
});
