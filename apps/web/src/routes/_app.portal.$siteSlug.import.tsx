import { createFileRoute } from '@tanstack/react-router';
import { ImportReport } from '@/components/portal/ImportReport';

/** 10.16 import report (read only; imports run from the CLI). */
export const Route = createFileRoute('/_app/portal/$siteSlug/import')({
  component: ImportReport,
});
