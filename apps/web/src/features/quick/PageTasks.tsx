import { Checkbox, cn, toast } from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { NO_DRAG } from './cardFrame';

/**
 * A page with to-dos on the home page (the page card): its to-dos as a real list, ticked right
 * on the card. The tick goes to the page, so an open editor sees it at once.
 */

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
}

/** The text of a to-do: the text runs of its first paragraph (what the server compares). */
function taskText(item: DocNode): string {
  return (item.content?.[0]?.content ?? [])
    .map((n) => (n.type === 'text' ? (n.text ?? '') : ''))
    .join('');
}

/**
 * To-do nodes in document order, sub-tasks and those inside quotes or toggles included: the
 * numbering `setPageTask` uses.
 */
function taskNodes(doc: DocNode | undefined): DocNode[] {
  const out: DocNode[] = [];
  const visit = (node: DocNode) => {
    if (node.type === 'taskItem') out.push(node);
    node.content?.forEach(visit);
  };
  if (doc) visit(doc);
  return out;
}

export function pageTasks(doc: DocNode | undefined): { checked: boolean; text: string }[] {
  return taskNodes(doc).map((node) => ({
    checked: node.attrs?.checked === true,
    text: taskText(node),
  }));
}

/** The same document with one to-do ticked, for showing it before the server answers. */
function withTask(doc: DocNode, index: number, checked: boolean): DocNode {
  let at = 0;
  const visit = (node: DocNode): DocNode => {
    let next = node;
    if (node.type === 'taskItem') {
      if (at === index) next = { ...node, attrs: { ...node.attrs, checked } };
      at += 1;
    }
    return next.content ? { ...next, content: next.content.map(visit) } : next;
  };
  return visit(doc);
}

const textOf = (node: DocNode): string =>
  node.type === 'text' ? (node.text ?? '') : (node.content ?? []).map(textOf).join('');

export function PageTaskList({
  nodeId,
  doc,
  queryKey,
  disabled,
}: {
  nodeId: string;
  doc: DocNode;
  /** The card's cached page content. */
  queryKey: readonly unknown[];
  disabled: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  type Content = { doc?: unknown };
  const tick = useMutation({
    mutationFn: (task: { index: number; text: string; checked: boolean }) =>
      api.call('setPageTask', { params: { nodeId }, body: task }),
    onMutate: async (task) => {
      await qc.cancelQueries({ queryKey });
      const before = qc.getQueryData<Content>(queryKey);
      qc.setQueryData<Content>(queryKey, (old) =>
        old?.doc ? { ...old, doc: withTask(old.doc as DocNode, task.index, task.checked) } : old,
      );
      return { before };
    },
    onError: (e, _task, ctx) => {
      qc.setQueryData(queryKey, ctx?.before);
      toast(t(errorKey(e)));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey }),
  });

  // The card lists only some of the to-dos, but each keeps its number in the whole page.
  const numbers = new Map(taskNodes(doc).map((node, i) => [node, i]));
  const items = (list: DocNode, depth: number): ReactNode =>
    (list.content ?? []).map((item) => {
      const at = numbers.get(item) ?? -1;
      const checked = item.attrs?.checked === true;
      const text = taskText(item);
      return (
        <li key={at} className="flex flex-col">
          <span className="flex min-h-7 items-center gap-2.5">
            <Checkbox
              checked={checked}
              disabled={disabled}
              aria-label={text}
              className={NO_DRAG}
              onCheckedChange={(v) => tick.mutate({ index: at, text, checked: v === true })}
            />
            <span className={cn('min-w-0 flex-1 truncate', checked && 'text-fg3 line-through')}>
              {text}
            </span>
          </span>
          {nested(item, depth + 1)}
        </li>
      );
    });
  const nested = (item: DocNode, depth: number): ReactNode =>
    (item.content ?? [])
      .filter((c) => c.type === 'taskList')
      .map((c, i) => (
        <ul key={i} className="m-0 list-none p-0 pl-5">
          {items(c, depth)}
        </ul>
      ));

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto text-cap leading-[19px] text-fg2',
        NO_DRAG,
      )}
    >
      {(doc.content ?? []).map((block, i) => {
        if (block.type === 'taskList') {
          return (
            <ul key={i} className="m-0 list-none p-0 text-fg">
              {items(block, 0)}
            </ul>
          );
        }
        const text = textOf(block).trim();
        if (!text) return null;
        return (
          <p key={i} className={cn('m-0 truncate', block.type === 'heading' && 'font-semibold')}>
            {text}
          </p>
        );
      })}
    </div>
  );
}
