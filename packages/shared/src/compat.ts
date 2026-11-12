import { z } from 'zod';
import type { ModuleKey } from './schemas/org';

/**
 * Server and client compatibility. Orgs update their servers on their own schedule, so mobile
 * and desktop apps adapt to the server they talk to: `apiLevel` and `capabilities` (bootstrap,
 * `getCompat`) say what this server offers, `minClientVersion` what it still accepts.
 */

/**
 * Raised by one on every contract addition (new endpoint, new optional field, new error code).
 * `pnpm --filter @crewhall/shared contract:check` fails when the contract grew past the
 * release snapshot (contract-snapshot.json) without raising it.
 */
export const API_LEVEL = 51;

/**
 * Features a client may look for before showing them. A capability of a module is listed only
 * while the module is on for the org (OrgSettings.modules); `since` is the apiLevel that
 * brought it. Add new keys at the end; never rename or remove one.
 */
export const CAPABILITIES = [
  { key: 'ui.prefs', since: 1 },
  { key: 'quick.density', since: 1 },
  { key: 'delivery.settings', since: 1 },
  { key: 'media.assets', since: 1 },
  { key: 'mail.bulk', since: 1, module: 'mail' },
  { key: 'mail.live', since: 1, module: 'mail' },
  { key: 'meet.volume', since: 1, module: 'meet' },
  { key: 'meet.remoteControl', since: 1, module: 'meet' },
  { key: 'meet.convLive', since: 1, module: 'meet' },
  { key: 'meet.dataCall', since: 1, module: 'meet' },
  { key: 'chat.delete', since: 1, module: 'chat' },
  { key: 'ai.act', since: 1, module: 'ai' },
  { key: 'ai.act.todo', since: 1, module: 'ai' },
  { key: 'ai.dictation', since: 1, module: 'ai' },
  { key: 'ui.sidebar', since: 2 },
  { key: 'chat.scheduled', since: 3, module: 'chat' },
  // Crewhall'a sor: live sources (calendar, tasks, meetings, people), time zone, cached usage.
  { key: 'ai.ask.live', since: 4, module: 'ai' },
  { key: 'ai.fastModel', since: 4, module: 'ai' },
  { key: 'desktop.releases', since: 5 },
  { key: 'desktop.multipartUpload', since: 6 },
  // Full width is a personal choice for every page (UiPrefs.pagesFullWidth), not per page.
  { key: 'ui.pagesFullWidth', since: 7, module: 'wiki' },
  // Web paths are English (paths.ts); older servers still link to the Turkish ones.
  { key: 'paths.english', since: 8 },
  // A link card changes its address in place (resolveLink) and may carry its own icon.
  { key: 'quick.linkEdit', since: 9 },
  // GIFs in chat through GIPHY; listed only while the org has a key and the feature on.
  { key: 'chat.gif', since: 10, module: 'chat' },
  // Yönetim › Yedekler warns when pg_dump is older than the database server.
  { key: 'backups.pgTools', since: 11 },
  // A space channel shared with another org (federation shared channels).
  { key: 'chat.sharedChannels', since: 12, module: 'chat' },
  // "Mesaj bilgisi" (getMessageInfo) and "okunmadı" that sticks (MyConversationState.markedUnread).
  { key: 'chat.messageInfo', since: 13, module: 'chat' },
  // Thank-you wall, birthdays and work anniversaries (kudos, celebrations, directory fields).
  { key: 'announcements.kudos', since: 13 },
  // GitHub, Azure DevOps and Jira integrations; "Ben bakıyorum" on webhook cards (claimMessage).
  { key: 'chat.integrations', since: 13, module: 'chat' },
  // Presence from device activity (15 min idle, lock, mobile background), meetings, timed choices.
  { key: 'presence.activity', since: 14 },
  // "Yap": calendar entries, chat messages, pages and notes, tasks from a conversation; "Sor":
  // Drive files by name and unread mail (new AiActKind and AiSearchKind values).
  { key: 'ai.act.more', since: 15, module: 'ai' },
  { key: 'ai.ask.filesMail', since: 15, module: 'ai' },
  // Boards project management: sprints, dependencies, start dates, time tracking, workload.
  { key: 'boards.projects', since: 16, module: 'boards' },
  // Org chart editing: managers by drag and drop or table, CSV import (importDirectory), team.
  { key: 'contacts.orgChartEdit', since: 17, module: 'contacts' },
  { key: 'contacts.accountSync', since: 38, module: 'contacts' },
  { key: 'calendar.exchange', since: 39, module: 'calendar' },
  // Room and desk booking (bookings endpoints, roomId / room on events).
  { key: 'calendar.bookings', since: 17, module: 'calendar' },
  // Free/busy-only connected accounts (updateCalendarAccount) and org-wide (delegated) accounts.
  { key: 'calendar.busyOnly', since: 17, module: 'calendar' },
  // "Crewhall toplantısı ekle" on events of a mirrored Google / Microsoft calendar.
  { key: 'calendar.externalMeetings', since: 17, module: 'calendar' },
  // Space tables: fields, views, rows; automation, form, assistant and MCP integrations.
  { key: 'tables', since: 18, module: 'tables' },
  // Microsoft integrations: Entra SCIM, Outlook add-in, Teams app (OrgSettings.integrations).
  { key: 'integrations.microsoft', since: 19 },
  // External storage mounts in a space's Drive (listSpaceMounts; empty while switched off).
  { key: 'drive.mounts', since: 19 },
  // Word, Excel and PowerPoint in a document server (Euro-Office / ONLYOFFICE or WOPI):
  // getOfficeCapabilities, openOfficeSession, createOfficeDocument.
  { key: 'office', since: 20, module: 'office' },
  // Plugins from the central marketplace (docs/contracts/eklentiler.md): Yönetim › Eklentiler,
  // listPluginSurfaces (tabs, cards, commands), plugin session tokens, runPluginCommand.
  { key: 'plugins', since: 21 },
  // A message posted by a plugin carries MessageVia.kind 'plugin' ("<plugin> ile").
  { key: 'plugins.via', since: 21 },
  // Quick access: hidden cards and card widths on the mobile home, shared by every phone.
  { key: 'quick.mobileLayout', since: 22 },
  // iOS incoming calls through PushKit and CallKit: voip push devices, VoipPush, declineCallSigned.
  { key: 'meet.voipPush', since: 23, module: 'meet' },
  // Presence "Sunuyor": dnd with auto screen_share while sharing the screen in a meeting.
  { key: 'presence.screenShare', since: 24, module: 'meet' },
  // Shared channels 2: a Drive folder kept in step with the other organizations' copies
  // (listSharedFolders, shareFolder, endSharedFolder).
  { key: 'chat.sharedFolders', since: 25, module: 'chat' },
  // Shared channels 2: the host's channel meeting, joined from a guest copy (joinSharedMeeting,
  // Conversation.federation.meeting).
  { key: 'chat.sharedMeetings', since: 25, module: 'chat' },
  // An admin grants a subset of what a plugin asks for (InstallPlugin.permissions,
  // UpdatePluginInstallation.permissions, UpgradePlugin.acceptPermissions);
  // PluginInstallation.requestedPermissions and PluginSurface.permissions say what was granted.
  { key: 'plugins.partial', since: 26 },
  // Plugin tabs and cards in the mobile app: the tab/card `mobile` flag and the bridge over
  // react-native-webview (BridgeContext.platform 'mobile').
  { key: 'plugins.mobile', since: 26 },
  // Approval requests (MCP, AI, plugins) as a notification and push: approval.requested.
  { key: 'notifications.approvalRequested', since: 27 },
  // Mail and calendar accounts connected from the app: createOAuthHandoff.
  { key: 'oauth.handoff', since: 28 },
  // VoIP devices say their APNs environment (sandbox dev builds next to TestFlight ones).
  { key: 'push.apnsEnvironment', since: 29 },
  // Unlisted and private marketplace listings: lookupPlugin finds one by id or install link;
  // PluginCatalogItem.visibility and .hosting.
  { key: 'plugins.lookup', since: 30 },
  // Self-hosted plugins: InstallPlugin.selfOrigin, PluginInstallation.hosting / .selfOrigin.
  { key: 'plugins.selfHosted', since: 30 },
  // Plugins notify people who opened them (`plugin.notification`, NotificationTarget 'plugin');
  // listPluginNotificationPrefs / updatePluginNotificationPref; `notifications:write`.
  { key: 'notifications.plugin', since: 31 },
  // Browser features for plugin frames (microphone, camera, geolocation, clipboard-write):
  // granted per installation (InstallPlugin.browser…), PluginSurface.browser says which.
  { key: 'plugins.browser', since: 32 },
  // A person's per-plugin settings: notification channels (bell, desktop, push) and "show on
  // mobile" (PluginNotificationPref.channels / .showOnMobile, PluginSurface.hiddenOnMobile,
  // Notification.desktop).
  { key: 'plugins.userPrefs', since: 33 },
  // A switch per notification row × channel (bell, desktop, push, e-mail), muting one device.
  { key: 'notifications.groups', since: 34 },
  // Versions of a mirrored event lost to a sync conflict (listCalendarEventVersions).
  { key: 'calendar.eventVersions', since: 37, module: 'calendar' },
  // Internal references in chat: Message.refs, resolveChatRefs, searchChatRefs.
  { key: 'chat.refs', since: 35, module: 'chat' },
  // Guests and members share the meeting chat (listGuestChat, sendGuestChat, Message.guestAuthor).
  { key: 'meet.guestChat', since: 36, module: 'meet' },
  // Being in a meeting on several devices: listActiveMeetings, JoinMeeting.device, "transferred".
  { key: 'meet.devices', since: 36, module: 'meet' },
  // Drive change feed for sync clients and the virtual drive (listDriveChanges).
  { key: 'drive.changes', since: 40 },
  // "Yap" takes the conversation so far (AiActRequest.history), reads real data, carries content
  // over (kinds todo_to_page, page_to_tasks, move_todo_items) and answers "evet" through
  // AiActResult.decided: the client presses the same approve and reject buttons.
  { key: 'ai.act.context', since: 40, module: 'ai' },
  // Pages: "hide completed to-dos" per person and page (UiPrefs.pagesHideDone).
  { key: 'ui.pagesHideDone', since: 41, module: 'wiki' },
  // Ticks a page's to-do without opening its document (setPageTask).
  { key: 'wiki.tasks', since: 41, module: 'wiki' },
  // A person pins a plugin's tab to the left rail: PluginSurface.pinnedTabs,
  // PluginNotificationPref.pinnedTabs, updatePluginNotificationPref { pinnedTabs }.
  { key: 'plugins.railPin', since: 42 },
  // A person may let a plugin work while nobody has it open; board cards raise plugin events.
  { key: 'plugins.offline', since: 50 },
  // Admins can see why a person did not get a push (getPushDiagnostics).
  { key: 'admin.pushDiagnostics', since: 43 },
  // A home card moves to another space's home: listCardMoveTargets, moveCard { layout } for undo,
  // the surface.changed event.
  { key: 'quick.moveTargets', since: 43 },
  // Following a page: Page.following, setPageFollow, the `page.updated` notification.
  { key: 'wiki.follow', since: 44, module: 'wiki' },
  // Text search across the org's content that works with the ai module off: searchContent.
  { key: 'search.content', since: 46 },
  // Following a page with its sub-pages: SetPageFollow.descendants, Page.followingDescendants.
  { key: 'wiki.followDescendants', since: 51, module: 'wiki' },
  // "Portal'a gönder": a page becomes or updates a draft portal doc (createPortalDocFromPage,
  // PortalDoc.sourceNodeId).
  { key: 'portal.fromPage', since: 51, module: 'portal' },
] as const satisfies readonly { key: string; since: number; module?: ModuleKey }[];

