import { ApiError, createApiClient } from '@crewhall/api-client';
import { IDENTITY_RAW_PATHS, MICROSOFT_WEB_PATHS } from '@crewhall/shared';
import { config } from '@/config';

/**
 * Sign-in of the Outlook add-in and the Teams app (sonraki-isler.md: "Kimlik: Crewhall OIDC").
 * Their pages live inside Microsoft's frames, where Crewhall's session cookie is a third-party
 * cookie, so they use Crewhall's own OpenID Connect provider instead: a sign-in dialog runs
 * the authorization code flow with PKCE against the integration's built-in client, and the
 * pane keeps the access and refresh tokens and calls the API as a bearer.
 */

export interface OfficeTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type OfficeHost = 'office' | 'teams';

const storeKey = (clientId: string) => `crewhall.office.${clientId}`;
const PENDING = 'crewhall.office.pending';

export function loadTokens(clientId: string): OfficeTokens | null {
  try {
    const raw = localStorage.getItem(storeKey(clientId));
    return raw ? (JSON.parse(raw) as OfficeTokens) : null;
  } catch {
    return null;
  }
}

export function saveTokens(clientId: string, tokens: OfficeTokens | null) {
  try {
    if (tokens) localStorage.setItem(storeKey(clientId), JSON.stringify(tokens));
    else localStorage.removeItem(storeKey(clientId));
  } catch {
    // Private mode: the person signs in again next time.
  }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function randomString(bytes = 32) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return base64url(b);
}

async function challengeOf(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export const callbackUrl = () => `${window.location.origin}${MICROSOFT_WEB_PATHS.officeCallback}`;

/** The dialog's first page: remember the PKCE verifier, then go to Crewhall's authorize. */
export async function startSignIn(clientId: string, host: OfficeHost) {
  const verifier = randomString();
  const state = randomString(16);
  sessionStorage.setItem(PENDING, JSON.stringify({ clientId, verifier, state, host }));
  const url = new URL(IDENTITY_RAW_PATHS.oidcAuthorize, config.apiUrl);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(),
    response_type: 'code',
    scope: 'openid profile email offline_access',
    state,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: 'S256',
  }).toString();
  window.location.assign(url.toString());
}

async function tokenRequest(body: Record<string, string>): Promise<OfficeTokens> {
  const res = await fetch(new URL(IDENTITY_RAW_PATHS.oidcToken, config.apiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/** The callback page: checks the state and trades the code; returns the host to answer. */
export async function finishSignIn(search: URLSearchParams) {
  const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as {
    clientId: string;
    verifier: string;
    state: string;
    host: OfficeHost;
  } | null;
  sessionStorage.removeItem(PENDING);
  const code = search.get('code');
  if (!pending || !code || search.get('state') !== pending.state) throw new Error('state');
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl(),
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  return { tokens, host: pending.host, clientId: pending.clientId };
}

/** A valid access token, refreshed when it is about to run out; null = sign in again. */
export async function accessToken(clientId: string): Promise<string | null> {
  const tokens = loadTokens(clientId);
  if (!tokens) return null;
  if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) return null;
  try {
    const next = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: clientId,
    });
    saveTokens(clientId, next);
    return next.accessToken;
  } catch {
    saveTokens(clientId, null);
    return null;
  }
}

/** The typed API client of a pane, as its person, with the integration's token. */
export function officeApi(clientId: string) {
  return createApiClient({
    baseUrl: config.apiUrl,
    credentials: 'omit',
    fetch: (input, init) => fetch(input, init),
    getToken: () => accessToken(clientId),
  });
}

export const isSignedOut = (e: unknown) => e instanceof ApiError && e.code === 'unauthenticated';

// ---- Office.js (loaded from Microsoft's CDN, as Office requires) -----------------------------

