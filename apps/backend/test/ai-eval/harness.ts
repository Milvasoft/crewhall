import { randomUUID } from 'node:crypto';
import type { AiActProposal, AiActResult, ApprovalDetail } from '@crewhall/shared';
import { FakeProvider, systemOf, type FakeRequest } from '../ai-fake-provider';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from '../helpers';
import { SCENARIOS, type MockStep, type Scenario } from './scenarios';

/**
 * Runs the eval scenarios through the public API, as the panel does: plan, press the buttons the
 * result asks for, then look at the real data. With `AI_EVAL_LIVE=1` the same scenarios run against
 * a real model and spend real tokens:
 *
 *   AI_EVAL_LIVE=1 AI_EVAL_PROVIDER=anthropic AI_EVAL_MODEL=claude-opus-5-5 AI_EVAL_API_KEY=… \
 *     pnpm --filter @crewhall/backend eval:ai
 */

export const LIVE = process.env.AI_EVAL_LIVE === '1';

class CheckFailed extends Error {}

type Past = {
  request: string;
  message: string;
  proposals: AiActProposal[];
  skipped: string[];
};

/** Sentences that say work is done. A proposal is not done, and neither is a failed step. */
const CLAIM =
  /(?<!\p{L})(aktardım|aktarıldı|oluşturdum|oluşturuldu|ekledim|eklendi|gönderdim|gönderildi|taşıdım|taşındı|tamamladım|tamamlandı|yaptım|hallettim)(?!\p{L})/iu;

export class EvalContext {
  last: AiActResult | null = null;
  readonly history: Past[] = [];
  readonly appliedResults: ApprovalDetail[] = [];
  private spaceIds = new Map<string, string>();
  private pages = new Map<string, string>();
  private cards = new Map<string, string>();
  private surfaceId = '';
  private directIds = new Set<string>();

  constructor(
    readonly app: TestApp,
    readonly owner: Client,
    readonly me: Client,
    readonly meId: string,
    readonly elifId: string,
    readonly boardId: string,
  ) {}

  async ready() {
    const { items } = await this.owner.api.call('listSpaces');
    for (const s of items) this.spaceIds.set(s.name, s.id);
    const mine = (await this.me.api.call('listSurfaces')).items;
    this.surfaceId = mine.find((s) => s.owner.type === 'user')!.id;
  }

  // ---- seed -----------------------------------------------------------------------------------

  async todo(title: string, items: string[]) {
    const card = await this.me.api.call('createCard', {
      params: { surfaceId: this.surfaceId },
      body: {
        type: 'todo',
        config: {
          title,
          items: items.map((text) => ({ id: randomUUID(), text, done: false, doneAt: null })),
        },
      },
    });
    this.cards.set(title, card.id);
  }

  async page(space: string, name: string, markdown: string, opts: { lock?: boolean } = {}) {
    const page = await this.owner.api.call('createPage', {
      params: { spaceId: this.spaceIds.get(space)! },
      body: { name, ...(markdown ? { markdown } : {}) },
    });
    this.pages.set(`${space}/${name}`, page.id);
    if (opts.lock) {
      await this.owner.api.call('updatePage', {
        params: { nodeId: page.id },
        body: { locked: true },
      });
    }
    return page.id;
  }

  async folder(space: string, name: string) {
    const folder = await this.owner.api.call('createFolder', {
      params: { spaceId: this.spaceIds.get(space)! },
      body: { parentId: null, name },
    });
    this.pages.set(`${space}/${name}`, folder.id);
  }

  async group(name: string, text: string) {
    const conv = await this.owner.api.call('createConversation', {
      body: { type: 'group', name, userIds: [this.meId, this.elifId] },
    });
    await this.owner.api.call('sendMessage', {
      params: { conversationId: conv.id },
      body: { clientMsgId: randomUUID(), text },
    });
  }

  // ---- the panel --------------------------------------------------------------------------------

  /** One message in the panel, with the conversation so far. */
  async send(user: string, locale: 'tr' | 'en' = 'tr') {
    const result = (await this.me.api.call('planAiActions', {
      body: {
        request: user,
        locale,
        timeZone: 'UTC',
        history: this.history.slice(-6),
      },
    })) as AiActResult;
    this.last = result;
    this.history.push({
      request: user,
      message: result.message,
      proposals: result.proposals,
      skipped: result.skipped,
    });
    // The panel presses the buttons a reply such as "evet" asks for.
    for (const id of result.decided?.approve ?? []) await this.approve(id);
    for (const id of result.decided?.reject ?? []) {
      await this.me.api.call('rejectMcpApproval', { params: { approvalId: id }, body: {} });
    }
    return result;
  }

