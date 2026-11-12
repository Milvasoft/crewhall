import { type McpToolDoc } from '@crewhall/shared';
import { Button, cn, EmptyState, Icon, Input, Skeleton, Table, Tag, Td, Th } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { PageHeader } from '@/components/admin/Settings';
import { Card } from '@/components/mcp/Overview';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';
import { catalogQuery } from '@/lib/mcp/queries';

export const Route = createFileRoute('/_app/account/mcp/docs')({
  validateSearch: z.object({ tool: z.string().optional() }),
  component: DocsPage,
});

/**
 * Araç belgeleri (design 18.11): the catalog comes from the server's zod schemas, the same
 * source tools/list uses; tools outside every connection of mine are drawn faded.
 */
function DocsPage() {
  const { t } = useI18n();
  const catalog = useQuery(catalogQuery);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [q, setQ] = useState('');
  const tools = (catalog.data?.tools ?? []).filter((tool) =>
    `${tool.name} ${tool.description}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const selected =
    catalog.data?.tools.find((x) => x.name === search.tool) ?? catalog.data?.tools[0] ?? null;

  function downloadCatalog() {
    if (!catalog.data) return;
    const blob = new Blob([JSON.stringify(catalog.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'crewhall-mcp-tools.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Workspace crumbs={[{ label: t('mcp.overview.title') }, { label: t('mcp.docs.title') }]}>
      <PageHeader
        title={t('mcp.docs.title')}
        subtitle={
          catalog.data
            ? t('mcp.docs.subtitle', {
                tools: catalog.data.tools.length,
                resources: catalog.data.resources.length,
              })
            : undefined
        }
        actions={
          <>
            <div className="relative w-[220px]">
              <Icon
                name="search"
                size={15}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg3"
              />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('mcp.docs.search')}
                aria-label={t('mcp.docs.search')}
                className="h-9 pl-9"
              />
            </div>
            <Button size="sm" variant="out" onClick={downloadCatalog} disabled={!catalog.data}>
              <Icon name="code" size={15} />
              {t('mcp.docs.json')}
            </Button>
          </>
        }
      />
      {!catalog.data ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="overflow-x-auto rounded-2xl bg-surface shadow-line">
            <Table>
              <thead>
                <tr>
                  <Th>{t('mcp.docs.cols.tool')}</Th>
                  <Th>{t('mcp.docs.cols.description')}</Th>
                  <Th>{t('mcp.docs.cols.scope')}</Th>
                  <Th>{t('mcp.docs.cols.approval')}</Th>
                </tr>
              </thead>
              <tbody>
                {tools.length === 0 ? (
                  <tr>
                    <Td colSpan={4}>
                      <EmptyState icon="search" title={t('mcp.docs.empty')} />
                    </Td>
                  </tr>
                ) : (
                  tools.map((tool) => (
                    <tr
                      key={tool.name}
                      aria-selected={selected?.name === tool.name}
                      title={tool.available ? undefined : t('mcp.docs.unavailable')}
                      className={cn(
                        'cursor-pointer hover:bg-bg2',
                        selected?.name === tool.name && 'bg-bg2',
                        !tool.available && 'opacity-50',
                      )}
                      onClick={() => void navigate({ search: { tool: tool.name }, replace: true })}
                    >
                      <Td className="font-mono text-xs font-semibold">{tool.name}</Td>
                      <Td className="min-w-[180px] text-cap whitespace-normal">
                        {describe(t, tool)}
                      </Td>
                      <Td className="text-cap whitespace-nowrap">
                        {t(`mcp.scopeShort.${tool.scope}`)}
                      </Td>
                      <Td className="text-cap whitespace-nowrap">
                        {t(`mcp.docs.approval.${tool.approval ?? 'none'}`)}
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
          </div>
          {selected ? <ToolDetail tool={selected} /> : null}
          <Card title={t('mcp.docs.resources')} className="xl:col-span-2">
            {catalog.data.resources.map((r) => (
              <div key={r.uriTemplate} className="flex flex-wrap items-center gap-2 text-cap">
                <code className="rounded-xs bg-bg2 px-1.5 py-0.5 font-mono text-xs">
                  {r.uriTemplate}
                </code>
                <span className="text-fg2">{r.description}</span>
              </div>
            ))}
            <span className="text-xs text-fg2">
              {t('mcp.docs.limits', {
                rpm: catalog.data.limits.requestsPerMinute,
                wpm: catalog.data.limits.writesPerMinute,
                kb: Math.round(catalog.data.limits.responseBytes / 1024),
              })}
            </span>
          </Card>
        </div>
      )}
    </Workspace>
  );
}

type T = ReturnType<typeof useI18n>['t'];

/** Localized one-liner when we have one, else the server's description. */
function describe(t: T, tool: McpToolDoc) {
  const key = `mcp.docs.tools.${tool.name}` as Parameters<T>[0];
  const text = t(key);
  return text === key ? tool.description : text;
}

function ToolDetail({ tool }: { tool: McpToolDoc }) {
  const { t } = useI18n();
  return (
    <Card title={<span className="font-mono">{tool.name}</span>} className="xl:sticky xl:top-0">
      <p className="m-0 text-sm text-fg2">{tool.description}</p>
      <div className="flex flex-wrap gap-1.5">
        <Tag>{t('mcp.docs.scopeLabel', { scope: t(`mcp.scopes.${tool.scope}`) })}</Tag>
        <Tag>
          {t('mcp.docs.approvalLabel', {
            value: t(`mcp.docs.approval.${tool.approval ?? 'none'}`),
          })}
        </Tag>
        {tool.readOnly ? <Tag>{t('mcp.docs.hints.readOnly')}</Tag> : null}
        <Tag tone={tool.destructive ? 'prod' : undefined}>
          {tool.destructive ? t('mcp.docs.hints.destructive') : t('mcp.docs.hints.notDestructive')}
        </Tag>
        {tool.idempotent ? <Tag>{t('mcp.docs.hints.idempotent')}</Tag> : null}
      </div>
      {!tool.available ? (
        <span className="text-xs text-warning">{t('mcp.docs.unavailable')}</span>
      ) : null}
      <span className="eyebrow">{t('mcp.docs.schema')}</span>
      <pre className="m-0 max-h-80 overflow-auto rounded-lg bg-bg2 p-3 font-mono text-xs leading-5">
        {JSON.stringify(tool.inputSchema, null, 2)}
      </pre>
      {tool.example ? (
        <>
          <span className="eyebrow">{t('mcp.docs.example')}</span>
          <pre className="m-0 overflow-auto rounded-lg bg-bg2 p-3 font-mono text-xs leading-5">
            {JSON.stringify(tool.example, null, 2)}
          </pre>
        </>
      ) : null}
    </Card>
  );
}
