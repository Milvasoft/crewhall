import { Button, Icon } from '@crewhall/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { PageHeader } from '@/components/admin/Settings';
import { CopyButton } from '@/components/mcp/parts';
import { Card } from '@/components/mcp/Overview';
import { Workspace } from '@/components/shell/Workspace';
import { config } from '@/config';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useTheme } from '@/lib/theme/ThemeContext';

export const Route = createFileRoute('/_app/account/mcp/api')({
  component: ApiDocsPage,
});

/**
 * REST API (roadmap 4): the OpenAPI document the server generates from the contract, examples
 * with a personal token, and the reference itself in a frame (rest-api.html).
 */
function ApiDocsPage() {
  const { t, locale } = useI18n();
  const { scheme } = useTheme();
  const base = config.apiUrl.replace(/\/$/, '');
  const lang = locale === 'en' ? 'en' : 'tr';
  const spec = `${base}/api/openapi.json?lang=${lang}`;
  const folder = t('mcp.api.exampleFolder');

  const curl = [
    `curl -H "Authorization: Bearer $CREWHALL_TOKEN" \\`,
    `  ${base}/api/v1/spaces`,
    '',
    `curl -X POST -H "Authorization: Bearer $CREWHALL_TOKEN" \\`,
    `  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \\`,
    `  -d '{"parentId":null,"name":"${folder}"}' \\`,
    `  ${base}/api/v1/spaces/<spaceId>/folders`,
  ].join('\n');

  const typescript = [
    `import { ApiError, createApiClient } from '@crewhall/api-client';`,
    '',
    'const api = createApiClient({',
    `  baseUrl: '${base}',`,
    '  getToken: () => process.env.CREWHALL_TOKEN ?? null,',
    '});',
    '',
    `const { items } = await api.call('listSpaces');`,
    'try {',
    `  await api.call('createFolder', {`,
    '    params: { spaceId: items[0]!.id },',
    `    body: { parentId: null, name: '${folder}' },`,
    '    idempotencyKey: crypto.randomUUID(),',
    '  });',
    '} catch (err) {',
    `  if (err instanceof ApiError && err.code === 'token_scope') {`,
    `    // ${t('mcp.api.scopeComment')}`,
    '  }',
    '}',
  ].join('\n');

  return (
    <Workspace crumbs={[{ label: t('account.title') }, { label: t('mcp.api.title') }]}>
      <PageHeader
        title={t('mcp.api.title')}
        subtitle={t('mcp.api.subtitle')}
        actions={
          <>
            <Button size="sm" variant="out" asChild>
              <Link to="/account/mcp">
                <Icon name="key" size={15} />
                {t('mcp.api.token')}
              </Link>
            </Button>
            <Button size="sm" variant="out" asChild>
              <a href={spec} download="crewhall-openapi.json">
                <Icon name="download" size={15} />
                {t('mcp.api.download')}
              </a>
            </Button>
          </>
        }
      />
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Card title={t('mcp.api.curl')} aside={<CopyButton value={curl} />}>
          <p className="m-0 text-cap text-fg2">{t('mcp.api.curlHint')}</p>
          <Code>{curl}</Code>
        </Card>
        <Card title={t('mcp.api.typescript')} aside={<CopyButton value={typescript} />}>
          <p className="m-0 text-cap text-fg2">{t('mcp.api.typescriptHint')}</p>
          <Code>{typescript}</Code>
        </Card>
        <Card title={t('mcp.api.rules')} className="xl:col-span-2">
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-cap text-fg2">
            <li>{t('mcp.api.ruleScope')}</li>
            <li>{t('mcp.api.ruleNever')}</li>
            <li>{t('mcp.api.ruleErrors')}</li>
            <li>{t('mcp.api.rulePaging')}</li>
          </ul>
        </Card>
      </div>
      <section aria-label={t('mcp.api.reference')} className="mt-5">
        <iframe
          // A new frame when the scheme or language changes; Scalar reads them once.
          key={`${scheme}-${lang}`}
          title={t('mcp.api.reference')}
          src={`/rest-api.html?theme=${scheme}&lang=${lang}`}
          className="block h-[calc(100dvh-160px)] min-h-[560px] w-full rounded-2xl border-0 bg-surface shadow-line"
        />
      </section>
    </Workspace>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="m-0 overflow-auto rounded-lg bg-bg2 p-3 font-mono text-xs leading-5">
      {children}
    </pre>
  );
}
