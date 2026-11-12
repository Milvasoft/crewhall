/** The plugin's model. Providers speak `Fields`; the sync engine compares `Canon` values. */

/** One server, two plugins: which one this copy serves. */
export type Product = 'azure' | 'jira';

export type ProviderKind = 'azure' | 'jira';
export type Priority = 'p1' | 'p2' | 'p3';
export type StatusCategory = 'todo' | 'doing' | 'done' | 'removed';

/**
 * A work item in neutral form. `undefined` means this item cannot say: the field does not exist
 * on its type, or the service hides it (Jira Cloud may hide e-mail addresses).
 */
export interface Fields {
  title: string;
  description: string;
  status: string;
  /** E-mail, lower case. */
  assignee: string | null | undefined;
  priority: Priority | null | undefined;
  dueDate: string | null | undefined;
  startDate: string | null | undefined;
  labels: string[];
  points: number | null | undefined;
}

export type FieldsPatch = Partial<Omit<Fields, 'labels'>> & { labels?: string[] };

export interface ExternalItem {
  id: string;
  /** What people call it: `#123`, `ABC-12`. */
  key: string;
  url: string;
  type: string;
  project: string;
  updatedAt: string;
  commentCount: number;
  /** Deleted, or in a removed state. */
  removed: boolean;
  fields: Fields;
}

export interface ExternalComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface ProjectMeta {
  types: string[];
  statuses: { name: string; category: StatusCategory; types: string[] }[];
}

export interface Scope {
  project: string;
  types: string[];
  /** Extra WIQL condition or JQL, written by the person who owns the connection. */
  filter: string;
}

export interface Provider {
  readonly kind: ProviderKind;
  whoami(): Promise<{ name: string; email: string | null }>;
  listProjects(): Promise<{ id: string; key: string; name: string }[]>;
  projectMeta(project: string): Promise<ProjectMeta>;
  /** Changed since `since` (everything when null), oldest first, at most `limit`. */
  changedSince(scope: Scope, since: string | null, limit: number): Promise<ExternalItem[]>;
  getItem(id: string): Promise<ExternalItem | null>;
  createItem(scope: Scope, type: string, fields: FieldsPatch): Promise<ExternalItem>;
  updateItem(item: ExternalItem, patch: FieldsPatch): Promise<ExternalItem>;
  listComments(item: ExternalItem): Promise<ExternalComment[]>;
  addComment(item: ExternalItem, text: string): Promise<string>;
  assignedToMe(limit: number): Promise<ExternalItem[]>;
  search(text: string, limit: number): Promise<ExternalItem[]>;
  /** Subscribes to changes; null when the token may not (polling then does the work). */
  createWebhook(scope: Scope, url: string): Promise<string | null>;
  removeWebhook(id: string): Promise<void>;
  /** Ids a webhook body talks about. The body is never trusted beyond that. */
  webhookItems(body: unknown): string[];
}

export type AuthSecret =
  | { kind: 'pat'; token: string; email?: string }
  | {
      kind: 'entra';
      tenant: string;
      clientId: string;
      clientSecret?: string;
      refreshToken: string;
      accessToken?: string;
      expiresAt?: number;
    };

export interface Installation {
  id: string;
  apiUrl: string;
  orgId: string;
  orgName: string;
  /** Sealed with the plugin's key. */
  secret: string;
  permissions: string[];
}

export interface Connection {
  id: string;
  installationId: string;
  ownerId: string;
  provider: ProviderKind;
  name: string;
  baseUrl: string;
  account: string;
  authKind: AuthSecret['kind'];
  /** Sealed `AuthSecret`. */
  auth: string;
  createdAt: string;
}

export type Direction = 'both' | 'to_crewhall' | 'to_external';
export type ConflictRule = 'newest' | 'external' | 'crewhall';

export interface Sync {
  id: string;
  installationId: string;
  ownerId: string;
  connectionId: string;
  boardId: string;
  boardName: string;
  scope: Scope;
  /** Column id → external statuses; the first is the one written. */
  columnMap: Record<string, string[]>;
  direction: Direction;
  conflict: ConflictRule;
  comments: boolean;
  /** New cards also open a work item of `defaultType`. */
  pushNewCards: boolean;
  defaultType: string;
  timeZone: string;
  enabled: boolean;
  webhookToken: string;
  webhookId: string | null;
  watermark: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  linked: number;
  createdAt: string;
}

/** What both sides agreed on last time. */
export interface Canon {
  title: string;
  description: string;
  column: string;
  assignee: string | null;
  priority: Priority | null;
  dueDate: string | null;
  startDate: string | null;
  labels: string[];
  points: number | null;
}

export interface Link {
  syncId: string;
  extId: string;
  extKey: string;
  extUrl: string;
  extUpdatedAt: string;
  extComments: number;
  cardId: string;
  cardKey: string;
  cardUpdatedAt: string;
  cardComments: number;
  base: Canon;
  /** External comment id → card activity id. */
  comments: Record<string, string>;
  removed: boolean;
}

export type LogLevel = 'info' | 'conflict' | 'error';

export interface LogEntry {
  at: string;
  level: LogLevel;
  /** Message key; the page words it. */
  code: string;
  item?: string;
  detail?: string;
}

export interface OAuthState {
  id: string;
  installationId: string;
  ownerId: string;
  name: string;
  baseUrl: string;
  tenant: string;
  clientId: string;
  /** Sealed. */
  clientSecret: string | null;
  verifier: string;
  createdAt: string;
  /** Filled by the callback so the page can tell how it went. */
  result: 'pending' | 'ok' | 'failed';
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}
