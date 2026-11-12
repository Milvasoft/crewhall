import { def, type EndpointDef } from '../endpoint-def';
import { ServerCompat } from '../schemas/branding';

/** Version compatibility (compat.ts): public, and never refused as client_outdated. */
export const compatEndpoints = {
  /** Server version, apiLevel, accepted app versions, store links and deprecations. */
  getCompat: def({
    method: 'GET',
    path: '/api/v1/meta/compat',
    auth: 'public',
    response: ServerCompat,
  }),
} as const satisfies Record<string, EndpointDef>;
