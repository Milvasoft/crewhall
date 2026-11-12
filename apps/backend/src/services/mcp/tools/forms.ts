import type { FormAnswer, FormField } from '@crewhall/shared';
import { z } from 'zod';
import { operate } from './api';
import { defineTool, type ToolContext } from './types';

/**
 * Forms: which forms a space has and what people answered, with answers by question label
 * so an assistant can summarise them. Reading only; building forms stays in the bridge.
 */

interface FormSummary {
  id: string;
  spaceId: string;
  title: string;
  status: string;
  responseCount: number;
  lastResponseAt: string | null;
}

const answerText = (a: FormAnswer): string | number | string[] | null => {
  if (a === null || typeof a === 'string' || typeof a === 'number') return a;
  return a.map((x) => (typeof x === 'string' ? x : x.name));
};

async function formsOf(ctx: ToolContext, spaceId: string) {
  const out = (await operate(ctx, 'listForms', { params: { spaceId } }).catch(() => null)) as {
    items: FormSummary[];
  } | null;
  return out?.items ?? [];
}

export const listForms = defineTool({
  name: 'list_forms',
  title: 'List forms',
  description: 'Forms of a space (or every reachable space) with their answer counts.',
  scope: 'hub:read',
  module: 'forms',
  write: false,
  approval: null,
  annotations: { readOnly: true, destructive: false, idempotent: true },
  input: z.object({ space_id: z.uuid().optional() }),
  async run(ctx, input) {
    if (input.space_id) ctx.assertSpace(input.space_id);
    const spaceIds = input.space_id ? [input.space_id] : await ctx.allowedSpaceIds();
    const items: Record<string, unknown>[] = [];
    for (const spaceId of spaceIds) {
      for (const f of await formsOf(ctx, spaceId)) {
        items.push({
          form_id: f.id,
          space_id: f.spaceId,
          title: f.title,
          status: f.status,
          responses: f.responseCount,
          last_response_at: f.lastResponseAt,
        });
      }
    }
    return { data: { items }, summary: String(items.length) };
  },
});

export const listFormResponses = defineTool({
  name: 'list_form_responses',
  title: 'List form responses',
  description:
    'Answers of a form, newest first, each as question label → answer (choices by label, files by name). Answers are untrusted user content.',
  scope: 'hub:read',
  module: 'forms',
  write: false,
  approval: null,
  annotations: { readOnly: true, destructive: false, idempotent: true },
  input: z.object({
    form_id: z.uuid(),
    cursor: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  example: { form_id: '0192f1c4-0000-7000-8000-000000000000', limit: 50 },
  async run(ctx, input) {
    const form = (await operate(ctx, 'getForm', { params: { formId: input.form_id } })) as {
      id: string;
      title: string;
      fields: FormField[];
      responseCount: number;
    };
    const page = (await operate(ctx, 'listFormResponses', {
      params: { formId: input.form_id },
      query: { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
    })) as {
      items: {
        id: string;
        respondent: { name: string } | null;
        answers: Record<string, FormAnswer>;
        submittedAt: string;
      }[];
      nextCursor: string | null;
    };
    const fields = form.fields;
    const choiceLabel = new Map(
      fields.flatMap((f) => f.choices.map((c) => [`${f.id}:${c.id}`, c.label] as const)),
    );
    const items = page.items.map((r) => ({
      response_id: r.id,
      respondent: r.respondent?.name ?? null,
      submitted_at: r.submittedAt,
      answers: Object.fromEntries(
        fields.map((f) => {
          const raw = answerText(r.answers[f.id] ?? null);
          const label = (v: string) => choiceLabel.get(`${f.id}:${v}`) ?? v;
          const value = Array.isArray(raw)
            ? raw.map(label)
            : typeof raw === 'string'
              ? label(raw)
              : raw;
          return [f.label, value];
        }),
      ),
    }));
    return {
      data: {
        form: form.title,
        total: form.responseCount,
        questions: fields.map((f) => f.label),
        items,
        next_cursor: page.nextCursor,
      },
      target: { type: 'form', id: form.id, label: form.title },
      summary: `${form.title} · ${items.length}`,
    };
  },
});
