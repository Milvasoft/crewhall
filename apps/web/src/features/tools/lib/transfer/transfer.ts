// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/transfer/transfer.ts. See THIRD_PARTY.md.
import type { ToolDataType } from '@/features/tools/lib/tool-sdk';

/**
 * In-memory hand-off buffer for "Send To". When a user sends output from one
 * tool to another, the payload is held here and consumed once by the
 * destination tool after navigation.
 *
 * Why in-memory (module singleton) and NOT the URL or storage:
 *  - Tool payloads may contain secrets (tokens, connection strings, JSON with
 *    PII). Putting them in the URL leaks them into history, logs and referrers.
 *  - We deliberately do not persist them; a page refresh discards the payload,
 *    which is the privacy-safe default.
 */
export interface TransferPayload {
  toolId: string;
  value: string;
  sourceType?: ToolDataType;
  sourceToolId?: string;
}

let pending: TransferPayload | null = null;

export function stageTransfer(payload: TransferPayload): void {
  pending = payload;
}

/**
 * Consume the payload for `toolId` exactly once. Returns undefined if there is
 * nothing staged for this tool.
 */
export function consumeTransfer(toolId: string): TransferPayload | undefined {
  if (pending && pending.toolId === toolId) {
    const value = pending;
    pending = null;
    return value;
  }
  return undefined;
}

export function clearTransfer(): void {
  pending = null;
}
