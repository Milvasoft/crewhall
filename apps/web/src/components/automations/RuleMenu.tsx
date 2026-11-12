import { paths, type AutomationRule } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { ConfirmDialog } from '@/components/forms/parts';
import { api } from '@/lib/api';
import { automationKeys, rulesQuery, setRuleCache } from '@/lib/automations/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';

/** The rule page opens on its run history with this hash (`/automations/rule/<id>#runs`). */
export const RUNS_HASH = 'runs';

/** Renames a rule; the list shows the new name at once. */
export function useRenameRule() {
  const { t } = useI18n();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rule, name }: { rule: AutomationRule; name: string }) =>
      api.call('updateAutomationRule', { params: { ruleId: rule.id }, body: { name } }),
    onMutate: ({ rule, name }) => {
      qc.setQueryData(rulesQuery(rule.spaceId).queryKey, (old) =>
        old
          ? { ...old, items: old.items.map((r) => (r.id === rule.id ? { ...r, name } : r)) }
          : old,
      );
    },
    onSuccess: (saved) => {
      setRuleCache(qc, saved);
      toast(t('automations.menu.renamed'));
    },
    onError: (e, { rule }) => {
      void qc.invalidateQueries({ queryKey: automationKeys.list(rule.spaceId) });
      toast(t(errorKey(e)));
    },
  });
}

/**
 * Right-click menu of a rule in a list: open, run history and, for those who manage the space's
 * automations, pause / resume, rename and delete.
 */
export function RuleContextMenu({
  rule,
  canManage,
  spaceSlug,
  onRename,
  children,
}: {
  rule: AutomationRule;
  canManage: boolean;
  spaceSlug: string;
  onRename?: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [deleting, setDeleting] = useState(false);

  const toggle = useMutation({
    mutationFn: () =>
      api.call('updateAutomationRule', {
        params: { ruleId: rule.id },
        body: { enabled: !rule.enabled },
      }),
    onSuccess: (r) => {
      setRuleCache(qc, r);
      toast(r.enabled ? t('automations.menu.resumed') : t('automations.menu.paused'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteAutomationRule', { params: { ruleId: rule.id } }),
    onSuccess: () => {
      setDeleting(false);
      // Leave the rule's own page before its data goes.
      if (pathname === paths.automationRule(rule.id)) {
        void navigate({ to: '/automations/$spaceSlug', params: { spaceSlug } });
      }
      qc.removeQueries({ queryKey: automationKeys.rule(rule.id) });
      void qc.invalidateQueries({ queryKey: automationKeys.list(rule.spaceId) });
      toast(t('automations.editor.deleted'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const entries: ActionEntry[] = [
    {
      kind: 'item',
      key: 'open',
      icon: 'arrowUR',
      label: t('automations.menu.open'),
      onSelect: () =>
        void navigate({ to: '/automations/rule/$ruleId', params: { ruleId: rule.id } }),
    },
    {
      kind: 'item',
      key: 'runs',
      icon: 'history',
      label: t('automations.menu.runs'),
      onSelect: () =>
        void navigate({
          to: '/automations/rule/$ruleId',
          params: { ruleId: rule.id },
          hash: RUNS_HASH,
        }),
    },
  ];
  if (canManage) {
    entries.push(
      { kind: 'sep', key: 's1' },
      {
        kind: 'item',
        key: 'toggle',
        icon: rule.enabled ? 'pause' : 'play',
        label: rule.enabled ? t('automations.menu.pause') : t('automations.menu.resume'),
        disabledReason: toggle.isPending ? t('automations.menu.saving') : undefined,
        onSelect: () => toggle.mutate(),
      },
      ...(onRename
        ? [
            {
              kind: 'item',
              key: 'rename',
              icon: 'pencil',
              label: t('automations.menu.rename'),
              onSelect: onRename,
            } satisfies ActionEntry,
          ]
        : []),
      { kind: 'sep', key: 's2' },
      {
        kind: 'item',
        key: 'delete',
        icon: 'trash',
        label: t('automations.editor.delete'),
        danger: true,
        onSelect: () => setDeleting(true),
      },
    );
  }

  return (
    <>
      <ActionContextMenu entries={entries}>{children}</ActionContextMenu>
      {canManage ? (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={t('automations.editor.deleteTitle', { name: rule.name })}
          body={t('automations.editor.deleteBody')}
          confirm={t('automations.editor.delete')}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </>
  );
}
