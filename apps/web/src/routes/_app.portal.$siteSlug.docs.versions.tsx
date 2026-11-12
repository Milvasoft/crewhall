import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { VersionsScreen } from '@/components/portal/Versions';

/** 10.4 versions, 10.5 freeze dialog (`freeze`). */
export const Route = createFileRoute('/_app/portal/$siteSlug/docs/versions')({
  validateSearch: z.object({ freeze: z.boolean().optional() }),
  component: VersionsScreen,
});
