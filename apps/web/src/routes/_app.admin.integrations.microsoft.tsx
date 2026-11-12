import { createFileRoute } from '@tanstack/react-router';
import { MicrosoftPage } from '@/components/microsoft/MicrosoftPage';

/** Yönetim › Entegrasyonlar › Microsoft 365 (sonraki-isler.md "Microsoft entegrasyonları"). */
export const Route = createFileRoute('/_app/admin/integrations/microsoft')({
  component: MicrosoftPage,
});
