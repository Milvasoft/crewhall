import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MacConfig = { identity?: string | null; hardenedRuntime?: boolean };

/** Loads the builder config fresh, so it reads the environment of the test. */
function macConfig(): MacConfig {
  const require = createRequire(import.meta.url);
  const path = require.resolve('../electron-builder.config.cjs');
  delete require.cache[path];
  return (require(path) as { mac: MacConfig }).mac;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('macOS signing', () => {
  it('without a Developer ID the app is signed ad-hoc, so macOS remembers camera and microphone', () => {
    vi.stubEnv('CSC_LINK', '');
    vi.stubEnv('CSC_NAME', '');
    const mac = macConfig();
    expect(mac.identity).toBe('-');
    expect(mac.hardenedRuntime).toBe(false);
  });

  it('with a Developer ID electron-builder picks the identity and hardens the runtime', () => {
    vi.stubEnv('CSC_LINK', 'certificate.p12');
    const mac = macConfig();
    expect(mac.identity).toBeUndefined();
    expect(mac.hardenedRuntime).toBe(true);
  });
});
