import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { pluginInstallations, type DbOrTx } from '@crewhall/db';
import type { PluginEventType } from '@crewhall/plugin-sdk';
import type { EventRequest } from '@crewhall/plugin-sdk/server';
import type { JobDeps } from '../../jobs/handlers';
import type { Jobs } from '../../jobs/queue';
import { AppError } from '../../http/errors';
import { activeInstallations, callPlugin } from './installations';

/**
 * Event subscriptions (docs/contracts/eklentiler.md › Olaylar): a signed POST per subscribed
 * installation, queued (`plugin.deliver`, retried with backoff). Payloads carry ids and
 * metadata only; a plugin reads content through the API with a person's session token.
 */

export async function emitPluginEvent(
  deps: { db: DbOrTx; jobs: Jobs },
  orgId: string,
  type: PluginEventType,
  data: Record<string, unknown>,
) {
  const rows = await activeInstallations(deps.db, orgId);
  for (const row of rows) {
    if (!row.permissions.includes('hub:read')) continue;
    for (const sub of row.manifest.entryPoints.events.filter((e) => e.type === type)) {
      const body: EventRequest = {
        id: randomUUID(),
        type,
        installationId: row.id,
        occurredAt: new Date().toISOString(),
        data,
      };
      await deps.jobs.send('plugin.deliver', { installationId: row.id, path: sub.url, body });
    }
  }
}

/** plugin.deliver: one event to one installation; an unreachable plugin is retried. */
export async function deliverPluginEvent(
  deps: JobDeps,
  data: { installationId: string; path: string; body: Record<string, unknown> },
) {
  const [row] = await deps.db
    .select()
    .from(pluginInstallations)
    .where(eq(pluginInstallations.id, data.installationId));
  if (!row || !row.enabled) return;
  try {
    await callPlugin(deps.env, row, data.path, data.body);
  } catch (err) {
    if (err instanceof AppError && err.code === 'plugin_unreachable') throw err;
    deps.logger.warn({ err, plugin: row.pluginId }, 'plugin event dropped');
  }
}
