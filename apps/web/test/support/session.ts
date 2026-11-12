import { db } from '@/mocks/db';

/** Puts a signed-in session for `userId` into the mock db (skips the sign-in screens). */
export function signedInAs(userId: string): void {
  const s = db();
  s.sessions.push({
    id: 'test-session',
    userId,
    userAgent: 'test',
    ip: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });
  s.auth.sessionId = 'test-session';
}
