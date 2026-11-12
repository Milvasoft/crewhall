import { and, eq } from 'drizzle-orm';
import { messages, newId } from '@crewhall/db';
import type { Deps } from '../../deps';
import { auditVia } from '../audit';
import { sendMessage } from '../chat/messages';
import type { DriveActor } from '../drive/access';

/**
 * The send itself, shared by the tool and the approval queue. Inside `auditVia` chat writes
 * `body.via`, so the message reaches every client (WS too) already marked "Claude ile".
 */
export async function deliverMessage(
  deps: Deps,
  a: DriveActor,
  input: { conversation_id: string; text: string; reply_to_id?: string | undefined },
  via: Record<string, unknown>,
) {
  const msg = await auditVia.run(via, () =>
    sendMessage(deps, a, input.conversation_id, {
      clientMsgId: newId(),
      text: input.text,
      replyToId: input.reply_to_id,
      attachmentNodeIds: [],
    }),
  );
  const [row] = await deps.db
    .select({ updatedAt: messages.updatedAt })
    .from(messages)
    .where(and(eq(messages.id, msg.id), eq(messages.orgId, a.org.id)));
  return { msg, rev: (row?.updatedAt ?? new Date()).toISOString() };
}
