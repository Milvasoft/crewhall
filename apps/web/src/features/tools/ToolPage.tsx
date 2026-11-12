import { EmptyState, Spinner } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Workspace } from '@/components/shell/Workspace';
import { nodeQuery } from '@/features/drive/api';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { ToolHeader } from './components/tool/ToolHeader';
import { ToolRunner } from './components/tool/ToolRunner';
import { categoryKey, useLocalizedTool } from './i18n';
import { getDefinition } from './lib/registry';
import { ToolsSidebar } from './ToolsSidebar';

/** Drive files over this open in the Drive viewer instead (a tool works on text in memory). */
const MAX_SEED_BYTES = 5 * 1024 * 1024;

/** /tools/<id>: the tool, and with `?node=<id>` that Drive file's text as its input. */
export function ToolPage({ toolId, nodeId }: { toolId: string; nodeId?: string }) {
  const { t } = useI18n();
  const localize = useLocalizedTool();
  const def = getDefinition(toolId);
  const tool = def ? localize(def) : undefined;
  useDocumentTitle(tool?.name);

  const node = useQuery({ ...nodeQuery(nodeId ?? ''), enabled: Boolean(nodeId) });
  const seed = useQuery({
    queryKey: ['tools', 'seed', nodeId, node.data?.version],
    enabled: Boolean(node.data) && (node.data?.sizeBytes ?? 0) <= MAX_SEED_BYTES,
    queryFn: async ({ signal }) => {
      const { url } = await api.call('getDownloadUrl', { params: { nodeId: nodeId! }, signal });
      return (await fetch(url, { signal })).text();
    },
    staleTime: Infinity,
  });

  if (!def || !tool) {
    return (
      <Workspace sidebar={<ToolsSidebar />} crumbs={[{ label: t('tools.title') }]}>
        <EmptyState
          className="m-auto"
          icon="tool"
          title={t('tools.home.noResults', { q: toolId })}
        />
      </Workspace>
    );
  }
  const waiting = Boolean(nodeId) && (node.isPending || seed.isPending) && !node.isError;
  const failed =
    Boolean(nodeId) &&
    (node.isError || seed.isError || (node.data?.sizeBytes ?? 0) > MAX_SEED_BYTES);
  return (
    <Workspace
      sidebar={<ToolsSidebar category={def.category} toolId={def.id} />}
      crumbs={[
        { label: t('tools.title') },
        { label: t(categoryKey(def.category, 'name')) },
        { label: tool.name },
      ]}
    >
      <ToolHeader definition={def} />
      {nodeId && node.data ? (
        <p className="m-0 -mt-2 text-xs text-fg3">
          {t('tools.open.fromFile', { name: node.data.name })}
        </p>
      ) : null}
      {failed ? <p className="m-0 text-sm text-danger">{t('tools.open.failed')}</p> : null}
      {waiting ? (
        <div className="flex items-center gap-2 text-sm text-fg2">
          <Spinner />
          {t('tools.open.loading')}
        </div>
      ) : (
        <ToolRunner key={`${toolId}:${nodeId ?? ''}`} toolId={toolId} seed={seed.data} />
      )}
    </Workspace>
  );
}
