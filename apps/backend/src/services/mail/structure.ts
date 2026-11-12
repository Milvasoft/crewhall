import type { MailPartInfo } from '@crewhall/db';
import type { MailAttachment } from '@crewhall/shared';
import type { MessageStructureObject } from 'imapflow';

/**
 * BODYSTRUCTURE in a form small enough to cache: the leaf parts with their IMAP part numbers.
 * Opening a message downloads only its text parts and small inline images (BODY.PEEK[part]);
 * attachments are listed from here and fetched one by one when asked.
 */

/** Inline images larger than this stay as attachments rather than data URIs. */
export const INLINE_IMAGE_MAX = 3 * 1024 * 1024;

const cid = (id: string | undefined | null) =>
  id ? id.replace(/^<|>$/g, '').trim().toLowerCase() || null : null;

/** Decoded size: base64 grows by a third on the wire. */
function decodedSize(node: MessageStructureObject) {
  const size = node.size ?? 0;
  return node.encoding?.toLowerCase() === 'base64' ? Math.floor((size * 3) / 4) : size;
}

export function partsOf(root: MessageStructureObject | undefined): MailPartInfo[] {
  if (!root) return [];
  const out: MailPartInfo[] = [];
  const walk = (node: MessageStructureObject, fallback: string) => {
    const type = (node.type || 'application/octet-stream').toLowerCase();
    // An attached message is one file, not a tree to open.
    if (node.childNodes?.length && type !== 'message/rfc822') {
      node.childNodes.forEach((child, i) => walk(child, child.part ?? `${fallback}.${i + 1}`));
      return;
    }
    const filename =
      node.dispositionParameters?.filename ??
      node.parameters?.name ??
      (type === 'message/rfc822' ? 'message.eml' : null);
    out.push({
      part: node.part ?? fallback,
      type,
      disposition: node.disposition?.toLowerCase() ?? null,
      filename,
      size: decodedSize(node),
      contentId: cid(node.id),
      encoding: node.encoding?.toLowerCase() ?? null,
      charset: node.parameters?.charset?.toLowerCase() ?? null,
    });
  };
  walk(root, '1');
  return out;
}

/** Shown in the body through `cid:` instead of listed as a file. */
const isInlineImage = (p: MailPartInfo) =>
  p.type.startsWith('image/') &&
  p.contentId !== null &&
  p.disposition !== 'attachment' &&
  p.size <= INLINE_IMAGE_MAX;

const isBodyText = (p: MailPartInfo) =>
  (p.type === 'text/html' || p.type === 'text/plain') &&
  p.disposition !== 'attachment' &&
  !p.filename;

export function isAttachment(p: MailPartInfo) {
  if (isBodyText(p)) return false;
  return p.disposition === 'attachment' || Boolean(p.filename) || isInlineImage(p);
}

export const hasFiles = (parts: MailPartInfo[]) =>
  parts.some((p) => isAttachment(p) && !isInlineImage(p));

/** The parts to download to show a message: first HTML, first plain text, inline images. */
export function bodyParts(parts: MailPartInfo[]) {
  const html = parts.find((p) => p.type === 'text/html' && isBodyText(p)) ?? null;
  const text = parts.find((p) => p.type === 'text/plain' && isBodyText(p)) ?? null;
  const inline = html ? parts.filter(isInlineImage) : [];
  return { html, text, inline };
}

export function attachmentsOf(parts: MailPartInfo[]): MailAttachment[] {
  return parts.filter(isAttachment).map((p, i) => ({
    part: p.part,
    filename: p.filename || `attachment-${i + 1}`,
    contentType: p.type,
    size: p.size,
    inline: isInlineImage(p),
  }));
}
