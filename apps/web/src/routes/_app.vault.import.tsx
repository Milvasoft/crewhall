import { createFileRoute } from '@tanstack/react-router';
import { ImportWizard } from '@/components/vault/ImportWizard';

/** Bitwarden / Vaultwarden import (design 8.12-8.14). */
export const Route = createFileRoute('/_app/vault/import')({
  component: ImportWizard,
});
