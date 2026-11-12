import { Spinner } from '@crewhall/ui';

/** Shown while route guards load (bootstrap, session) for longer than the pending delay. */
export function PendingPage() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-bg">
      <Spinner />
    </div>
  );
}
