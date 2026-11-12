import { EmptyState, Spinner } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { z } from 'zod';
import { api } from '@/lib/api';
import { drawingQuery } from '@/lib/boards/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

// Excalidraw is large: it loads only when a drawing opens.
const DrawingEditor = lazy(() =>
  import('@/components/drawings/DrawingEditor').then((m) => ({ default: m.DrawingEditor })),
);

/** A drawing (design 6.10): `/d/<nodeId>`; `?new=1` right after "Yeni çizim". */
export const Route = createFileRoute('/_app/d/$drawingId')({
  validateSearch: z.object({ new: z.literal('1').optional().catch(undefined) }),
  component: function DrawingRoute() {
    const { t } = useI18n();
    const { drawingId } = Route.useParams();
    const { new: fresh } = Route.useSearch();
    const q = useQuery(drawingQuery(drawingId));
    useDocumentTitle(q.data?.name);
    // Feeds "Son açılanlar" (Drive and the drawings menu).
    useEffect(() => {
      void api.call('markNodeOpened', { params: { nodeId: drawingId } }).catch(() => undefined);
    }, [drawingId]);
    if (q.isError) {
      return (
        <EmptyState className="m-auto" icon="vector" title={t('boards.drawings.loadFailed')} />
      );
    }
    if (!q.data) {
      return (
        <div className="m-auto">
          <Spinner />
        </div>
      );
    }
    return (
      <Suspense
        fallback={
          <div className="m-auto">
            <Spinner />
          </div>
        }
      >
        <DrawingEditor key={drawingId} drawing={q.data} isNew={fresh === '1'} />
      </Suspense>
    );
  },
});
