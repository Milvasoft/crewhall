import { ApiError } from '@crewhall/api-client';
import { generatePassword } from '@crewhall/crypto';
import { api, NotConnectedError } from '../shared/api';
import { t } from '../shared/i18n';
import {
  CONTENT_SCRIPT_REQUESTS,
  RequestError,
  type Envelope,
  type Reply,
  type RequestName,
  type Requests,
} from '../shared/messages';
import { hitPath } from '../shared/links';
import { getConnection, getSettings } from '../shared/storage';
import { CaptureService } from './capture';
import { fillGenerated, fillLogin } from './fill';
import { createMenus, onMenuClick } from './menus';
import { VaultService, type KeyValue } from './vault';

const session: KeyValue = {
  get: async (key) => (await chrome.storage.session.get(key))[key],
  set: (key, value) => chrome.storage.session.set({ [key]: value }),
  remove: (key) => chrome.storage.session.remove(key),
  keys: async () => Object.keys(await chrome.storage.session.get(null)),
};

const vault: VaultService = new VaultService({
  api,
  userId: async () => {
    const c = await getConnection();
    if (!c) throw new NotConnectedError();
    return c.userId;
  },
  session,
  onLock: () => capture.clear(),
});
const capture: CaptureService = new CaptureService(vault, session);

/* ---------------------------------- content script ---------------------------------- */

const CAPTURE_SCRIPT = 'crewhall-capture';
const EVERY_SITE = ['https://*/*', 'http://*/*'];

/** The save question needs a script on every site, so it exists only while the vault is on. */
async function syncCaptureScript() {
  const settings = await getSettings();
  const allowed = await chrome.permissions.contains({ origins: EVERY_SITE });
  const wanted = settings.vault && settings.capture && allowed;
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CAPTURE_SCRIPT] });
  // Crewhall's own pages hold the account and vault passwords: the script does not run there.
  const connection = await getConnection();
  const script = {
    id: CAPTURE_SCRIPT,
    js: ['capture.js'],
    matches: EVERY_SITE,
    excludeMatches: connection ? [`${connection.origin}/*`] : [],
    allFrames: true,
    runAt: 'document_idle' as const,
  };
  if (wanted && !registered.length) {
    await chrome.scripting.registerContentScripts([script]);
  } else if (wanted) {
    await chrome.scripting.updateContentScripts([script]);
  } else if (registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [CAPTURE_SCRIPT] });
  }
}

/* --------------------------------------- badge --------------------------------------- */

async function refreshBadge() {
  const connection = await getConnection();
  const settings = await getSettings();
  if (!connection || !settings.badge) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  try {
    const { unread } = await (await api()).call('getNotificationCounts');
    await chrome.action.setBadgeBackgroundColor({ color: '#FBC419' });
    await chrome.action.setBadgeTextColor({ color: '#141516' });
    await chrome.action.setBadgeText({ text: unread > 0 ? (unread > 99 ? '99+' : String(unread)) : '' });
  } catch {
    await chrome.action.setBadgeText({ text: '' });
  }
}

/* ------------------------------------- clipboard ------------------------------------- */

const CLIPBOARD = 'clipboard.pending';

async function clearClipboardNow() {
  const value = (await session.get(CLIPBOARD)) as string | undefined;
  await session.remove(CLIPBOARD);
  if (!value || !(await chrome.permissions.contains({ permissions: ['clipboardRead'] }))) return;
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Clears a copied password from the clipboard after 30 seconds',
    });
  }
  await chrome.runtime.sendMessage({ t: 'offscreen.clear', value });
  await chrome.offscreen.closeDocument();
}

/* -------------------------------------- requests -------------------------------------- */

type Handler<N extends RequestName> = (
  p: Requests[N]['in'],
  sender: chrome.runtime.MessageSender,
) => Promise<Requests[N]['out']>;

function tabOf(p: { tabId?: number }, sender: chrome.runtime.MessageSender): number {
  const tabId = p.tabId ?? sender.tab?.id;
  if (tabId === undefined) throw new RequestError('no_tab');
  return tabId;
}

async function closePrompt(tabId: number) {
  await chrome.tabs.sendMessage(tabId, { t: 'capture.close' }).catch(() => undefined);
}