  async approve(approvalId: string) {
    const done = await this.me.api.call('approveMcpApproval', { params: { approvalId } });
    this.appliedResults.push(done);
    return done;
  }

  async approveOpen() {
    for (const p of this.last?.proposals ?? []) await this.approve(p.approvalId);
  }

  // ---- reading the real state -------------------------------------------------------------------

  async todoItems(title: string) {
    const surface = await this.me.api.call('getSurface', { params: { surfaceId: this.surfaceId } });
    const card = surface.cards.find((c) => c.type === 'todo' && c.config.title === title);
    if (!card || card.type !== 'todo') throw new CheckFailed(`no to-do card "${title}"`);
    return card.config.items.map((i) => i.text);
  }

  /** The body of the page with this name that the person (or the owner) can see. */
  async pageMarkdown(name: string, who: 'me' | 'owner' = 'me') {
    const client = who === 'me' ? this.me : this.owner;
    const { items } = await client.api.call('searchNodes', {
      query: { q: name, type: 'page', limit: 10 },
    });
    const hit = items.find((h) => h.node.name === name);
    if (!hit) throw new CheckFailed(`no page "${name}"`);
    this.pages.set(`${hit.node.id}`, hit.node.id);
    const content = await client.api.call('getPageContent', {
      params: { nodeId: hit.node.id },
      query: {},
    });
    return content.markdown;
  }

  async boardCards() {
    const detail = await this.me.api.call('getBoard', { params: { boardId: this.boardId } });
    return detail.cards.map((c) => c.title);
  }

  async events() {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { items } = await this.me.api.call('listCalendarOccurrences', {
      query: { from, to, meetings: 'false', cards: 'false' } as never,
    });
    return items.map((e) => ({ title: e.title, start: e.start }));
  }

  /** Text of every message this person sent to anyone, through the assistant. */
  async sentMessages() {
    const { items } = await this.me.api.call('listConversations', { query: {} });
    const out: string[] = [];
    for (const conv of items) {
      const page = await this.me.api.call('listMessages', {
        params: { conversationId: conv.id },
        query: {},
      });
      for (const m of page.items) if (m.author?.id === this.meId) out.push(m.text);
    }
    return out;
  }

  async pendingCount() {
    const { items } = await this.me.api.call('listMcpApprovals', { query: { status: 'pending' } });
    return items.length;
  }

  // ---- checks -----------------------------------------------------------------------------------

  said() {
    return [this.last?.message ?? '', ...(this.last?.skipped ?? [])].join(' ');
  }

  applied() {
    return JSON.stringify(this.appliedResults.map((r) => r.result ?? null));
  }

  contains(text: string, part: string) {
    if (!text.toLocaleLowerCase('tr').includes(part.toLocaleLowerCase('tr'))) {
      throw new CheckFailed(`expected "${part}" in: ${text.slice(0, 300)}`);
    }
  }

  lacks(text: string, part: string) {
    if (text.toLocaleLowerCase('tr').includes(part.toLocaleLowerCase('tr'))) {
      throw new CheckFailed(`did not expect "${part}" in: ${text.slice(0, 300)}`);
    }
  }

  includes(list: string[], item: string) {
    if (!list.includes(item))
      throw new CheckFailed(`expected "${item}" in ${JSON.stringify(list)}`);
  }

  excludes(list: string[], item: string) {
    if (list.includes(item)) throw new CheckFailed(`did not expect "${item}"`);
  }

  same(a: unknown, b: unknown) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new CheckFailed(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
  }

  proposed(n: number) {
    const got = this.last?.proposals.length ?? 0;
    if (got !== n) {
      throw new CheckFailed(`expected ${n} proposal(s), got ${got}: ${this.said().slice(0, 200)}`);
    }
  }

  /** Nothing has been done yet, so the reply must not say anything was. */
  claimsNothing() {
    if (CLAIM.test(this.last?.message ?? '')) {
      throw new CheckFailed(`claims done work: ${this.last?.message}`);
    }
  }

