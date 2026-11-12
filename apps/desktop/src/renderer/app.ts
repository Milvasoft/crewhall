import {
  acceleratorFromKey,
  formatShortcut,
  type ShortcutProblem,
} from '../common/global-shortcut';
import { createTranslator, type Translate } from '../common/i18n';
import type {
  DesktopApi,
  FolderView,
  NewPair,
  ScreenSource,
  SettingsView,
  SpaceView,
  View,
} from '../common/ipc';
import { showMacScreenGrant } from '../common/permissions';
import { overallState, type VirtualDriveView } from '../common/virtual-drive';
import type { PairStatus, SyncPair } from '../sync/engine';
import { h, mount } from './dom';
import { loader } from './loader';
import { bump, enter, growWidth, stagger } from './motion';

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

const api = window.desktop;
const params = new URLSearchParams(location.search);
const root = document.getElementById('root')!;
let t: Translate = (k) => k;
let locale = 'tr';

function productLogo(): HTMLElement {
  return h(
    'picture',
    {},
    h('source', { srcset: '../assets/logo-white.svg', media: '(prefers-color-scheme: dark)' }),
    h('img', { class: 'product-logo', src: '../assets/logo.svg', alt: 'Crewhall' }),
  );
}

// ---- setup: which server? -----------------------------------------------------------------

function setupView(): void {
  document.title = t('desktop.setup.title');
  const input = h('input', {
    type: 'text',
    id: 'server',
    placeholder: t('desktop.setup.serverPlaceholder'),
    autocomplete: 'url',
    spellcheck: 'false',
    value: params.get('server') ?? '',
  });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'primary', type: 'submit' }, t('desktop.setup.continue'));

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        submit.textContent = t('desktop.setup.checking');
        error.textContent = '';
        const busy = loader(t('desktop.setup.checking'), 'small');
        submit.before(busy);
        const result = await api.checkServer(input.value).catch(() => null);
        busy.remove();
        submit.disabled = false;
        submit.textContent = t('desktop.setup.continue');
        if (!result) error.textContent = t('desktop.setup.errors.unreachable');
        else if (!result.ok) error.textContent = t(`desktop.setup.errors.${result.error}`);
        else showFound(result.origin, result.brand);
      },
    },
    h('label', { class: 'field', for: 'server' }, t('desktop.setup.serverLabel')),
    input,
    error,
    h('div', { class: 'row' }, submit),
  );

  mount(
    root,
    h(
      'div',
      { class: 'center' },
      productLogo(),
      h('h1', {}, t('desktop.setup.title')),
      h('p', { class: 'muted' }, t('desktop.setup.subtitle')),
      form,
    ),
  );
  stagger(root.firstElementChild);
  input.focus();

  function showFound(
    origin: string,
    brand: { orgName: string; appName: string; logoUrl: string | null; showPoweredBy: boolean },
    failed = false,
  ) {
    const connect = h('button', { class: 'primary' }, t('desktop.setup.connect'));
    const fail = h('p', { class: 'error', role: 'alert' });
    if (failed) fail.textContent = t('desktop.setup.errors.unreachable');
    connect.addEventListener('click', async () => {
      // Main closes this window once the app window has loaded the organization's page.
      loadingView(brand.orgName);
      try {
        await api.connect(origin);
      } catch {
        showFound(origin, brand, true);
      }
    });
    mount(
      root,
      h(
        'div',
        { class: 'center stack' },
        h('p', { class: 'muted' }, t('desktop.setup.foundTitle')),
        h(
          'div',
          { class: 'card org' },
          brand.logoUrl ? h('img', { src: brand.logoUrl, alt: '' }) : null,
          h(
            'div',
            {},
            h('div', { class: 'name' }, brand.orgName),
            h('div', { class: 'muted small' }, `${brand.appName} · ${new URL(origin).host}`),
          ),
        ),
        fail,
        h(
          'div',
          { class: 'row spread' },
          h('button', { class: 'link', onclick: () => setupView() }, t('desktop.setup.other')),
          connect,
        ),
        brand.showPoweredBy ? h('p', { class: 'muted small' }, t('desktop.setup.poweredBy')) : null,
      ),
    );
    stagger(root.firstElementChild, 40);
    connect.focus();
  }
}

// ---- loading: between the first-run screen or app start and the organization's page ----

function loadingView(name = params.get('name') ?? ''): void {
  const text = t('desktop.loading.connecting');
  document.title = text;
  mount(
    root,
    h(
      'div',
      { class: 'center loading' },
      loader(text),
      name ? h('div', { class: 'name' }, name) : null,
      h('p', { class: 'muted small' }, text),
    ),
  );
}

// ---- offline ------------------------------------------------------------------------------

