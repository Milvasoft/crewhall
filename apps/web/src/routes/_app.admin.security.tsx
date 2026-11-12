import { createFileRoute } from '@tanstack/react-router';
import { SecurityPolicyPage } from '@/components/identity/SecurityPolicyPage';

/** Yönetim › Güvenlik (design 9.11). */
export const Route = createFileRoute('/_app/admin/security')({
  component: SecurityPolicyPage,
});
