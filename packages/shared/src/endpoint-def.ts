import { z } from 'zod';
import type { Deprecation } from './compat';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type Auth = 'public' | 'session';

export interface EndpointDef {
  method: Method;
  path: `/api/v1/${string}`;
  auth: Auth;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  /** On its way out: answered with Deprecation and Sunset headers, listed by getCompat. */
  deprecated?: Deprecation;
}

export const def = <const T extends EndpointDef>(d: T) => d;
export const items = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });
export const Empty = z.object({});
