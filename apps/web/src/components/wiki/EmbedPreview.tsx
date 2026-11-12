import type { EmbedAttrs } from '@crewhall/editor';
import { pagePath } from '@crewhall/shared';
import { Icon, type IconName } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { nodeLocation } from '@/features/drive/paths';
import { rawPreviewUrl } from '@/features/drive/urls';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';

const TYPE_ICON: Record<string, IconName> = {
  file: 'file',
  folder: 'folder',
  page: 'page',
  board: 'board',
  drawing: 'vector',
};

/** Card for an embedded Hub node (design 5.5): name, type, place, open link; access-aware. */
export function EmbedPreview({ attrs }: { attrs: EmbedAttrs }) {
  const { t } = useI18n();
  const { nodeId } = attrs;
  const q = useQuery({
    queryKey: ['wiki', 'embed', nodeId],
    queryFn: ({ signal }) => api.call('getNode', { params: { nodeId }, signal }),
    enabled: Boolean(nodeId),
    retry: false,
    staleTime: 30_000,
  });
  const n = q.data;
  const { items: spaces } = useSpaces();
  let body;
  if (q.isPending) body = <span className="wk-muted">{t('wiki.editor.embedLoading')}</span>;
  else if (q.isError) {
    body = (
      <span className="wk-muted">
        <Icon name="lock" size={14} />{' '}
        {isApiError(q.error, 'not_found') ? t('wiki.editor.embedNoAccess') : t('errors.internal')}
      </span>
    );
  } else if (!n) {
    body = null;
  } else if (n.deletedAt) {
    body = (
      <span className="wk-muted">
        <Icon name="trash" size={14} /> {t('wiki.editor.embedDeleted')}
      </span>
    );
  } else {
    const slug = spaces.find((x) => x.id === n.spaceId)?.slug ?? '';
    const image = n.type === 'file' && n.preview === 'ready';
    body = (
      <>
        {image ? (
          <img
            src={rawPreviewUrl(n.id, 'thumb_256', n.version ?? undefined)}
            alt=""
            className="wk-embed-thumb"
          />
        ) : (
          <span className="wk-embed-icon">
            <Icon name={TYPE_ICON[n.type] ?? 'file'} size={18} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="wk-embed-name">{n.name}</span>
          <span className="wk-embed-meta">
            {t(`wiki.editor.embedType.${n.type}`)} · {n.space.name}
            {n.path.length ? ` › ${n.path.map((x) => x.name).join(' › ')}` : ''}
          </span>
        </span>
        {n.type === 'page' ? (
          <Link
            to="/p/$pageRef"
            params={{ pageRef: pagePath(n).slice(3) }}
            className="wk-embed-open"
          >
            {t('wiki.editor.embedOpen')}
          </Link>
        ) : slug ? (
          <Link {...nodeLocation(n, slug)} className="wk-embed-open">
            {t('wiki.editor.embedOpen')}
          </Link>
        ) : null}
      </>
    );
  }
  return <div className="wk-embed-card">{body}</div>;
}