  async cleanup() {
    const ids = [...new Set(this.pages.values())];
    if (ids.length) {
      await this.owner.api.call('trashNodes', { body: { nodeIds: ids } }).catch(() => undefined);
    }
    const { items } = await this.me.api.call('searchNodes', {
      query: { q: 'Yapılacaklar', type: 'page', limit: 20 },
    });
    const mine = items.map((h) => h.node.id);
    if (mine.length) {
      await this.me.api.call('trashNodes', { body: { nodeIds: mine } }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------------------
// The mock model
// ---------------------------------------------------------------------------------------

function promptOf(r: FakeRequest) {
  return [systemOf(r), ...(r.body.messages ?? []).map((m) => m.content)].join('\n');
}

/** Answers one model call of a turn from the script. */
function answer(step: MockStep | undefined, r: FakeRequest): string {
  const fallback = { message: 'Tam olarak ne yapmamı istiyorsun?', actions: [] };
  if (!step) return JSON.stringify(fallback);
  const prompt = promptOf(r);
  const kinds = step.needs?.kinds ?? [];
  const offered = kinds.every((k) => prompt.includes(`"type":"${k}"`));
  const remembers = !step.needs?.history || prompt.includes('<history>');
  if (!offered || !remembers) return JSON.stringify(step.weak ?? fallback);
  return JSON.stringify(typeof step.good === 'function' ? step.good(prompt) : step.good);
}

export interface EvalWorld {
  app: TestApp;
  fake: FakeProvider | null;
  owner: Client;
  elifId: string;
  boardId: string;
  spaceIds: string[];
  close(): Promise<void>;
}

export async function startWorld(): Promise<EvalWorld> {
  const fake = LIVE ? null : await new FakeProvider().start();
  const app = await createTestApp();
  const { owner } = await setupWithOwner(app);
  const spaces = (await owner.api.call('listSpaces')).items.filter((s) => s.kind === 'shared');
  const elif = await join(
    app,
    owner,
    'elif@milvasoft.com',
    'member',
    spaces.map((s) => s.id),
  );
  const milvasoft = spaces.find((s) => s.name === 'Milvasoft')!;
  const board = await owner.api.call('createBoard', {
    params: { spaceId: milvasoft.id },
    body: { name: 'Sürüm işleri', template: 'sprint' },
  });
  await owner.api.call('updateMcpPolicy', {
    body: { requestsPerMinute: 600, writesPerMinute: 200 },
  });
  await owner.api.call('updateAiSettings', {
    body: LIVE
      ? {
          enabled: true,
          provider: (process.env.AI_EVAL_PROVIDER ?? 'anthropic') as never,
          ...(process.env.AI_EVAL_MODEL ? { model: process.env.AI_EVAL_MODEL } : {}),
          ...(process.env.AI_EVAL_BASE_URL ? { baseUrl: process.env.AI_EVAL_BASE_URL } : {}),
          apiKey: process.env.AI_EVAL_API_KEY ?? null,
        }
      : { enabled: true, provider: 'openai_compatible', baseUrl: `${fake!.url}/v1`, model: 'llm' },
  });
  return {
    app,
    fake,
    owner,
    elifId: elif.me.user.id,
    boardId: board.id,
    spaceIds: spaces.map((s) => s.id),
    async close() {
      await app.close();
      await fake?.close();
    },
  };
}

let people = 0;

/** One scenario for a new person: their own home page, editor in the shared spaces. */
export async function runScenario(world: EvalWorld, scenario: Scenario) {
  people += 1;
  const person = await join(world.app, world.owner, `kisi${people}@milvasoft.com`, 'member');
  for (const spaceId of world.spaceIds) {
    // The default space already has everyone in it, with a lower role.
    const userId = person.me.user.id;
    await world.owner.api
      .call('addSpaceMember', { params: { spaceId }, body: { userId, role: 'editor' } })
      .catch(() =>
        world.owner.api.call('updateSpaceMember', {
          params: { spaceId, userId },
          body: { role: 'editor' },
        }),
      );
  }
  const c = new EvalContext(
    world.app,
    world.owner,
    person.person,
    person.me.user.id,
    world.elifId,
    world.boardId,
  );
  await c.ready();
  try {
    await scenario.seed?.(c);
    for (const turn of scenario.turns) {
      if (world.fake) {
        const steps = [...(turn.model ?? [])];
        world.fake.responder = (r) => answer(steps.shift(), r);
      }
      await c.send(turn.user);
      if (turn.approve) await c.approveOpen();
      await turn.check?.(c);
    }
  } finally {
    await c.cleanup();
    if (world.fake) world.fake.responder = null;
  }
}

export { SCENARIOS };
