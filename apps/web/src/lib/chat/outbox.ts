import { type ErrorCode, type MessageGif, type MessageRef } from '@crewhall/shared';
import { type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { getUpload, retryUpload, subscribeUploads } from '@/features/drive/uploads';
import { api, isApiError } from '@/lib/api';
import { newId } from '@/lib/ids';
import { noteNewMessage, putMessages } from './cache';
import { excerptOf } from './names';
import { mentionIds } from './text';
import { type QuotedMessage } from './types';

/**
 * Messages waiting to be sent (4.18). Each carries a client id, so a retry after a timeout
 * never creates a second copy; a chat's queue goes out strictly in order. Attachments upload
 * first through the Drive upload manager into the chat's attachments folder.
 */

export interface PendingAttachment {
  uploadId: string;
  name: string;
  size: number;
  mime: string;
}

export type PendingStatus = 'queued' | 'sending' | 'failed';

export interface PendingMessage {
  clientMsgId: string;
  conversationId: string;
  text: string;
  replyTo: QuotedMessage | null;
  attachments: PendingAttachment[];
  mentions: string[];
  /** Asked and confirmed: "@herkes" in a chat of 20+ people. */
  confirmMentionAll: boolean;
  /** Confirmed after a DLP warning (409 dlp_warning): send anyway. */
  dlpAck: boolean;
  /** Slash commands (roadmap 23): `/me` and `/whisper`. */
  emote?: boolean;
  whisperTo?: string;
  /** A GIF from GIPHY (the message may have no text). */
  gif?: MessageGif;
  /** Internal references (the message may have no text). */
  refs?: MessageRef[];
  status: PendingStatus;
  /** Error code when the server refused it (not for network trouble). */
  error: ErrorCode | null;
  createdAt: string;
}

const RETRY_MS = 5000;
let items: PendingMessage[] = [];
const listeners = new Set<() => void>();
let qc: QueryClient | null = null;
let meId = '';
const busy = new Set<string>();

function emit() {
  listeners.forEach((l) => l());
}

function patch(id: string, p: Partial<PendingMessage>) {
  items = items.map((x) => (x.clientMsgId === id ? { ...x, ...p } : x));
  emit();
}

export function bindOutbox(client: QueryClient, userId: string): void {
  qc = client;
  meId = userId;
}

/**
 * Sending goes over HTTP and is tried whenever a message is queued; only a failed request
 * keeps it waiting. A socket coming back is a good moment to retry everything left.
 */
export function setOutboxOnline(v: boolean): void {
  if (v) flushAll();
}

export function enqueue(
  m: Pick<PendingMessage, 'conversationId' | 'text' | 'replyTo' | 'attachments'> & {
    confirmMentionAll?: boolean;
    emote?: boolean;
    whisperTo?: string;
    gif?: MessageGif;
    refs?: MessageRef[];
  },
): PendingMessage {
  const p: PendingMessage = {
    ...m,
    confirmMentionAll: m.confirmMentionAll ?? false,
    dlpAck: false,
    clientMsgId: newId(),
    mentions: mentionIds(m.text),
    status: 'queued',
    error: null,
    createdAt: new Date().toISOString(),
  };
  items = [...items, p];
  emit();
  void flush(m.conversationId);
  return p;
}

export function discard(clientMsgId: string): void {
  items = items.filter((x) => x.clientMsgId !== clientMsgId);
  emit();
}

/** "Tekrar dene": a refused message or a stalled upload goes back in the queue. */
export function retry(
  clientMsgId: string,
  opts: { confirmMentionAll?: boolean; dlpAck?: boolean } = {},
): void {
  const p = items.find((x) => x.clientMsgId === clientMsgId);
  if (!p) return;
  if (opts.confirmMentionAll) patch(clientMsgId, { confirmMentionAll: true });
  if (opts.dlpAck) patch(clientMsgId, { dlpAck: true });
  for (const a of p.attachments) {
    const u = getUpload(a.uploadId);
    if (u && (u.status === 'error' || u.status === 'paused')) retryUpload(a.uploadId);
  }
  patch(clientMsgId, { status: 'queued', error: null });
  void flush(p.conversationId);
}

/** Node ids of finished uploads, or null while one is still going (or stalled). */
export function uploadedNodeIds(attachments: PendingAttachment[]): string[] | null {
  const ids: string[] = [];
  for (const a of attachments) {
    const u = getUpload(a.uploadId);
    if (u?.status !== 'done' || !u.result) return null;
    ids.push(u.result.id);
  }
  return ids;
}

function flushAll() {
  for (const id of new Set(items.map((x) => x.conversationId))) void flush(id);
}

type UploadsState = 'done' | 'waiting' | 'stalled';

function uploadsState(p: PendingMessage): { state: UploadsState; nodeIds: string[] } {
  const nodeIds: string[] = [];
  let state: UploadsState = 'done';
  for (const a of p.attachments) {
    const u = getUpload(a.uploadId);
    if (u?.status === 'done' && u.result) {
      nodeIds.push(u.result.id);
      continue;
    }
    if (!u || ['error', 'canceled', 'interrupted', 'paused'].includes(u.status)) {
      state = 'stalled';
    } else if (state !== 'stalled') {
      state = 'waiting';
    }
  }
  return { state, nodeIds };
}

async function flush(conversationId: string): Promise<void> {
  if (busy.has(conversationId) || !qc) return;
  busy.add(conversationId);
  try {
    for (;;) {
      const next = items.find((x) => x.conversationId === conversationId);
      if (!next || next.status === 'failed') return;
      const { state, nodeIds } = uploadsState(next);
      if (state !== 'done') return; // the upload listener calls flush again
      patch(next.clientMsgId, { status: 'sending' });
      try {
        const msg = await api.call('sendMessage', {
          params: { conversationId },
          body: {
            clientMsgId: next.clientMsgId,
            text: next.text,
            replyToId: next.replyTo?.id,
            attachmentNodeIds: nodeIds,
            confirmMentionAll: next.confirmMentionAll || undefined,
            dlpAck: next.dlpAck || undefined,
            emote: next.emote || undefined,
            whisperTo: next.whisperTo,
            gif: next.gif,
            refs: next.refs,
          },
          idempotencyKey: next.clientMsgId,
        });
        putMessages(qc, conversationId, [msg]);
        noteNewMessage(qc, msg, meId, { reading: true, excerpt: excerptOf(msg) });
        items = items.filter((x) => x.clientMsgId !== next.clientMsgId);
        emit();
      } catch (e) {
        if (isApiError(e) && e.status < 500) {
          patch(next.clientMsgId, { status: 'failed', error: e.code });
        } else {
          // Network or server trouble: keep it queued; the reconnect (or this timer) retries.
          patch(next.clientMsgId, { status: 'queued' });
          setTimeout(() => void flush(conversationId), RETRY_MS);
        }
        return;
      }
    }
  } finally {
    busy.delete(conversationId);
  }
}

subscribeUploads(() => {
  if (items.some((p) => p.status === 'queued' && p.attachments.length > 0)) flushAll();
});

const EMPTY: PendingMessage[] = [];
const perChat = new Map<string, { src: PendingMessage[]; list: PendingMessage[] }>();

export function usePending(conversationId: string): PendingMessage[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => {
      const cached = perChat.get(conversationId);
      if (cached?.src === items) return cached.list;
      const list = items.filter((x) => x.conversationId === conversationId);
      const out = list.length ? list : EMPTY;
      perChat.set(conversationId, { src: items, list: out });
      return out;
    },
    () => EMPTY,
  );
}

/** Upload progress of one pending attachment, for the "1,2 / 2,8 MB" line. */
export function attachmentProgress(a: PendingAttachment): {
  loaded: number;
  status: string;
} {
  const u = getUpload(a.uploadId);
  return { loaded: u?.loaded ?? 0, status: u?.status ?? 'error' };
}

export function resetOutbox(): void {
  items = [];
  busy.clear();
  perChat.clear();
  emit();
}
