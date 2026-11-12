import {
  CHAT_LIMITS,
  MESSAGE_REF_LIMITS,
  parseSlashCommand,
  type ChatCommand,
  type GifResult,
  type ResolvedRef,
  type UserSummary,
} from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  Kbd,
  SuggestionPanel,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { addUploads, cancelUpload, useUploads } from '@/features/drive/uploads';
import { api } from '@/lib/api';
import { excerptOf, nameOf, rememberPeople } from '@/lib/chat/names';
import { enqueue, uploadedNodeIds, type PendingAttachment } from '@/lib/chat/outbox';
import { membersQuery } from '@/lib/chat/queries';
import { refFromUrl, refSearchQuery } from '@/lib/chat/refs';
import { sendTyping, useSocketState } from '@/lib/chat/runtime';
import { getPresence } from '@/lib/chat/stores';
import { ALL, MENTION_RE } from '@/lib/chat/text';
import { type Conversation, type Message, type QuotedMessage } from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useDebounced } from '@/lib/useDebounced';
import { useMessageActions } from './actions';
import {
  COMMAND_ICONS,
  PollDialog,
  useAvailableCommands,
  useSlashCommands,
  type CommandOutcome,
} from './commands';
import { EmojiPicker } from './EmojiPicker';
import { GifPicker, toMessageGif, useGifEnabled } from './gif';
import { ScheduleDialog, ScheduledBar, ScheduleMenu, scheduledKey, useWhen } from './scheduled';
import { REF_ICON } from './RefCards';
import { matchPluginCommand, usePluginSurfaces } from '@/components/plugins/surfaces';

interface Mention {
  label: string;
  id: string;
}

interface Draft {
  text: string;
  mentions: Mention[];
}

/** Unsent text per chat survives switching chats (memory only). */
const drafts = new Map<string, Draft>();
/** References waiting in each chat's box, like its draft. */
const refDrafts = new Map<string, ResolvedRef[]>();
const folders = new Map<string, Promise<{ spaceId: string; folderId: string }>>();

function toTokens(text: string, mentions: Mention[]): string {
  let out = text;
  for (const m of [...mentions].sort((a, b) => b.label.length - a.label.length)) {
    out = out.split(`@${m.label}`).join(`<@${m.id}>`);
  }
  return out;
}

function fromTokens(text: string, allLabel: string): Draft {
  const mentions: Mention[] = [];
  const out = text.replace(MENTION_RE, (_, id: string) => {
    const label = id === ALL ? allLabel : (nameOf(id) ?? id);
    if (!mentions.some((m) => m.id === id)) mentions.push({ label, id });
    return `@${label}`;
  });
  return { text: out, mentions };
}

export function quoteOf(m: Message): QuotedMessage {
  return {
    id: m.id,
    seq: m.seq,
    author: m.author,
    webhookName: m.webhook?.name ?? null,
    guestAuthor: m.guestAuthor ?? null,
    excerpt: excerptOf(m).slice(0, 200),
    hasAttachments: m.attachments.length > 0,
    deleted: false,
  };
}

export interface ComposerHandle {
  focus: () => void;
  insert: (text: string) => void;
  addFiles: (files: File[]) => void;
}

interface Staged extends PendingAttachment {
  key: string;
}

/** Writing box (4.1, 4.2, 4.4, 4.18): Enter sends, Shift+Enter new line, @ suggests people. */
export const Composer = forwardRef<
  ComposerHandle,
  {
    conv: Conversation;
    me: string;
    reply: Message | null;
    onClearReply: () => void;
    editing: Message | null;
    onDoneEdit: () => void;
    onEditLast: () => void;
    onSent: () => void;
    placeholder: string;
  }
