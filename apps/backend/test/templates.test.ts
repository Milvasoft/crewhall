import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { organizations } from '@crewhall/db';
import { invalidateModules } from '../src/services/identity/modules';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Template gallery (roadmap 8): built-in page, board and space templates; org, space and personal
 * templates saved from a page, a board or a whole space; applying creates the content.
 */
describe('template gallery', () => {
  let app: TestApp;
  let owner: Client;
  let member: Client;
  let spaceId: string;

  const content = async (nodeId: string) =>
    (
      await owner.api.call('getPageContent', {
        params: { nodeId },
        query: { format: 'markdown' },
      })
    ).markdown;
  const newSpace = async (name: string) =>
    (await owner.api.call('createSpace', { body: { name, color: 's2' } })).id;
  const boardOf = (boardId: string) => owner.api.call('getBoard', { params: { boardId } });

  async function setModule(key: 'boards' | 'wiki', on: boolean) {
    const [org] = await app.deps.db.select().from(organizations);
    const settings = org!.settings;
    await app.deps.db
      .update(organizations)
      .set({ settings: { ...settings, modules: { ...settings.modules, [key]: on } } })
      .where(eq(organizations.id, org!.id));
    invalidateModules();
  }

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    const joined = await join(app, owner, 'mert@milvasoft.com', 'member', [spaceId]);
    member = joined.person;
    // Invited people join as viewers; Mert edits this space.
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: joined.me.user.id },
      body: { role: 'editor' },
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('lists built-in page, board and space templates in the caller language', async () => {
    const list = await owner.api.call('listTemplates', { query: {} });
    const ids = list.items.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'builtin:meeting',
        'builtin:kickoff',
        'builtin:sprint',
        'builtin:board:onboarding',
        'builtin:board:sprint',
        'builtin:space:onboarding',
        'builtin:space:kickoff',
        'builtin:space:sprint',
      ]),
    );
    expect(list.canCreateOrg).toBe(true);
    const space = list.items.find((t) => t.id === 'builtin:space:kickoff')!;
    expect(space).toMatchObject({ kind: 'space', scope: 'builtin', name: 'Proje başlangıcı' });
    expect(space.summary.pages).toEqual(['Proje özeti', 'Toplantı notları', 'Kararlar']);
    const boards = await owner.api.call('listTemplates', { query: { kind: 'board' } });
    expect(boards.items.every((t) => t.kind === 'board')).toBe(true);
    expect((await member.api.call('listTemplates', { query: {} })).canCreateOrg).toBe(false);
  });

  it('applies a page, a board with starter cards and a whole space', async () => {
    const page = await owner.api.call('applyTemplate', {
      params: { templateRef: 'builtin:meeting' },
      body: { spaceId, parentId: null },
    });
    expect(page.nodes).toEqual([expect.objectContaining({ type: 'page', name: 'Toplantı notu' })]);
    const md = await content(page.nodes[0]!.id);
    expect(md).not.toContain('«tarih»');
    expect(md).toContain('Ahmet Buğra Kösen');

    const board = await owner.api.call('applyTemplate', {
      params: { templateRef: 'builtin:board:onboarding' },
      body: { spaceId, parentId: null },
    });
    const detail = await boardOf(board.nodes[0]!.id);
    expect(detail.columns.map((c) => c.name)).toEqual(['Yapılacak', 'Bu hafta', 'Tamamlandı']);
    expect(detail.columns.at(-1)!.isDone).toBe(true);
    expect(detail.cards.map((c) => c.title)).toContain('Ekip sohbetine katıl, kendini tanıt');
    expect(detail.board.settings.labels.map((l) => l.name)).toEqual([
      'Hesaplar',
      'Ekip',
      'Araçlar',
    ]);

    const target = await newSpace('Yeni proje');
    const space = await owner.api.call('applyTemplate', {
      params: { templateRef: 'builtin:space:onboarding' },
      body: { spaceId: target, parentId: null },
    });
    expect(space.skipped).toEqual([]);
    expect(space.nodes.map((n) => [n.type, n.name])).toEqual([
      ['page', 'Hoş geldin'],
      ['board', 'Oryantasyon görevleri'],
    ]);
    const tree = await owner.api.call('listPageTree', { params: { spaceId: target } });
    const welcome = tree.items.find((i) => i.name === 'Hoş geldin')!;
    expect(
      tree.items
        .filter((i) => i.parentId === welcome.id)
        .map((i) => i.name)
        .sort(),
    ).toEqual(['Araçlar ve erişimler', 'Ekip ve iletişim']);
  });

  it('saves a board as a template with its columns and cards, and applies it again', async () => {
    const source = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Teslim akışı', template: 'roadmap' },
    });
    const { columns } = await boardOf(source.id);
    await owner.api.call('createBoardCard', {
      params: { boardId: source.id },
      body: {
        columnId: columns[1]!.id,
        title: 'Hazırlık',
        description: 'Kontrol listesi',
        labels: ['l1'],
        assigneeIds: [],
      },
    });
    const tpl = await owner.api.call('createTemplate', {
      body: { kind: 'board', scope: 'org', nodeId: source.id, name: 'Teslim süreci' },
    });
    expect(tpl).toMatchObject({ kind: 'board', scope: 'org', canDelete: true });
    expect(tpl.summary.cards).toBe(1);

    // Org templates are visible to every member; they apply them like built-ins.
    const seen = await member.api.call('listTemplates', { query: { kind: 'board' } });
    expect(seen.items.find((t) => t.id === tpl.id)).toMatchObject({ canDelete: false });
    const copy = await member.api.call('applyTemplate', {
      params: { templateRef: tpl.id },
      body: { spaceId, parentId: null },
    });
    const detail = await boardOf(copy.nodes[0]!.id);
    expect(detail.columns.map((c) => c.name)).toEqual(columns.map((c) => c.name));
    expect(detail.cards).toEqual([
      expect.objectContaining({ title: 'Hazırlık', labels: ['l1'], assignees: [] }),
    ]);
    expect(detail.cards[0]!.columnId).toBe(detail.columns[1]!.id);
  });

  it('saves a whole space and recreates its page tree and boards elsewhere', async () => {
    const source = await newSpace('Kaynak');
    const parent = await owner.api.call('createPage', {
      params: { spaceId: source },
      body: { name: 'Mimari', markdown: 'Kuyruk Redis ile.' },
    });
    await owner.api.call('createPage', {
      params: { spaceId: source },
      body: { name: 'Kilit', parentId: parent.id, markdown: 'Ayrıntı' },
    });
    await owner.api.call('createBoard', {
      params: { spaceId: source },
      body: { name: 'İşler', template: 'sprint' },
    });
    const tpl = await owner.api.call('createTemplate', {
      body: { kind: 'space', scope: 'personal', spaceId: source, name: 'Ekip alanı' },
    });
    expect(tpl.summary).toMatchObject({ pages: ['Mimari', 'Kilit'], boards: ['İşler'] });

    const target = await newSpace('Hedef');
    const res = await owner.api.call('applyTemplate', {
      params: { templateRef: tpl.id },
      body: { spaceId: target, parentId: null },
    });
    expect(res.nodes.map((n) => n.name)).toEqual(['Mimari', 'İşler']);
    const tree = await owner.api.call('listPageTree', { params: { spaceId: target } });
    const mimari = tree.items.find((i) => i.name === 'Mimari')!;
    expect(tree.items.find((i) => i.name === 'Kilit')!.parentId).toBe(mimari.id);
    expect(await content(mimari.id)).toContain('Kuyruk Redis ile.');

    // A personal template is only its owner's.
    expect(
      (await member.api.call('listTemplates', { query: {} })).items.some((t) => t.id === tpl.id),
    ).toBe(false);
  });

  it('checks who may save and delete org and space templates', async () => {
    const page = await member.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Notlarım', markdown: 'Benim notum' },
    });
    await expect(
      member.api.call('createTemplate', {
        body: { kind: 'page', scope: 'org', nodeId: page.id, name: 'Kurumsal' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      member.api.call('createTemplate', {
        body: { kind: 'page', scope: 'space', nodeId: page.id, spaceId, name: 'Space' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    const mine = await member.api.call('createTemplate', {
      body: { kind: 'page', scope: 'personal', nodeId: page.id, name: 'Kişisel' },
    });
    const org = await owner.api.call('createTemplate', {
      body: { kind: 'page', scope: 'org', nodeId: page.id, name: 'Kurum notu' },
    });
    await expect(
      member.api.call('deleteTemplate', { params: { templateRef: org.id } }),
    ).rejects.toMatchObject({ status: 403 });
    await member.api.call('deleteTemplate', { params: { templateRef: mine.id } });
    await owner.api.call('deleteTemplate', { params: { templateRef: org.id } });
    expect(
      (await owner.api.call('listTemplates', { query: { kind: 'page' } })).items.some(
        (t) => t.id === org.id,
      ),
    ).toBe(false);
    // An org template is used through createPage like any page template.
    const again = await owner.api.call('createTemplate', {
      body: { kind: 'page', scope: 'org', nodeId: page.id, name: 'Kurum notu 2' },
    });
    const made = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Şablondan', templateId: again.id },
    });
    expect(await content(made.id)).toContain('Benim notum');
  });

  it('skips the part of a switched-off module', async () => {
    await setModule('boards', false);
    try {
      const target = await newSpace('Modülsüz');
      const res = await owner.api.call('applyTemplate', {
        params: { templateRef: 'builtin:space:sprint' },
        body: { spaceId: target, parentId: null },
      });
      expect(res.skipped).toEqual(['boards']);
      expect(res.nodes.map((n) => n.type)).toEqual(['page', 'page']);
      await expect(
        owner.api.call('applyTemplate', {
          params: { templateRef: 'builtin:board:sprint' },
          body: { spaceId: target, parentId: null },
        }),
      ).rejects.toMatchObject({ code: 'module_disabled' });
    } finally {
      await setModule('boards', true);
    }
  });
});
