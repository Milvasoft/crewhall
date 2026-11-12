import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { formsMockState } from '@/mocks/forms';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const FORM = '0190f0a0-0000-7000-8000-00000000f001';
const state = () => formsMockState(db());

describe('forms (roadmap 16)', () => {
  it('lists the space forms and asks for a name before creating one', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/forms/milvasoft');
    expect((await screen.findAllByText('Ekim teknik buluşması')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Yanıt alıyor').length).toBeGreaterThan(0);
    const user = userEvent.setup();
    const before = state().forms.length;
    await user.click(screen.getAllByRole('button', { name: 'Yeni form' })[0]!);
    const dialog = await screen.findByRole('dialog');
    // Nothing is created until it has a name.
    expect(within(dialog).getByRole('button', { name: 'Oluştur' })).toBeDisabled();
    expect(state().forms).toHaveLength(before);
    await user.type(within(dialog).getByLabelText('Form adı'), 'Kahve tercihleri');
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/forms\/f\//));
    expect(await screen.findByDisplayValue('Kahve tercihleri')).toBeInTheDocument();
    expect(screen.getByText('Form boş')).toBeInTheDocument();
  });

  it('selects a field from anywhere on its row and keeps it selected (B7)', async () => {
    signedInAs(USER.bugra);
    renderApp(`/forms/f/${FORM}`);
    const user = userEvent.setup();
    await screen.findByDisplayValue('Ekim teknik buluşması');
    const title = screen.getByText('Hangi ekiptesin?');
    await user.click(title);
    const settings = screen.getByRole('complementary', { name: 'Alan ayarları' });
    expect(within(settings).getByLabelText('Soru')).toHaveValue('Hangi ekiptesin?');
    // A second click on the same title does not drop the selection.
    await user.click(title);
    expect(within(settings).getByLabelText('Soru')).toHaveValue('Hangi ekiptesin?');
  });

  it('warns about unfinished questions before publishing', async () => {
    signedInAs(USER.bugra);
    state().forms[0]!.status = 'draft';
    renderApp(`/forms/f/${FORM}`);
    const user = userEvent.setup();
    await screen.findByDisplayValue('Ekim teknik buluşması');
    await user.click(screen.getByRole('button', { name: 'Tek seçim alanı ekle' }));
    await user.click(screen.getByRole('button', { name: 'Yayınla' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yayınlamadan önce bak' });
    expect(
      within(dialog).getByText('Soru metni alan türünün adı olarak kalmış.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Seçenekler "Seçenek 1" gibi kalmış.')).toBeInTheDocument();
    expect(state().forms[0]!.status).toBe('draft');
    await user.click(within(dialog).getByRole('button', { name: 'Yine de yayınla' }));
    await waitFor(() => expect(state().forms[0]!.status).toBe('open'));
  });

  it('offers another answer and the way back after sending', async () => {
    signedInAs(USER.can);
    renderApp(`/forms/edit/${FORM}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Ekim teknik buluşması' });
    await user.type(screen.getByRole('textbox', { name: 'Adın soyadın' }), 'Can');
    await user.click(screen.getByRole('radio', { name: 'Web' }));
    await user.click(screen.getByRole('button', { name: 'Gönder' }));
    expect(await screen.findByText('Teşekkürler!')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Formlara dön' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Başka yanıt gönder' }));
    expect(screen.getByRole('textbox', { name: 'Adın soyadın' })).toHaveValue('');
  });

  it('adds fields from the palette, edits them and saves', async () => {
    signedInAs(USER.bugra);
    renderApp(`/forms/f/${FORM}`);
    const user = userEvent.setup();
    await screen.findByDisplayValue('Ekim teknik buluşması');
    await user.click(screen.getByRole('button', { name: 'Puan alanı ekle' }));
    const settings = screen.getByRole('complementary', { name: 'Alan ayarları' });
    const label = within(settings).getByLabelText('Soru');
    await user.clear(label);
    await user.type(label, 'Konuşmacıları puanla');
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() =>
      expect(state().forms[0]!.fields.map((f) => f.label)).toContain('Konuşmacıları puanla'),
    );
    // Added after the selected (first) field.
    expect(state().forms[0]!.fields[1]!.type).toBe('rating');
  });

  it('moves a field with the move buttons and drops broken conditions', async () => {
    signedInAs(USER.bugra);
    renderApp(`/forms/f/${FORM}`);
    const user = userEvent.setup();
    await screen.findByDisplayValue('Ekim teknik buluşması');
    // "Backend için öneri" depends on "Hangi ekiptesin?"; moving it to the top drops the condition.
    const row = () =>
      screen.getByRole('button', { name: 'Backend için öneri alanını taşı' }).parentElement!;
    for (let i = 0; i < 4; i++) {
      await user.click(within(row()).getByRole('button', { name: 'Yukarı taşı' }));
    }
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(state().forms[0]!.fields[0]!.id).toBe('note'));
    expect(state().forms[0]!.fields[0]!.showIf).toBeNull();
  });

  it('answers in the app with conditional fields and required checks', async () => {
    signedInAs(USER.can);
    renderApp(`/forms/edit/${FORM}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Ekim teknik buluşması' });
    expect(screen.queryByText('Backend için öneri')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Gönder' }));
    expect((await screen.findAllByText('Bu alan zorunlu.')).length).toBe(2);
    await user.type(screen.getByRole('textbox', { name: 'Adın soyadın' }), 'Can Demir');
    await user.click(screen.getByRole('radio', { name: 'Backend' }));
    expect(await screen.findByText('Backend için öneri')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '4 / 5' }));
    await user.click(screen.getByRole('button', { name: 'Gönder' }));
    expect((await screen.findAllByText('Bu alan zorunlu.')).length).toBe(1);
    await user.type(screen.getByRole('textbox', { name: 'Backend için öneri' }), 'Daha çok demo');
    await user.click(screen.getByRole('button', { name: 'Gönder' }));
    expect(await screen.findByText('Teşekkürler!')).toBeInTheDocument();
    const last = state().responses.at(-1)!;
    expect(last.answers).toMatchObject({
      name: 'Can Demir',
      team: 'api',
      score: 4,
      note: 'Daha çok demo',
    });
  });

  it('shows results as charts and a table', async () => {
    signedInAs(USER.bugra);
    renderApp(`/forms/f/${FORM}/results`);
    const user = userEvent.setup();
    expect(await screen.findByText('3 yanıt')).toBeInTheDocument();
    expect(await screen.findByText('Hangi ekiptesin?')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument(); // rating average
    expect(screen.getByRole('link', { name: /CSV indir/ })).toHaveAttribute(
      'href',
      expect.stringContaining(`/api/v1/forms/${FORM}/responses.csv`),
    );
    await user.click(screen.getByRole('radio', { name: /Tablo/ }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Mert Kaya')).toBeInTheDocument();
    expect(within(table).getByText('Kuyruk izleme')).toBeInTheDocument();
  });

  it('makes the form public and answers through the link without a session', async () => {
    signedInAs(USER.bugra);
    const form = state().forms[0]!;
    form.settings = { ...form.settings, access: 'public', oneResponse: true };
    db().auth.sessionId = null;
    renderApp(`/f/${form.token}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Ekim teknik buluşması' });
    expect(screen.getByText('Her kişi bir kez yanıtlayabilir.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Adın soyadın' }), 'Ziyaretçi');
    await user.click(screen.getByRole('radio', { name: 'Web' }));
    await user.click(screen.getByRole('button', { name: 'Gönder' }));
    expect(await screen.findByText('Teşekkürler!')).toBeInTheDocument();
    expect(state().responses.at(-1)!.respondentId).toBeNull();
  });

  it('shows an invalid link page for unknown tokens', async () => {
    renderApp('/f/yok-boyle-bir-link');
    expect(await screen.findByText('Bu form linki geçersiz')).toBeInTheDocument();
  });
});
