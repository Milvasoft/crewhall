import { LOCALES } from '@crewhall/i18n';
import {
  Avatar,
  Chip,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Icon,
  IconButton,
  Kbd,
  type IconName,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { openStatusDialog } from '@/components/chat/dialogs';
import { openAsk } from '@/lib/ai/ask';
import { useAiAvailability } from '@/lib/ai/availability';
import { chatEnabled } from '@/lib/chat/enabled';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { searchQuery } from '@/features/drive/api';
import { plainSnippet } from '@/features/drive/pages/SearchPage';
import { nodeIcon } from '@/features/drive/fileKinds';
import { nodeLocation } from '@/features/drive/paths';
import { spaceName, spaceSubtitle } from '@/components/spaces/spaceUtils';
import { openDialog } from '@/lib/dialogs';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { enabledModules, isNodeTypeEnabled } from '@/lib/identity/modules';
import { signOutWithSso } from '@/lib/identity/signOut';
import { useExit } from '@/lib/motion';
import { setPaletteOpen, usePaletteOpen } from '@/lib/palette';
import { readLastSite, setPublishOpen } from '@/lib/portal/context';
import { membersQuery, spacesQuery } from '@/lib/queries';
import { canOpenRoute, ROUTE_CATALOG, routeOfPath, type RouteId } from '@/lib/routes/catalog';
import { categoryKey, useLocalizedTool } from '@/features/tools/i18n';
import { getAllDefinitions as getAllToolDefinitions } from '@/features/tools/lib/registry';
import { ROUTE_LABELS } from '@/lib/routes/labels';
import { useRecentRoutes } from '@/lib/routes/recent';
import { fold, matchScore } from '@/lib/routes/search';
import { usePermissions } from '@/lib/session';
import { useShellLayout } from '@/lib/shell';
import { useTheme } from '@/lib/theme/ThemeContext';
import { useVersion } from '@/lib/useVersion';

type Kind = 'all' | 'file' | 'drawing' | 'space' | 'person' | 'page' | 'command';
const KINDS: Kind[] = ['all', 'file', 'drawing', 'space', 'person', 'page', 'command'];

interface Entry {
  id: string;
  kind: Exclude<Kind, 'all'>;
  label: string;
  meta?: string;
  icon?: IconName;
  lead?: ReactNode;
  shortcut?: string;
  /** Catalogue page ("Git"): searched with its synonyms, recent ones first. */
  route?: RouteId;
  keywords?: readonly string[];
  run: () => void;
}

/** Shown on an empty palette before anything was visited (and after the recent ones). */
const SHORTCUTS: RouteId[] = [
  'notifications',
  'account.approvals',
  'account.profile',
  'admin.general',
];

/**
 * Ctrl K palette (doc 02 · 2.9): Drive nodes (names and file contents, only what the person can see),
 * spaces, people, every page and settings page one may open ("Git", lib/routes/catalog) and
 * commands. Tab cycles the type filter, ">" shows commands only, "/" pages only. Empty, it shows
 * the recently visited pages and a few shortcuts.
 */
export function CommandPalette() {
  const open = usePaletteOpen();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(!open);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // The body stays for the close animation, then unmounts so the next open starts empty.
  const body = useExit(open, 160);
  return (
    <Dialog open={open} onOpenChange={setPaletteOpen}>
      {body.mounted ? <PaletteBody /> : null}
    </Dialog>
  );
}

function PaletteBody() {
  const { t, locale, setLocale } = useI18n();
  const localizeTool = useLocalizedTool();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me, canOrg, role } = usePermissions();
  const { scheme, setAppearance } = useTheme();
  const phone = useShellLayout() === 'phone';
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const spaces = useQuery(spacesQuery());
  const people = useQuery(membersQuery({ status: 'active' }));
  const meetOn = enabledModules(me).has('meet');
  const ai = useAiAvailability();
  const version = useVersion();
  const versionMeta = version.lines.join(' · ');

  const commandsOnly = search.startsWith('>');
  const pagesOnly = search.startsWith('/');
  const effectiveKind: Kind = commandsOnly ? 'command' : pagesOnly ? 'page' : kind;
  const term = commandsOnly || pagesOnly ? search.slice(1).trim() : search;
  const recent = useRecentRoutes();
  const here = routeOfPath(useRouterState({ select: (s) => s.location.pathname }));
  const [nodeTerm, setNodeTerm] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setNodeTerm(term.trim()), 200);
    return () => clearTimeout(id);
  }, [term]);
  const nodes = useQuery({
    ...searchQuery({ q: nodeTerm, limit: 8 }),
    enabled:
      nodeTerm.length > 1 &&
      (effectiveKind === 'all' || effectiveKind === 'file' || effectiveKind === 'drawing'),
    retry: false,
  });

  const close = () => setPaletteOpen(false);
  const go = (to: string, params?: Record<string, string>) => {
    close();
    void navigate({ to, params });
  };

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    for (const h of nodes.data?.items ?? []) {
      if (!isNodeTypeEnabled(me, h.node.type)) continue;
      const slug = spaces.data?.items.find((x) => x.id === h.space.id)?.slug;
      list.push({
        id: `node-${h.node.id}`,
        // Drawings are their own module: their own group and Tab filter.
        kind: h.node.type === 'drawing' ? 'drawing' : 'file',
        label: h.node.name,
        // Content matches (roadmap 10) show where in the text the words are.
        meta:
          h.matchedIn === 'content' && h.snippet
            ? `${t('drive.search.inContent')}: ${plainSnippet(h.snippet)}`
            : [h.space.name, ...h.path.map((p) => p.name)].join(' › '),
        icon: nodeIcon(h.node),
        run: () => {
          close();
          if (h.node.type === 'board') {
            void navigate({ to: '/b/$boardId', params: { boardId: h.node.id } });
          } else if (h.node.type === 'drawing') {
            void navigate({ to: '/d/$drawingId', params: { drawingId: h.node.id } });
          } else if (slug) {
            void navigate(nodeLocation(h.node, slug));
          }
        },
      });
    }
    for (const s of spaces.data?.items ?? []) {
      list.push({
        id: `space-${s.id}`,
        kind: 'space',
        label: spaceName(s, t),
        meta: spaceSubtitle(s, t),
        lead: <SpaceAvatar space={s} size="sm" />,
        run: () => go('/$module/$spaceSlug', { module: 'drive', spaceSlug: s.slug }),
      });
    }
    for (const m of people.data?.items ?? []) {
      if (m.user.id === me?.user.id) continue;
      list.push({
        id: `person-${m.user.id}`,
        kind: 'person',
        label: m.user.name,
        meta: `${m.user.email} · ${t(`common.roles.org.${m.role}`)}`,
        lead: <Avatar name={m.user.name} size="sm" />,
        run: () =>
          canOrg('org.manage_members')
            ? go('/admin/members/$userId', { userId: m.user.id })
            : close(),
      });
    }
    const enabled = enabledModules(me);
    const viewer = {
      role,
      installAdmin: me?.installAdmin === true,
      modules: enabled,
      can: canOrg,
    };
    for (const r of ROUTE_CATALOG) {
      if (!canOpenRoute(r, viewer)) continue;
      const { label, icon } = ROUTE_LABELS[r.id];
      const parent = 'parent' in r ? r.parent : undefined;
      list.push({
        id: `route-${r.id}`,
        kind: 'page',
        label: t(label),
        meta: parent ? t(ROUTE_LABELS[parent].label) : undefined,
        icon,
        route: r.id,
        keywords: r.keywords,
        run: () => go(r.path),
      });
    }
    // Every tool is a "Git" entry: typed names and keywords in both languages find it.
    if (enabled.has('tools')) {
      for (const def of getAllToolDefinitions()) {
        const tool = localizeTool(def);
        list.push({
          id: `tool-${def.id}`,
          kind: 'page',
          label: tool.name,
          meta: `${t('tools.title')} › ${t(categoryKey(def.category, 'name'))}`,
          icon: 'tool',
          keywords: tool.keywords,
          run: () => go('/tools/$toolId', { toolId: def.id }),
        });
      }
    }
    if (enabled.has('portal') && (canOrg('portal.edit') || canOrg('portal.publish'))) {
      const site = readLastSite();
      const portalPages: [MessageKey, string, IconName][] = [
        ['portal.palette.docs', '/portal/$siteSlug/docs', 'page'],
        ['portal.palette.blog', '/portal/$siteSlug/blog', 'edit'],
      ];
      for (const [key, to, icon] of portalPages) {
        if (to.includes('$siteSlug') && !site) continue;
        list.push({
          id: `page-${to}`,
          kind: 'page',
          label: t(key),
          icon,
          run: () => go(to, site ? { siteSlug: site } : undefined),
        });
      }
      if (canOrg('portal.publish')) {
        list.push({
          id: 'cmd-portal-publish',
          kind: 'command',
          label: t('portal.palette.publish'),
          icon: 'upload',
          run: () => {
            close();
            void navigate({ to: '/portal' }).then(() => setPublishOpen(true));
          },
        });
      }
    }
    list.push({
      id: 'cmd-add-link',
      kind: 'command',
      label: t('palette.cmd.addLink'),
      icon: 'link',
      shortcut: 'L',
      run: () => {
        close();
        void navigate({ to: '/' }).then(() => openDialog('addLink'));
      },
    });
    if (canOrg('org.create_space')) {
      list.push({
        id: 'cmd-new-space',
        kind: 'command',
        label: t('palette.cmd.newSpace'),
        icon: 'plus',
        run: () => {
          close();
          openDialog('newSpace');
        },
      });
    }
    if (canOrg('org.invite')) {
      list.push({
        id: 'cmd-invite',
        kind: 'command',
        label: t('palette.cmd.invite'),
        icon: 'userPlus',
        run: () => {
          close();
          void navigate({ to: '/admin/members', search: { invite: true } });
        },
      });
    }
    // Chat module commands (design 04, 19.15, 19.17); new chat only while chat is on.
    if (chatEnabled(me)) {
      list.push({
        id: 'cmd-new-chat',
        kind: 'command',
        label: t('chat.list.newChat'),
        icon: 'compose',
        run: () => {
          close();
          void navigate({ to: '/chat/new' });
        },
      });
    }
    // Meet module (design 07): new meeting.
    if (role !== 'guest' && meetOn) {
      list.push({
        id: 'cmd-new-meeting',
        kind: 'command',
        label: t('meet.actions.new'),
        icon: 'video',
        run: () => {
          close();
          void navigate({ to: '/meetings', search: { new: 'now' } });
        },
      });
      list.push({
        id: 'cmd-schedule-meeting',
        kind: 'command',
        label: t('palette.cmd.scheduleMeeting'),
        icon: 'calendar',
        run: () => {
          close();
          void navigate({ to: '/meetings', search: { new: 'schedule' } });
        },
      });
    }
    // Mail module (roadmap 24): new e-mail.
    if (role !== 'guest' && enabledModules(me).has('mail')) {
      list.push({
        id: 'cmd-new-mail',
        kind: 'command',
        label: t('mail.palette.compose'),
        icon: 'mail',
        run: () => {
          close();
          void navigate({ to: '/mail', search: { new: 1 } });
        },
      });
    }
    list.push(
      {
        id: 'cmd-status',
        kind: 'command',
        label: t('chat.status.title'),
        icon: 'smile',
        shortcut: 'Alt S',
        run: () => {
          close();
          openStatusDialog(true);
        },
      },
      {
        id: 'cmd-notifications',
        kind: 'command',
        label: t('shell.notifications'),
        icon: 'bell',
        run: () => {
          close();
          void navigate({ to: '/notifications' });
        },
      },
    );
    list.push({
      id: 'cmd-theme',
      kind: 'command',
      label: t(scheme === 'dark' ? 'shell.lightMode' : 'shell.darkMode'),
      icon: scheme === 'dark' ? 'sun' : 'moon',
      run: () => {
        setAppearance(scheme === 'dark' ? 'light' : 'dark');
        close();
      },
    });
    for (const l of LOCALES) {
      if (l === locale) continue;
      list.push({
        id: `cmd-lang-${l}`,
        kind: 'command',
        label: t('palette.cmd.language', { language: t(`prefs.languages.${l}`) }),
        icon: 'lang',
        run: () => {
          setLocale(l);
          close();
        },
      });
    }
    list.push({
      id: 'cmd-version',
      kind: 'command',
      label: t('shell.version.title'),
      meta: versionMeta,
      icon: 'info',
      run: () => {
        close();
        version.copy();
      },
    });
    list.push({
      id: 'cmd-signout',
      kind: 'command',
      label: t('shell.signOut'),
      icon: 'logout',
      run: () => {
        close();
        void signOutWithSso(qc).then((left) => {
          if (!left) void navigate({ to: '/login' });
        });
      },
    });
    return list;
    // `go` and `close` are stable enough for a palette that rebuilds on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.data, spaces.data, people.data, me, scheme, locale, t, versionMeta]);

  const needle = term.trim();
  const folded = fold(needle);
  // Pages match their synonyms too and rank (recently visited ones first); the rest by name.
  const score = (e: Entry): number => {
    // Node hits come filtered by the server (name search across spaces).
    if (!needle || e.kind === 'file' || e.kind === 'drawing') return 1;
    if (e.route) {
      const s = matchScore(needle, { label: e.label, crumb: e.meta, keywords: e.keywords });
      return s && (recent.includes(e.route) ? s + 150 : s);
    }
    return fold(e.label).includes(folded) || fold(e.meta ?? '').includes(folded) ? 1 : 0;
  };
  const ranked = entries
    .filter((e) => effectiveKind === 'all' || e.kind === effectiveKind)
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s > 0);
  const filtered = [
    ...ranked.filter((x) => x.e.kind === 'page').sort((a, b) => b.s - a.s),
    ...ranked.filter((x) => x.e.kind !== 'page'),
  ].map((x) => x.e);
  // "Crewhall'a sor" (yol haritası #11): the typed text as a question to the AI side panel.
  // Offered for question-like text (three words or a question mark) so name searches stay as they were.
  const question = term.trim();
  const looksLikeQuestion = question.split(/\s+/).length >= 3 || question.endsWith('?');
  if (ai.usable && looksLikeQuestion && (effectiveKind === 'all' || effectiveKind === 'command')) {
    filtered.unshift({
      id: 'ai-ask',
      kind: 'command',
      label: t('ai.ask.palette', { q: question }),
      icon: 'sparkle',
      run: () => {
        close();
        openAsk(question);
      },
    });
  } else if (
    ai.setupHint &&
    looksLikeQuestion &&
    (effectiveKind === 'all' || effectiveKind === 'command')
  ) {
    filtered.unshift({
      id: 'ai-ask',
      kind: 'command',
      label: t('ai.setup.palette'),
      icon: 'sparkle',
      run: () => go('/admin/ai'),
    });
  }
  // Typing: "Git" (pages) first. Empty: recently visited pages, a few shortcuts and the commands.
  let sections: { key: string; heading: string; items: Entry[] }[];
  if (!needle && effectiveKind === 'all') {
    const byRoute = new Map(filtered.flatMap((e) => (e.route ? [[e.route, e] as const] : [])));
    const pick = (ids: RouteId[]) =>
      ids.flatMap((id) => {
        const e = id === here ? undefined : byRoute.get(id);
        return e ? [e] : [];
      });
    const recentItems = pick(recent).slice(0, 5);
    const shortcuts = pick(SHORTCUTS).filter((e) => !recentItems.includes(e));
    sections = [
      { key: 'recent', heading: t('palette.groups.recent'), items: recentItems },
      { key: 'shortcuts', heading: t('palette.groups.shortcuts'), items: shortcuts },
      {
        key: 'command',
        heading: t('palette.groups.command'),
        items: filtered.filter((e) => e.kind === 'command'),
      },
    ];
  } else {
    const order: Exclude<Kind, 'all'>[] = needle
      ? ['page', 'file', 'drawing', 'space', 'person', 'command']
      : ['file', 'drawing', 'space', 'person', 'page', 'command'];
    sections = order.map((g) => ({
      key: g,
      heading: t(`palette.groups.${g}`),
      items: filtered.filter((e) => e.kind === g),
    }));
  }
  const shown = sections.flatMap((x) => x.items);

  return (
    <DialogContent
      width={640}
      className="top-[96px] translate-y-0 gap-0 overflow-hidden rounded-3xl border border-glass-line p-0"
      overlayClassName="bg-scrim"
      aria-describedby={undefined}
    >
      <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
      <Command shouldFilter={false} loop className={phone ? 'flex-1' : undefined}>
        {/* Phone (H10): chips get their own row, a close button stands in for Escape. */}
        <div className={phone ? 'flex items-center pr-2' : 'relative'}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t('palette.placeholder')}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault();
                const i = KINDS.indexOf(kind);
                setKind(KINDS[(i + (e.shiftKey ? KINDS.length - 1 : 1)) % KINDS.length] ?? 'all');
              }
            }}
          />
          {phone ? (
            <DialogClose asChild>
              <IconButton size="sm" tone="plain" aria-label={t('common.actions.close')}>
                <Icon name="x" size={18} />
              </IconButton>
            </DialogClose>
          ) : null}
          <div
            className={phone ? 'hidden' : 'absolute top-1/2 right-3 flex -translate-y-1/2 gap-1'}
          >
            {KINDS.map((k) => (
              <Chip
                key={k}
                size="sm"
                on={effectiveKind === k}
                onClick={() => setKind(k)}
                tabIndex={-1}
              >
                {t(`palette.kinds.${k}`)}
              </Chip>
            ))}
          </div>
        </div>
        {phone ? (
          <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-3 py-2 [scrollbar-width:none]">
            {KINDS.map((k) => (
              <Chip key={k} size="sm" on={effectiveKind === k} onClick={() => setKind(k)}>
                {t(`palette.kinds.${k}`)}
              </Chip>
            ))}
          </div>
        ) : null}
        <CommandList className={phone ? 'max-h-none flex-1' : undefined}>
          <CommandEmpty className="px-3 py-8 text-center text-sm text-fg2">
            {t('palette.empty')}
          </CommandEmpty>
          {sections.map(({ key, heading, items }) => {
            if (!items.length) return null;
            return (
              <CommandGroup key={key} heading={heading}>
                {items.map((e) => (
                  <CommandItem key={`${key}-${e.id}`} value={`${key}-${e.id}`} onSelect={e.run}>
                    {e.lead ?? (
                      <span className="flex size-6 items-center justify-center rounded-[7px] bg-bg2 text-fg2">
                        <Icon name={e.icon ?? 'arrowR'} size={14} />
                      </span>
                    )}
                    <Highlight text={e.label} term={needle} />
                    {e.meta ? <span className="truncate text-cap text-fg3">{e.meta}</span> : null}
                    {e.shortcut ? <Kbd className="ml-auto">{e.shortcut}</Kbd> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
        </CommandList>
        <footer className="flex h-11 items-center gap-4 border-t border-line px-4 text-xs text-fg2 max-md:hidden">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd>
            {t('palette.hint.move')}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            {t('palette.hint.open')}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Tab</Kbd>
            {t('palette.hint.filter')}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>&gt;</Kbd>
            {t('palette.hint.commands')}
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>/</Kbd>
            {t('palette.hint.pages')}
          </span>
          <span className="ml-auto tn">
            {t('palette.count', { count: shown.filter((e) => e.id !== 'ai-ask').length })}
          </span>
        </footer>
      </Command>
    </DialogContent>
  );
}

/** Underlines the match (doc 02 · 2.9); "zeka" underlines "zekâ" too. */
function Highlight({ text, term }: { text: string; term: string }) {
  const i = term ? fold(text).indexOf(fold(term)) : -1;
  if (i < 0) return <span className="truncate font-medium">{text}</span>;
  return (
    <span className="truncate font-medium">
      {text.slice(0, i)}
      <span className="underline decoration-fg underline-offset-[3px]">
        {text.slice(i, i + term.length)}
      </span>
      {text.slice(i + term.length)}
    </span>
  );
}
