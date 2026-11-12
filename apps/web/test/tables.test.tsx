import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { monthGrid, timelineRange } from '@/lib/tables/dates';
import { opsFor, viewFields } from '@/lib/tables/fields';
import { db } from '@/mocks/db';
import { tablesMockState } from '@/mocks/tables';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const state = () => tablesMockState(db());

describe('tables units', () => {
  it('lays out whole weeks for a month and a timeline window', () => {
    const g = monthGrid('2026-10-15', 1);
    expect(g.from).toBe('2026-09-28');
    expect(g.to).toBe('2026-11-01');
    expect(g.days).toHaveLength(35);
    const sunday = monthGrid('2026-10-15', 7);
    expect(sunday.from).toBe('2026-09-27');
    const tl = timelineRange('2026-10-29', 1, 6);
    expect(tl.from).toBe('2026-10-26');
    expect(tl.days).toHaveLength(42);
  });

  it('offers filter operators per type and orders view fields', () => {
    expect(opsFor('checkbox')).toEqual(['is_checked', 'is_unchecked']);
    expect(opsFor('multi_select')).toContain('has_all');
    const st = state();
    const fields = st.fields.filter((f) => f.tableId === st.tables[0]!.id);
    const view = st.views.find((v) => v.tableId === st.tables[0]!.id)!;
    const hidden = { ...view, config: { ...view.config, hidden: [fields[2]!.id], order: [fields[3]!.id] } };
    const shown = viewFields(fields, hidden);
    expect(shown[0]!.primary).toBe(true);
    expect(shown[1]!.id).toBe(fields[3]!.id);
    expect(shown.some((f) => f.id === fields[2]!.id)).toBe(false);
  });
});

describe('tables (roadmap)', () => {
  it('lists the space tables and opens the grid', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/tables/milvasoft');
    const user = userEvent.setup();
    await user.click((await screen.findAllByText('Müşteriler')).at(-1)!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/tables\/t\//));
    expect(await screen.findByText('Firma 1')).toBeInTheDocument();
    expect(screen.getByText('320 satır')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Aşamalar' })).toBeInTheDocument();
  });

  it('edits a row in its detail, comments and shows the change in history', async () => {
    signedInAs(USER.bugra);
    const st = state();
    const table = st.tables[0]!;
    const row = st.rows.find((r) => r.tableId === table.id)!;
    const primary = st.fields.find((f) => f.tableId === table.id && f.primary)!;
    renderApp(`/tables/t/${table.id}?row=${row.id}`);
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog');
    const input = await within(dialog).findByDisplayValue('Firma 1');
    await user.clear(input);
    await user.type(input, 'Firma 1 A.Ş.{Enter}');
    await waitFor(() => expect(row.values[primary.id]).toBe('Firma 1 A.Ş.'));
    await user.type(within(dialog).getByRole('textbox', { name: 'Yorum yazın' }), 'İlk görüşme yapıldı');
    await user.click(within(dialog).getByRole('button', { name: 'Gönder' }));
    expect(await within(dialog).findByText('İlk görüşme yapıldı')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('tab', { name: 'Geçmiş' }));
    expect(await within(dialog).findByText('değiştirdi')).toBeInTheDocument();
  });

  it('shows kanban columns from the single select field', async () => {
    signedInAs(USER.bugra);
    const st = state();
    const table = st.tables[0]!;
    const kanban = st.views.find((v) => v.tableId === table.id && v.type === 'kanban')!;
    renderApp(`/tables/t/${table.id}?view=${kanban.id}`);
    for (const name of ['Aday', 'Görüşme', 'Teklif', 'Kazanıldı']) {
      expect(await screen.findByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('creates a table from the new table dialog', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/tables/milvasoft');
    const user = userEvent.setup();
    const before = state().tables.length;
    await user.click((await screen.findAllByRole('button', { name: 'Yeni tablo' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Ad'), 'Demirbaşlar');
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur' }));
    await waitFor(() => expect(state().tables).toHaveLength(before + 1));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/tables\/t\//));
    expect(await screen.findByRole('heading', { name: 'Demirbaşlar' })).toBeInTheDocument();
  });
});