export type Capability = (typeof CAPABILITIES)[number]['key'];

/** Capabilities the org has, given its enabled modules. */
export function capabilitiesFor(modules: readonly ModuleKey[]): Capability[] {
  const on = new Set<string>(modules);
  return CAPABILITIES.filter((c) => !('module' in c) || on.has(c.module)).map((c) => c.key);
}

export const CLIENT_PLATFORMS = ['ios', 'android', 'desktop', 'web'] as const;
export const ClientPlatform = z.enum(CLIENT_PLATFORMS);
export type ClientPlatform = z.infer<typeof ClientPlatform>;
/** Platforms the server may turn away when too old; the web app always matches its server. */
export type GatedPlatform = Exclude<ClientPlatform, 'web'>;

/** Oldest app versions a server accepts unless MIN_CLIENT_IOS / _ANDROID / _DESKTOP say otherwise. */
export const MIN_CLIENT_DEFAULTS: Record<GatedPlatform, string> = {
  ios: '0.0.0',
  android: '0.0.0',
  desktop: '0.0.0',
};

/** Request header naming the calling app: `X-Crewhall-Client: android/1.4.2`. */
export const CLIENT_HEADER = 'X-Crewhall-Client';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** `android/1.4.2` → { platform, version }; null when absent or malformed (never blocked). */
export function parseClientHeader(
  value: string | null | undefined,
): { platform: ClientPlatform; version: string } | null {
  if (!value) return null;
  const [platform, version] = value.trim().split('/');
  const p = ClientPlatform.safeParse(platform?.toLowerCase());
  if (!p.success || !version || !SEMVER.test(version)) return null;
  return { platform: p.data, version };
}

