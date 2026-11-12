import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbOrTx } from '@crewhall/db';
import type { Logger } from '../../logger';
import type { MailContext } from './accounts';
import { stopAllLive, touchLive } from './live';

const lockFolder = vi.hoisted(() => vi.fn());

vi.mock('imapflow', () => ({
  ImapFlow: class {
    usable = true;
    on() {
      return this;
    }
    async connect() {}
    close() {
      this.usable = false;
    }
  },
}));
vi.mock('./folders', async (original) => ({
  ...(await original<typeof import('./folders')>()),
  lockFolder,
}));
vi.mock('./sync', async (original) => ({
  ...(await original<typeof import('./sync')>()),
  syncFolder: async () => ({ changed: false, complete: true }),
}));

const context = {
  account: { id: 'account-1', orgId: 'org-1', userId: 'user-1' },
  settings: { imapHost: 'imap.test', imapPort: 143, imapSecurity: 'none' },
  auth: async () => ({ user: 'a@test', pass: 'secret' }),
} as unknown as MailContext;

describe('mail background watcher', () => {
  const onUnhandled = vi.fn();

  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled);
    await stopAllLive();
  });

  it('logs a connection lost while it goes back to INBOX after a drain', async () => {
    const lost = new Error('connection lost');
    // The first selection comes with the connection, the second one ends the drain.
    lockFolder.mockResolvedValueOnce({ release: () => {} }).mockRejectedValueOnce(lost);
    process.on('unhandledRejection', onUnhandled);
    const debug = vi.fn();

    touchLive({ db: {} as DbOrTx, logger: { debug } as unknown as Logger }, context, {
      sync: 'INBOX',
    });
    await vi.waitFor(() => expect(lockFolder).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    // Long enough for a rejection nobody listens to to be reported.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onUnhandled).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith({ err: lost }, 'mail background drain failed');
  });
});