>(function Composer(
  { conv, me, reply, onClearReply, editing, onDoneEdit, onEditLast, onSent, placeholder },
  ref,
) {
  const { t, locale } = useI18n();
  const act = useMessageActions();
  const socket = useSocketState();
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const initial = drafts.get(conv.id) ?? { text: '', mentions: [] };
  const [text, setText] = useState(initial.text);
  const [mentions, setMentions] = useState<Mention[]>(initial.mentions);
  // Internal references to send with the message; none in a chat shared with another
  // installation, whose people could not open them.
  const refsOn = !conv.federation;
  const [refs, setRefsState] = useState<ResolvedRef[]>(refDrafts.get(conv.id) ?? []);
  const setRefs = (next: ResolvedRef[]) => {
    setRefsState(next);
    if (next.length) refDrafts.set(conv.id, next);
    else refDrafts.delete(conv.id);
  };
  const [refPopup, setRefPopup] = useState<{ query: string; start: number } | null>(null);
  const refQuery = useDebounced(refPopup?.query.trim() ?? '', 200);
  // The last results stay while the next ones load: no flicker, no option lost under the pointer.
  const refSearch = useQuery({
    ...refSearchQuery(refQuery),
    enabled: refPopup !== null,
    placeholderData: (previous) => previous,
  });
  const refCandidates = useMemo(
    () =>
      refPopup === null
        ? []
        : (refSearch.data?.items ?? []).filter(
            (c) => !refs.some((r) => r.kind === c.kind && r.id === c.id),
          ),
    [refPopup, refSearch.data, refs],
  );
  const [staged, setStaged] = useState<Staged[]>([]);
  const [popup, setPopup] = useState<{ query: string; start: number } | null>(null);
  /** The `/` command menu (roadmap 23): open while the first word is being typed. */
  const [cmdQuery, setCmdQuery] = useState<string | null>(null);
  const [pollDraft, setPollDraft] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  /** "Daha sonra gönder": the menu, and the picker (with its own text for `/zamanla`). */
  const [scheduleMenu, setScheduleMenu] = useState(false);
  /** GIF picker: open, and the search `/gif <kelime>` opened it with. */
  const [gifPicker, setGifPicker] = useState<{ query: string } | null>(null);
  const gifOn = useGifEnabled();
  const [scheduleDialog, setScheduleDialog] = useState<{
    draft: Draft | null;
    at: Date | null;
  } | null>(null);
  const qc = useQueryClient();
  const when = useWhen();
  const [index, setIndex] = useState(0);
  const [confirmAll, setConfirmAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const uploads = useUploads();
  const allLabel = t('chat.mention.allName');
  const commands = useAvailableCommands(conv);
  const runCommand = useSlashCommands(conv, setPollDraft);
  const pluginSurfaces = usePluginSurfaces();
  const cmdCandidates = useMemo(
    () => (cmdQuery === null ? [] : commands.filter((c) => c.startsWith(cmdQuery.toLowerCase()))),
    [cmdQuery, commands],
  );

  // Starting an edit loads the message once (render-time sync with the prop, no effect).
  if (editing && editing.id !== editingId) {
    const d = fromTokens(editing.text, allLabel);
    setEditingId(editing.id);
    setText(d.text);
    setMentions(d.mentions);
  } else if (!editing && editingId) {
    setEditingId(null);
    const d = drafts.get(conv.id) ?? { text: '', mentions: [] };
    setText(d.text);
    setMentions(d.mentions);
  }

  const { data: members } = useQuery({
    ...membersQuery(conv.id),
    enabled: conv.type !== 'direct' || popup !== null,
  });

  const candidates = useMemo(() => {
    if (!popup) return [];
    const q = popup.query.toLocaleLowerCase(locale);
    const people: (UserSummary & { group?: boolean })[] = (members ?? [])
      .map((m) => m.user)
      .filter((u) => u.id !== me)
      .filter(
        (u) =>
          !q ||
          u.name
            .toLocaleLowerCase(locale)
            .split(/\s+/)
            .some((p) => p.startsWith(q)) ||
          u.name.toLocaleLowerCase(locale).startsWith(q),
      )
      .sort((a, b) => {
        const on = (id: string) => (getPresence(id)?.state === 'online' ? 0 : 1);
        return on(a.id) - on(b.id) || a.name.localeCompare(b.name, locale);
      })
      .slice(0, 8);
    const out: { id: string; label: string; user?: UserSummary }[] = people.map((u) => ({
      id: u.id,
      label: u.name,
      user: u,
    }));
    if (conv.memberCount >= 3 && (!q || allLabel.toLocaleLowerCase(locale).startsWith(q))) {
      out.push({ id: ALL, label: allLabel });
    }
    return out;
  }, [popup, members, me, locale, conv.memberCount, allLabel]);

  const save = (next: string, ms: Mention[]) => {
    if (!editing) drafts.set(conv.id, { text: next, mentions: ms });
  };

  const detect = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const cmd = editing ? null : /^\/([a-z]{0,12})$/i.exec(before);
    if (cmd) {
      if (cmdQuery !== cmd[1]) setIndex(0);
      setCmdQuery(cmd[1] ?? '');
      if (popup) setPopup(null);
      return;
    }
    if (cmdQuery !== null) setCmdQuery(null);
    // `[[`: an item to refer to (text after it filters; `]` or a line break ends it).
    const ref = refsOn && !editing ? /(^|\s)\[\[([^[\]\n]{0,60})$/.exec(before) : null;
    if (ref) {
      setRefPopup({ query: ref[2] ?? '', start: caret - (ref[2]?.length ?? 0) - 2 });
      setIndex(0);
      if (popup) setPopup(null);
      return;
    }
    if (refPopup) setRefPopup(null);
    const m = /(^|\s)@([\p{L}\d._-]{0,30})$/u.exec(before);
    if (m) {
      setPopup({ query: m[2] ?? '', start: caret - (m[2]?.length ?? 0) - 1 });
      setIndex(0);
    } else if (popup) {
      setPopup(null);
    }
  };

  const pick = (c: { id: string; label: string; user?: UserSummary }) => {
    if (!popup) return;
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, popup.start)}@${c.label} ${text.slice(caret)}`;
    const ms = mentions.some((m) => m.id === c.id)
      ? mentions
      : [...mentions, { label: c.label, id: c.id }];
    if (c.user) rememberPeople([c.user]);
    setText(next);
    setMentions(ms);
    save(next, ms);
    setPopup(null);
    const pos = popup.start + c.label.length + 2;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const addRef = (r: ResolvedRef) => {
    if (refs.some((x) => x.kind === r.kind && x.id === r.id)) return;
    if (refs.length >= MESSAGE_REF_LIMITS.perMessage) {
      toast.error(t('chat.refs.tooMany', { max: MESSAGE_REF_LIMITS.perMessage }));
      return;
    }
    setRefs([...refs, r]);
  };

  /** A picked item replaces the `[[…` typed so far. */
  const pickRef = (r: ResolvedRef) => {
    if (!refPopup) return;
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, refPopup.start)}${text.slice(caret)}`;
    const pos = refPopup.start;
    setText(next);
    save(next, mentions);
    setRefPopup(null);
    addRef(r);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const pickCommand = (c: ChatCommand) => {
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    // `/whisper` goes straight on to choosing the person.
    const head = `/${c} ${c === 'whisper' ? '@' : ''}`;
    const next = `${head}${text.slice(caret).trimStart()}`;
    setText(next);
    save(next, mentions);
    setCmdQuery(null);
    const pos = head.length;
    if (c === 'whisper') detect(next, pos);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const clearDraft = () => {
    drafts.delete(conv.id);
    setText('');
    setMentions([]);
    setStaged([]);
    setRefs([]);
    setRefPopup(null);
    setCmdQuery(null);
    onClearReply();
  };

  const insert = (s: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = `${text.slice(0, start)}${s}${text.slice(end)}`;
    setText(next);
    save(next, mentions);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + s.length, start + s.length);
    });
  };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    if (staged.length + files.length > CHAT_LIMITS.attachmentsPerMessage) {
      toast.error(t('chat.composer.tooManyFiles', { max: CHAT_LIMITS.attachmentsPerMessage }));
      return;
    }
    try {
      let target = folders.get(conv.id);
      if (!target) {
        target = api.call('getChatAttachmentFolder', { params: { conversationId: conv.id } });
        folders.set(conv.id, target);
        target.catch(() => folders.delete(conv.id));
      }
      const { spaceId, folderId } = await target;
      const ids = addUploads(
        files,
        { spaceId, parentId: folderId, folderName: conv.title },
        { onConflict: 'rename', quiet: true },
      );
      setStaged((cur) => [
        ...cur,
        ...files.map((f, i) => ({
          key: ids[i] ?? f.name,
          uploadId: ids[i] ?? '',
          name: f.name,
          size: f.size,
          mime: f.type,
        })),
      ]);
    } catch (e) {
      toast.error(t(errorKey(e)));
    }
  };

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    insert,
    addFiles: (files) => void addFiles(files),
  }));

  /** Schedules the draft (or `override`, from `/zamanla`) to go out at `at`. */
  const schedule = async (at: Date, override?: string): Promise<boolean> => {
    const body = override ?? toTokens(text, mentions).trim();
    const files = override !== undefined ? [] : staged.map(({ key: _k, ...a }) => a);
    const refList = override !== undefined ? [] : refs.map(({ kind, id }) => ({ kind, id }));
    const nodeIds = uploadedNodeIds(files);
    if (!nodeIds) {
      toast.error(t('chat.schedule.uploading'));
      return false;
    }
    if (!body && nodeIds.length === 0 && refList.length === 0) return false;
    try {
      await api.call('createScheduledMessage', {
        params: { conversationId: conv.id },
        body: {
          text: body,
          replyToId: reply?.id,
          attachmentNodeIds: nodeIds,
          ...(refList.length ? { refs: refList } : {}),
          sendAt: at.toISOString(),
        },
      });
      void qc.invalidateQueries({ queryKey: scheduledKey(conv.id) });
      toast(t('chat.schedule.scheduled', { when: when(at) }));
      clearDraft();
      return true;
    } catch (e) {
      toast.error(t(errorKey(e)));
      return false;
    }
  };

  /** A picked GIF goes out at once (with the reply, if one is open). */
  const sendGif = (g: GifResult) => {
    enqueue({
      conversationId: conv.id,
      text: '',
      replyTo: reply ? quoteOf(reply) : null,
      attachments: [],
      gif: toMessageGif(g),
    });
    onClearReply();
    onSent();
  };

  const send = async (confirmed = false) => {
    const tokens = toTokens(text, mentions).trim();
    if (editing) {
      if (!tokens) return;
      if (await act.edit(editing, tokens)) {
        onDoneEdit();
      }
      return;
    }
    if (!tokens && staged.length === 0 && refs.length === 0) return;
    if (tokens.length > CHAT_LIMITS.messageChars) {
      toast.error(t('chat.composer.tooLong', { max: CHAT_LIMITS.messageChars }));
      return;
    }
    // Slash commands run without files; an unknown one is plain text (roadmap 23).
    const command = staged.length === 0 && refs.length === 0 ? parseSlashCommand(tokens) : null;
    // A plugin's command (docs/contracts/eklentiler.md); built-in commands win on a name clash.
    const pluginCommand =
      staged.length === 0 && refs.length === 0 && !command
        ? matchPluginCommand(tokens, pluginSurfaces)
        : null;
    if (pluginCommand) {
      if (running) return;
      setRunning(true);
      try {
        const res = await api.call('runPluginCommand', {
          params: { conversationId: conv.id },
          body: pluginCommand,
        });
        clearDraft();
        onSent();
        if (res.reply) toast(res.reply);
      } catch (e) {
        toast.error(t(errorKey(e)));
      } finally {
        setRunning(false);
      }
      return;
    }
    let outcome: CommandOutcome | null = null;
    if (command) {
      if (running) return;
      setRunning(true);
      try {
        outcome = await runCommand(command.command, command.rest);
      } finally {
        setRunning(false);
      }
      if (outcome.kind === 'keep') return;
      if (outcome.kind === 'gif') {
        clearDraft();
        setGifPicker({ query: outcome.query });
        return;
      }
      if (outcome.kind === 'schedule') {
        if (outcome.at && outcome.text) void schedule(outcome.at, outcome.text);
        else setScheduleDialog({ draft: fromTokens(outcome.text, allLabel), at: outcome.at });
        return;
      }
      if (outcome.kind === 'done') {
        clearDraft();
        onSent();
        return;
      }
    }
    // Answering a whisper stays a whisper between the same two people.
    const replyWhisper = reply?.whisperTo
      ? reply.author?.id === me
        ? reply.whisperTo.id
        : reply.author?.id
      : undefined;
    const whisperTo = outcome?.kind === 'send' ? outcome.whisperTo : replyWhisper;
    const body = outcome?.kind === 'send' ? outcome.text : tokens;
    const group = body.includes(`<@${ALL}>`) || body.includes('<@here>');
    if (
      group &&
      !whisperTo &&
      conv.memberCount >= CHAT_LIMITS.mentionAllConfirmMembers &&
      !confirmed
    ) {
      setConfirmAll(true);
      return;
    }
    enqueue({
      conversationId: conv.id,
      text: body,
      replyTo: reply ? quoteOf(reply) : null,
      attachments: staged.map(({ key: _k, ...a }) => a),
      ...(refs.length ? { refs: refs.map(({ kind, id }) => ({ kind, id })) } : {}),
      confirmMentionAll: confirmed,
      ...(outcome?.kind === 'send' && outcome.emote ? { emote: true } : {}),
      ...(whisperTo ? { whisperTo } : {}),
    });
    clearDraft();
    onSent();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (refPopup) {
      if (e.key === 'Escape') {
        setRefPopup(null);
        return;
      }
      if (refCandidates.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const d = e.key === 'ArrowDown' ? 1 : -1;
          setIndex((i) => (i + d + refCandidates.length) % refCandidates.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const c = refCandidates[index] ?? refCandidates[0];
          if (c) pickRef(c);
          return;
        }
      }
    }
    if (cmdQuery !== null && cmdCandidates.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setIndex((i) => (i + d + cmdCandidates.length) % cmdCandidates.length);
        return;
      }
      // A fully typed command with Enter runs at once; Tab (or a partial name) completes it.
      const exact = cmdCandidates.find((c) => c === cmdQuery.toLowerCase());
      if (e.key === 'Tab' || (e.key === 'Enter' && !exact)) {
        e.preventDefault();
        const c = cmdCandidates[index] ?? cmdCandidates[0];
        if (c) pickCommand(c);
        return;
      }
      if (e.key === 'Escape') {
        setCmdQuery(null);
        return;
      }
    }
    if (popup && candidates.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setIndex((i) => (i + d + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const c = candidates[index];
        if (c) pick(c);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (popup) setPopup(null);
      else if (editing) onDoneEdit();
      else if (reply) onClearReply();
      return;
    }
    // Ctrl/Cmd+Shift+Enter: "Daha sonra gönder".
    if (e.key === 'Enter' && e.shiftKey && (e.ctrlKey || e.metaKey) && !editing) {
      e.preventDefault();
      if (text.trim() || staged.length || refs.length) setScheduleMenu(true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
      return;
    }
    if (e.key === 'ArrowUp' && !text && !editing) {
      e.preventDefault();
      onEditLast();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
      return;
    }
    // A whole pasted address of this Crewhall becomes a reference, if the sender can open it.
    const pasted = e.clipboardData.getData('text/plain').trim();
    if (refsOn && !editing && /^https?:\/\/\S+$/.test(pasted)) {
      const target = pasted;
      void refFromUrl(target).then((r) => {
        if (!r) return;
        // Take the address back out of the box; it pasted as plain text meanwhile.
        const el = area.current;
        const current = el?.value ?? '';
        const at = current.lastIndexOf(target);
        if (at >= 0) {
          const next = `${current.slice(0, at)}${current.slice(at + target.length)}`;
          setText(next);
          save(next, mentions);
        }
        addRef(r);
      });
    }
  };

  if (!conv.permissions.write) {
    return (
      <div className="mx-6 mb-5 rounded-xl bg-bg2 px-4 py-3 text-center text-cap text-fg2">
        {conv.archivedAt ? t('chat.composer.archived') : t('chat.composer.readOnly')}
      </div>
    );
  }

  const offline = socket.everOpened && socket.status !== 'open';
  const lines = Math.min(8, Math.max(1, text.split('\n').length));

  const commandList = (
    <>
      <div className="shrink-0 px-3 pt-2.5 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
        {t('chat.commands.title')}
      </div>
      <div
        role="listbox"
        aria-label={t('chat.commands.title')}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {cmdCandidates.map((c, i) => (
          <button
            key={c}
            ref={i === index ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : undefined}
            type="button"
            role="option"
            aria-selected={i === index}
            onMouseDown={(e) => {
              e.preventDefault();
              pickCommand(c);
            }}
            onMouseEnter={() => setIndex(i)}
            className={cn(
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors duration-(--t-fast)',
              i === index && 'bg-bg2',
            )}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-bg2 text-fg2">
              <Icon name={COMMAND_ICONS[c]} size={13} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-cap font-semibold">
                /{c} <span className="font-normal text-fg2">{t(`chat.commands.${c}.hint`)}</span>
              </span>
              <span className="block truncate font-mono text-[11px] text-fg3">
                {t(`chat.commands.${c}.usage`)}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="flex shrink-0 gap-3 border-t border-line px-3 py-1.5 text-[11px] text-fg3">
        <span>
          <Kbd>↑ ↓</Kbd> {t('chat.commands.move')}
        </span>
        <span>
          <Kbd>Tab</Kbd> {t('chat.commands.pick')}
        </span>
        <span>
          <Kbd>Esc</Kbd> {t('chat.commands.close')}
        </span>
      </div>
    </>
  );

  // Header and key hints stay put; the people scroll when the panel is capped (doc 02 · 9.4).
  const mentionList = (
    <>
      <div className="shrink-0 px-3 pt-2.5 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
        {t('chat.mention.title')}
      </div>
      <div
        role="listbox"
        aria-label={t('chat.mention.title')}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {candidates.map((c, i) => (
          <button
            key={c.id}
            ref={i === index ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : undefined}
            type="button"
            role="option"
            aria-selected={i === index}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(c);
            }}
            onMouseEnter={() => setIndex(i)}
            className={cn(
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors duration-(--t-fast)',
              i === index && 'bg-bg2',
            )}
          >
            {c.user ? (
              <Avatar name={c.user.name} src={c.user.imageUrl} size="sm" />
            ) : (
              <span className="flex size-6 items-center justify-center rounded-full bg-accent text-accent-fg">
                <Icon name="at" size={13} />
              </span>
            )}
            <span className="text-cap font-semibold">
              {c.id === ALL ? t('chat.mention.all') : c.label}
            </span>
            {c.id === ALL ? (
              <span className="text-xs text-fg2">
                {t('chat.mention.allHint', { count: conv.memberCount })}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex shrink-0 gap-3 border-t border-line px-3 py-1.5 text-[11px] text-fg3">
        <span>
          <Kbd>↑ ↓</Kbd> {t('chat.mention.move')}
        </span>
        <span>
          <Kbd>Enter</Kbd> {t('chat.mention.pick')}
        </span>
        <span>
          <Kbd>Esc</Kbd> {t('chat.mention.close')}
        </span>
      </div>
    </>
  );

  const refList = (
    <>
      <div className="shrink-0 px-3 pt-2.5 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
        {t('chat.refs.pickerTitle')}
      </div>
      <div
        role="listbox"
        aria-label={t('chat.refs.pickerTitle')}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {refCandidates.length === 0 ? (
          <p className="m-0 px-3 py-3 text-cap text-fg2">
            {refSearch.isFetching ? t('chat.refs.searching') : t('chat.refs.none')}
          </p>
        ) : null}
        {refCandidates.map((c, i) =>
          c.item ? (
            <button
              key={`${c.kind}:${c.id}`}
              type="button"
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pickRef(c);
              }}
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-1.5 text-left',
                i === index && 'bg-bg2',
              )}
            >
              <Icon name={REF_ICON[c.item.type]} size={16} className="shrink-0 text-fg2" />
              <span className="min-w-0 flex-1 truncate text-cap font-semibold">{c.item.title}</span>
              <span className="shrink-0 text-xs text-fg2">{c.item.spaceName}</span>
            </button>
          ) : null,
        )}
      </div>
    </>
  );

  return (
    <div className="relative mx-6 mb-4">
      {!editing ? <ScheduledBar conv={conv} /> : null}
      <SuggestionPanel
        open={
          refPopup !== null || (popup !== null && candidates.length > 0) || cmdCandidates.length > 0
        }
        onDismiss={() => {
          setPopup(null);
          setRefPopup(null);
          setCmdQuery(null);
        }}
        side="top"
        aria-label={
          refPopup
            ? t('chat.refs.pickerTitle')
            : cmdCandidates.length
              ? t('chat.commands.title')
              : t('chat.mention.title')
        }
        className="overflow-hidden bg-bg p-0"
        anchor={
          <div
            className={cn(
              'flex flex-col rounded-xl bg-bg shadow-line2 focus-within:shadow-[inset_0_0_0_1.5px_var(--fg)]',
            )}
          >
            {reply || editing ? (
              <div
                key={editing?.id ?? reply?.id}
                className="flex animate-rise-in items-start gap-2 px-3 pt-2.5"
              >
                <div className="min-w-0 flex-1 rounded-md bg-bg2 px-3 py-1.5 shadow-[inset_3px_0_0_var(--accent)]">
                  <span className="text-xs font-bold">
                    {editing
                      ? t('chat.composer.editing')
                      : t('chat.composer.replyingTo', {
                          name:
                            reply?.author?.name ??
                            reply?.webhook?.name ??
                            reply?.guestAuthor?.name ??
                            '',
                        })}
                  </span>
                  {reply ? (
                    <p className="m-0 truncate text-xs text-fg2">{excerptOf(reply)}</p>
                  ) : null}
                </div>
                <IconButton
                  size="xs"
                  tone="plain"
                  aria-label={t('chat.composer.cancel')}
                  onClick={() => (editing ? onDoneEdit() : onClearReply())}
                >
                  <Icon name="x" size={14} />
                </IconButton>
              </div>
            ) : null}
            {refs.length && !editing ? (
              <ul
                aria-label={t('chat.refs.attached')}
                className="m-0 flex list-none flex-wrap gap-1.5 px-3 pt-2.5 pb-0"
              >
                {refs.map((r) => (
                  <li
                    key={`${r.kind}:${r.id}`}
                    className="flex h-8 animate-pop-in items-center gap-2 rounded-md bg-bg2 pr-1 pl-2.5 text-xs"
                  >
                    <Icon name={r.item ? REF_ICON[r.item.type] : 'link'} size={13} />
                    <span className="max-w-[200px] truncate font-semibold">{r.item?.title}</span>
                    <IconButton
                      size="xs"
                      tone="plain"
                      aria-label={t('chat.refs.remove', { name: r.item?.title ?? '' })}
                      onClick={() => setRefs(refs.filter((x) => x !== r))}
                    >
                      <Icon name="x" size={12} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            ) : null}
            {staged.length ? (
              <ul className="m-0 flex list-none flex-wrap gap-1.5 px-3 pt-2.5 pb-0">
                {staged.map((s) => {
                  const u = uploads.items.find((x) => x.id === s.uploadId);
                  const pct = u ? Math.round((u.loaded / Math.max(1, s.size)) * 100) : 0;
                  return (
                    <li
                      key={s.key}
                      className="flex h-8 animate-pop-in items-center gap-2 rounded-md bg-bg2 pr-1 pl-2.5 text-xs"
                    >
                      <Icon name="file" size={13} />
                      <span className="max-w-[160px] truncate font-semibold">{s.name}</span>
                      <span className="text-fg2">
                        {u?.status === 'done' ? formatBytes(s.size, locale) : `%${pct}`}
                      </span>
                      <IconButton
                        size="xs"
                        tone="plain"
                        aria-label={t('chat.composer.removeFile', { name: s.name })}
                        onClick={() => {
                          cancelUpload(s.uploadId);
                          setStaged((cur) => cur.filter((x) => x.key !== s.key));
                        }}
                      >
                        <Icon name="x" size={12} />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <div className="flex items-end gap-1 py-1.5 pr-1.5 pl-4">
              <textarea
                ref={area}
                value={text}
                rows={lines}
                maxLength={CHAT_LIMITS.messageChars + 200}
                placeholder={placeholder}
                aria-label={placeholder}
                onChange={(e) => {
                  setText(e.target.value);
                  save(e.target.value, mentions);
                  detect(e.target.value, e.target.selectionStart);
                  if (e.target.value.trim()) sendTyping(conv.id);
                }}
                onSelect={(e) => detect(e.currentTarget.value, e.currentTarget.selectionStart)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onBlur={() => {
                  setPopup(null);
                  setRefPopup(null);
                  setCmdQuery(null);
                }}
                className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent py-2 text-[14px] leading-5 outline-none placeholder:text-fg3 focus-visible:shadow-none focus-visible:outline-none"
              />
              <EmojiPicker onPick={insert}>
                <IconButton size="sm" tone="plain" aria-label={t('chat.composer.emoji')}>
                  <Icon name="smile" size={18} />
                </IconButton>
              </EmojiPicker>
              {gifOn && !editing ? (
                <GifPicker
                  open={gifPicker !== null}
                  onOpenChange={(v) => setGifPicker(v ? { query: '' } : null)}
                  initialQuery={gifPicker?.query ?? ''}
                  onPick={sendGif}
                >
                  <IconButton size="sm" tone="plain" aria-label={t('chat.gif.button')}>
                    <span className="text-[11px] font-black tracking-tight">GIF</span>
                  </IconButton>
                </GifPicker>
              ) : null}
              {refsOn && !editing ? (
                <Tooltip content={t('chat.refs.add')}>
                  <IconButton
                    size="sm"
                    tone="plain"
                    aria-label={t('chat.refs.add')}
                    onClick={() => {
                      const el = area.current;
                      const start = el?.selectionStart ?? text.length;
                      const lead = start > 0 && !/\s/.test(text[start - 1] ?? '') ? ' ' : '';
                      insert(`${lead}[[`);
                      const next = `${text.slice(0, start)}${lead}[[${text.slice(el?.selectionEnd ?? start)}`;
                      detect(next, start + lead.length + 2);
                    }}
                  >
                    <Icon name="link" size={18} />
                  </IconButton>
                </Tooltip>
              ) : null}
              {!editing ? (
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('chat.composer.attach')}
                  onClick={() => fileInput.current?.click()}
                >
                  <Icon name="clip" size={18} />
                </IconButton>
              ) : null}
              <IconButton
                size="sm"
                aria-label={editing ? t('chat.composer.save') : t('chat.composer.send')}
                disabled={(!text.trim() && staged.length === 0 && refs.length === 0) || running}
                onClick={() => void send()}
                className="bg-fg text-bg hover:bg-fg disabled:bg-bg2 disabled:text-fg3"
              >
                <Icon name={editing ? 'check' : 'send'} size={16} />
              </IconButton>
              {!editing ? (
                <ScheduleMenu
                  open={scheduleMenu}
                  onOpenChange={setScheduleMenu}
                  disabled={(!text.trim() && staged.length === 0 && refs.length === 0) || running}
                  onPick={(at) => void schedule(at)}
                  onCustom={() => setScheduleDialog({ draft: null, at: null })}
                >
                  <IconButton
                    size="xs"
                    tone="plain"
                    aria-label={t('chat.schedule.later')}
                    className="-ml-1 self-center"
                  >
                    <Icon name="chevU" size={14} />
                  </IconButton>
                </ScheduleMenu>
              ) : null}
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void addFiles([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
            </div>
          </div>
        }
      >
        {refPopup ? refList : cmdCandidates.length ? commandList : mentionList}
      </SuggestionPanel>
      {scheduleDialog ? (
        <ScheduleDialog
          title={t('chat.schedule.later')}
          initialAt={scheduleDialog.at ?? undefined}
          initialText={scheduleDialog.draft?.text}
          withText={scheduleDialog.draft !== null}
          onOpenChange={(v) => !v && setScheduleDialog(null)}
          onSubmit={(at, edited) => {
            const d = scheduleDialog.draft;
            return schedule(at, d ? toTokens(edited, d.mentions) : undefined);
          }}
        />
      ) : null}
      {pollDraft !== null ? (
        <PollDialog
          conv={conv}
          initial={pollDraft}
          open
          onOpenChange={(v) => {
            if (!v) setPollDraft(null);
          }}
        />
      ) : null}
      {offline ? (
        <p className="m-0 animate-fade-in px-1 pt-1.5 text-xs text-fg2">
          {t('chat.composer.offline')}
        </p>
      ) : null}
      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent width={420}>
          <DialogHeader
            title={t('chat.mention.confirmTitle')}
            description={t('chat.mention.confirmBody', { count: conv.memberCount })}
          />
          <DialogFooter>
            <Button variant="gh" onClick={() => setConfirmAll(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="pri"
              onClick={() => {
                setConfirmAll(false);
                void send(true);
              }}
            >
              {t('chat.mention.confirmSend')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});
