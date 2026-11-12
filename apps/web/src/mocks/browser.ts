import { setupWorker } from 'msw/browser';
import { resetDb, type Scenario } from './db';
import { handlers } from './handlers';

/**
 * Starts the in-browser mock. `?mock=setup` starts an empty install (setup wizard),
 * `?mock=reset` restores the Milvasoft sample org. The query flag is removed afterwards.
 */
export async function startMocks(): Promise<void> {
  const url = new URL(window.location.href);
  const flag = url.searchParams.get('mock');
  if (flag === 'setup' || flag === 'reset') {
    resetDb(flag === 'setup' ? 'setup' : ('seed' satisfies Scenario));
    url.searchParams.delete('mock');
    window.history.replaceState(null, '', url);
  }
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true });
}
