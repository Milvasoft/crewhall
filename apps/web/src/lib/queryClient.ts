import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { isApiError } from '@/lib/api';
import { markSessionExpired } from '@/lib/sessionEvents';

let signedIn = false;

/** The shell marks the session as live once `me` loaded; 401s after that mean it expired. */
export function setSignedIn(v: boolean): void {
  signedIn = v;
}

function onError(error: unknown) {
  if (signedIn && isApiError(error, 'unauthenticated')) markSessionExpired();
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        retry: (count, error) => {
          if (isApiError(error) && error.status < 500) return false;
          return count < 2;
        },
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
