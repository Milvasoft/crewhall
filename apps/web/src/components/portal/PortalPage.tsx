import { Button, Count, Icon, toast } from '@crewhall/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { type Crumb, Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { changesQuery } from '@/lib/portal/api';
import { setPublishOpen, usePortalSite } from '@/lib/portal/context';
import { PortalSidebar } from './PortalSidebar';
import { PublishDialog } from './PublishDialog';

/**
 * Frame of every portal screen: portal sidebar, crumb, "Portalda ara", "Önizle" (the open
 * doc, post or home page) and "Yayınla N", which opens the publish dialog for the whole queue.
 */
export function PortalPage({
  crumbs,
  previewPath,
  children,
  panel,
  bodyClassName,
}: {
  crumbs: Crumb[];
  /** Site path that "Önizle" opens; omitted = the button is disabled. */
  previewPath?: string | null;
  children: ReactNode;
  panel?: ReactNode;
  bodyClassName?: string;
}) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const changes = useQuery(changesQuery(site.id));
  const pending = changes.data?.items.length ?? site.pendingCount;
  const preview = useMutation({
    mutationFn: (path: string) =>
      api.call('createPortalPreview', { params: { siteId: site.id }, body: { path } }),
    onSuccess: (link) => window.open(link.url, '_blank', 'noopener'),
    onError: (e) => toast(t(errorKey(e))),
  });

  return (
    <>
      <Workspace
        sidebar={<PortalSidebar />}
        crumbs={[{ label: t('shell.modules.portal') }, ...crumbs]}
        searchLabel={t('portal.top.search')}
        bodyClassName={bodyClassName}
        panel={panel}
        tools={
          <>
            <Button
              variant="gh"
              size="sm"
              disabled={!previewPath}
              loading={preview.isPending}
              title={previewPath ? undefined : t('portal.top.previewNone')}
              onClick={() => previewPath && preview.mutate(previewPath)}
            >
              <Icon name="eye" size={16} />
              {t('portal.top.preview')}
            </Button>
            {site.capabilities.publish ? (
              pending > 0 ? (
                <Button variant="pri" size="sm" onClick={() => setPublishOpen(true)}>
                  <Icon name="upload" size={16} />
                  {t('portal.top.publish')}
                  <Count className="bg-accent-fg text-accent">{pending}</Count>
                </Button>
              ) : (
                <Button variant="out" size="sm" onClick={() => setPublishOpen(true)}>
                  <Icon name="check" size={16} />
                  {t('portal.top.published')}
                </Button>
              )
            ) : null}
          </>
        }
      >
        {children}
      </Workspace>
      {site.capabilities.publish ? <PublishDialog /> : null}
    </>
  );
}
