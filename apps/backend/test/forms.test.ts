import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { boardCards, formFiles, notifications, organizations } from '@crewhall/db';
import type { FormField } from '@crewhall/shared';
import { forgetFormsSwitch } from '../src/services/forms/access';
import { sweepForms } from '../src/services/forms/deliver';
import { resetLimits } from '../src/services/forms/limit';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

const FIELDS: FormField[] = [
  {
    id: 'name',
    type: 'short_text',
    label: 'Adın',
    help: null,
    required: true,
    choices: [],
    min: null,
    max: null,
    maxFiles: 1,
    showIf: null,
  },
  {
    id: 'team',
    type: 'single_choice',
    label: 'Ekip',
    help: null,
    required: true,
    choices: [
      { id: 'web', label: 'Web' },
      { id: 'api', label: 'API' },
    ],
    min: null,
    max: null,
    maxFiles: 1,
    showIf: null,
  },
  {
    id: 'api_detail',
    type: 'long_text',
    label: 'API ayrıntısı',
    help: null,
    required: true,
    choices: [],
    min: null,
    max: null,
    maxFiles: 1,
    showIf: { fieldId: 'team', op: 'equals', value: 'api' },
  },
  {
    id: 'score',
    type: 'rating',
    label: 'Puan',
    help: null,
    required: false,
    choices: [],
    min: null,
    max: 5,
    maxFiles: 1,
    showIf: null,
  },
  {
    id: 'count',
    type: 'number',
    label: 'Kaç kişi',
    help: null,
    required: false,
    choices: [],
    min: 1,
    max: 50,
    maxFiles: 1,
    showIf: null,
  },
  {
    id: 'day',
    type: 'date',
    label: 'Tarih',
    help: null,
    required: false,
    choices: [],
    min: null,
    max: null,
    maxFiles: 1,
    showIf: null,
  },
  {
    id: 'cv',
    type: 'file',
    label: 'Dosya',
    help: null,
    required: false,
    choices: [],
    min: null,
    max: null,
    maxFiles: 2,
    showIf: null,
  },
];

const dataUrl = (text: string, mime = 'text/plain') =>
  `data:${mime};base64,${Buffer.from(text).toString('base64')}`;

