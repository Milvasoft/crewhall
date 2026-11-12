import {
  type AutomationCatalog,
  type AutomationField,
  type AutomationRule,
  type AutomationRun,
  type EndpointName,
} from '@crewhall/shared';
import { MockApiError, myRole, paginate, requireUser, summary, type Resolvers } from './core';
import { newId } from './db';
import { SPACE, USER, type MockState } from './seed';

/**
 * Automations part of the contract mock (roadmap 17): the server's built-in catalog, rules
 * and a simulated run history ("Şimdi dene" succeeds; real events only happen on the server).
 */

const f = (
  key: string,
  kind: AutomationField['kind'],
  required: boolean,
  dependsOn: string | null = null,
): AutomationField => ({ key, kind, required, options: [], dependsOn });

export const MOCK_CATALOG: AutomationCatalog = {
  triggers: [
    {
      type: 'boards.card_moved',
      module: 'boards',
      available: true,
      unavailableReason: null,
      fields: [
        f('boardId', 'board', true),
        f('fromColumnId', 'column', false, 'boardId'),
        f('toColumnId', 'column', false, 'boardId'),
      ],
      variables: [
        'card.ref',
        'card.title',
        'card.url',
        'board.name',
        'from.name',
        'to.name',
        'to.done',
        'actor.name',
      ],
    },
    {
      type: 'forms.response_submitted',
      module: 'forms',
      available: true,
      unavailableReason: null,
      fields: [f('formId', 'form', true)],
      variables: ['form.title', 'form.url', 'response.url', 'respondent.name', 'answers'],
    },
    {
      type: 'drive.file_uploaded',
      module: null,
      available: true,
      unavailableReason: null,
      fields: [f('folderId', 'folder', false), f('extensions', 'text', false)],
      variables: [
        'file.name',
        'file.mime',
        'file.size',
        'file.version',
        'file.url',
        'folder.name',
        'actor.name',
      ],
    },
    {
      type: 'webhook.received',
      module: null,
      available: true,
      unavailableReason: null,
      fields: [],
      variables: ['body', 'contentType'],
    },
    {
      type: 'calendar.event_upcoming',
      module: 'calendar',
      available: true,
      unavailableReason: null,
      fields: [f('minutesBefore', 'number', true)],
      variables: [
        'event.title',
        'event.startsAt',
        'event.endsAt',
        'event.allDay',
        'event.location',
        'event.url',
        'calendar.name',
        'minutesBefore',
      ],
    },
    {
      type: 'tables.row_created',
      module: 'tables',
      available: true,
      unavailableReason: null,
      fields: [f('tableId', 'table', true)],
      variables: ['table.name', 'row.id', 'row.title', 'row.url', 'values', 'actor.name'],
    },
    {
      type: 'tables.row_updated',
      module: 'tables',
      available: true,
      unavailableReason: null,
      fields: [f('tableId', 'table', true), f('fieldId', 'table_field', false, 'tableId')],
      variables: [...['table.name', 'row.id', 'row.title', 'row.url', 'values', 'actor.name'], 'before', 'changed'],
    },
  ],
  actions: [
    {
      type: 'chat.post',
      module: 'chat',
      available: true,
      unavailableReason: null,
      fields: [f('conversationId', 'conversation', true), f('text', 'template', true)],
      variables: [],
    },
    {
      type: 'boards.create_card',
      module: 'boards',
      available: true,
      unavailableReason: null,
      fields: [
        f('boardId', 'board', true),
        f('columnId', 'column', true, 'boardId'),
        f('title', 'template', true),
        f('description', 'template', false),
      ],
      variables: [],
    },
    {
      type: 'notify.users',
      module: null,
      available: true,
      unavailableReason: null,
      fields: [f('userIds', 'users', true), f('text', 'template', true)],
      variables: [],
    },
    {
      type: 'webhook.send',
      module: null,
      available: true,
      unavailableReason: null,
      fields: [f('url', 'url', true)],
      variables: [],
    },
    {
      type: 'tables.create_row',
      module: 'tables',
      available: true,
      unavailableReason: null,
      fields: [f('tableId', 'table', true), f('values', 'table_values', false, 'tableId')],
      variables: [],
    },
    {
      type: 'tables.update_row',
      module: 'tables',
      available: true,
      unavailableReason: null,
      fields: [
        f('tableId', 'table', true),
        f('rowId', 'template', true),
        f('values', 'table_values', false, 'tableId'),
      ],
      variables: [],
    },
  ],
};

interface AutomationsMockState {
  rules: (Omit<AutomationRule, 'owner'> & { ownerId: string })[];
  runs: AutomationRun[];
}

const RULE_ID = '0190f0a0-0000-7000-8000-00000000a001';
const now = () => new Date().toISOString();

function seed(): AutomationsMockState {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    rules: [
      {
        id: RULE_ID,
        spaceId: SPACE.milvasoft,
        name: 'Yeni yanıtta bana haber ver',
        enabled: true,
        trigger: { type: 'drive.file_uploaded', config: { folderId: null, extensions: 'pdf' } },
        conditions: [],
        actions: [
          {
            id: 'a1',
            type: 'notify.users',
            config: { userIds: [USER.bugra], text: '{{file.name}} yüklendi' },
          },
        ],
        ownerId: USER.bugra,
        hookUrl: null,
        signingSecret: 'mock-signing-secret',
        disabledReason: null,
        failureStreak: 0,
        runCount: 1,
        lastRunAt: at,
        lastStatus: 'succeeded',
        createdAt: at,
        updatedAt: at,
      },
    ],
    runs: [
      {
        id: newId(),
        ruleId: RULE_ID,
        status: 'succeeded',
        triggerType: 'drive.file_uploaded',
        event: { file: { name: 'teklif.pdf' } },
        steps: [
          {
            actionId: 'a1',
            type: 'notify.users',
            status: 'succeeded',
            error: null,
            output: { notified: 1 },
            ms: 12,
          },
        ],
        error: null,
        test: false,
        depth: 0,
        startedAt: at,
        finishedAt: at,
        createdAt: at,
      },
    ],
  };
}

