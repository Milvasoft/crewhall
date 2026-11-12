import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { PublishHistory } from '@/components/portal/PublishHistory';

/** 10.12 publish history (`sel` = open publish). */
export const Route = createFileRoute('/_app/portal/$siteSlug/publishes')({
  validateSearch: z.object({ sel: z.string().optional() }),
  component: PublishHistory,
});