function offlineView(): void {
  const server = params.get('server') ?? '';
  document.title = t('desktop.offline.title');
  mount(
    root,
    h(
      'div',
      { class: 'center stack' },
      h('h1', {}, t('desktop.offline.title')),
      h(
        'p',
        { class: 'muted' },
        t('desktop.offline.body', { name: server.replace(/^https?:\/\//, '') }),
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { class: 'primary', onclick: () => void api.retry() },
          t('desktop.offline.retry'),
        ),
        h(
          'button',
          {
            onclick: () => {
              if (confirm(t('desktop.settings.changeServerConfirm'))) void api.changeServer();
            },
          },
          t('desktop.offline.changeServer'),
        ),
      ),
    ),
  );
  stagger(root.firstElementChild);
  // Try again by itself when the network comes back.
  window.addEventListener('online', () => void api.retry());
}

// ---- outdated: the server answered 426 ----

async function outdatedView(): Promise<void> {
  const server = (params.get('server') ?? '').replace(/^https?:\/\//, '');
  document.title = t('desktop.outdated.title');
  const box = h('div', { class: 'center stack' });
  mount(root, box);
  const draw = (s: SettingsView) => {
    const u = s.update;
    const status =
      u.state === 'available' || u.state === 'downloaded'
        ? t(`desktop.settings.update.${u.state}`, { version: u.version })
        : t(`desktop.settings.update.${u.state}`);
    mount(
      box,
      productLogo(),
      h('h1', {}, t('desktop.outdated.title')),
      h('p', { class: 'muted' }, t('desktop.outdated.body', { name: server, version: s.version })),
      h('p', { class: 'update-status' }, status),
      h(
        'div',
        { class: 'row' },
        u.state === 'downloaded'
          ? h(
              'button',
              { class: 'primary', onclick: () => void api.installUpdate() },
              t('desktop.settings.installUpdate'),
            )
          : h(
              'button',
              {
                class: 'primary',
                onclick: () => void api.checkUpdates(),
                disabled: u.state === 'disabled' || u.state === 'checking',
              },
              t('desktop.settings.checkUpdates'),
            ),
        h('button', { onclick: () => void api.retry() }, t('desktop.offline.retry')),
      ),
      u.state === 'disabled' || u.state === 'error'
        ? h('p', { class: 'muted small' }, t('desktop.outdated.manual'))
        : null,
    );
  };
  draw(await api.getSettings());
  stagger(box);
  api.onSettings(draw);
}

// ---- files sent from Explorer --------------------------------------------------------------

function formatSize(bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  const at = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1);
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[at],
    unitDisplay: 'short',
    maximumFractionDigits: at < 2 ? 0 : 1,
  }).format(bytes / 1024 ** at);
}

