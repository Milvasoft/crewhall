import { escapeXml, parseXml, type XmlElement } from '../../xml';
import { calendarFetch, ProviderError } from '../http';

/**
 * Exchange Web Services over plain HTTP + XML, with the repo's small XML reader. Only NTLM comes
 * from a library (@ewsjs/xhr, MIT), because it is a connection-level handshake. EWS checks element
 * order against its schema: the builders here and in the clients keep that order on purpose.
 */

const T = 'http://schemas.microsoft.com/exchange/services/2006/types';
const M = 'http://schemas.microsoft.com/exchange/services/2006/messages';

/** Exchange 2013 is the oldest server this speaks to; newer ones accept the older dialect. */
const SERVER_VERSION = 'Exchange2013';
const MAX_RESPONSE_BYTES = 50_000_000;

/** The reason of a ProviderError when Exchange refused the sign-in. */
export const EWS_REFUSED = 'ews_refused';

export interface EwsConnection {
  url: string;
  auth: 'ntlm' | 'basic';
  /** `DOMAIN\user` or the mailbox address. */
  username: string;
  password: string;
}

export type EwsTransport = (
  conn: EwsConnection,
  xml: string,
) => Promise<{ status: number; text: string }>;

const headers = {
  'content-type': 'text/xml; charset=utf-8',
  accept: 'text/xml',
};

async function basicTransport(conn: EwsConnection, xml: string) {
  const res = await calendarFetch(conn.url, {
    method: 'POST',
    headers: {
      ...headers,
      authorization: `Basic ${Buffer.from(`${conn.username}:${conn.password}`).toString('base64')}`,
    },
    body: xml,
    // The credentials go to the configured server and nowhere else.
    redirect: 'error',
  });
  return { status: res.status, text: await res.text() };
}

/** The library rejects with a response-like object for anything but 200. */
interface XhrLike {
  status?: number;
  responseText?: string;
  /** Node's error code when the connection itself failed. */
  code?: string;
}

async function ntlmTransport(conn: EwsConnection, xml: string) {
  const { XhrApi } = await import('@ewsjs/xhr');
  const api = new XhrApi({ timeout: 60_000 }).useNtlmAuthentication(conn.username, conn.password);
  try {
    const res = (await api.xhr({
      url: conn.url,
      type: 'POST',
      data: xml,
      headers,
    })) as unknown as XhrLike;
    return { status: res.status ?? 200, text: res.responseText ?? '' };
  } catch (err) {
    const res = err as XhrLike | null;
    if (typeof res?.status === 'number' && res.status > 0) {
      return { status: res.status, text: res.responseText ?? '' };
    }
    // No answer at all, or a server that does not offer NTLM (the handshake has nothing to read).
    throw new ProviderError(0, res?.code ? 'unreachable' : 'ntlm_failed');
  }
}

let override: EwsTransport | null = null;

/** Tests play the server here. */
export function setEwsTransport(t: EwsTransport | null) {
  override = t;
}

function transport(conn: EwsConnection, xml: string) {
  if (override) return override(conn, xml);
  return conn.auth === 'ntlm' ? ntlmTransport(conn, xml) : basicTransport(conn, xml);
}

