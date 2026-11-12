import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '@/components/vault/SettingsPage';

/** Vault settings (design 8.16). */
export const Route = createFileRoute('/_app/vault/settings')({
  component: SettingsPage,
});
