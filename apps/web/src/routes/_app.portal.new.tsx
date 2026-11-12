import { createFileRoute } from '@tanstack/react-router';
import { CreateSitePage } from '@/components/portal/CreateSite';

/** "Yeni site" from the site picker (site managers). */
export const Route = createFileRoute('/_app/portal/new')({
  component: CreateSitePage,
});