function store(s: MockState): AutomationsMockState {
  const holder = s as MockState & { automations?: AutomationsMockState };
  holder.automations ??= seed();
  return holder.automations;
}

const RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 } as const;
function roleAtLeast(s: MockState, spaceId: string, min: keyof typeof RANK) {
  const u = requireUser(s);
  const r = myRole(s, spaceId, u.id);
  if (!r) throw new MockApiError('not_found');
  if (RANK[r] < RANK[min]) throw new MockApiError('forbidden');
  return u;
}

function out(s: MockState, r: AutomationsMockState['rules'][number]): AutomationRule {
  const { ownerId, ...rest } = r;
  const owner = s.users.find((u) => u.id === ownerId);
  return { ...rest, owner: owner ? summary(owner) : null };
}

function ruleOf(s: MockState, id: string) {
  const r = store(s).rules.find((x) => x.id === id);
  if (!r) throw new MockApiError('not_found');
  return r;
}

const hookFor = (r: { id: string; trigger: { type: string } }) =>
  r.trigger.type === 'webhook.received'
    ? `${window.location.origin}/api/automations/hooks/${r.id}?key=mock`
    : null;

type AutomationsName = Extract<
  EndpointName,
  | 'getAutomationCatalog'
  | 'listAutomationRules'
  | 'createAutomationRule'
  | 'getAutomationRule'
  | 'updateAutomationRule'
  | 'deleteAutomationRule'
  | 'testAutomationRule'
  | 'regenerateAutomationHook'
  | 'listAutomationRuns'
>;

export const automationsResolvers: Resolvers<AutomationsName> = {
  getAutomationCatalog: ({ s }) => {
    requireUser(s);
    return MOCK_CATALOG;
  },
  listAutomationRules: ({ s, params }) => {
    roleAtLeast(s, params.spaceId!, 'editor');
    return {
      items: store(s)
        .rules.filter((r) => r.spaceId === params.spaceId)
        .map((r) => out(s, r)),
    };
  },
  createAutomationRule: ({ s, params, body }) => {
    const u = roleAtLeast(s, params.spaceId!, 'admin');
    if (!MOCK_CATALOG.triggers.some((t) => t.type === body.trigger.type && t.available)) {
      throw new MockApiError('automation_trigger_unknown');
    }
    const id = newId();
    const rule = {
      id,
      spaceId: params.spaceId!,
      ...body,
      ownerId: u.id,
      hookUrl: null as string | null,
      signingSecret: 'mock-signing-secret',
      disabledReason: null,
      failureStreak: 0,
      runCount: 0,
      lastRunAt: null,
      lastStatus: null,
      createdAt: now(),
      updatedAt: now(),
    };
    rule.hookUrl = hookFor(rule);
    store(s).rules.push(rule);
    return out(s, rule);
  },
  getAutomationRule: ({ s, params }) => {
    const r = ruleOf(s, params.ruleId!);
    roleAtLeast(s, r.spaceId, 'editor');
    return out(s, r);
  },
  updateAutomationRule: ({ s, params, body }) => {
    const r = ruleOf(s, params.ruleId!);
    const u = roleAtLeast(s, r.spaceId, 'admin');
    Object.assign(r, body, { ownerId: u.id, updatedAt: now() });
    if (body.enabled === true) Object.assign(r, { disabledReason: null, failureStreak: 0 });
    r.hookUrl = hookFor(r);
    return out(s, r);
  },
  deleteAutomationRule: ({ s, params }) => {
    const r = ruleOf(s, params.ruleId!);
    roleAtLeast(s, r.spaceId, 'admin');
    const st = store(s);
    st.rules = st.rules.filter((x) => x.id !== r.id);
    st.runs = st.runs.filter((x) => x.ruleId !== r.id);
    return {};
  },
  testAutomationRule: ({ s, params }) => {
    const r = ruleOf(s, params.ruleId!);
    roleAtLeast(s, r.spaceId, 'admin');
    const run: AutomationRun = {
      id: newId(),
      ruleId: r.id,
      status: 'succeeded',
      triggerType: r.trigger.type,
      event: { sample: true },
      steps: r.actions.map((a) => ({
        actionId: a.id,
        type: a.type,
        status: 'succeeded' as const,
        error: null,
        output: {},
        ms: 5,
      })),
      error: null,
      test: true,
      depth: 0,
      startedAt: now(),
      finishedAt: now(),
      createdAt: now(),
    };
    store(s).runs.push(run);
    Object.assign(r, { runCount: r.runCount + 1, lastRunAt: now(), lastStatus: 'succeeded' });
    return run;
  },
  regenerateAutomationHook: ({ s, params }) => {
    const r = ruleOf(s, params.ruleId!);
    roleAtLeast(s, r.spaceId, 'admin');
    r.hookUrl = r.hookUrl ? `${r.hookUrl.split('?')[0]}?key=${newId().slice(0, 8)}` : null;
    return out(s, r);
  },
  listAutomationRuns: ({ s, params, query }) => {
    const r = ruleOf(s, params.ruleId!);
    roleAtLeast(s, r.spaceId, 'editor');
    const runs = store(s)
      .runs.filter((x) => x.ruleId === r.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return paginate(runs, query.cursor, query.limit);
  },
};
