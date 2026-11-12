/** Values derived from the build-time env. The only place that reads import.meta.env. */
const env = import.meta.env;

export const config = {
  /** Origin of the backend; empty means same origin (dev proxy or Caddy). */
  apiUrl: (env.VITE_API_URL as string | undefined) || window.location.origin,
  /** In-browser MSW mock of the contract and better-auth. */
  mock: env.VITE_API_MOCK === '1' || env.MODE === 'mock',
  dev: env.DEV,
} as const;