describe('forms', () => {
  let app: TestApp;
  let owner: Client;
  let ownerId: string;
  let spaceId: string;
  let altyapiId: string;
  let mert: Awaited<ReturnType<typeof join>>;
  let selin: Awaited<ReturnType<typeof join>>;
  let can: Awaited<ReturnType<typeof join>>;

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    const spaces = (await owner.api.call('listSpaces')).items;
    spaceId = spaces.find((s) => s.isDefault)!.id;
    altyapiId = spaces.find((s) => s.name === 'Altyapı')!.id;
    mert = await join(app, owner, 'mert@milvasoft.com', 'member');
    selin = await join(app, owner, 'selin@milvasoft.com', 'member');
    can = await join(app, owner, 'can@milvasoft.com', 'member');
    // Mert edits the default space, Selin only views it, Can is not in it.
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: mert.me.user.id },
      body: { role: 'editor' },
    });
    await owner.api.call('removeSpaceMember', { params: { spaceId, userId: can.me.user.id } });
  });
  afterAll(async () => {
    await app.close();
  });

  const create = (c: Client, fields: FormField[] = FIELDS) =>
    c.api.call('createForm', { params: { spaceId }, body: { title: 'Etkinlik kaydı', fields } });

  it('lets space editors build forms and hides them from others', async () => {
    const form = await create(mert.person);
    expect(form).toMatchObject({ status: 'draft', responseCount: 0, publicUrl: null });
    expect(form.settings).toMatchObject({ access: 'org', anonymous: false, oneResponse: false });
    expect(form.owner?.id).toBe(mert.me.user.id);

    await expect(create(selin.person)).rejects.toMatchObject({ status: 403 });
    await expect(
      can.person.api.call('getForm', { params: { formId: form.id } }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      selin.person.api.call('getForm', { params: { formId: form.id } }),
    ).rejects.toMatchObject({ status: 403 });
    // Viewers list only open forms.
    expect((await selin.person.api.call('listForms', { params: { spaceId } })).items).toEqual([]);
    expect(
      (await mert.person.api.call('listForms', { params: { spaceId } })).items.map((f) => f.id),
    ).toContain(form.id);
  });

  it('rejects broken definitions and opening an empty form', async () => {
    await expect(create(mert.person, [FIELDS[0]!, FIELDS[0]!])).rejects.toMatchObject({
      code: 'form_definition_invalid',
    });
    // A condition must point to an earlier field.
    await expect(create(mert.person, [{ ...FIELDS[2]! }, FIELDS[1]!])).rejects.toMatchObject({
      code: 'form_definition_invalid',
    });
    const empty = await create(mert.person, []);
    await expect(
      mert.person.api.call('updateForm', {
        params: { formId: empty.id },
        body: { status: 'open' },
      }),
    ).rejects.toMatchObject({ code: 'form_definition_invalid' });
  });

  it('takes answers from any org member, with required and conditional fields', async () => {
    const form = await create(mert.person);
    // Drafts are not answerable by others.
    await expect(
      can.person.api.call('getFormToFill', {
        params: { formId: form.id },
      }),
    ).rejects.toMatchObject({ status: 404 });
    await mert.person.api.call('updateForm', {
      params: { formId: form.id },
      body: { status: 'open' },
    });

    const fill = await can.person.api.call('getFormToFill', { params: { formId: form.id } });
    expect(fill).toMatchObject({ accepting: true, alreadyResponded: false, orgName: 'Milvasoft' });

    await expect(
      can.person.api.call('submitForm', {
        params: { formId: form.id },
        body: { answers: { team: 'api' } },
      }),
    ).rejects.toMatchObject({
      code: 'form_answers_invalid',
      details: { fields: { name: 'required', api_detail: 'required' } },
    });
    await expect(
      can.person.api.call('submitForm', {
        params: { formId: form.id },
        body: { answers: { name: 'Can', team: 'mobile' } },
      }),
    ).rejects.toMatchObject({ details: { fields: { team: 'unknown_choice' } } });
    await expect(
      can.person.api.call('submitForm', {
        params: { formId: form.id },
        body: { answers: { name: 'Can', team: 'web', count: 99 } },
      }),
    ).rejects.toMatchObject({ details: { fields: { count: 'too_large' } } });

    // The hidden field's answer is dropped, not stored.
    await can.person.api.call('submitForm', {
      params: { formId: form.id },
      body: {
        answers: { name: '  Can  ', team: 'web', api_detail: 'gizli', score: 4, day: '2026-11-02' },
      },
    });
    await selin.person.api.call('submitForm', {
      params: { formId: form.id },
      body: { answers: { name: 'Selin', team: 'api', api_detail: 'Uçlar', score: 2, count: 3 } },
    });

    const list = await mert.person.api.call('listFormResponses', {
      params: { formId: form.id },
      query: { limit: 1 },
    });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.respondent?.name).toBe('selin');
    const next = await mert.person.api.call('listFormResponses', {
      params: { formId: form.id },
      query: { limit: 1, cursor: list.nextCursor! },
    });
    expect(next.items[0]!.answers).toEqual({
      name: 'Can',
      team: 'web',
      score: 4,
      day: '2026-11-02',
    });
    expect(next.nextCursor).toBeNull();

    const stats = await mert.person.api.call('getFormStats', { params: { formId: form.id } });
    expect(stats.total).toBe(2);
    const team = stats.fields.find((f) => f.fieldId === 'team')!;
    expect(team.counts).toEqual({ web: 1, api: 1 });
    const score = stats.fields.find((f) => f.fieldId === 'score')!;
    expect(score).toMatchObject({ answered: 2, average: 3, min: 2, max: 4 });
    expect(score.counts).toMatchObject({ '1': 0, '2': 1, '4': 1, '5': 0 });
    expect(stats.daily.reduce((s, d) => s + d.count, 0)).toBe(2);

    await expect(
      selin.person.api.call('getFormStats', { params: { formId: form.id } }),
    ).rejects.toMatchObject({ status: 403 });

    const csv = await mert.person.fetch(
      `http://localhost:3000/api/v1/forms/${form.id}/responses.csv`,
      {
        headers: { 'Accept-Language': 'tr' },
      },
    );
    expect(csv.status).toBe(200);
    const bytes = Buffer.from(await csv.arrayBuffer());
    // UTF-8 BOM so Excel reads Turkish letters.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    expect(text).toContain('Gönderim zamanı,Yanıtlayan,Adın,Ekip,API ayrıntısı,Puan');
    expect(text).toContain(',selin,Selin,API,Uçlar,2,3,,');
    const denied = await selin.person.fetch(
      `http://localhost:3000/api/v1/forms/${form.id}/responses.csv`,
    );
    expect(denied.status).toBe(403);
  });

  it('allows one answer per person and keeps anonymous answers anonymous', async () => {
    const form = await create(mert.person, FIELDS.slice(0, 2));
    const settings = { ...form.settings, oneResponse: true, anonymous: true };
    await mert.person.api.call('updateForm', {
      params: { formId: form.id },
      body: { settings, status: 'open' },
    });
    const body = { answers: { name: 'Can', team: 'web' } };
    await can.person.api.call('submitForm', { params: { formId: form.id }, body });
    await expect(
      can.person.api.call('submitForm', { params: { formId: form.id }, body }),
    ).rejects.toMatchObject({ code: 'form_already_answered' });
    expect(
      (await can.person.api.call('getFormToFill', { params: { formId: form.id } }))
        .alreadyResponded,
    ).toBe(true);
    const list = await mert.person.api.call('listFormResponses', { params: { formId: form.id } });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.respondent).toBeNull();
  });

  it('closes at closesAt and on status closed', async () => {
    const form = await create(mert.person, FIELDS.slice(0, 1));
    await mert.person.api.call('updateForm', {
      params: { formId: form.id },
      body: {
        status: 'open',
        settings: { ...form.settings, closesAt: '2020-01-01T00:00:00.000Z' },
      },
    });
    expect(
      (await can.person.api.call('getFormToFill', { params: { formId: form.id } })).accepting,
    ).toBe(false);
    await expect(
      can.person.api.call('submitForm', {
        params: { formId: form.id },
        body: { answers: { name: 'x' } },
      }),
    ).rejects.toMatchObject({ code: 'form_closed' });
  });

  it('stores uploads per respondent and serves them to result readers only', async () => {
    const form = await create(mert.person);
    await mert.person.api.call('updateForm', {
      params: { formId: form.id },
      body: { status: 'open' },
    });
    const up = await can.person.api.call('uploadFormFile', {
      params: { formId: form.id },
      body: { fieldId: 'cv', name: 'özgeçmiş.txt', dataURL: dataUrl('merhaba') },
    });
    expect(up).toMatchObject({ name: 'özgeçmiş.txt', sizeBytes: 7 });
    // Someone else cannot attach Can's upload.
    await expect(
      selin.person.api.call('submitForm', {
        params: { formId: form.id },
        body: { answers: { name: 'S', team: 'web', cv: [up] } },
      }),
    ).rejects.toMatchObject({ code: 'form_file_invalid' });
    await expect(
      can.person.api.call('uploadFormFile', {
        params: { formId: form.id },
        body: { fieldId: 'name', name: 'a.txt', dataURL: dataUrl('x') },
      }),
    ).rejects.toMatchObject({ code: 'form_file_invalid' });

    const sent = await can.person.api.call('submitForm', {
      params: { formId: form.id },
      body: { answers: { name: 'Can', team: 'web', cv: [{ ...up, name: 'değiştirilmiş.exe' }] } },
    });
    const list = await mert.person.api.call('listFormResponses', { params: { formId: form.id } });
    expect(list.items.find((r) => r.id === sent.id)!.answers.cv).toEqual([up]);
    const url = await mert.person.api.call('getFormFileUrl', { params: { fileId: up.fileId } });
    const res = await fetch(url.url);
    expect(await res.text()).toBe('merhaba');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    await expect(
      can.person.api.call('getFormFileUrl', { params: { fileId: up.fileId } }),
    ).rejects.toMatchObject({ status: 404 });

    // Unattached uploads are swept after a day.
    const stray = await can.person.api.call('uploadFormFile', {
      params: { formId: form.id },
      body: { fieldId: 'cv', name: 'unutulan.txt', dataURL: dataUrl('x') },
    });
    await app.deps.db
      .update(formFiles)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(formFiles.id, stray.fileId));
    expect((await sweepForms(app.deps)).removed).toBe(1);
  });

  it('answers through a public link with a rate limit and a honeypot', async () => {
    resetLimits();
    const form = await create(mert.person, FIELDS.slice(0, 2));
    // Editors cannot make public links unless the space allows it; the owner (space owner) can.
    await expect(
      mert.person.api.call('updateForm', {
        params: { formId: form.id },
        body: { settings: { ...form.settings, access: 'public' }, status: 'open' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    const opened = await owner.api.call('updateForm', {
      params: { formId: form.id },
      body: { settings: { ...form.settings, access: 'public', oneResponse: true }, status: 'open' },
    });
    expect(opened.publicUrl).toMatch(/^http:\/\/localhost:5173\/f\/[\w-]+$/);
    const token = opened.publicUrl!.split('/').pop()!;

    const guest = new Client(app);
    guest.ip = '203.0.113.7';
    const pub = await guest.api.call('getPublicForm', { params: { token } });
    expect(pub).toMatchObject({ title: 'Etkinlik kaydı', accepting: true, orgName: 'Milvasoft' });

    const body = (n: number) => ({
      answers: { name: `Ziyaretçi ${n}`, team: 'web' },
      clientToken: `browser-token-${n}`,
    });
    await guest.api.call('submitPublicForm', { params: { token }, body: body(0) });
    await expect(
      guest.api.call('submitPublicForm', { params: { token }, body: body(0) }),
    ).rejects.toMatchObject({ code: 'form_already_answered' });
    await expect(
      guest.api.call('submitPublicForm', {
        params: { token },
        body: { answers: { name: 'x', team: 'web' } },
      }),
    ).rejects.toMatchObject({ code: 'form_answers_invalid' });
    // Honeypot: looks fine, nothing stored.
    await guest.api.call('submitPublicForm', {
      params: { token },
      body: { ...body(99), website: 'http://spam.example' },
    });
    for (let i = 1; i < 10; i++) {
      await guest.api
        .call('submitPublicForm', { params: { token }, body: body(i) })
        .catch(() => undefined);
    }
    await expect(
      guest.api.call('submitPublicForm', { params: { token }, body: body(50) }),
    ).rejects.toMatchObject({ status: 429 });
    const other = new Client(app);
    other.ip = '198.51.100.4';
    await other.api.call('submitPublicForm', { params: { token }, body: body(51) });

    const list = await mert.person.api.call('listFormResponses', { params: { formId: form.id } });
    expect(list.items.every((r) => r.respondent === null)).toBe(true);
    expect(list.items.some((r) => r.answers.name === 'Ziyaretçi 99')).toBe(false);

    const regenerated = await owner.api.call('regenerateFormLink', { params: { formId: form.id } });
    expect(regenerated.publicUrl).not.toBe(opened.publicUrl);
    await expect(guest.api.call('getPublicForm', { params: { token } })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('opens a board card, notifies the owner and keeps a CSV in Drive', async () => {
    const board = await mert.person.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Başvurular', template: 'empty', key: 'BSV' },
    });
    const detail = await mert.person.api.call('getBoard', { params: { boardId: board.id } });
    const column = detail.columns[0]!;
    const form = await create(mert.person, FIELDS.slice(0, 2));
    // Selin cannot point a form at a board she cannot write to (and cannot edit forms anyway).
    const settings = {
      ...form.settings,
      notifyOnResponse: true,
      destinations: {
        board: { boardId: board.id, columnId: column.id, titleFieldId: 'name' },
        drive: { parentId: null },
      },
    };
    await expect(
      mert.person.api.call('updateForm', {
        params: { formId: form.id },
        body: {
          settings: {
            ...settings,
            destinations: {
              ...settings.destinations,
              board: { ...settings.destinations.board, columnId: spaceId },
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'form_destination_invalid' });
    await mert.person.api.call('updateForm', {
      params: { formId: form.id },
      body: { settings, status: 'open' },
    });
    await can.person.api.call('submitForm', {
      params: { formId: form.id },
      body: { answers: { name: 'Can Demir', team: 'api' } },
    });

    const cards = await app.deps.db
      .select()
      .from(boardCards)
      .where(eq(boardCards.boardNodeId, board.id));
    expect(cards.map((c) => c.title)).toEqual(['Can Demir']);
    expect(cards[0]!.descText).toContain('Ekip: API');
    expect(cards[0]!.columnId).toBe(column.id);

    const bell = await app.deps.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, mert.me.user.id), eq(notifications.type, 'forms.response')),
      );
    expect(bell).toHaveLength(1);
    expect(bell[0]!.url).toBe(`/forms/f/${form.id}/results`);

    const after = await mert.person.api.call('getForm', { params: { formId: form.id } });
    expect(after.driveNodeId).not.toBeNull();
    const node = await mert.person.api.call('getNode', { params: { nodeId: after.driveNodeId! } });
    expect(node.name).toBe('Etkinlik kaydı · Yanıtlar.csv');
    await selin.person.api.call('submitForm', {
      params: { formId: form.id },
      body: { answers: { name: 'Selin', team: 'web' } },
    });
    const versions = await mert.person.api.call('listVersions', {
      params: { nodeId: after.driveNodeId! },
    });
    expect(versions.items.length).toBe(2);
    const manual = await mert.person.api.call('exportFormToDrive', { params: { formId: form.id } });
    expect(manual.nodeId).toBe(after.driveNodeId);
    void ownerId;
    void altyapiId;
  });

  it('answers 403 module_disabled while the module is off', async () => {
    const form = await create(mert.person, FIELDS.slice(0, 1));
    const [org] = await app.deps.db.select().from(organizations);
    const settings = org!.settings;
    await app.deps.db
      .update(organizations)
      .set({ settings: { ...settings, modules: { forms: false } } as typeof settings })
      .where(eq(organizations.id, org!.id));
    forgetFormsSwitch();
    try {
      await expect(
        mert.person.api.call('listForms', { params: { spaceId } }),
      ).rejects.toMatchObject({ code: 'module_disabled' });
      const csv = await mert.person.fetch(
        `http://localhost:3000/api/v1/forms/${form.id}/responses.csv`,
      );
      expect(csv.status).toBe(403);
      const me = await mert.person.api.call('me');
      expect(me.modules).not.toContain('forms');
    } finally {
      await app.deps.db
        .update(organizations)
        .set({ settings })
        .where(eq(organizations.id, org!.id));
      forgetFormsSwitch();
    }
  });
});
