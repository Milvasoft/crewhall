import {
  FormField,
  FormSettings,
  checkAnswers,
  ratingScale,
  type EndpointName,
  type Form,
  type FormAnswers,
  type FormFieldStats,
  type FormFile,
  type FormStatus,
} from '@crewhall/shared';
import {
  MockApiError,
  memberOf,
  myRole,
  paginate,
  requireUser,
  summary,
  type Resolvers,
} from './core';
import { newId } from './db';
import { SPACE, USER, type MockState } from './seed';

/**
 * Forms part of the contract mock (roadmap 16): definitions, answers and uploads in memory,
 * answers checked with the same shared rules as the server.
 */

interface MockForm {
  id: string;
  spaceId: string;
  title: string;
  description: string | null;
  fields: FormField[];
  settings: FormSettings;
  status: FormStatus;
  token: string;
  ownerId: string;
  driveNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface MockResponse {
  id: string;
  formId: string;
  respondentId: string | null;
  key: string | null;
  answers: FormAnswers;
  submittedAt: string;
}
interface MockUpload extends FormFile {
  formId: string;
  fieldId: string;
  owner: string;
  attached: boolean;
}

export interface FormsMockState {
  forms: MockForm[];
  responses: MockResponse[];
  files: MockUpload[];
}

const FORM_ID = '0190f0a0-0000-7000-8000-00000000f001';
const now = () => new Date().toISOString();
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function seed(): FormsMockState {
  const fields = [
    { id: 'name', type: 'short_text', label: 'Adın soyadın', required: true },
    {
      id: 'team',
      type: 'single_choice',
      label: 'Hangi ekiptesin?',
      required: true,
      choices: [
        { id: 'web', label: 'Web' },
        { id: 'api', label: 'Backend' },
        { id: 'mobile', label: 'Mobil' },
      ],
    },
    {
      id: 'topics',
      type: 'multi_choice',
      label: 'Hangi oturumlara katılacaksın?',
      choices: [
        { id: 'ai', label: 'Yapay zekâ' },
        { id: 'sec', label: 'Güvenlik' },
        { id: 'ops', label: 'Operasyon' },
      ],
    },
    { id: 'score', type: 'rating', label: 'Geçen etkinliği nasıl buldun?', max: 5 },
    {
      id: 'note',
      type: 'long_text',
      label: 'Backend için öneri',
      required: true,
      showIf: { fieldId: 'team', op: 'equals', value: 'api' },
    },
  ].map((f) => FormField.parse(f));
  const form: MockForm = {
    id: FORM_ID,
    spaceId: SPACE.milvasoft,
    title: 'Ekim teknik buluşması',
    description: 'Katılım ve konu tercihleri. Yanıtlar etkinlik planına girer.',
    fields,
    settings: FormSettings.parse({ notifyOnResponse: true }),
    status: 'open',
    token: 'buluşma-2026',
    ownerId: USER.bugra,
    driveNodeId: null,
    createdAt: ago(6),
    updatedAt: ago(1),
  };
  const raw: { who: string; a: FormAnswers; d: number }[] = [
    {
      who: USER.elif,
      a: { name: 'Elif Yıldız', team: 'web', topics: ['ai', 'sec'], score: 5 },
      d: 3,
    },
    {
      who: USER.mert,
      a: { name: 'Mert Kaya', team: 'api', topics: ['ops'], score: 4, note: 'Kuyruk izleme' },
      d: 2,
    },
    { who: USER.selin, a: { name: 'Selin Ak', team: 'mobile', topics: ['ai'], score: 3 }, d: 1 },
  ];
  const responses: MockResponse[] = raw.map((r) => ({
    id: newId(),
    formId: FORM_ID,
    respondentId: r.who,
    key: null,
    answers: r.a,
    submittedAt: ago(r.d),
  }));
  return { forms: [form], responses, files: [] };
}

export function formsMockState(s: MockState): FormsMockState {
  const holder = s as MockState & { forms?: FormsMockState };
  holder.forms ??= seed();
  return holder.forms;
}

const RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 } as const;
const isEditor = (s: MockState, spaceId: string, userId: string) => {
  const r = myRole(s, spaceId, userId);
  return r !== null && RANK[r] >= RANK.editor;
};

