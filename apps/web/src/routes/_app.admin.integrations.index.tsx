import { createFileRoute } from '@tanstack/react-router';
import { IntegrationsPage } from '@/components/identity/IntegrationsPage';

/** Yönetim › Entegrasyonlar (design 9.14): identity providers. */
export const Route = createFileRoute('/_app/admin/integrations/')({
  component: IntegrationsPage,
});
