import { createFileRoute } from '@tanstack/react-router';
import { Overview } from '@/components/portal/Overview';

/** 10.1 Overview. */
export const Route = createFileRoute('/_app/portal/$siteSlug/')({
  component: Overview,
});
