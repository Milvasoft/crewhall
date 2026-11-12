import { createFileRoute } from '@tanstack/react-router';
import { HealthPage } from '@/components/vault/HealthPage';

/** Vault health report (design 8.15). */
export const Route = createFileRoute('/_app/vault/health')({
  component: HealthPage,
});