function formOf(s: MockState, id: string) {
  const f = formsMockState(s).forms.find((x) => x.id === id);
  if (!f) throw new MockApiError('not_found');
  return f;
}

function editable(s: MockState, id: string) {
  const u = requireUser(s);
  const f = formOf(s, id);
  if (!isEditor(s, f.spaceId, u.id)) {
    throw new MockApiError(myRole(s, f.spaceId, u.id) ? 'forbidden' : 'not_found');
  }
  return { u, f };
}

const accepting = (f: MockForm) =>
  f.status === 'open' && (!f.settings.closesAt || new Date(f.settings.closesAt) > new Date());

function toForm(s: MockState, f: MockForm): Form {
  const st = formsMockState(s);
  const rs = st.responses.filter((r) => r.formId === f.id);
  const owner = s.users.find((u) => u.id === f.ownerId);
  return {
    id: f.id,
    spaceId: f.spaceId,
    title: f.title,
    description: f.description,
    fields: f.fields,
    settings: f.settings,
    status: f.status,
    publicUrl: f.settings.access === 'public' ? `${window.location.origin}/f/${f.token}` : null,
    fillPath: `/forms/edit/${f.id}`,
    responseCount: rs.length,
    lastResponseAt:
      rs
        .map((r) => r.submittedAt)
        .sort()
        .at(-1) ?? null,
    driveNodeId: f.driveNodeId,
    owner: owner ? summary(owner) : null,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

const toFill = (s: MockState, f: MockForm, answered: boolean) => ({
  id: f.id,
  title: f.title,
  description: f.description,
  fields: f.fields,
  anonymous: f.settings.anonymous,
  oneResponse: f.settings.oneResponse,
  alreadyResponded: answered,
  accepting: accepting(f),
  orgName: s.org?.name ?? '',
});

function submit(
  s: MockState,
  f: MockForm,
  answers: FormAnswers,
  who: string,
  userId: string | null,
) {
  if (!accepting(f)) throw new MockApiError('form_closed');
  const { clean, errors } = checkAnswers(f.fields, answers);
  if (Object.keys(errors).length)
    {throw new MockApiError('form_answers_invalid', undefined, { fields: errors });}
  const st = formsMockState(s);
  const key = f.settings.oneResponse ? `${f.id}:${who}` : null;
  if (key && st.responses.some((r) => r.key === key))
    {throw new MockApiError('form_already_answered');}
  const id = newId();
  st.responses.push({
    id,
    formId: f.id,
    respondentId: f.settings.anonymous ? null : userId,
    key,
    answers: clean,
    submittedAt: now(),
  });
  for (const file of st.files) {
    if (file.owner === who && file.formId === f.id) file.attached = true;
  }
  return { id, confirmation: f.settings.confirmation };
}

const DATA_URL = /^data:([^;,]*);base64,(.*)$/s;
function upload(
  s: MockState,
  f: MockForm,
  input: { fieldId: string; name: string; dataURL: string },
  owner: string,
) {
  if (!accepting(f)) throw new MockApiError('form_closed');
  const field = f.fields.find((x) => x.id === input.fieldId);
  const m = DATA_URL.exec(input.dataURL);
  if (!field || field.type !== 'file' || !m) throw new MockApiError('form_file_invalid');
  const file: MockUpload = {
    fileId: newId(),
    name: input.name,
    mime: m[1] || 'application/octet-stream',
    sizeBytes: Math.floor((m[2]!.length * 3) / 4),
    formId: f.id,
    fieldId: field.id,
    owner,
    attached: false,
  };
  formsMockState(s).files.push(file);
  return { fileId: file.fileId, name: file.name, mime: file.mime, sizeBytes: file.sizeBytes };
}

function stats(f: MockForm, rs: MockResponse[]): FormFieldStats[] {
  return f.fields.map((field) => {
    const counts: Record<string, number> = {};
    const nums: number[] = [];
    let answered = 0;
    for (const r of rs) {
      const v = r.answers[field.id];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))
        {continue;}
      answered++;
      if (typeof v === 'string' && field.type === 'single_choice') counts[v] = (counts[v] ?? 0) + 1;
      if (Array.isArray(v) && field.type === 'multi_choice') {
        for (const x of v) if (typeof x === 'string') counts[x] = (counts[x] ?? 0) + 1;
      }
      if (typeof v === 'number') {
        nums.push(v);
        if (field.type === 'rating') counts[String(v)] = (counts[String(v)] ?? 0) + 1;
      }
    }
    for (const c of field.choices) counts[c.id] ??= 0;
    if (field.type === 'rating')
      {for (let i = 1; i <= ratingScale(field); i++) counts[String(i)] ??= 0;}
    return {
      fieldId: field.id,
      type: field.type,
      answered,
      counts,
      average: nums.length
        ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100
        : null,
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
    };
  });
}