/** The parts of Office.js the add-in uses. */
export interface OfficeAsyncResult<T> {
  status: 'succeeded' | 'failed';
  value: T;
  error?: { message: string };
}
export interface OfficeAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  isInline: boolean;
}
export interface OfficeItem {
  subject: string | { getAsync(cb: (r: OfficeAsyncResult<string>) => void): void };
  from?: { displayName: string; emailAddress: string };
  dateTimeCreated?: Date;
  itemId?: string;
  attachments?: OfficeAttachment[];
  body: {
    getAsync(type: 'text' | 'html', cb: (r: OfficeAsyncResult<string>) => void): void;
    setSelectedDataAsync(
      data: string,
      options: { coercionType: 'html' | 'text' },
      cb: (r: OfficeAsyncResult<void>) => void,
    ): void;
  };
  getAttachmentsAsync?(cb: (r: OfficeAsyncResult<OfficeAttachment[]>) => void): void;
  getAttachmentContentAsync(
    id: string,
    cb: (r: OfficeAsyncResult<{ content: string; format: string }>) => void,
  ): void;
  removeAttachmentAsync?(id: string, cb: (r: OfficeAsyncResult<void>) => void): void;
}
export interface OfficeDialog {
  addEventHandler(
    event: 'dialogMessageReceived' | 'dialogEventReceived',
    cb: (arg: { message?: string; error?: number }) => void,
  ): void;
  close(): void;
}
export interface OfficeGlobal {
  onReady(): Promise<unknown>;
  context: {
    mailbox?: { item: OfficeItem | null };
    ui: {
      displayDialogAsync(
        url: string,
        options: { height: number; width: number; promptBeforeOpen?: boolean },
        cb: (r: OfficeAsyncResult<OfficeDialog>) => void,
      ): void;
      messageParent(message: string): void;
    };
  };
}

declare global {
  interface Window {
    Office?: OfficeGlobal;
  }
}

const OFFICE_JS = 'https://appsforoffice.microsoft.com/lib/1/hosted/office.js';
let officeLoad: Promise<OfficeGlobal | null> | null = null;

/** Office.js, or null outside Office (a plain browser tab, tests). */
export function loadOffice(): Promise<OfficeGlobal | null> {
  officeLoad ??= new Promise((resolve) => {
    if (window.Office) {
      void window.Office.onReady().then(() => resolve(window.Office ?? null));
      return;
    }
    const script = document.createElement('script');
    script.src = OFFICE_JS;
    script.onload = () => {
      const office = window.Office;
      if (!office) resolve(null);
      else void office.onReady().then(() => resolve(office));
    };
    script.onerror = () => resolve(null);
    // Blocked or never loading (no network, a plain browser test): give up after a while.
    setTimeout(() => resolve(window.Office ?? null), 6000);
    document.head.appendChild(script);
  });
  return officeLoad;
}

/** Callback-style Office calls as promises. */
export function officeCall<T>(run: (cb: (r: OfficeAsyncResult<T>) => void) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    run((r) => (r.status === 'succeeded' ? resolve(r.value) : reject(new Error(r.error?.message)))),
  );
}

/** Opens the sign-in dialog of the add-in and waits for its tokens. */
export async function officeSignIn(office: OfficeGlobal, clientId: string): Promise<boolean> {
  const url = `${window.location.origin}${MICROSOFT_WEB_PATHS.officeSignIn}?client=${encodeURIComponent(clientId)}&host=office`;
  const dialog = await officeCall<OfficeDialog>((cb) =>
    office.context.ui.displayDialogAsync(
      url,
      { height: 60, width: 30, promptBeforeOpen: false },
      cb,
    ),
  );
  return new Promise((resolve) => {
    dialog.addEventHandler('dialogMessageReceived', (arg) => {
      dialog.close();
      try {
        saveTokens(clientId, JSON.parse(arg.message ?? '') as OfficeTokens);
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    // Closed by the person.
    dialog.addEventHandler('dialogEventReceived', () => resolve(false));
  });
}
