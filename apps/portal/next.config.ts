import path from 'node:path';
import type { NextConfig } from 'next';

/** Headers on every response; pages stay cacheable (no per-request nonce). */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

// The repo root: workspace packages (@crewhall/shared, @crewhall/editor) live outside this app.
const repoRoot = path.join(process.cwd(), '..', '..');

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  transpilePackages: ['@crewhall/shared', '@crewhall/editor'],
  poweredByHeader: false,
  reactStrictMode: true,
  // no generated AGENTS.md in the app folder
  agentRules: false,
  async rewrites() {
    return {
      // Old Docusaurus static image URLs keep working: /img/x.png → Hub media /media/img/x.png.
      beforeFiles: [{ source: '/img/:path*', destination: '/media/img/:path*' }],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
