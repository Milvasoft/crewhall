import { and, eq } from 'drizzle-orm';
import { approvalRequests } from '@crewhall/db';
import { z } from 'zod';
import * as chat from './chat';
import * as drive from './drive';
import * as pages from './pages';
import * as personal from './personal';
import * as portal from './portal';
import * as quick from './quick';
import * as read from './read';
import * as tables from './tables';
import { defineTool, ToolError, type ToolDef } from './types';

const getApproval = defineTool({
  name: 'get_approval',
  title: 'Get approval status',
  description:
    'Status of a request in the approval queue (pending, approved, rejected, expired, stale, applied, failed).',
  scope: 'hub:read',
  write: false,
  approval: null,
  annotations: { readOnly: true, destructive: false, idempotent: true },
  input: z.object({ approval_id: z.uuid() }),
  async run(ctx, input) {
    const [row] = await ctx.deps.db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.id, input.approval_id), eq(approvalRequests.userId, ctx.a.userId)),
      );
    if (!row) throw new ToolError('not_found', 'Onay isteği bulunamadı.');
    return {
      data: {
        approval_id: row.id,
        status: row.status,
        decided_at: row.decidedAt?.toISOString() ?? null,
        error_code: row.errorCode,
        result: row.result,
      },
    };
  },
});

/**
 * Every tool, in catalog order (design 18.11). Modules add theirs here when they land:
 * pages, boards, meetings. Tools with a `module` disappear while the org has that module off.
 * tools/list shows only the tools whose scope the connection has.
 */
export const TOOLS: ToolDef[] = [
  read.search,
  read.listSpaces,
  read.getNode,
  read.listChildren,
  quick.listLinks,
  quick.addLink,
  quick.addQuickCard,
  drive.uploadFile,
  drive.completeUpload,
  drive.createFolder,
  drive.trashNodes,
  chat.listConversations,
  chat.sendMessageTool,
  chat.readMessages,
  chat.listNotifications,
  pages.createPage,
  pages.appendToPage,
  personal.createCalendarEvent,
  personal.listUnreadMail,
  portal.listPortalDocs,
  portal.upsertPortalDoc,
  portal.createBlogPost,
  portal.requestPortalPublish,
  tables.listTablesTool,
  tables.queryTableRowsTool,
  tables.addTableRows,
  tables.updateTableRowTool,
  getApproval,
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const RESOURCES = [read.pageResource];
