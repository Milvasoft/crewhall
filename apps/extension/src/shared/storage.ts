/** What the extension keeps. `local` survives restarts; `session` lives in memory only. */

export interface Connection {
  origin: string;
  /** Bearer session of this browser. It cannot open the vault. */
  token: string;
  userId: string;
  userName: string;
  email: string;
  orgName: string;
}

export interface Settings {
  /** Vault tab, filling and the save question; turning it on asks for access to every site. */
  vault: boolean;
  /** Ask to save or update after a sign-in. */
  capture: boolean;
  badge: boolean;
  /** Sites where the save question was answered "never". */
  neverHosts: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  vault: false,
  capture: true,
  badge: true,
  neverHosts: [],
};

export interface DriveTarget {
  spaceId: string;
  parentId: string | null;
  label: string;
}

const CONNECTION = 'connection';
const SETTINGS = 'settings';
const DRIVE_TARGET = 'driveTarget';

export async function getConnection(): Promise<Connection | null> {
  const r = await chrome.storage.local.get(CONNECTION);
  return (r[CONNECTION] as Connection | undefined) ?? null;
}

export const setConnection = (c: Connection) => chrome.storage.local.set({ [CONNECTION]: c });
export const clearConnection = () => chrome.storage.local.remove(CONNECTION);

export async function getSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(r[SETTINGS] as Partial<Settings> | undefined) };
}

export async function updateSettings(change: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...change };
  await chrome.storage.local.set({ [SETTINGS]: next });
  return next;
}

export async function getDriveTarget(): Promise<DriveTarget | null> {
  const r = await chrome.storage.local.get(DRIVE_TARGET);
  return (r[DRIVE_TARGET] as DriveTarget | undefined) ?? null;
}

export const setDriveTarget = (t: DriveTarget) => chrome.storage.local.set({ [DRIVE_TARGET]: t });

/** What a right click or the popup hands to the send window. */
export interface Draft {
  kind: 'image' | 'link' | 'selection' | 'page' | 'screenshot';
  pageUrl: string;
  title: string;
  /** Image or file address. */
  srcUrl?: string;
  /** Selected or page text, as HTML when it could be read from the page. */
  html?: string;
  text?: string;
  /** Screenshot as a data URL. */
  dataUrl?: string;
}

export async function putDraft(draft: Draft): Promise<string> {
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`draft:${id}`]: draft });
  return id;
}

export async function takeDraft(id: string): Promise<Draft | null> {
  const key = `draft:${id}`;
  const r = await chrome.storage.session.get(key);
  return (r[key] as Draft | undefined) ?? null;
}

export const dropDraft = (id: string) => chrome.storage.session.remove(`draft:${id}`);
