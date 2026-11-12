import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type HttpProxy } from 'vite';
import { buildInfoPlugin } from './buildInfoPlugin';

/**
 * Dev only: cookies are per host, not per port, so several local checkouts on `localhost`
 * overwrite each other's session. Serve one on `<name>.localhost` and set VITE_PROXY_ORIGIN to
 * the origin the API trusts; the proxy then presents that origin.
 */
function presentOrigin(origin: string | undefined) {
  if (!origin) return undefined;
  return (proxy: HttpProxy.ProxyServer) => {
    proxy.on('proxyReq', (req) => req.setHeader('origin', origin));
    proxy.on('proxyReqWs', (req) => req.setHeader('origin', origin));
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // VITE_DEV_HTTPS=1: a self-signed https dev server, so camera and microphone work when the app
  // is opened by LAN address from another device (browsers allow them only on https or localhost).
  const https = env.VITE_DEV_HTTPS === '1' || env.VITE_DEV_HTTPS === 'true';
  return {
    plugins: [
      tanstackRouter({
        target: 'react',
        routesDirectory: './src/routes',
        generatedRouteTree: './src/routeTree.gen.ts',
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
      buildInfoPlugin(),
      ...(https ? [basicSsl()] : []),
    ],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
      rolldownOptions: {
        // The API reference is its own page (Scalar's global CSS stays out of the app).
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          restApi: fileURLToPath(new URL('./rest-api.html', import.meta.url)),
        },
        output: {
          codeSplitting: {
            groups: [
              // @noble's hash classes extend a shared base (HashMD). Left to automatic splitting,
              // SHA-1 (TOTP) landed in the vault strength chunk and the base in another chunk that
              // imports it back; in that import cycle the base was still undefined when SHA-1 ran
              // ("Class extends value undefined"), a white screen in production. One chunk for all
              // of @noble keeps base and subclasses together, and it imports nothing of ours.
              { name: 'noble', test: /[\\/]node_modules[\\/]@noble[\\/]/ },
            ],
          },
        },
      },
    },
    server: {
      // 5173 by default; PORT lets a second checkout or the preview runner pick another one.
      port: Number(process.env.PORT) || 5173,
      strictPort: true,
      proxy: env.VITE_API_URL
        ? undefined
        : {
            '/api': {
              target: env.VITE_API_PROXY || 'http://localhost:3000',
              changeOrigin: false,
              configure: presentOrigin(env.VITE_PROXY_ORIGIN),
            },
            // Chat gateway (doc 17 §6); the ticket travels in the query string.
            '/ws': {
              target: env.VITE_API_PROXY || 'http://localhost:3000',
              changeOrigin: false,
              ws: true,
              configure: presentOrigin(env.VITE_PROXY_ORIGIN),
            },
            // Page collaboration (Hocuspocus). Like Caddy's `handle_path /collab*`: the prefix is
            // dropped, so phones and the LAN reach collab through the web port alone
            // (backend: COLLAB_PUBLIC_URL=ws://<host>:<web port>/collab).
            '/collab': {
              target: env.VITE_COLLAB_PROXY || 'http://localhost:3001',
              changeOrigin: false,
              ws: true,
              rewrite: (path) => path.replace(/^\/collab/, '') || '/',
              configure: presentOrigin(env.VITE_PROXY_ORIGIN),
            },
            // LiveKit signalling through the dev server: an https page may not open ws:// to
            // LiveKit (mixed content), so it uses wss://<this host>/livekit (RoomView).
            '/livekit': {
              target: env.VITE_LIVEKIT_PROXY || 'http://localhost:7880',
              changeOrigin: true,
              ws: true,
              rewrite: (path) => path.replace(/^\/livekit/, '') || '/',
            },
            // MCP server and its OAuth 2.1 endpoints, as Caddy routes them in production.
            ...Object.fromEntries(
              [
                '/mcp',
                '/.well-known',
                '/oauth/authorize',
                '/oauth/register',
                '/oauth/token',
                '/oauth/revoke',
                '/caldav',
                '/carddav',
              ].map((p) => [
                p,
                {
                  target: env.VITE_API_PROXY || 'http://localhost:3000',
                  changeOrigin: false,
                  configure: presentOrigin(env.VITE_PROXY_ORIGIN),
                },
              ]),
            ),
            // WebDAV (Finder, Windows Explorer, rclone). A pattern, not a prefix: "/dav" would
            // also catch the invitation page "/davet/…".
            '^/dav(/.*)?$': {
              target: env.VITE_API_PROXY || 'http://localhost:3000',
              changeOrigin: false,
              configure: presentOrigin(env.VITE_PROXY_ORIGIN),
            },
            // WOPI host (office module): the document server reads and saves files here.
            '/wopi': {
              target: env.VITE_API_PROXY || 'http://localhost:3000',
              changeOrigin: false,
            },
          },
    },
    preview: { port: 4173 },
  };
});