/** Space, then folder, then the upload and what came of it. */
async function sendView(): Promise<void> {
  document.title = t('desktop.sendTo.title');
  const box = h('div', { class: 'send' });
  mount(root, box);
  const info = await api.sendInfo();
  const summary = () =>
    h(
      'p',
      { class: 'muted small' },
      `${info.names.slice(0, 3).join(', ')}${info.names.length > 3 ? ' …' : ''} · ${t(
        'desktop.sendTo.summary',
        { count: info.files },
      )} · ${formatSize(info.bytes)}`,
    );
  const close = () => h('button', { onclick: () => window.close() }, t('desktop.sendTo.close'));

  const spaces = await api.listSpaces().catch(() => null);
  if (!spaces) {
    mount(
      box,
      h('h1', {}, t('desktop.sendTo.title')),
      summary(),
      h('p', { class: 'error' }, t('desktop.sendTo.signIn')),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { class: 'primary', onclick: () => void api.sendOpenApp(null) },
          t('desktop.sendTo.openApp'),
        ),
        close(),
      ),
    );
    return;
  }

  const chooseSpace = () => {
    const usable = spaces.filter((s) => s.canEdit);
    mount(
      box,
      h('h1', {}, t('desktop.sendTo.title')),
      summary(),
      h('h2', {}, t('desktop.sync.chooseSpace')),
      usable.length === 0
        ? h('p', { class: 'muted' }, t('desktop.sendTo.noSpaces'))
        : h(
            'div',
            { class: 'list' },
            ...usable.map((sp) => h('button', { onclick: () => void browse(sp, []) }, sp.name)),
          ),
      h('div', { class: 'row' }, close()),
    );
  };

  const browse = async (space: SpaceView, trail: FolderView[]) => {
    const parent = trail.at(-1) ?? null;
    const folders = await api
      .listFolders(space.id, parent?.id ?? null)
      .catch((): FolderView[] => []);
    mount(
      box,
      h('h1', {}, t('desktop.sendTo.title')),
      summary(),
      h('p', { class: 'crumbs' }, [space.name, ...trail.map((f) => f.name)].join(' / ')),
      folders.length === 0
        ? h('p', { class: 'muted' }, t('desktop.sync.noFolders'))
        : h(
            'div',
            { class: 'list' },
            ...folders.map((f) =>
              h('button', { onclick: () => void browse(space, [...trail, f]) }, f.name),
            ),
          ),
      h(
        'div',
        { class: 'row spread' },
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              onclick: () =>
                trail.length ? void browse(space, trail.slice(0, -1)) : chooseSpace(),
            },
            t('desktop.sync.back'),
          ),
          close(),
        ),
        h(
          'button',
          { class: 'primary', onclick: () => void upload(space, parent) },
          t('desktop.sendTo.uploadHere'),
        ),
      ),
    );
  };

  const upload = async (space: SpaceView, folder: FolderView | null) => {
    const bar = h('i', {});
    const line = h('p', { class: 'small muted' });
    mount(
      box,
      h('h1', {}, t('desktop.sendTo.uploading')),
      h('div', { class: 'progress', role: 'presentation' }, bar),
      line,
      h(
        'div',
        { class: 'row' },
        h('button', { onclick: () => void api.sendCancel() }, t('desktop.sync.cancel')),
      ),
    );
    const stop = api.onSend((p) => {
      bar.style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 100}%`;
      line.textContent = p.current
        ? t('desktop.sendTo.progress', { done: p.done + 1, total: p.total, name: p.current })
        : '';
    });
    const result = await api
      .sendStart({ spaceId: space.id, folderId: folder?.id ?? null })
      .finally(stop);
    const problems = [...result.failed, ...result.skipped];
    mount(
      box,
      h('h1', {}, problems.length ? t('desktop.sendTo.partly') : t('desktop.sendTo.done')),
      h('p', {}, t('desktop.sendTo.uploaded', { count: result.uploaded })),
      problems.length
        ? h(
            'div',
            {},
            h('p', { class: 'error small' }, t('desktop.sendTo.notUploaded')),
            h('ul', { class: 'small' }, ...problems.map((p) => h('li', {}, p))),
          )
        : null,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            onclick: () => void api.sendOpenApp({ slug: space.slug, folderId: folder?.id ?? null }),
          },
          t('desktop.sendTo.openInDrive'),
        ),
        close(),
      ),
    );
  };

  chooseSpace();
}

// ---- screen picker ------------------------------------------------------------------------

async function pickerView(): Promise<void> {
  document.title = t('desktop.screenShare.title');
  const [sources, access] = await Promise.all([
    api.screenSources().catch((): ScreenSource[] => []),
    api.screenAccess().catch(() => ({ needsSystemGrant: false, granted: true })),
  ]);
  const macGrant = showMacScreenGrant(access, sources.length);
  let chosen: string | null = sources.find((s) => s.kind === 'screen')?.id ?? null;
  const share = h('button', { class: 'primary' }, t('desktop.screenShare.share'));
  share.disabled = !chosen;
  share.addEventListener('click', () => void api.chooseSource(chosen));
  const buttons: HTMLButtonElement[] = [];

  const group = (kind: ScreenSource['kind'], title: string) => {
    const items = sources.filter((s) => s.kind === kind);
    if (items.length === 0) return null;
    return h(
      'section',
      {},
      h('h2', {}, title),
      h(
        'div',
        { class: 'sources' },
        ...items.map((s) => {
          const b = h(
            'button',
            { class: 'source', 'aria-pressed': String(s.id === chosen), title: s.name },
            h('img', { src: s.thumbnail, alt: '' }),
            h('span', {}, s.name),
          );
          b.addEventListener('click', () => {
            chosen = s.id;
            share.disabled = false;
            for (const other of buttons) other.setAttribute('aria-pressed', String(other === b));
          });
          b.addEventListener('dblclick', () => void api.chooseSource(s.id));
          buttons.push(b);
          return b;
        }),
      ),
    );
  };

  mount(
    root,
    h(
      'div',
      { class: 'picker' },
      h('h1', {}, t('desktop.screenShare.title')),
      macGrant
        ? h(
            'div',
            { class: 'stack' },
            h('p', {}, t('desktop.screenShare.macGrant')),
            h(
              'div',
              { class: 'row' },
              h(
                'button',
                { class: 'primary', onclick: () => void api.openScreenSettings() },
                t('desktop.screenShare.openSettings'),
              ),
              h(
                'button',
                { onclick: () => void api.relaunch() },
                t('desktop.screenShare.relaunch'),
              ),
            ),
          )
        : sources.length === 0
          ? h('p', { class: 'muted' }, t('desktop.screenShare.empty'))
          : null,
      group('screen', t('desktop.screenShare.screens')),
      group('window', t('desktop.screenShare.windows')),
      h(
        'div',
        { class: 'row end' },
        h(
          'button',
          { onclick: () => void api.chooseSource(null) },
          t('desktop.screenShare.cancel'),
        ),
        share,
      ),
    ),
  );
  for (const grid of root.querySelectorAll('.sources')) stagger(grid, 25);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void api.chooseSource(null);
  });
}

// ---- settings -----------------------------------------------------------------------------

type Tab = 'general' | 'sync' | 'about';

async function settingsView(): Promise<void> {
  document.title = t('desktop.settings.title');
  let tab: Tab =
    (['general', 'sync', 'about'] as const).find((x) => x === params.get('tab')) ?? 'general';
  let settings = await api.getSettings();
  /** While adding a pair the list must not be redrawn under the person. */
  let wizard: HTMLElement | null = null;
  const panel = h('section', { class: 'panel' });
  const pill = h('span', { class: 'tab-pill', 'aria-hidden': 'true' });
  const tabButtons = (['general', 'sync', 'about'] as const).map((id) =>
    h(
      'button',
      {
        role: 'tab',
        'data-tab': id,
        onclick: () => {
          if (tab === id && !wizard) return;
          tab = id;
          wizard = null;
          draw(true);
        },
      },
      t(`desktop.settings.tabs.${id}`),
    ),
  );
  const tabs = h('nav', { class: 'tabs', role: 'tablist' }, pill, ...tabButtons);
  /** What the last draw showed, so only real changes animate (status pushes arrive often). */
  const shown = new Map<string, { state: string; pct: number }>();
  let pillPlaced = false;
  let lastUpdate = settings.update.state;

  const draw = (switched = false) => {
    for (const b of tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    const selected = tabButtons.find((b) => b.dataset.tab === tab)!;
    // The highlight slides between tabs; the first placement does not move.
    pill.style.transition = pillPlaced ? '' : 'none';
    pill.style.transform = `translateY(${selected.offsetTop}px)`;
    pill.style.height = `${selected.offsetHeight}px`;
    pillPlaced = true;

    if (tab === 'general') mount(panel, generalTab(settings));
    else if (tab === 'sync') mount(panel, wizard ?? syncTab(settings, startWizard, () => draw()));
    else mount(panel, aboutTab(settings));
    if (switched) enter(panel.firstElementChild);
    if (tab === 'sync' && !wizard) animatePairs(switched);
    // "Update ready" appears with a bump rather than silently.
    if (tab === 'about' && !switched && lastUpdate !== settings.update.state) {
      bump(panel.querySelector('.update-status'));
      enter(panel.querySelector('.install-update'));
    }
    lastUpdate = settings.update.state;
  };

  /** New cards rise in, a changed status chip bumps, progress bars grow from where they were. */
  const animatePairs = (switched: boolean) => {
    for (const p of settings.pairs) {
      const card = panel.querySelector<HTMLElement>(`[data-pair="${CSS.escape(p.id)}"]`);
      if (!card) continue;
      const status = settings.statuses.find((x) => x.id === p.id);
      const state = p.paused ? 'paused' : (status?.state ?? 'idle');
      const progress = status?.progress;
      const pct =
        progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
      const before = shown.get(p.id);
      if (!before && !switched) enter(card);
      else if (before && before.state !== state) bump(card.querySelector('.state'));
      const bar = card.querySelector<HTMLElement>('.progress > i');
      if (bar) growWidth(bar, before?.pct ?? 0, pct);
      shown.set(p.id, { state, pct });
    }
  };

  const startWizard = () => {
    wizard = h('div', { class: 'stack' });
    const done = () => {
      wizard = null;
      draw(true);
    };
    void pairWizard(wizard, settings, done);
    draw(true);
  };

  api.onSettings((next) => {
    settings = next;
    if (!wizard) draw();
  });
  mount(root, h('div', { class: 'settings' }, tabs, panel));
  draw();
  stagger(panel.firstElementChild);
}

function toggle(checked: boolean, onChange: (on: boolean) => void): HTMLInputElement {
  const input = h('input', { type: 'checkbox', class: 'switch', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function generalTab(s: SettingsView): HTMLElement {
  return h(
    'div',
    {},
    h('h1', {}, t('desktop.settings.tabs.general')),
    h(
      'div',
      { class: 'setting' },
      h(
        'div',
        {},
        h('div', { class: 'label' }, t('desktop.settings.server')),
        h(
          'div',
          { class: 'muted' },
          s.brand ? `${s.brand.orgName} · ${s.serverUrl ?? ''}` : (s.serverUrl ?? ''),
        ),
      ),
      h(
        'button',
        {
          onclick: () => {
            if (confirm(t('desktop.settings.changeServerConfirm'))) void api.changeServer();
          },
        },
        t('desktop.settings.changeServer'),
      ),
    ),
    h(
      'div',
      { class: 'setting' },
      h(
        'div',
        {},
        h('div', { class: 'label' }, t('desktop.settings.notifications')),
        h('div', { class: 'muted small' }, t('desktop.settings.notificationsHint')),
      ),
      toggle(s.notifications, (on) => void api.setSettings({ notifications: on })),
    ),
    h(
      'div',
      { class: 'setting' },
      h(
        'div',
        {},
        h('div', { class: 'label' }, t('desktop.settings.autostart')),
        h('div', { class: 'muted small' }, t('desktop.settings.autostartHint')),
      ),
      toggle(s.autostart, (on) => void api.setSettings({ autostart: on })),
    ),
    shortcutSetting(s),
    s.platform === 'win32'
      ? h(
          'div',
          { class: 'setting' },
          h(
            'div',
            {},
            h('div', { class: 'label' }, t('desktop.settings.explorerMenu')),
            h('div', { class: 'muted small' }, t('desktop.settings.explorerMenuHint')),
          ),
          toggle(s.explorerMenu, (on) => void api.setSettings({ explorerMenu: on })),
        )
      : null,
  );
}

/** The system-wide shortcut: press the keys to change it; refusals stay on screen. */
function shortcutSetting(s: SettingsView): HTMLElement {
  const current = s.globalShortcut;
  let shown = current.accelerator;
  const message = h('p', { class: 'error small', role: 'alert' });
  message.hidden = current.state !== 'taken';
  if (current.state === 'taken') message.textContent = t('desktop.settings.shortcutErrors.held');
  const show = (error: ShortcutProblem) => {
    message.textContent = t(`desktop.settings.shortcutErrors.${error}`);
    message.hidden = false;
  };
  const value = h(
    'button',
    { class: 'shortcut', type: 'button' },
    current.accelerator
      ? formatShortcut(current.accelerator, s.platform)
      : t('desktop.settings.shortcutOff'),
  );
  value.title = t('desktop.settings.shortcutChange');
  const stopRecording = () => {
    value.classList.remove('recording');
    value.textContent = shown
      ? formatShortcut(shown, s.platform)
      : t('desktop.settings.shortcutOff');
  };
  value.addEventListener('click', () => {
    value.classList.add('recording');
    value.textContent = t('desktop.settings.shortcutPress');
  });
  value.addEventListener('blur', stopRecording);
  value.addEventListener('keydown', (e) => {
    if (!value.classList.contains('recording')) return;
    e.preventDefault();
    if (e.code === 'Escape') {
      value.blur();
      return;
    }
    const accelerator = acceleratorFromKey(e, s.platform);
    if (!accelerator) return;
    void api.setGlobalShortcut(accelerator).then((r) => {
      message.hidden = true;
      if (r.ok) shown = accelerator;
      else show(r.error);
      stopRecording();
    });
  });
  return h(
    'div',
    { class: 'setting' },
    h(
      'div',
      {},
      h('div', { class: 'label' }, t('desktop.settings.shortcut')),
      h('div', { class: 'muted small' }, t('desktop.settings.shortcutHint')),
      message,
    ),
    h(
      'div',
      { class: 'row' },
      value,
      current.state === 'off'
        ? h(
            'button',
            { type: 'button', onclick: () => void api.setGlobalShortcut('default') },
            t('desktop.settings.shortcutDefault'),
          )
        : h(
            'button',
            { type: 'button', onclick: () => void api.setGlobalShortcut(null) },
            t('desktop.settings.shortcutDisable'),
          ),
    ),
  );
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

function pairCard(pair: SyncPair, status: PairStatus | undefined): HTMLElement {
  const state = pair.paused ? 'paused' : (status?.state ?? 'idle');
  const lines: Array<HTMLElement | null> = [];
  if (status?.error) {
    lines.push(
      h(
        'p',
        { class: 'error small' },
        t(`desktop.sync.errors.${status.error.code}`, status.error.details),
      ),
    );
  }
  if (status?.progress && status.progress.total > 0) {
    lines.push(
      h('div', { class: 'progress', role: 'presentation' }, h('i', {})),
      h('p', { class: 'small muted' }, t('desktop.sync.progress', status.progress)),
    );
  }
  lines.push(
    h(
      'p',
      { class: 'small muted' },
      status?.lastSyncAt
        ? [
            t('desktop.sync.lastSync', { time: formatTime(status.lastSyncAt) }),
            status.stats
              ? [
                  t('desktop.sync.uploaded', { count: status.stats.uploaded }),
                  t('desktop.sync.downloaded', { count: status.stats.downloaded }),
                  t('desktop.sync.conflicts', { count: status.stats.conflicts }),
                ].join(' · ')
              : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : t('desktop.sync.never'),
    ),
  );
  const onlineOnly = status?.skipped.filter((s) => s.reason === 'online_only').length ?? 0;
  if (onlineOnly > 0) {
    lines.push(
      h('p', { class: 'small muted' }, t('desktop.sync.onlineOnly', { count: onlineOnly })),
    );
  }
  if (status && status.skipped.length > 0) {
    lines.push(
      h(
        'details',
        {},
        h('summary', {}, t('desktop.sync.skipped', { count: status.skipped.length })),
        h(
          'ul',
          {},
          ...status.skipped
            .slice(0, 50)
            .map((s) => h('li', {}, `${s.path} (${t(`desktop.sync.skipReasons.${s.reason}`)})`)),
        ),
      ),
    );
  }
  if (status && status.failed.length > 0) {
    lines.push(
      h(
        'details',
        {},
        h('summary', {}, t('desktop.sync.failed', { count: status.failed.length })),
        h(
          'ul',
          {},
          ...status.failed.slice(0, 50).map((f) => h('li', {}, `${f.path}: ${f.message}`)),
        ),
      ),
    );
  }

  return h(
    'div',
    { class: 'card pair stack', 'data-pair': pair.id },
    h(
      'div',
      { class: 'row spread' },
      h(
        'div',
        {},
        h('div', { class: 'path' }, [pair.spaceName, pair.folderPath].filter(Boolean).join(' / ')),
        h('div', { class: 'local' }, pair.localPath),
      ),
      h('span', { class: `state ${state}` }, t(`desktop.sync.states.${state}`)),
    ),
    ...lines,
    h(
      'div',
      { class: 'row' },
      state === 'confirm'
        ? h(
            'button',
            { class: 'primary', onclick: () => void api.confirmDeletes(pair.id) },
            t('desktop.sync.confirmDeletes'),
          )
        : null,
      h(
        'button',
        { onclick: () => void api.syncNow(pair.id), disabled: pair.paused || state === 'syncing' },
        t('desktop.sync.syncNow'),
      ),
      h(
        'button',
        { onclick: () => void api.setPaused(pair.id, !pair.paused) },
        t(pair.paused ? 'desktop.sync.resume' : 'desktop.sync.pause'),
      ),
      h(
        'button',
        { onclick: () => void api.openPairFolder(pair.id) },
        t('desktop.sync.openFolder'),
      ),
      h(
        'button',
        {
          class: 'danger',
          onclick: () => {
            if (confirm(t('desktop.sync.removeConfirm'))) void api.removePair(pair.id);
          },
        },
        t('desktop.sync.remove'),
      ),
    ),
  );
}

/** The virtual drive's card; what went wrong with switching it on stays until the next try. */
let driveProblem: string | null = null;

function driveCard(drive: VirtualDriveView, redraw: () => void): HTMLElement {
  const statuses = drive.spaces.flatMap((sp) => (sp.status ? [sp.status] : []));
  const state =
    drive.state === 'running' ? overallState(statuses) : drive.state === 'error' ? 'error' : null;
  const lines: Array<HTMLElement | null> = [];
  if (driveProblem) lines.push(h('p', { class: 'error small', role: 'alert' }, driveProblem));
  if (drive.error) {
    lines.push(
      h(
        'p',
        { class: 'error small' },
        t(`desktop.sync.errors.${drive.error.code}`, drive.error.details),
      ),
    );
  }
  for (const f of drive.fetches) {
    const pct = f.total > 0 ? Math.round((f.done / f.total) * 100) : 0;
    lines.push(
      h('p', { class: 'small muted' }, t('desktop.sync.drive.fetching', { name: f.path, pct })),
    );
  }
  for (const space of drive.spaces) {
    const status = space.status;
    if (!status) continue;
    if (status.error) {
      lines.push(
        h(
          'p',
          { class: 'error small' },
          `${space.name}: ${t(`desktop.sync.errors.${status.error.code}`, status.error.details)}`,
        ),
      );
    }
    if (status.state === 'confirm') {
      lines.push(
        h(
          'button',
          { class: 'primary', onclick: () => void api.confirmVirtualDriveDeletes(status.id) },
          t('desktop.sync.confirmDeletes'),
        ),
      );
    }
    if (status.failed.length > 0) {
      lines.push(
        h(
          'details',
          {},
          h(
            'summary',
            {},
            `${space.name}: ${t('desktop.sync.failed', { count: status.failed.length })}`,
          ),
          h(
            'ul',
            {},
            ...status.failed.slice(0, 50).map((f) => h('li', {}, `${f.path}: ${f.message}`)),
          ),
        ),
      );
    }
  }

  const change = (on: boolean) => {
    if (!on && !confirm(t('desktop.sync.drive.offConfirm'))) {
      redraw();
      return;
    }
    driveProblem = null;
    void api.setVirtualDrive(on).then((result) => {
      driveProblem = result.ok ? null : t(`desktop.sync.drive.problems.${result.error}`);
      redraw();
    });
  };

  return h(
    'div',
    { class: 'card pair stack', 'data-pair': 'virtual-drive' },
    h(
      'div',
      { class: 'row spread' },
      h(
        'div',
        {},
        h('div', { class: 'path' }, t('desktop.sync.drive.title')),
        h('div', { class: 'local' }, drive.root),
      ),
      h(
        'div',
        { class: 'row' },
        state ? h('span', { class: `state ${state}` }, t(`desktop.sync.states.${state}`)) : null,
        toggle(drive.enabled, change),
      ),
    ),
    h('p', { class: 'small muted' }, t('desktop.sync.drive.hint')),
    ...lines,
    h(
      'div',
      { class: 'row' },
      drive.enabled
        ? h('button', { onclick: () => void api.openVirtualDrive() }, t('desktop.sync.openFolder'))
        : h(
            'button',
            {
              onclick: () => {
                driveProblem = null;
                void api.pickVirtualDriveFolder().then(redraw);
              },
            },
            t('desktop.sync.drive.changeFolder'),
          ),
      drive.enabled
        ? h(
            'button',
            { onclick: () => void api.syncVirtualDrive(), disabled: drive.state !== 'running' },
            t('desktop.sync.syncNow'),
          )
        : null,
    ),
  );
}

function syncTab(s: SettingsView, add: () => void, redraw: () => void): HTMLElement {
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'row spread' },
      h('h1', {}, t('desktop.settings.tabs.sync')),
      h('button', { class: 'primary', onclick: add }, t('desktop.sync.add')),
    ),
    s.virtualDrive ? driveCard(s.virtualDrive, redraw) : null,
    h('p', { class: 'muted' }, t('desktop.sync.intro')),
    s.pairs.length === 0 ? h('p', { class: 'muted' }, t('desktop.sync.empty')) : null,
    ...s.pairs.map((p) =>
      pairCard(
        p,
        s.statuses.find((x) => x.id === p.id),
      ),
    ),
  );
}

/** Space → Drive folder → local folder. */
async function pairWizard(box: HTMLElement, _s: SettingsView, done: () => void): Promise<void> {
  const error = h('p', { class: 'error', role: 'alert' });
  const cancel = () => h('button', { onclick: done }, t('desktop.sync.cancel'));

  const spaces = await api.listSpaces().catch((): SpaceView[] => []);
  /** Each wizard step settles in; the list of a folder rises in item by item. */
  const step = () => {
    enter(box, { y: 4, ms: 180 });
    stagger(box.querySelector('.list'), 20);
  };

  const chooseSpace = () => {
    mount(
      box,
      h('h1', {}, t('desktop.sync.chooseSpace')),
      h(
        'div',
        { class: 'list' },
        ...spaces.map((sp) => h('button', { onclick: () => void browse(sp, []) }, sp.name)),
      ),
      error,
      h('div', { class: 'row' }, cancel()),
    );
    step();
  };

  const browse = async (space: SpaceView, trail: FolderView[]) => {
    const parent = trail.at(-1) ?? null;
    const folders = await api
      .listFolders(space.id, parent?.id ?? null)
      .catch((): FolderView[] => []);
    mount(
      box,
      h('h1', {}, t('desktop.sync.chooseFolder')),
      h('p', { class: 'crumbs' }, [space.name, ...trail.map((f) => f.name)].join(' / ')),
      space.canEdit ? null : h('p', { class: 'error small' }, t('desktop.sync.readOnly')),
      folders.length === 0
        ? h('p', { class: 'muted' }, t('desktop.sync.noFolders'))
        : h(
            'div',
            { class: 'list' },
            ...folders.map((f) =>
              h('button', { onclick: () => void browse(space, [...trail, f]) }, f.name),
            ),
          ),
      error,
      h(
        'div',
        { class: 'row spread' },
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              onclick: () =>
                trail.length ? void browse(space, trail.slice(0, -1)) : chooseSpace(),
            },
            t('desktop.sync.back'),
          ),
          cancel(),
        ),
        h(
          'button',
          {
            class: 'primary',
            onclick: () =>
              void chooseLocal({
                spaceId: space.id,
                spaceName: space.name,
                folderId: parent?.id ?? null,
                folderPath: trail.map((f) => f.name).join(' / '),
                localPath: '',
              }),
          },
          trail.length ? t('desktop.sync.useThisFolder') : t('desktop.sync.wholeSpace'),
        ),
      ),
    );
    step();
  };

  const chooseLocal = async (pair: NewPair) => {
    const path = await api.pickLocalFolder();
    if (!path) return;
    const result = await api.addPair({ ...pair, localPath: path });
    if (result.ok) done();
    else error.textContent = t(`desktop.sync.errors.${result.error}`);
  };

  chooseSpace();
}

function aboutTab(s: SettingsView): HTMLElement {
  const u = s.update;
  const status =
    u.state === 'available' || u.state === 'downloaded'
      ? t(`desktop.settings.update.${u.state}`, { version: u.version })
      : t(`desktop.settings.update.${u.state}`);
  return h(
    'div',
    { class: 'stack' },
    productLogo(),
    h('h1', {}, s.brand?.appName ?? 'Crewhall'),
    h('p', { class: 'muted' }, t('desktop.settings.version', { version: s.version })),
    h('h2', {}, t('desktop.settings.updates')),
    h('p', { class: 'update-status' }, status),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          onclick: () => void api.checkUpdates(),
          disabled: u.state === 'disabled' || u.state === 'checking',
        },
        t('desktop.settings.checkUpdates'),
      ),
      u.state === 'downloaded'
        ? h(
            'button',
            { class: 'primary install-update', onclick: () => void api.installUpdate() },
            t('desktop.settings.installUpdate'),
          )
        : null,
    ),
    h('p', { class: 'muted small' }, t('desktop.settings.unsignedNote')),
  );
}

// ---- remote control -------------------------------------------------------------------------

/** "<name> wants to control your screen · Allow / Decline" (always on top, 30 s, then declined). */
function controlRequestView(): void {
  const name = params.get('name') ?? '';
  document.title = t('desktop.control.requestTitle', { name });
  const give = h(
    'button',
    { class: 'primary', onclick: () => void api.answerControl(true) },
    t('desktop.control.give'),
  );
  mount(
    root,
    h(
      'div',
      { class: 'dialog stack' },
      h('h2', {}, t('desktop.control.requestTitle', { name })),
      h('p', { class: 'muted' }, t('desktop.control.requestBody')),
      h(
        'div',
        { class: 'row end' },
        h('button', { onclick: () => void api.answerControl(false) }, t('desktop.control.deny')),
        give,
      ),
    ),
  );
  stagger(root.firstElementChild);
  // No default action on Enter: a stray key press must never hand over the screen.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void api.answerControl(false);
  });
}

/** macOS without the Accessibility permission: say why and open the settings. */
function controlPermissionView(): void {
  const name = params.get('name') ?? '';
  const app = params.get('app') ?? 'Crewhall';
  document.title = t('desktop.control.permissionTitle');
  mount(
    root,
    h(
      'div',
      { class: 'dialog stack' },
      h('h2', {}, t('desktop.control.permissionTitle')),
      h('p', { class: 'muted' }, t('desktop.control.permissionBody', { name, app })),
      h(
        'div',
        { class: 'row end' },
        h('button', { onclick: () => void api.answerControl(false) }, t('desktop.control.close')),
        h(
          'button',
          { class: 'primary', onclick: () => void api.openAccessibilitySettings() },
          t('desktop.control.openSettings'),
        ),
      ),
    ),
  );
  stagger(root.firstElementChild);
}

/** The band on top of the controlled screen: who, how to take it back, Stop. */
function controlBannerView(): void {
  const name = params.get('name') ?? '';
  document.documentElement.classList.add('overlay');
  document.title = t('desktop.control.banner', { name });
  mount(
    root,
    h(
      'div',
      { class: 'control-band', role: 'status' },
      h('span', { class: 'live', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'band-text' },
        h('strong', {}, t('desktop.control.banner', { name })),
        h('span', {}, t('desktop.control.shortcutHint')),
      ),
      h(
        'button',
        { class: 'stop', onclick: () => void api.stopControl() },
        t('desktop.control.stop'),
      ),
    ),
  );
  enter(root.firstElementChild, { y: -8, ms: 220 });
}

/** A frame around the controlled screen; clicks pass through it. */
function controlBorderView(): void {
  document.documentElement.classList.add('overlay');
  mount(root, h('div', { class: 'control-frame', 'aria-hidden': 'true' }));
}

// ---- start --------------------------------------------------------------------------------

async function main(): Promise<void> {
  const i18n = await api.i18n();
  locale = i18n.locale;
  t = createTranslator(i18n.locale, i18n.messages);
  document.documentElement.lang = i18n.locale;
  const view = (params.get('view') ?? 'setup') as View;
  if (view === 'setup') setupView();
  else if (view === 'loading') loadingView();
  else if (view === 'offline') offlineView();
  else if (view === 'outdated') await outdatedView();
  else if (view === 'picker') await pickerView();
  else if (view === 'send') await sendView();
  else if (view === 'control-request') controlRequestView();
  else if (view === 'control-permission') controlPermissionView();
  else if (view === 'control-banner') controlBannerView();
  else if (view === 'control-border') controlBorderView();
  else await settingsView();
}

void main();
