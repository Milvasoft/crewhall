import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '@crewhall/db';
import { CommandResponse, type CommandRequest } from '@crewhall/plugin-sdk/server';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit, auditVia } from '../audit';
import { requireMember, requirePermission, type ChatActor } from '../chat/access';
import { sendMessage } from '../chat/messages';
import { callPlugin, loadInstallation, pluginName } from './installations';
import { issueSessionToken } from './tokens';

/**
 * `/command args` in a chat (docs/contracts/eklentiler.md › Komutlar): a signed request to the
 * plugin server with the person's session token. The answer is a note only the caller sees
 * and/or a message posted for them, marked "<plugin> ile".
 */
export async function runPluginCommand(
  deps: Deps,
  a: ChatActor,
  conversationId: string,
  input: { installationId: string; command: string; args: string },
  req: RequestInfo,
): Promise<{ reply: string | null; messageId: string | null }> {
  if (a.actor.orgRole === 'guest') throw new AppError('forbidden', { reason: 'guest' });
  const m = await requireMember(deps.db, a, conversationId);
  requirePermission(a, m, 'write');
  const row = await loadInstallation(deps.db, a.org.id, input.installationId);
  if (!row.enabled) throw new AppError('plugin_disabled');
  const command = row.manifest.entryPoints.commands.find((c) => c.name === input.command);
  if (!command) throw new AppError('plugin_not_found', { command: input.command });
  const [user] = await deps.db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, a.userId));
  const { token } = await issueSessionToken(deps.db, deps.env, {
    orgId: a.org.id,
    installationId: row.id,
    pluginId: row.pluginId,
    user: user!,
    scopes: row.permissions,
  });
  const locale = a.org.branding.defaultLocale === 'en' ? 'en' : 'tr';
  const request: CommandRequest = {
    installationId: row.id,
    command: command.name,
    args: input.args,
    conversationId,
    user: { id: user!.id, name: user!.name },
    token,
    locale,
  };
  const answer = CommandResponse.safeParse(await callPlugin(deps.env, row, command.url, request));
  if (!answer.success) throw new AppError('plugin_unreachable', { reason: 'shape' });

  let messageId: string | null = null;
  const client = pluginName(row.manifest, locale);
  if (answer.data.post) {
    const via = { kind: 'plugin', client, plugin: row.pluginId, installation: row.id };
    const msg = await auditVia.run(via, () =>
      sendMessage(deps, a, conversationId, {
        clientMsgId: randomUUID(),
        text: answer.data.post!,
        attachmentNodeIds: [],
      }),
    );
    messageId = msg.id;
  }
  await audit(
    deps.db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'plugin.command',
      targetType: 'conversation',
      targetId: conversationId,
      meta: { pluginId: row.pluginId, command: command.name, posted: messageId !== null },
    },
    req,
  );
  return { reply: answer.data.reply ?? null, messageId };
}