/** Compares `major.minor.patch` (pre-release suffixes ignored): <0, 0 or >0. */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** Marks an endpoint for removal; the server answers it with Deprecation and Sunset headers. */
export interface Deprecation {
  /** ISO date the replacement shipped. */
  since: string;
  /** ISO date after which a release may remove it. */
  removeAfter: string;
  /** What to call instead (endpoint name or field). */
  replacement?: string;
}

/**
 * Response or body fields on their way out (endpoint-level ones are marked on the endpoint in
 * endpoints.ts). Listed by `getCompat`; the contract check lets a release remove them only
 * after `removeAfter`.
 */
const PAGE_FULL_WIDTH: Deprecation = {
  since: '2026-10-23',
  removeAfter: '2027-04-23',
  replacement: 'UiPrefs.pagesFullWidth',
};

export const DEPRECATED_FIELDS: readonly (Deprecation & { endpoint: string; field: string })[] = [
  // Full width became a personal choice; the per-page value is no longer read.
  { endpoint: 'getPage', field: 'fullWidth', ...PAGE_FULL_WIDTH },
  { endpoint: 'updatePage', field: 'fullWidth', ...PAGE_FULL_WIDTH },
  { endpoint: 'getPublicPage', field: 'fullWidth', ...PAGE_FULL_WIDTH },
];
