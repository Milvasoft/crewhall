import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FormField, Table } from '@crewhall/shared';
import { searchTableRows } from '../src/services/tables/ask';
import { actorFor } from '../src/services/boards/collab';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { callTool } from './mcp-helpers';

const field = (t: Table, name: string) => t.fields.find((f) => f.name === name)!;

const q = (id: string, type: FormField['type'], label: string, extra: Partial<FormField> = {}): FormField => ({
  id,
  type,
  label,
  help: null,
  required: false,
  choices: [],
  min: null,
  max: null,
  maxFiles: 1,
  showIf: null,
  ...extra,
});

/** Tables with the rest of Crewhall: forms write rows, the assistant and MCP read and write. */
describe('tables integrations', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let spaceId: string;
  let mert: Awaited<ReturnType<typeof join>>;
  let can: Awaited<ReturnType<typeof join>>;

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    orgId = setup.orgId;
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    mert = await join(app, owner, 'mert@milvasoft.com', 'member');
    can = await join(app, owner, 'can@milvasoft.com', 'member');
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: mert.me.user.id },
      body: { role: 'editor' },
    });
    await owner.api.call('removeSpaceMember', { params: { spaceId, userId: can.me.user.id } });
    await owner.api.call('updateMcpPolicy', { body: { requestsPerMinute: 600, writesPerMinute: 200 } });
  });
  afterAll(async () => {
    await app.close();
  });

  it('makes a table from a form and adds a row per answer', async () => {
    const form = await mert.person.api.call('createForm', {
      params: { spaceId },
      body: {
        title: 'Başvuru',
        fields: [
          q('name', 'short_text', 'Ad soyad', { required: true }),
          q('team', 'single_choice', 'Ekip', {
            choices: [
              { id: 'web', label: 'Web' },
              { id: 'api', label: 'API' },
            ],
          }),
          q('score', 'rating', 'Puan', { max: 5 }),
        ],
      },
    });
    const table = await mert.person.api.call('createFormTable', { params: { formId: form.id } });
    expect(table.name).toBe('Başvuru · Yanıtlar');
    expect(table.fields.map((f) => [f.name, f.type])).toEqual([
      ['Yanıtlayan', 'text'],
      ['Ad soyad', 'text'],
      ['Ekip', 'single_select'],
      ['Puan', 'rating'],
      ['Gönderilme', 'created_at'],
    ]);
    // Can is not in the space: he can answer an org form but not make its table.
    await expect(
      can.person.api.call('createFormTable', { params: { formId: form.id } }),
    ).rejects.toMatchObject({ status: 404 });

    await mert.person.api.call('updateForm', {
      params: { formId: form.id },
      body: {
        status: 'open',
        settings: { ...form.settings, destinations: { drive: null, board: null, table: { tableId: table.id } } },
      },
    });
    await owner.api.call('submitForm', {
      params: { formId: form.id },
      body: { answers: { name: 'Ayşe Yılmaz', team: 'api', score: 4 } },
    });
    const rows = await mert.person.api.call('queryTableRows', { params: { tableId: table.id }, query: {} });
    expect(rows.total).toBe(1);
    const v = rows.items[0]!.values;
    expect(v[field(table, 'Ad soyad').id]).toBe('Ayşe Yılmaz');
    expect(v[field(table, 'Puan').id]).toBe(4);
    const team = field(table, 'Ekip');
    expect(v[team.id]).toBe(team.options.choices!.find((c) => c.label === 'API')!.id);
    expect(v[field(table, 'Yanıtlayan').id]).toBe((await owner.api.call('me')).user.name);

    const back = await mert.person.api.call('getForm', { params: { formId: form.id } });
    expect(back.settings.destinations.table).toEqual({ tableId: table.id });
  });

  it('lets the assistant find rows only in tables the person can see', async () => {
    const t = await mert.person.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Envanter', template: 'inventory' },
    });
    const primary = t.fields.find((f) => f.primary)!;
    await mert.person.api.call('createTableRow', {
      params: { tableId: t.id },
      body: { values: { [primary.id]: 'Dizüstü bilgisayar X1' } },
    });
    const mertActor = (await actorFor(app.deps.db, mert.me.user.id, orgId))!;
    const byWords = await searchTableRows(app.deps.db, mertActor, 'dizüstü');
    expect(byWords.map((r) => r.title)).toContain('Dizüstü bilgisayar X1');
    expect(byWords[0]!.url).toMatch(new RegExp(`^/tables/t/${t.id}\\?row=`));
    const byName = await searchTableRows(app.deps.db, mertActor, 'envanterde neler var');
    expect(byName.some((r) => r.tableName === 'Envanter')).toBe(true);
    const canActor = (await actorFor(app.deps.db, can.me.user.id, orgId))!;
    expect(await searchTableRows(app.deps.db, canActor, 'dizüstü')).toEqual([]);
  });

  it('reads and writes rows over MCP with the tables:write scope', async () => {
    const crm = await mert.person.api.call('createTable', {
      params: { spaceId },
      body: { name: 'MCP müşterileri', template: 'crm' },
    });
    const token = async (scopes: ('hub:read' | 'tables:write')[]) =>
      (
        await mert.person.api.call('createMcpToken', {
          body: { name: scopes.join(' '), scopes, spaceIds: null, expiresInDays: 30 },
        })
      ).value;
    const reader = await token(['hub:read']);
    const writer = await token(['hub:read', 'tables:write']);

    const listed = await callTool(app, reader, 'list_tables', { space_id: spaceId });
    const tables = listed.data.tables as { table_id: string; fields: { name: string }[] }[];
    expect(tables.find((x) => x.table_id === crm.id)!.fields.map((f) => f.name)).toContain('Aşama');

    const denied = await callTool(app, reader, 'add_table_rows', { table_id: crm.id, rows: [{ Şirket: 'X' }] });
    expect(denied.body.error).toBe('insufficient_scope');

    const added = await callTool(app, writer, 'add_table_rows', {
      table_id: crm.id,
      rows: [
        { Şirket: 'Acme', Aşama: 'Teklif', Tutar: '12.500', Sorumlu: 'mert@milvasoft.com' },
        { Şirket: 'Beta', Aşama: 'Bilinmeyen' },
      ],
    });
    const rows = added.data.rows as { row_id: string; skipped: string[] }[];
    expect(rows).toHaveLength(2);
    expect(rows[1]!.skipped).toEqual(['Aşama']);

    const updated = await callTool(app, writer, 'update_table_row', {
      table_id: crm.id,
      row_id: rows[1]!.row_id,
      values: { Aşama: 'Kazanıldı' },
    });
    expect(updated.data.changed).toBe(1);

    const found = await callTool(app, reader, 'query_table_rows', { table_id: crm.id, query: 'acme' });
    const items = found.data.rows as { values: Record<string, string> }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.values).toMatchObject({ Şirket: 'Acme', Aşama: 'Teklif', Sorumlu: 'mert' });
  });
});
