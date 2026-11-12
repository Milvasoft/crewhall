import type { organizations, orgMembers } from '@crewhall/db';
import type { Actor, EndpointName, Endpoints, PathParams } from '@crewhall/shared';
import type { Context } from 'hono';
import type { z } from 'zod';
import type { Auth } from '../auth/auth';
import type { Deps } from '../deps';

type SessionResult = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
export type AuthUser = SessionResult['user'];
export type AuthSession = SessionResult['session'];

export interface AppEnv {
  Variables: {
    requestId: string;
  };
}

export type BodyOut<N extends EndpointName> = Endpoints[N] extends {
  body: infer B extends z.ZodType;
}
  ? z.output<B>
  : undefined;

export type QueryOut<N extends EndpointName> = Endpoints[N] extends {
  query: infer Q extends z.ZodType;
}
  ? z.output<Q>
  : undefined;

/** Request facts the audit log records. */
export interface RequestInfo {
  ip: string | null;
  userAgent: string | null;
  /** Accept-Language, for localized error messages. */
  locale: string | null;
}

export interface PublicCtx<N extends EndpointName> {
  deps: Deps;
  c: Context<AppEnv>;
  req: RequestInfo;
  params: PathParams<N>;
  body: BodyOut<N>;
  query: QueryOut<N>;
}

export interface UserCtx<N extends EndpointName> extends PublicCtx<N> {
  user: AuthUser;
  session: AuthSession;
}

export type OrgRow = typeof organizations.$inferSelect;
export type MemberRow = typeof orgMembers.$inferSelect;

export interface OrgCtx<N extends EndpointName> extends UserCtx<N> {
  org: OrgRow;
  member: MemberRow;
  actor: Actor;
}
