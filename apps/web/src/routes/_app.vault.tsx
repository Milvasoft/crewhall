import { createFileRoute, Outlet } from '@tanstack/react-router';
import { VaultGate } from '@/components/vault/VaultGate';

/** Vault (design 08): every screen below sits behind setup / unlock. */
export const Route = createFileRoute('/_app/vault')({
  component: function VaultLayout() {
    return (
      <VaultGate>
        <Outlet />
      </VaultGate>
    );
  },
});
