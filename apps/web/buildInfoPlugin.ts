import { execFileSync } from 'node:child_process';
import type { Plugin } from 'vite';

/**
 * Which build this is: the page reads it from a meta tag (src/lib/buildInfo.ts). A tag in
 * index.html rather than a value in the bundle, so a new build number does not change the hash
 * of every chunk and browsers keep what they cached.
 */

export interface BuildValues {
  /** CI's build number: rises with every build, nobody bumps it by hand. Null outside CI. */
  id: string | null;
  commit: string | null;
  builtAt: string;
}

function gitCommit(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return out.trim() || null;
  } catch {
    // No git in the image (docker/web/Dockerfile) or not a checkout.
    return null;
  }
}

/** BUILD_ID and BUILD_COMMIT come from CI (pipeline/azure-pipeline-ci-test-web.yml). */
export function buildValues(
  env: Record<string, string | undefined> = process.env,
  commitOf: () => string | null = gitCommit,
  now: Date = new Date(),
): BuildValues {
  return {
    id: env.BUILD_ID?.trim() || null,
    commit: env.BUILD_COMMIT?.trim() || commitOf(),
    builtAt: now.toISOString(),
  };
}

export function buildInfoPlugin(values: BuildValues = buildValues()): Plugin {
  return {
    name: 'crewhall-build-info',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: {
          name: 'crewhall-build',
          content: values.id ?? '',
          'data-commit': values.commit ?? '',
          'data-built-at': values.builtAt,
        },
        injectTo: 'head',
      },
    ],
  };
}