const handlers: { [N in RequestName]: Handler<N> } = {
  'vault.state': () => vault.state(),
  'vault.unlock': ({ password }) => vault.unlock(password),
  'vault.lock': () => vault.lock(),
  'vault.list': ({ pageUrl }) => vault.list(pageUrl),
  'vault.fill': ({ itemId, tabId }) => fillLogin(vault, itemId, tabId),
  'vault.secret': async ({ itemId, field }) => {
    if (field === 'totp') {
      return { value: (await vault.totp(itemId, { forCopy: true })).code };
    }
    const { payload, vaultId } = await vault.login(itemId);
    await vault.report(itemId, vaultId, field);
    return { value: field === 'username' ? payload.username : payload.password };
  },
  'vault.totp': ({ itemId }) => vault.totp(itemId),
  'vault.generate': async ({ options }) => ({ value: generatePassword(options) }),
  'vault.fillGenerated': ({ value, tabId }) => fillGenerated(value, tabId),
  'clipboard.clearLater': async ({ value }) => {
    await session.set(CLIPBOARD, value);
    await chrome.alarms.create('clipboard', { delayInMinutes: 0.5 });
    return null;
  },
  'capture.submitted': async ({ username, password }, sender) => {
    // Comes from a page's content script: nothing about it is trusted.
    const valid =
      typeof username === 'string' &&
      typeof password === 'string' &&
      username.length <= 1000 &&
      password.length <= 5000;
    if (valid && sender.tab?.id !== undefined && sender.url) {
      await capture.submitted(sender.tab.id, sender.url, username, password);
    }
    return null;
  },
  'capture.check': async (_p, sender) => {
    if (sender.tab?.id === undefined) return { show: false };
    return { show: (await capture.prompt(sender.tab.id).catch(() => null)) !== null };
  },
  'capture.prompt': (p, sender) => capture.prompt(tabOf(p, sender)),
  'capture.save': async (p, sender) => {
    const tabId = tabOf(p, sender);
    await capture.save(tabId, p.id, p.vaultId);
    await closePrompt(tabId);
    return null;
  },
  'capture.dismiss': async (p, sender) => {
    const tabId = tabOf(p, sender);
    await capture.dismiss(tabId, Boolean(p.never));
    await closePrompt(tabId);
    return null;
  },
  'capture.openUnlock': async () => {
    await chrome.action.openPopup().catch(() =>
      chrome.windows.create({ url: 'popup.html', type: 'popup', width: 400, height: 600 }),
    );
    return null;
  },
  'features.sync': async () => {
    await syncCaptureScript();
    await refreshBadge();
    return null;
  },
};

function toFailure(e: unknown): Extract<Reply<never>, { ok: false }> {
  if (e instanceof RequestError) return { ok: false, code: e.code, details: e.details };
  if (e instanceof ApiError) return { ok: false, code: e.code, details: e.details };
  if (e instanceof NotConnectedError) return { ok: false, code: 'not_connected' };
  return { ok: false, code: 'internal' };
}

chrome.runtime.onMessage.addListener((message: Envelope, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = handlers[message.t] as Handler<RequestName> | undefined;
  if (!handler) return false;
  // Pages run content scripts; a compromised page must not reach anything but its own two calls.
  const fromExtension = sender.url?.startsWith(chrome.runtime.getURL('')) ?? false;
  if (!fromExtension && !CONTENT_SCRIPT_REQUESTS.includes(message.t)) {
    respond({ ok: false, code: 'forbidden' } satisfies Reply<never>);
    return false;
  }
  handler(message.p, sender).then(
    (value) => respond({ ok: true, value }),
    (e: unknown) => respond(toFailure(e)),
  );
  return true;
});

/* --------------------------------------- events --------------------------------------- */

// Holds the bearer token: only the extension's own pages and worker may read it.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  void syncCaptureScript();
  void chrome.alarms.create('tick', { periodInMinutes: 1 });
  void refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  void syncCaptureScript();
  void chrome.alarms.create('tick', { periodInMinutes: 1 });
  void refreshBadge();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void onMenuClick(info, tab).catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'clipboard') void clearClipboardNow().catch(() => undefined);
  if (alarm.name === 'tick') {
    void vault.expire();
    void capture.sweep();
    void refreshBadge();
  }
});

// The computer was locked: the vault goes with it, as in the desktop app.
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'locked') void vault.lock();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.connection && !changes.connection.newValue) void vault.lock();
  if (changes.connection || changes.settings) {
    void syncCaptureScript();
    void refreshBadge();
  }
});

chrome.permissions.onRemoved.addListener(() => void syncCaptureScript());
chrome.permissions.onAdded.addListener(() => void syncCaptureScript());
chrome.tabs.onRemoved.addListener((tabId) => void capture.forget(tabId));

/* --------------------------------- address bar: "ch …" --------------------------------- */

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let searchSeq = 0;

chrome.omnibox.setDefaultSuggestion({ description: t('omnibox.hint') });

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  const seq = ++searchSeq;
  void (async () => {
    const connection = await getConnection();
    if (!connection || text.trim().length < 2) return;
    const client = await api();
    const [hits, spaces] = await Promise.all([
      client.call('searchContent', { query: { q: text.trim(), limit: 6 } }),
      client.call('listSpaces'),
    ]);
    if (seq !== searchSeq) return;
    const slugs = new Map(spaces.items.map((s) => [s.id, s.slug]));
    suggest(
      hits.items.flatMap((hit) => {
        const path = hitPath(hit, (id) => slugs.get(id));
        return path
          ? [{ content: new URL(path, connection.origin).href, description: escapeXml(hit.title || hit.snippet) }]
          : [];
      }),
    );
  })().catch(() => undefined);
});

chrome.omnibox.onInputEntered.addListener((text) => {
  void (async () => {
    const connection = await getConnection();
    if (!connection) {
      await chrome.runtime.openOptionsPage();
      return;
    }
    // A picked suggestion is one of our own addresses; anything else opens Crewhall.
    await chrome.tabs.create({
      url: text.startsWith(`${connection.origin}/`) ? text : connection.origin,
    });
  })();
});
