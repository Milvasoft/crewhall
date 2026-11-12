import type { ToolCallUndo } from '@crewhall/db';
import type { ApprovalAction, McpPolicy, McpScope, McpVia, ModuleKey } from '@crewhall/shared';
import type { z } from 'zod';
import type { Deps } from '../../../deps';
import type { MemberRow } from '../../../http/types';
import type { RequestInfo } from '../../../http/types';
import type { DriveActor } from '../../drive/access';
import type { McpPrincipal } from '../principal';

/** Tool errors the client can show as they are (design 18.13: actionable sentences). */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ApprovalRequestInput {
  action: ApprovalAction;
  /** Frozen input applied after the approval. */
  payload: Record<string, unknown>;
  title: string;
  target: string | null;
  items: { kind: string; label: string; detail: string | null; location: string | null }[];
  /** Revision of every target now; a change before applying makes the request stale. */
  targetRevs: Record<string, string>;
  clientNote: string | null;
}

/** Everything a tool may use: the person (never a separate Claude account) and the limits. */
export interface ToolContext {
  deps: Deps;
  /** The person, in the connection's org. */
  a: DriveActor;
  member: MemberRow;
  principal: McpPrincipal;
  via: McpVia;
  scopes: McpScope[];
  /** null = every space the person can reach. */
  spaceIds: string[] | null;
  policy: McpPolicy;
  req: RequestInfo;
  requestId: string;
  /** Throws when the connection is limited to other spaces. */
  assertSpace(spaceId: string): void;
  /** Reachable spaces ∩ the connection's spaces. */
  allowedSpaceIds(): Promise<string[]>;
  /** The person's personal space id (their "Benim" surface counts as part of it). */
  personalSpaceId(): Promise<string | null>;
  /** Puts the call into the approval queue; the tool returns the pending result. */
  requestApproval(input: ApprovalRequestInput): Promise<ToolOutcome>;
}

export interface ToolOutcome {
  data: Record<string, unknown>;
  /** One line for the activity list ("Yeni klasör · Space › Sözleşmeler"). */
  summary?: string;
  target?: { type: string; id: string | null; label: string | null };
  undo?: ToolCallUndo;
  /** Set by requestApproval. */
  approvalId?: string;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  /** Switchable module the tool belongs to; off in the org = the tool does not exist. */
  module?: ModuleKey;
  write: boolean;
  /** When a human approval kicks in (18.11 "Onay" column). */
  approval: 'always' | 'bulk' | 'policy' | null;
  annotations: { readOnly: boolean; destructive: boolean; idempotent: boolean };
  input: S;
  example?: Record<string, unknown>;
  run(ctx: ToolContext, input: z.output<S>): Promise<ToolOutcome>;
}

/** Keeps the input type of each tool while collecting them in one list. */
export const defineTool = <S extends z.ZodObject>(def: ToolDef<S>) => def as unknown as ToolDef;
