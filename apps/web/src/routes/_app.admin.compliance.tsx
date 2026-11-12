import { createFileRoute } from '@tanstack/react-router';
import { CompliancePage } from '@/components/identity/CompliancePage';

/** Yönetim › Uyumluluk (roadmap 25). */
export const Route = createFileRoute('/_app/admin/compliance')({
  component: CompliancePage,
});
