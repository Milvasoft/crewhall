import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { MediaLibrary } from '@/components/portal/MediaLibrary';

/** 10.14 media library (`sel` = selected file). */
export const Route = createFileRoute('/_app/portal/$siteSlug/media')({
  validateSearch: z.object({
    sel: z.string().optional(),
    filter: z.enum(['all', 'image', 'document', 'unused']).optional(),
  }),
  component: MediaLibrary,
});
