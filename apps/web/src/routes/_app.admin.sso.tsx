import { createFileRoute } from '@tanstack/react-router';
import { SsoAppsPage } from '@/components/identity/SsoAppsPage';

/** Yönetim › SSO uygulamaları (design 9.12, 9.13). */
export const Route = createFileRoute('/_app/admin/sso')({
  component: SsoAppsPage,
});