export const envelope = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="${T}" xmlns:m="${M}">` +
  `<soap:Header><t:RequestServerVersion Version="${SERVER_VERSION}"/></soap:Header>` +
  `<soap:Body>${body}</soap:Body></soap:Envelope>`;

// ---- reading ------------------------------------------------------------------------------------

export const childOf = (el: XmlElement | null | undefined, name: string) =>
  el?.children.find((c) => c.name === name) ?? null;

export const childrenNamed = (el: XmlElement | null | undefined, name: string) =>
  el?.children.filter((c) => c.name === name) ?? [];

/** A child's text; null when it is absent or empty. */
export const textOf = (el: XmlElement | null | undefined, name: string) => {
  const t = childOf(el, name)?.text.trim();
  return t ? t : null;
};

/** The first descendant with that name. */
export function findDeep(el: XmlElement | null, name: string): XmlElement | null {
  if (!el) return null;
  for (const c of el.children) {
    if (c.name === name) return c;
    const hit = findDeep(c, name);
    if (hit) return hit;
  }
  return null;
}

// ---- errors -------------------------------------------------------------------------------------

/** EWS answers 200 with a response code; these map to what the sync already understands. */
const STATUS: Record<string, number> = {
  ErrorIrresolvableConflict: 412,
  ErrorChangeKeyRequiredForWriteOperations: 412,
  ErrorStaleObject: 412,
  ErrorItemNotFound: 404,
  ErrorFolderNotFound: 404,
  ErrorInvalidSyncStateData: 410,
  ErrorInvalidSyncState: 410,
  ErrorAccessDenied: 403,
  ErrorServerBusy: 503,
};

export const responseError = (code: string) => new ProviderError(STATUS[code] ?? 500, code);

/** A response message's own error, when it has one. */
export function messageError(msg: XmlElement): ProviderError | null {
  if (msg.attrs.ResponseClass !== 'Error') return null;
  return responseError(textOf(msg, 'ResponseCode') ?? 'ews_error');
}

/**
 * One SOAP call. Returns its response messages, one per requested item; those can fail one by
 * one, so the caller decides (`single` and `each` below). Throws ProviderError otherwise.
 */
export async function ewsMessages(conn: EwsConnection, body: string): Promise<XmlElement[]> {
  let res: { status: number; text: string };
  try {
    res = await transport(conn, envelope(body));
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(0, 'unreachable');
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError(401, EWS_REFUSED);
  const root = parseXml(res.text, MAX_RESPONSE_BYTES);
  const fault = findDeep(root, 'Fault');
  if (fault) {
    throw new ProviderError(
      res.status || 500,
      findDeep(fault, 'ResponseCode')?.text ?? 'soap_fault',
    );
  }
  if (res.status !== 200 || !root) throw new ProviderError(res.status || 500, `http_${res.status}`);
  const list = findDeep(root, 'ResponseMessages');
  if (!list) throw new ProviderError(500, 'no_response_messages');
  return list.children;
}

/** A call with one item: its message, or its error. */
export async function single(conn: EwsConnection, body: string): Promise<XmlElement> {
  const [msg] = await ewsMessages(conn, body);
  if (!msg) throw new ProviderError(500, 'no_response_messages');
  const err = messageError(msg);
  if (err) throw err;
  return msg;
}

// ---- writing ------------------------------------------------------------------------------------

export const x = escapeXml;

/** `<t:Name>text</t:Name>`, or nothing without a value. */
export const el = (name: string, value: string | null | undefined) =>
  value === null || value === undefined || value === '' ? '' : `<t:${name}>${x(value)}</t:${name}>`;

export const itemIdXml = (id: string, changeKey?: string | null) =>
  `<t:ItemId Id="${x(id)}"${changeKey ? ` ChangeKey="${x(changeKey)}"` : ''}/>`;

export const folderRef = (id: string) =>
  /^[a-z]+$/.test(id) ? `<t:DistinguishedFolderId Id="${id}"/>` : `<t:FolderId Id="${x(id)}"/>`;

const FULL_SHAPE = (extra = '') =>
  `<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape><t:BodyType>Text</t:BodyType>${
    extra ? `<t:AdditionalProperties>${extra}</t:AdditionalProperties>` : ''
  }</m:ItemShape>`;

/** Every property of the items, in batches; items that are gone by now are left out. */
export async function getItems(
  conn: EwsConnection,
  ids: string[],
  extraFields = '',
): Promise<XmlElement[]> {
  const out: XmlElement[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const messages = await ewsMessages(
      conn,
      `<m:GetItem>${FULL_SHAPE(extraFields)}<m:ItemIds>${batch.map((id) => itemIdXml(id)).join('')}</m:ItemIds></m:GetItem>`,
    );
    for (const msg of messages) {
      const err = messageError(msg);
      if (err && err.status !== 404) throw err;
      const items = childOf(msg, 'Items');
      if (items) out.push(...items.children);
    }
  }
  return out;
}

export interface FolderChanges {
  /** Created or changed items' ids. */
  changed: string[];
  deleted: string[];
  /** Any change at all (a read flag counts). */
  any: boolean;
  syncState: string;
}

/** What changed in a folder since `syncState`; everything there when it is null. */
export async function syncFolder(
  conn: EwsConnection,
  folder: string,
  syncState: string | null,
): Promise<FolderChanges> {
  const out: FolderChanges = { changed: [], deleted: [], any: false, syncState: syncState ?? '' };
  for (let i = 0; i < 400; i++) {
    const msg = await single(
      conn,
      `<m:SyncFolderItems><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>` +
        `<m:SyncFolderId>${folderRef(folder)}</m:SyncFolderId>` +
        (out.syncState ? `<m:SyncState>${x(out.syncState)}</m:SyncState>` : '') +
        `<m:MaxChangesReturned>512</m:MaxChangesReturned></m:SyncFolderItems>`,
    );
    out.syncState = textOf(msg, 'SyncState') ?? out.syncState;
    for (const change of childOf(msg, 'Changes')?.children ?? []) {
      out.any = true;
      if (change.name === 'Delete') {
        const id = childOf(change, 'ItemId')?.attrs.Id;
        if (id) out.deleted.push(id);
      } else if (change.name === 'Create' || change.name === 'Update') {
        const id = findDeep(change, 'ItemId')?.attrs.Id;
        if (id) out.changed.push(id);
      }
    }
    if (textOf(msg, 'IncludesLastItemInRange') !== 'false') return out;
  }
  throw new ProviderError(500, 'sync_incomplete');
}
