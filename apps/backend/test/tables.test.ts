import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { automationRuns, organizations } from '@crewhall/db';
import type { Table, TablesWsEvent, WsServerEvent } from '@crewhall/shared';
import { userTopic } from '../src/realtime/bus';
import { forgetTablesSwitch } from '../src/services/tables/access';
import { readXlsx, writeXlsx } from '../src/services/tables/xlsx';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

const csvUrl = (text: string) => `data:text/csv;base64,${Buffer.from(text).toString('base64')}`;
const field = (t: Table, name: string) => t.fields.find((f) => f.name === name)!;

describe('tables', () => {
  let app: TestApp;
  let owner: Client;
  let ownerId: string;
  let spaceId: string;
  let mert: Awaited<ReturnType<typeof join>>;
  let selin: Awaited<ReturnType<typeof join>>;
  let can: Awaited<ReturnType<typeof join>>;
  const events: WsServerEvent[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    mert = await join(app, owner, 'mert@milvasoft.com', 'member');
    selin = await join(app, owner, 'selin@milvasoft.com', 'member');
    can = await join(app, owner, 'can@milvasoft.com', 'member');
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: mert.me.user.id },
      body: { role: 'editor' },
    });
    await owner.api.call('removeSpaceMember', { params: { spaceId, userId: can.me.user.id } });
    app.deps.bus.subscribe(userTopic(selin.me.user.id), (e) => events.push(e));
  });
  afterAll(async () => {
    await app.close();
  });

  it('builds tables from templates, editors write, viewers read, others see nothing', async () => {
    const crm = await mert.person.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Müşteriler', template: 'crm' },
    });
    expect(crm.fields.map((f) => f.name)).toEqual([
      'Şirket',
      'İlgili kişi',
      'E-posta',
      'Telefon',
      'Aşama',
      'Tutar',
      'Sorumlu',
      'Sonraki adım',
      'Notlar',
    ]);
    expect(crm.views.map((v) => [v.name, v.type])).toEqual([
      ['Tüm müşteriler', 'grid'],
      ['Satış hunisi', 'kanban'],
      ['Takip takvimi', 'calendar'],
    ]);
    expect(crm.views[1]!.config.kanbanFieldId).toBe(field(crm, 'Aşama').id);
    expect(crm.rowCount).toBe(3);
    expect(crm.canEdit).toBe(true);

    const seen = await selin.person.api.call('getTable', { params: { tableId: crm.id } });
    expect(seen.canEdit).toBe(false);
    await expect(
      selin.person.api.call('createTableRow', {
        params: { tableId: crm.id },
        body: { values: {} },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      can.person.api.call('getTable', { params: { tableId: crm.id } }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await selin.person.api.call('listTables', { params: { spaceId } })).items.map((t) => t.name),
    ).toContain('Müşteriler');

    const inventory = await owner.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Envanter', template: 'inventory' },
    });
    const page = await owner.api.call('queryTableRows', {
      params: { tableId: inventory.id },
      query: { viewId: inventory.views.find((v) => v.name === 'Azalan stok')!.id },
    });
    // Formula fields: quantity × price and the reorder check the "low stock" view filters on.
    expect(page.items.map((r) => r.values[field(inventory, 'Ürün').id])).toEqual([
      'USB-C şarj aleti',
    ]);
    expect(page.items[0]!.values[field(inventory, 'Toplam değer').id]).toBe(2600);
  });

  it('writes rows with coercion, history, comments, trash and realtime events', async () => {
    const t = await mert.person.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Görevler' },
    });
    const name = field(t, 'Ad');
    const status = field(t, 'Durum');
    const due = await mert.person.api.call('createTableField', {
      params: { tableId: t.id },
      body: { name: 'Bitiş', type: 'date' },
    });
    const who = await mert.person.api.call('createTableField', {
      params: { tableId: t.id },
      body: { name: 'Sorumlu', type: 'person', options: { multiple: false } },
    });
    events.length = 0;
    const row = await mert.person.api.call('createTableRow', {
      params: { tableId: t.id },
      body: {
        values: { [name.id]: 'Sunucu bakımı', [status.id]: 'yapılıyor', [due.id]: '05.11.2026' },
      },
    });
    expect(row.values).toMatchObject({
      [name.id]: 'Sunucu bakımı',
      [status.id]: 'doing',
      [due.id]: '2026-11-05',
    });
    const changed = events.find((e): e is TablesWsEvent => e.type === 'tables.changed');
    expect(changed).toMatchObject({ tableId: t.id, rowIds: [row.id] });

    await expect(
      mert.person.api.call('createTableRow', {
        params: { tableId: t.id },
        body: { values: { [status.id]: 'bilinmiyor', [who.id]: [can.me.user.id] } },
      }),
    ).rejects.toMatchObject({
      code: 'table_value_invalid',
      details: { fields: { [status.id]: 'unknown_choice', [who.id]: 'not_member' } },
    });

    await mert.person.api.call('updateTableRow', {
      params: { tableId: t.id, rowId: row.id },
      body: { values: { [status.id]: 'done', [who.id]: [ownerId] } },
    });
    const history = await mert.person.api.call('listTableRowHistory', {
      params: { tableId: t.id, rowId: row.id },
    });
    expect(history.items.map((h) => h.kind)).toEqual(['updated', 'created']);
    expect(history.items[0]!.changes).toEqual([
      { fieldId: status.id, fieldName: 'Durum', from: 'doing', to: 'done' },
      { fieldId: who.id, fieldName: 'Sorumlu', from: null, to: [ownerId] },
    ]);

    // Viewers may comment.
    const comment = await selin.person.api.call('addTableRowComment', {
      params: { tableId: t.id, rowId: row.id },
      body: { text: 'Hangi sunucu?' },
    });
    expect(comment.author?.name).toBe('selin');
    expect(
      (await owner.api.call('getTableRow', { params: { tableId: t.id, rowId: row.id } }))
        .commentCount,
    ).toBe(1);

    await mert.person.api.call('deleteTableRows', {
      params: { tableId: t.id },
      body: { rowIds: [row.id] },
    });
    expect((await owner.api.call('queryTableRows', { params: { tableId: t.id } })).total).toBe(0);
    await mert.person.api.call('restoreTableRows', {
      params: { tableId: t.id },
      body: { rowIds: [row.id] },
    });
    expect((await owner.api.call('queryTableRows', { params: { tableId: t.id } })).total).toBe(1);
  });

  it('changes field types, guards the primary field and formulas', async () => {
    const t = await owner.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Dönüşüm' },
    });
    const name = field(t, 'Ad');
    const notes = field(t, 'Notlar');
    for (const v of ['12', '7,5', 'yok']) {
      await owner.api.call('createTableRow', {
        params: { tableId: t.id },
        body: { values: { [name.id]: v, [notes.id]: v } },
      });
    }
    await owner.api.call('updateTableField', {
      params: { tableId: t.id, fieldId: notes.id },
      body: { type: 'number', options: { precision: 1 } },
    });
    const rows = await owner.api.call('queryTableRows', { params: { tableId: t.id } });
    expect(rows.items.map((r) => r.values[notes.id])).toEqual([12, 7.5, null]);
    await expect(
      owner.api.call('deleteTableField', { params: { tableId: t.id, fieldId: name.id } }),
    ).rejects.toMatchObject({ code: 'table_primary_field' });
    await expect(
      owner.api.call('createTableField', {
        params: { tableId: t.id },
        body: { name: 'İki kat', type: 'formula', options: { formula: '{Yok} * 2' } },
      }),
    ).rejects.toMatchObject({ code: 'table_formula_invalid' });
    const double = await owner.api.call('createTableField', {
      params: { tableId: t.id },
      body: { name: 'İki kat', type: 'formula', options: { formula: '{Notlar} * 2' } },
    });
    const again = await owner.api.call('queryTableRows', { params: { tableId: t.id } });
    expect(again.items.map((r) => r.values[double.id])).toEqual([24, 15, 0]);
  });

  it('filters, sorts, groups, searches and pages on the server', async () => {
    const t = await owner.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Sayılar' },
    });
    const name = field(t, 'Ad');
    const status = field(t, 'Durum');
    const n = await owner.api.call('createTableField', {
      params: { tableId: t.id },
      body: { name: 'Değer', type: 'number' },
    });
    for (let i = 1; i <= 30; i++) {
      await owner.api.call('createTableRow', {
        params: { tableId: t.id },
        body: {
          values: {
            [name.id]: `Kayıt ${i}`,
            [n.id]: i,
            [status.id]: i % 3 === 0 ? 'done' : i % 3 === 1 ? 'todo' : null,
          },
        },
      });
    }
    const view = await owner.api.call('createTableView', {
      params: { tableId: t.id },
      body: {
        name: 'Büyükler',
        type: 'grid',
        config: {
          filters: [{ fieldId: n.id, op: 'gt', value: '10' }],
          sorts: [{ fieldId: n.id, dir: 'desc' }],
          groupBy: status.id,
        },
      },
    });
    const first = await owner.api.call('queryTableRows', {
      params: { tableId: t.id },
      query: { viewId: view.id, limit: 5 },
    });
    expect(first.total).toBe(20);
    expect(first.groups).toEqual([
      { key: 'todo', count: 6, start: 0 },
      { key: 'done', count: 7, start: 6 },
      { key: '', count: 7, start: 13 },
    ]);
    expect(first.items.map((r) => r.values[n.id])).toEqual([28, 25, 22, 19, 16]);
    const second = await owner.api.call('queryTableRows', {
      params: { tableId: t.id },
      query: { viewId: view.id, limit: 5, cursor: first.nextCursor! },
    });
    expect(second.items.map((r) => r.values[n.id])).toEqual([13, 30, 27, 24, 21]);
    const search = await owner.api.call('queryTableRows', {
      params: { tableId: t.id },
      query: { q: 'kayıt 2' },
    });
    expect(search.total).toBe(11);
  });

  it('links rows across tables with lookups and rollups', async () => {
    const products = await owner.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Ürünler' },
    });
    const pName = field(products, 'Ad');
    const price = await owner.api.call('createTableField', {
      params: { tableId: products.id },
      body: { name: 'Fiyat', type: 'currency' },
    });
    const a = await owner.api.call('createTableRow', {
      params: { tableId: products.id },
      body: { values: { [pName.id]: 'Kalem', [price.id]: 10 } },
    });
    const b = await owner.api.call('createTableRow', {
      params: { tableId: products.id },
      body: { values: { [pName.id]: 'Defter', [price.id]: 35 } },
    });
    const orders = await owner.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Siparişler' },
    });
    const items = await owner.api.call('createTableField', {
      params: { tableId: orders.id },
      body: {
        name: 'Kalemler',
        type: 'relation',
        options: { tableId: products.id, multiple: true },
      },
    });
    const total = await owner.api.call('createTableField', {
      params: { tableId: orders.id },
      body: {
        name: 'Toplam',
        type: 'rollup',
        options: { relationFieldId: items.id, targetFieldId: price.id, fn: 'sum' },
      },
    });
    const names = await owner.api.call('createTableField', {
      params: { tableId: orders.id },
      body: {
        name: 'Ürün adları',
        type: 'lookup',
        options: { relationFieldId: items.id, targetFieldId: pName.id },
      },
    });
    const order = await owner.api.call('createTableRow', {
      params: { tableId: orders.id },
      body: { values: { [items.id]: [a.id, b.id] } },
    });
    expect(order.values[total.id]).toBe(45);
    expect(order.values[names.id]).toEqual(['Kalem', 'Defter']);
    await expect(
      owner.api.call('createTableRow', {
        params: { tableId: orders.id },
        body: { values: { [items.id]: [orders.id] } },
      }),
    ).rejects.toMatchObject({ code: 'table_value_invalid' });
  });

  it('imports CSV as a new table and appends, exports CSV and Excel', async () => {
    const created = await owner.api.call('importTable', {
      params: { spaceId },
      body: {
        fileName: 'stok.csv',
        mode: 'new',
        dataURL: csvUrl(
          'Ürün;Adet;Tarih;Aktif\nKalem;10;01.11.2026;evet\nDefter;5;2026-11-02;hayır\n',
        ),
      },
    });
    expect(created).toMatchObject({ rowsAdded: 2, fieldsCreated: 4, skippedColumns: [] });
    const t = await owner.api.call('getTable', { params: { tableId: created.tableId } });
    expect(t.name).toBe('stok');
    expect(t.fields.map((f) => [f.name, f.type])).toEqual([
      ['Ürün', 'text'],
      ['Adet', 'number'],
      ['Tarih', 'date'],
      ['Aktif', 'checkbox'],
    ]);
    const appended = await owner.api.call('importTable', {
      params: { spaceId },
      body: {
        fileName: 'ek.csv',
        mode: 'append',
        tableId: t.id,
        dataURL: csvUrl('adet,ürün,Renk\n3,Silgi,mavi\n'),
      },
    });
    expect(appended).toMatchObject({ rowsAdded: 1, fieldsCreated: 0, skippedColumns: ['Renk'] });

    const csv = await owner.fetch(`http://localhost:3000/api/v1/tables/${t.id}/export?format=csv`);
    expect(csv.status).toBe(200);
    const text = Buffer.from(await csv.arrayBuffer()).toString('utf8');
    expect(text).toContain('Ürün,Adet,Tarih,Aktif');
    expect(text).toContain('Silgi,3');

    const xlsx = await owner.fetch(
      `http://localhost:3000/api/v1/tables/${t.id}/export?format=xlsx`,
    );
    const rows = readXlsx(new Uint8Array(await xlsx.arrayBuffer()));
    expect(rows[0]).toEqual(['Ürün', 'Adet', 'Tarih', 'Aktif']);
    expect(rows[1]).toEqual(['Kalem', '10', '2026-11-01', 'true']);

    // An .xlsx file imports as a table too.
    const file = writeXlsx([
      ['Ad', 'Puan'],
      ['Ayşe', 4],
      ['Ali', 5],
    ]);
    const fromXlsx = await owner.api.call('importTable', {
      params: { spaceId },
      body: {
        fileName: 'puanlar.xlsx',
        mode: 'new',
        dataURL: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${Buffer.from(file).toString('base64')}`,
      },
    });
    expect(fromXlsx.rowsAdded).toBe(2);
    await expect(
      owner.api.call('importTable', {
        params: { spaceId },
        body: { fileName: 'bos.csv', mode: 'new', dataURL: csvUrl('') },
      }),
    ).rejects.toMatchObject({ code: 'table_import_invalid' });
  });

  it('runs automations on row events and writes rows from templates', async () => {
    const crm = await owner.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Otomatik CRM', template: 'crm' },
    });
    const tasks = await owner.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Görevler' },
    });
    const name = field(crm, 'Şirket');
    const email = field(crm, 'E-posta');
    const stage = field(crm, 'Aşama');
    const next = field(crm, 'Notlar');
    const owner_ = field(crm, 'Sorumlu');
    const taskTitle = tasks.fields.find((f) => f.primary)!;
    const runsOf = (ruleId: string) =>
      app.deps.db.select().from(automationRuns).where(eq(automationRuns.ruleId, ruleId));

    // Unknown field keys and tables of other spaces are refused when saving.
    await expect(
      owner.api.call('createAutomationRule', {
        params: { spaceId },
        body: {
          name: 'Bozuk',
          trigger: { type: 'tables.row_created', config: { tableId: crm.id } },
          actions: [
            { id: 'a', type: 'tables.create_row', config: { tableId: tasks.id, values: { nope: 'x' } } },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'automation_target_invalid' });

    const created = await owner.api.call('createAutomationRule', {
      params: { spaceId },
      body: {
        name: 'Yeni müşteri',
        trigger: { type: 'tables.row_created', config: { tableId: crm.id } },
        actions: [
          {
            id: 'fill',
            type: 'tables.update_row',
            config: {
              tableId: crm.id,
              rowId: '{{row.id}}',
              values: {
                [next.id]: '{{values.' + email.id + '}} adresine yaz',
                [owner_.id]: 'mert@milvasoft.com',
                [stage.id]: 'Olmayan aşama',
              },
            },
          },
        ],
      },
    });
    const won = await owner.api.call('createAutomationRule', {
      params: { spaceId },
      body: {
        name: 'Kazanılınca görev',
        trigger: { type: 'tables.row_updated', config: { tableId: crm.id, fieldId: stage.id } },
        conditions: [{ field: 'values.' + stage.id, op: 'equals', value: 'Kazanıldı' }],
        actions: [
          {
            id: 'task',
            type: 'tables.create_row',
            config: { tableId: tasks.id, values: { [taskTitle.id]: 'Sözleşme: {{row.title}}' } },
          },
        ],
      },
    });

    const row = await owner.api.call('createTableRow', {
      params: { tableId: crm.id },
      body: { values: { [name.id]: 'Acme', [email.id]: 'info@acme.test' } },
    });
    const runs = await runsOf(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', triggerType: 'tables.row_created' });
    expect(runs[0]!.steps[0]!.output).toMatchObject({ rowId: row.id, skipped: 'Aşama' });
    const filled = await owner.api.call('getTableRow', { params: { tableId: crm.id, rowId: row.id } });
    expect(filled.values[next.id]).toBe('info@acme.test adresine yaz');
    expect(filled.values[owner_.id]).toEqual([mert.me.user.id]);

    // The fill above changed other fields: the stage rule does not fire until the stage changes.
    expect(await runsOf(won.id)).toHaveLength(0);
    const wonChoice = stage.options.choices!.find((c) => c.label === 'Kazanıldı')!;
    const lostChoice = stage.options.choices!.find((c) => c.label === 'Kaybedildi')!;
    await owner.api.call('updateTableRow', {
      params: { tableId: crm.id, rowId: row.id },
      body: { values: { [stage.id]: lostChoice.id } },
    });
    expect(await runsOf(won.id)).toHaveLength(0);
    await owner.api.call('updateTableRow', {
      params: { tableId: crm.id, rowId: row.id },
      body: { values: { [stage.id]: wonChoice.id } },
    });
    expect(await runsOf(won.id)).toHaveLength(1);
    const taskRows = await owner.api.call('queryTableRows', { params: { tableId: tasks.id }, query: {} });
    expect(taskRows.items.map((r) => r.values[taskTitle.id])).toEqual(['Sözleşme: Acme']);
  });

  it('a partial view update keeps groupBy and the other settings', async () => {
    const t = await owner.api.call('createTable', { params: { spaceId }, body: { name: 'Görünüm ayarı' } });
    const status = t.fields.find((f) => f.type === 'single_select')!;
    const notes = t.fields.find((f) => f.type === 'long_text')!;
    const viewId = t.views[0]!.id;
    const update = (config: Record<string, unknown>) =>
      owner.api.call('updateTableView', { params: { tableId: t.id, viewId }, body: { config } });
    await update({ groupBy: status.id });
    await update({ hidden: [notes.id] });
    const v = await update({ sorts: [{ fieldId: status.id, dir: 'desc' }] });
    expect(v.config).toMatchObject({
      groupBy: status.id,
      hidden: [notes.id],
      sorts: [{ fieldId: status.id, dir: 'desc' }],
    });
    // A name-only change leaves the config alone, and an explicit null still clears a key.
    const renamed = await owner.api.call('updateTableView', {
      params: { tableId: t.id, viewId },
      body: { name: 'Gruplu' },
    });
    expect(renamed.config.groupBy).toBe(status.id);
    expect((await update({ groupBy: null })).config).toMatchObject({ groupBy: null, hidden: [notes.id] });
    // A new kanban view without a config gets its column field.
    const kanban = await owner.api.call('createTableView', {
      params: { tableId: t.id },
      body: { name: 'Pano', type: 'kanban' },
    });
    expect(kanban.config.kanbanFieldId).toBe(status.id);
  });

  it('keeps the last view and answers 403 while the module is off', async () => {
    const t = await owner.api.call('createTable', { params: { spaceId }, body: { name: 'Son' } });
    await expect(
      owner.api.call('deleteTableView', { params: { tableId: t.id, viewId: t.views[0]!.id } }),
    ).rejects.toMatchObject({ code: 'table_last_view' });
    const [org] = await app.deps.db.select().from(organizations);
    const settings = org!.settings;
    await app.deps.db
      .update(organizations)
      .set({ settings: { ...settings, modules: { tables: false } } as typeof settings })
      .where(eq(organizations.id, org!.id));
    forgetTablesSwitch();
    try {
      await expect(owner.api.call('listTables', { params: { spaceId } })).rejects.toMatchObject({
        code: 'module_disabled',
      });
      expect((await owner.fetch(`http://localhost:3000/api/v1/tables/${t.id}/export`)).status).toBe(
        403,
      );
    } finally {
      await app.deps.db
        .update(organizations)
        .set({ settings })
        .where(eq(organizations.id, org!.id));
      forgetTablesSwitch();
    }
  });
});
