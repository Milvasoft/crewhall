import type { AiActKind, AiActProposal, ApprovalDetail } from '@crewhall/shared';
import { Button, Icon, Spinner, toast, type IconName } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReauth } from '@/components/mcp/ReauthDialog';
import { clearDecisions, finishDecision, useQueuedDecision } from '@/lib/ai/decisions';
import { asCode } from '@/lib/ai/useAiRun';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { approvalQuery, mcpKeys } from '@/lib/mcp/queries';

export const ACT_ICON: Record<AiActKind, IconName> = {
  assign_card: 'userPlus',
  create_card: 'card',
  create_meeting: 'calendar',
  add_todo_item: 'todo',
  create_event: 'calendar',
  send_message: 'send',
  create_page: 'page',
  append_page: 'note',
  todo_to_page: 'page',
  page_to_tasks: 'todo',
  move_todo_items: 'todo',
};

type Decision = 'approved' | 'rejected';

/**
 * One prepared action in "Yap" mode: review it in Onay bekleyenler, or decide right here.
 * Approving uses the same endpoint (and the same passkey or password check) as that page;
 * both read the approval through the same query, so a decision taken there shows here too.
 */
export function ActProposal({ proposal }: { proposal: AiActProposal }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  // Closing the check stops the whole "evet": nothing further is approved behind the person's back.
  const reauth = useReauth({ onCancel: clearDecisions });
  const id = proposal.approvalId;
  // Shown at once; dropped when the server says otherwise or the call fails.
  const [optimistic, setOptimistic] = useState<Decision | null>(null);
  const detail = useQuery({
    ...approvalQuery(id),
    // Approved requests are applied by the worker; follow them until the outcome is known. A
    // pending one is checked now and then, in case it was decided on the approvals page.
    refetchInterval: (q) =>
      q.state.data?.status === 'approved'
        ? 1500
        : q.state.data?.status === 'pending'
          ? 15_000
          : false,
  });
  const server = detail.data?.status ?? 'pending';
  const status = server === 'pending' && optimistic ? optimistic : server;

  const settle = async (next: ApprovalDetail) => {
    qc.setQueryData(mcpKeys.approval(id), next);
    setOptimistic(null);
    finishDecision(id);
    // The queue, the history and the pending count in the menu.
    await qc.invalidateQueries({ queryKey: mcpKeys.all, refetchType: 'active' });
  };
  const failed = async (e: unknown) => {
    setOptimistic(null);
    finishDecision(id);
    toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal'));
    await qc.invalidateQueries({ queryKey: mcpKeys.approval(id) });
  };

  const approve = useMutation({
    mutationFn: () => api.call('approveMcpApproval', { params: { approvalId: id } }),
    onMutate: () => setOptimistic('approved'),
    onSuccess: settle,
    onError: async (e) => {
      if (reauth.handle(e, () => approve.mutate())) {
        setOptimistic(null);
        return;
      }
      await failed(e);
    },
  });
  const reject = useMutation({
    mutationFn: () => api.call('rejectMcpApproval', { params: { approvalId: id }, body: {} }),
    onMutate: () => setOptimistic('rejected'),
    onSuccess: settle,
    onError: failed,
  });

  // The buttons go away once decided: keep keyboard focus on the outcome instead of the body.
  const outcome = useRef<HTMLDivElement>(null);
  const decidedHere = useRef(false);

  // "Evet" or "Hepsini onayla": this card's turn to press its own button.
  const queued = useQueuedDecision(id);
  const pressed = useRef(false);
  const known = detail.data?.status;
  const unreadable = detail.isError;
  useEffect(() => {
    if (!queued) return;
    if (unreadable || (known && known !== 'pending')) {
      finishDecision(id);
      return;
    }
    if (!known || pressed.current) return;
    pressed.current = true;
    decidedHere.current = true;
    if (queued === 'approve') approve.mutate();
    else reject.mutate();
    // The mutations are stable for this card; only the queue and the status start a press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, known, unreadable, id]);
  useEffect(() => {
    if (decidedHere.current && status !== 'pending') outcome.current?.focus();
  }, [status]);

  return (
    <li className="flex flex-col gap-2 rounded-lg bg-bg2 px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon name={ACT_ICON[proposal.kind]} size={15} className="shrink-0 text-fg2" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-cap font-semibold">{proposal.title}</span>
          {proposal.detail ? (
            <span className="truncate text-xs text-fg2">{proposal.detail}</span>
          ) : null}
        </span>
      </div>
      {status === 'pending' ? (
        <div
          role="group"
          aria-label={proposal.title}
          className="flex flex-wrap items-center gap-1.5"
        >
          <Button size="xs" variant="out" asChild>
            <Link to="/account/approvals/$approvalId" params={{ approvalId: id }}>
              {t('ai.act.review')}
            </Link>
          </Button>
          <span className="flex-1" />
          <Button
            size="xs"
            variant="gh"
            disabled={approve.isPending || reject.isPending}
            onClick={() => {
              decidedHere.current = true;
              reject.mutate();
            }}
          >
            {t('ai.act.reject')}
          </Button>
          <Button
            size="xs"
            variant="pri"
            disabled={approve.isPending || reject.isPending}
            onClick={() => {
              decidedHere.current = true;
              if (detail.data?.needsReauth) reauth.ask(() => approve.mutate());
              else approve.mutate();
            }}
          >
            <Icon name="check" size={13} />
            {t('ai.act.approve')}
          </Button>
        </div>
      ) : (
        <div
          ref={outcome}
          tabIndex={-1}
          role="status"
          className="flex items-center gap-1.5 text-xs outline-none"
        >
          <Outcome
            kind={proposal.kind}
            status={status}
            result={detail.data?.result ?? null}
            errorCode={detail.data?.errorCode ?? null}
          />
        </div>
      )}
      {reauth.dialog}
    </li>
  );
}

function Outcome({
  kind,
  status,
  result,
  errorCode,
}: {
  kind: AiActKind;
  status: ApprovalDetail['status'];
  result: Record<string, unknown> | null;
  errorCode: string | null;
}) {
  const { t } = useI18n();
  if (status === 'approved') {
    return (
      <span className="flex items-center gap-1.5 text-fg2">
        <Spinner size={13} /> {t('ai.act.applying')}
      </span>
    );
  }
  if (status === 'applied') {
    const open = openLink(kind, result, t('ai.act.open'));
    return (
      <>
        <Icon name="check" size={14} className="text-success" />
        <span className="font-semibold">{t(`ai.act.done.${kind}`)}</span>
        {typeof result?.items === 'number' ? (
          <span className="text-fg2">{t('ai.act.doneCount', { n: result.items })}</span>
        ) : null}
        {open ? (
          <>
            <span aria-hidden className="text-fg3">
              →
            </span>
            {open}
          </>
        ) : null}
      </>
    );
  }
  return (
    <span className={status === 'rejected' ? 'text-fg2' : 'text-danger'}>
      {t(`mcp.approvals.status.${status}`)}
      {status === 'failed' && errorCode ? ` ${t(`errors.${asCode(errorCode)}`)}` : null}
    </span>
  );
}

/** Where the applied action can be seen, from the ids the server returned. */
function openLink(
  kind: AiActKind,
  result: Record<string, unknown> | null,
  label: string,
): ReactNode {
  const cls = 'font-semibold text-accent-text underline-offset-2 hover:underline';
  // Newer kinds return where the result opens.
  if (typeof result?.path === 'string' && result.path.startsWith('/')) {
    return (
      <PathLink href={result.path} className={cls}>
        {label}
      </PathLink>
    );
  }
  if (kind === 'add_todo_item') {
    return (
      <Link to="/" className={cls}>
        {label}
      </Link>
    );
  }
  if (kind === 'create_meeting') {
    return (
      <Link to="/meetings" search={{ view: 'scheduled' }} className={cls}>
        {label}
      </Link>
    );
  }
  const boardId = typeof result?.board_id === 'string' ? result.board_id : null;
  const number = typeof result?.number === 'number' ? result.number : null;
  if (!boardId || number === null) return null;
  return (
    <Link to="/b/$boardId/$cardRef" params={{ boardId, cardRef: String(number) }} className={cls}>
      {label}
    </Link>
  );
}

/** An in-app link to a path that may carry a query (`/calendar?event=…`). */
function PathLink({
  href,
  className,
  children,
}: {
  href: string;
  className: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        router.history.push(href);
      }}
    >
      {children}
    </a>
  );
}
