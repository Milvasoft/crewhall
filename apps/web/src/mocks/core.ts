import {
  type Actor,
  type endpoints,
  type EndpointName,
  type ErrorCode,
  type ResponseOf,
  type UserSummary,
} from '@crewhall/shared';
import { type z } from 'zod';
import { type MockState, type MockUser } from './seed';

/** Pieces shared by the contract resolvers (contract.ts, drive.ts, quick.ts). */

export class MockApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

type Def<N extends EndpointName> = (typeof endpoints)[N];
type Parsed<D, K extends 'body' | 'query'> =
  D extends Record<K, infer S extends z.ZodType> ? z.output<S> : undefined;

export interface Ctx<N extends EndpointName> {
  params: Record<string, string>;
  body: Parsed<Def<N>, 'body'>;
  query: Parsed<Def<N>, 'query'>;
  s: MockState;
  request: Request;
}

type ResolverResult<N extends EndpointName> = ResponseOf<N> | z.input<Def<N>['response']>;
export type Resolver<N extends EndpointName> = (
  ctx: Ctx<N>,
) => ResolverResult<N> | Promise<ResolverResult<N>>;

export type Resolvers<K extends EndpointName> = { [N in K]: Resolver<N> };

export function currentUser(s: MockState): MockUser | null {
  const session = s.sessions.find((x) => x.id === s.auth.sessionId);
  return session ? (s.users.find((u) => u.id === session.userId) ?? null) : null;
}

export function requireUser(s: MockState): MockUser {
  const u = currentUser(s);
  if (!u) throw new MockApiError('unauthenticated', 'No session');
  return u;
}

export function summary(u: MockUser): UserSummary {
  return { id: u.id, name: u.name, email: u.email, imageUrl: u.imageUrl };
}

export function memberOf(s: MockState, userId: string) {
  return s.members.find((m) => m.userId === userId) ?? null;
}

export function actorOf(s: MockState, u: MockUser): Actor {
  const m = memberOf(s, u.id);
  return { userId: u.id, orgRole: m?.role ?? 'guest', orgPermissions: m?.permissions ?? [] };
}

export function orgCtx(s: MockState) {
  const settings = s.org?.settings ?? { membersCanCreateSpaces: false, publicLinksEnabled: true };
  return { settings };
}

export function myRole(s: MockState, spaceId: string, userId: string) {
  return s.spaceMembers.find((x) => x.spaceId === spaceId && x.userId === userId)?.role ?? null;
}

export function randomToken(bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Offset cursors: enough for the mock, opaque to clients. */
export function paginate<T>(
  all: T[],
  cursor: string | undefined,
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const start = cursor ? Number(cursor) || 0 : 0;
  const items = all.slice(start, start + limit);
  return { items, nextCursor: start + limit < all.length ? String(start + limit) : null };
}