type FormsName = Extract<
  EndpointName,
  | 'listForms'
  | 'createForm'
  | 'getForm'
  | 'updateForm'
  | 'deleteForm'
  | 'regenerateFormLink'
  | 'exportFormToDrive'
  | 'listFormResponses'
  | 'getFormStats'
  | 'deleteFormResponse'
  | 'getFormFileUrl'
  | 'getFormToFill'
  | 'submitForm'
  | 'uploadFormFile'
  | 'getPublicForm'
  | 'submitPublicForm'
  | 'uploadPublicFormFile'
>;

export const formsResolvers: Resolvers<FormsName> = {
  listForms: ({ s, params }) => {
    const u = requireUser(s);
    if (!myRole(s, params.spaceId!, u.id)) throw new MockApiError('not_found');
    const editor = isEditor(s, params.spaceId!, u.id);
    const st = formsMockState(s);
    return {
      items: st.forms
        .filter((f) => f.spaceId === params.spaceId && (editor || f.status === 'open'))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((f) => {
          const out = toForm(s, f);
          return {
            id: f.id,
            spaceId: f.spaceId,
            title: f.title,
            status: f.status,
            access: f.settings.access,
            fieldCount: f.fields.length,
            responseCount: editor ? out.responseCount : 0,
            lastResponseAt: editor ? out.lastResponseAt : null,
            updatedAt: f.updatedAt,
          };
        }),
    };
  },
  createForm: ({ s, params, body }) => {
    const u = requireUser(s);
    if (!isEditor(s, params.spaceId!, u.id)) throw new MockApiError('forbidden');
    const f: MockForm = {
      id: newId(),
      spaceId: params.spaceId!,
      title: body.title,
      description: body.description ?? null,
      fields: body.fields,
      settings: FormSettings.parse({}),
      status: 'draft',
      token: newId().slice(0, 12),
      ownerId: u.id,
      driveNodeId: null,
      createdAt: now(),
      updatedAt: now(),
    };
    formsMockState(s).forms.push(f);
    return toForm(s, f);
  },
  getForm: ({ s, params }) => toForm(s, editable(s, params.formId!).f),
  updateForm: ({ s, params, body }) => {
    const { f } = editable(s, params.formId!);
    const status = body.status ?? f.status;
    const fields = body.fields ?? f.fields;
    if (status === 'open' && fields.length === 0) throw new MockApiError('form_definition_invalid');
    Object.assign(f, {
      title: body.title ?? f.title,
      description: body.description !== undefined ? body.description : f.description,
      fields,
      settings: body.settings ?? f.settings,
      status,
      updatedAt: now(),
    });
    return toForm(s, f);
  },
  deleteForm: ({ s, params }) => {
    const { f } = editable(s, params.formId!);
    const st = formsMockState(s);
    st.forms = st.forms.filter((x) => x.id !== f.id);
    st.responses = st.responses.filter((r) => r.formId !== f.id);
    return {};
  },
  regenerateFormLink: ({ s, params }) => {
    const { f } = editable(s, params.formId!);
    f.token = newId().slice(0, 12);
    return toForm(s, f);
  },
  exportFormToDrive: ({ s, params }) => {
    const { f } = editable(s, params.formId!);
    f.driveNodeId ??= newId();
    return { nodeId: f.driveNodeId, name: `${f.title} · Yanıtlar.csv` };
  },
  listFormResponses: ({ s, params, query }) => {
    const { f } = editable(s, params.formId!);
    const rs = formsMockState(s)
      .responses.filter((r) => r.formId === f.id)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .map((r) => {
        const who = r.respondentId ? s.users.find((u) => u.id === r.respondentId) : undefined;
        return {
          id: r.id,
          respondent: who ? summary(who) : null,
          answers: r.answers,
          submittedAt: r.submittedAt,
        };
      });
    return paginate(rs, query.cursor, query.limit);
  },
  getFormStats: ({ s, params }) => {
    const { f } = editable(s, params.formId!);
    const rs = formsMockState(s).responses.filter((r) => r.formId === f.id);
    const daily = new Map<string, number>();
    for (const r of rs)
      {daily.set(r.submittedAt.slice(0, 10), (daily.get(r.submittedAt.slice(0, 10)) ?? 0) + 1);}
    return {
      total: rs.length,
      daily: [...daily]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count })),
      fields: stats(f, rs),
    };
  },
  deleteFormResponse: ({ s, params }) => {
    const st = formsMockState(s);
    const r = st.responses.find((x) => x.id === params.responseId);
    if (!r) throw new MockApiError('not_found');
    editable(s, r.formId);
    st.responses = st.responses.filter((x) => x.id !== r.id);
    return {};
  },
  getFormFileUrl: ({ s, params }) => {
    const file = formsMockState(s).files.find((x) => x.fileId === params.fileId && x.attached);
    if (!file) throw new MockApiError('not_found');
    editable(s, file.formId);
    return {
      url: `${window.location.origin}/mock-files/${file.fileId}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  },
  getFormToFill: ({ s, params }) => {
    const u = requireUser(s);
    const f = formOf(s, params.formId!);
    if (f.status === 'draft' && !isEditor(s, f.spaceId, u.id)) throw new MockApiError('not_found');
    if (memberOf(s, u.id)?.role === 'guest' && !myRole(s, f.spaceId, u.id))
      {throw new MockApiError('not_found');}
    const answered = formsMockState(s).responses.some((r) => r.key === `${f.id}:user:${u.id}`);
    return toFill(s, f, answered);
  },
  submitForm: ({ s, params, body }) => {
    const u = requireUser(s);
    const f = formOf(s, params.formId!);
    if (f.status === 'draft') throw new MockApiError('not_found');
    return submit(s, f, body.answers, `user:${u.id}`, u.id);
  },
  uploadFormFile: ({ s, params, body }) => {
    const u = requireUser(s);
    return upload(s, formOf(s, params.formId!), body, `user:${u.id}`);
  },
  getPublicForm: ({ s, params }) => {
    const f = formsMockState(s).forms.find((x) => x.token === params.token);
    if (!f || f.settings.access !== 'public' || f.status === 'draft')
      {throw new MockApiError('not_found');}
    return toFill(s, f, false);
  },
  submitPublicForm: ({ s, params, body }) => {
    const f = formsMockState(s).forms.find((x) => x.token === params.token);
    if (!f || f.settings.access !== 'public' || f.status === 'draft')
      {throw new MockApiError('not_found');}
    if (body.website) return { id: newId(), confirmation: f.settings.confirmation };
    return submit(s, f, body.answers, `browser:${body.clientToken ?? newId()}`, null);
  },
  uploadPublicFormFile: ({ s, params, body }) => {
    const f = formsMockState(s).forms.find((x) => x.token === params.token);
    if (!f || f.settings.access !== 'public') throw new MockApiError('not_found');
    return upload(s, f, body, `browser:${body.clientToken ?? ''}`);
  },
};
