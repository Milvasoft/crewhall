import { createFileRoute } from '@tanstack/react-router';
import { MailAdminPage } from '@/components/mail/MailAdminPage';

/** Yönetim › Posta sunucusu (roadmap 24). */
export const Route = createFileRoute('/_app/admin/mail')({
  component: MailAdminPage,
});
