import { createFileRoute } from '@tanstack/react-router';
import { ChatReportsPage } from '@/components/chat/ChatReportsPage';

/** Yönetim › Bildirilen içerik: chat reports for owners and admins (API 54). */
export const Route = createFileRoute('/_app/admin/reports')({
  component: ChatReportsPage,
});
