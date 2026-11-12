import { type MailAttachment, type MailFolder, type MailMessage } from '@crewhall/shared';
import {
  Avatar,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/identity/parts';
import { api, idempotencyKey } from '@/lib/api';
import { formatBytes, formatDateLong, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { bodyDocument, sameAddress, type ComposeMode } from '@/lib/mail/compose';
import { patchLists, patchThread } from '@/lib/mail/bulk';
import { attachmentUrl, mailThreadQuery } from '@/lib/mail/queries';
import { usePermissions } from '@/lib/session';
import { useTheme } from '@/lib/theme/ThemeContext';
import { useSpaces } from '@/lib/useSpaces';
import { canView, openViewer } from '@/lib/viewer';
import { mailError } from './errors';
import { folderLabel } from './MailSidebar';
import { useDelayed } from './useDelayed';
import { useMailBulk } from './useMailBulk';

/**
 * Conversation view (roadmap 24): every message of the thread in this folder and in Sent,
 * oldest first; the newest and the unread ones open, the rest fold to one line.
 */
export function ThreadView({
  folder,
  uid,
  folders,
  me,
  allowRemoteImages,
  onCompose,
  onClose,
}: {
  folder: string;
  uid: number;
  folders: MailFolder[];
  me: string;
  allowRemoteImages: boolean;
  onCompose: (mode: ComposeMode, message: MailMessage) => void;
  /** The message left this folder (moved, deleted) or the phone back button. */
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [remote, setRemote] = useState(false);
  const thread = useQuery(mailThreadQuery(folder, uid, remote));
  const slow = useDelayed(thread.isPending);
  const items = thread.data?.items ?? [];
  const here = items.filter((m) => m.folder === folder);
  const current = items.find((m) => m.folder === folder && m.uid === uid) ?? items.at(-1);

  const bulk = useMailBulk();
  const uids = here.map((m) => m.uid);

  // Shown means read: marked here (optimistically) rather than by the server's read, so a
  // conversation prefetched on hover stays unread until it is opened.
  const marked = useRef(false);
  const unread = here.filter((m) => !m.seen).map((m) => m.uid);
  useEffect(() => {
    if (!thread.isSuccess || marked.current) return;
    marked.current = true;
    if (unread.length === 0) return;
    patchThread(qc, folder, uid, (m) => (m.folder === folder ? { ...m, seen: true } : m));
    void bulk(folder, 'seen', { kind: 'uids', uids: unread });
  });

  const setFlagged = async (flagged: boolean) => {
    const restore = patchThread(qc, folder, uid, (m) =>
      m.folder === folder && m.uid === current!.uid ? { ...m, flagged } : m,
    );
    const lists = patchLists(qc, folder, [current!.uid], { flagged });
    try {
      await api.call('mailUpdateFlags', {
        body: { folder, uids: [current!.uid], flagged },
        idempotencyKey: idempotencyKey(),
      });
    } catch (e) {
      restore();
      lists();
      toast(mailError(t, e));
    }
  };
  const markUnread = () => {
    onClose();
    void bulk(folder, 'unseen', { kind: 'uids', uids: [current!.uid] });
  };
  const move = (target: string) => {
    onClose();
    void bulk(folder, 'move', { kind: 'uids', uids }, target).then(
      (ok) => ok && toast(t('mail.view.moved')),
    );
  };
  const inTrashNow = folders.find((f) => f.path === folder)?.specialUse === 'trash';
  const remove = () => {
    onClose();
    void bulk(folder, 'delete', { kind: 'uids', uids }).then(
      (ok) => ok && toast(inTrashNow ? t('mail.view.deletedForever') : t('mail.view.deleted')),
    );
  };
  const inTrash = folders.find((f) => f.path === folder)?.specialUse === 'trash';
  const [confirmPurge, setConfirmPurge] = useState(false);

  if (thread.isPending) {
    if (!slow) return <div className="flex-1" />;
    return (
      <div className="flex flex-1 flex-col gap-3 p-6">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (thread.isError || !current) {
    return (
      <EmptyState
        icon="alert"
        title={thread.isError ? mailError(t, thread.error) : t('mail.view.loadFailed')}
      >
        <Button size="sm" onClick={onClose}>
          {t('mail.view.back')}
        </Button>
      </EmptyState>
    );
  }
  const blocked = items.reduce((n, m) => n + m.blockedImages, 0);
  const targets = folders.filter((f) => f.path !== folder);

  return (
    <article aria-label={t('mail.view.label')} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-2 md:px-5">
        <IconButton
          size="sm"
          tone="plain"
          aria-label={t('mail.view.back')}
          className="md:hidden"
          onClick={onClose}
        >
          <Icon name="arrowL" size={18} />
        </IconButton>
        <h1 className="m-0 min-w-0 flex-1 truncate text-sub font-semibold">
          {current.subject || t('mail.list.noSubject')}
        </h1>
        <Tooltip content={current.flagged ? t('mail.view.unflag') : t('mail.view.flag')}>
          <IconButton
            size="sm"
            tone="plain"
            aria-label={current.flagged ? t('mail.view.unflag') : t('mail.view.flag')}
            aria-pressed={current.flagged}
            onClick={() => void setFlagged(!current.flagged)}
          >
            <Icon name="flag" size={18} className={current.flagged ? 'text-warning' : undefined} />
          </IconButton>
        </Tooltip>
        <Tooltip content={inTrash ? t('mail.view.deleteForever') : t('mail.view.delete')}>
          <IconButton
            size="sm"
            tone="plain"
            aria-label={inTrash ? t('mail.view.deleteForever') : t('mail.view.delete')}
            onClick={() => (inTrash ? setConfirmPurge(true) : remove())}
          >
            <Icon name="trash" size={18} />
          </IconButton>
        </Tooltip>
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="sm" tone="plain" aria-label={t('mail.view.more')}>
              <Icon name="dotsV" size={18} />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon="eye" onSelect={markUnread}>
              {t('mail.view.markUnread')}
            </MenuItem>
            {targets.length ? <MenuSeparator /> : null}
            {targets.map((f) => (
              <MenuItem key={f.path} icon="folder" onSelect={() => move(f.path)}>
                {t('mail.view.moveTo')} · {folderLabel(f, t)}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-4 md:px-5">
        {blocked > 0 && allowRemoteImages && !remote ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-bg2 px-3 py-2 text-sm text-fg2">
            <Icon name="image" size={16} />
            <span className="min-w-0 flex-1">{t('mail.view.blocked', { count: blocked })}</span>
            <Button size="xs" variant="out" onClick={() => setRemote(true)}>
              {t('mail.view.showImages')}
            </Button>
          </div>
        ) : null}
        {items.map((m, i) => (
          <MessageCard
            key={`${m.folder}:${m.uid}`}
            message={m}
            me={me}
            remote={remote}
            initiallyOpen={i === items.length - 1 || (m.folder === folder && m.uid === uid)}
            onCompose={(mode) => onCompose(mode, m)}
          />
        ))}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="out" onClick={() => onCompose('reply', current)}>
            <Icon name="reply" size={16} />
            {t('mail.view.reply')}
          </Button>
          <Button size="sm" variant="out" onClick={() => onCompose('replyAll', current)}>
            <Icon name="reply" size={16} />
            {t('mail.view.replyAll')}
          </Button>
          <Button size="sm" variant="out" onClick={() => onCompose('forward', current)}>
            <Icon name="arrowR" size={16} />
            {t('mail.view.forward')}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmPurge}
        onOpenChange={setConfirmPurge}
        title={t('mail.view.deleteForever')}
        body={t('mail.view.deleteForeverBody')}
        confirm={t('mail.view.deleteForever')}
        onConfirm={() => {
          setConfirmPurge(false);
          remove();
        }}
      />
    </article>
  );
}

export function MessageCard({
  message: m,
  me,
  remote,
  initiallyOpen,
  onCompose,
  inboxId,
}: {
  message: MailMessage;
  me: string;
  remote: boolean;
  initiallyOpen: boolean;
  onCompose: (mode: ComposeMode) => void;
  /** A shared inbox's message: its attachments come through the inbox. */
  inboxId?: string;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(initiallyOpen || !m.seen);
  const name = m.from?.name || m.from?.address || t('mail.list.unknownSender');
  const date = m.date ? `${formatDateLong(m.date, locale)} ${formatTime(m.date, locale)}` : '';
  const people = (list: MailMessage['to']) =>
    list
      .map((a) => (sameAddress(a.address, me) ? t('mail.view.me') : a.name || a.address))
      .join(', ');
  const files = m.attachments.filter((a) => !a.inline);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('mail.view.expand')}
        className="flex items-center gap-3 rounded-xl bg-surface px-4 py-2.5 text-left shadow-line hover:bg-bg2"
      >
        <Avatar name={name} size="md" />
        <span className="w-40 shrink-0 truncate text-sm font-semibold">{name}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg2">
          {m.text?.slice(0, 160) ?? m.subject}
        </span>
        <span className="shrink-0 text-xs text-fg3 tn">{date}</span>
      </button>
    );
  }
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-surface px-4 py-3 shadow-line">
      <div className="flex items-start gap-3">
        <Avatar name={name} size="md" />
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col text-left"
          aria-label={t('mail.view.collapse')}
          onClick={() => setOpen(false)}
        >
          <span className="truncate text-sm font-semibold">
            {name}
            {m.from?.name ? (
              <span className="ml-1.5 font-normal text-fg3">{m.from.address}</span>
            ) : null}
          </span>
          <span className="truncate text-xs text-fg2">
            {t('mail.view.to')}: {people(m.to)}
            {m.cc.length ? ` · ${t('mail.view.cc')}: ${people(m.cc)}` : ''}
            {m.bcc.length ? ` · ${t('mail.view.bcc')}: ${people(m.bcc)}` : ''}
          </span>
        </button>
        <span className="shrink-0 pt-0.5 text-xs text-fg3 tn">{date}</span>
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="xs" tone="plain" aria-label={t('mail.view.more')}>
              <Icon name="dots" size={16} />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon="reply" onSelect={() => onCompose('reply')}>
              {t('mail.view.reply')}
            </MenuItem>
            <MenuItem icon="reply" onSelect={() => onCompose('replyAll')}>
              {t('mail.view.replyAll')}
            </MenuItem>
            <MenuItem icon="arrowR" onSelect={() => onCompose('forward')}>
              {t('mail.view.forward')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <MailBody message={m} remote={remote} />
      {files.length ? <Attachments message={m} files={files} inboxId={inboxId} /> : null}
    </section>
  );
}

/**
 * The message HTML in an iframe: sandboxed without scripts (same origin only so the page can
 * read its height), CSP inside the document, links open in a new tab without the referrer.
 */
export function MailBody({ message, remote }: { message: MailMessage; remote: boolean }) {
  const { t } = useI18n();
  const { scheme } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const doc = bodyDocument(message, { remoteImages: remote, dark: scheme === 'dark' });

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const body = el.contentDocument?.body;
      if (body) setHeight(Math.max(60, body.scrollHeight + 8));
    };
    const onLoad = () => {
      measure();
      const body = el.contentDocument?.body;
      if (body && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    el.addEventListener('load', onLoad);
    return () => {
      el.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [doc]);

  return (
    <iframe
      ref={frame}
      title={t('mail.view.frameTitle', { title: message.subject || t('mail.list.noSubject') })}
      srcDoc={doc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="w-full rounded-md border-0 bg-white"
      style={{ height }}
    />
  );
}

function Attachments({
  message,
  files,
  inboxId,
}: {
  message: MailMessage;
  files: MailAttachment[];
  inboxId?: string | undefined;
}) {
  const { t, locale } = useI18n();
  const [saving, setSaving] = useState<MailAttachment | null>(null);
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="text-xs font-semibold text-fg2">
        {t('mail.view.attachments', { count: files.length })}
      </span>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {files.map((a) => (
          <li
            key={a.part}
            className="flex max-w-full items-center gap-2 rounded-lg bg-bg2 py-1.5 pr-1.5 pl-3 text-sm"
          >
            <Icon name="file" size={16} className="shrink-0 text-fg2" />
            {canView(a.contentType, a.filename) ? (
              // Pictures, videos and PDFs open in the app's viewer.
              <button
                type="button"
                onClick={(e) => {
                  const shown = files.filter((x) => canView(x.contentType, x.filename));
                  openViewer(
                    shown.map((x) => ({
                      key: `mail:${message.folder}:${message.uid}:${x.part}`,
                      name: x.filename,
                      mime: x.contentType,
                      sizeBytes: x.size,
                      url: () =>
                        Promise.resolve(attachmentUrl(message.folder, message.uid, x.part, true)),
                      download: () =>
                        Promise.resolve(attachmentUrl(message.folder, message.uid, x.part)),
                    })),
                    shown.indexOf(a),
                    e.currentTarget.closest('li'),
                  );
                }}
                className="min-w-0 truncate font-medium hover:underline"
              >
                {a.filename}
              </button>
            ) : (
              <span className="min-w-0 truncate font-medium">{a.filename}</span>
            )}
            <span className="shrink-0 text-xs text-fg3">{formatBytes(a.size, locale)}</span>
            <Tooltip content={t('mail.view.download', { name: a.filename })}>
              <IconButton
                asChild
                size="xs"
                tone="plain"
                aria-label={t('mail.view.download', { name: a.filename })}
              >
                <a
                  href={attachmentUrl(message.folder, message.uid, a.part, false, inboxId)}
                  download={a.filename}
                >
                  <Icon name="download" size={14} />
                </a>
              </IconButton>
            </Tooltip>
            <Tooltip content={t('mail.view.saveToDrive')}>
              <IconButton
                size="xs"
                tone="plain"
                aria-label={`${t('mail.view.saveToDrive')}: ${a.filename}`}
                onClick={() => setSaving(a)}
              >
                <Icon name="upload" size={14} />
              </IconButton>
            </Tooltip>
          </li>
        ))}
      </ul>
      {saving ? (
        <SaveToDriveDialog
          message={message}
          attachment={saving}
          inboxId={inboxId}
          onClose={() => setSaving(null)}
        />
      ) : null}
    </div>
  );
}

const PERSONAL = 'personal';

function SaveToDriveDialog({
  message,
  attachment,
  inboxId,
  onClose,
}: {
  message: MailMessage;
  attachment: MailAttachment;
  inboxId?: string | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const spaces = useSpaces();
  const { canSpace } = usePermissions();
  const writable = spaces.items.filter(
    (s) => s.kind === 'shared' && !s.archivedAt && canSpace('space.edit_content', s.myRole),
  );
  const [target, setTarget] = useState(PERSONAL);
  const save = useMutation({
    mutationFn: () =>
      api.call('mailSaveAttachment', {
        body: {
          folder: message.folder,
          uid: message.uid,
          part: attachment.part,
          ...(inboxId ? { inboxId } : {}),
          ...(target !== PERSONAL ? { spaceId: target } : {}),
        },
      }),
    onSuccess: (res) => {
      toast(t('mail.saveDialog.saved', { name: res.name }));
      onClose();
    },
    onError: (e) => toast(mailError(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent width={440}>
        <DialogHeader
          icon="upload"
          title={t('mail.saveDialog.title')}
          description={t('mail.saveDialog.description', { name: attachment.filename })}
        />
        <Field label={t('mail.saveDialog.space')}>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PERSONAL}>{t('mail.saveDialog.personal')}</SelectItem>
              {writable.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {t('mail.saveDialog.spaceRoot', { space: s.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="pri" loading={save.isPending} onClick={() => save.mutate()}>
            {t('mail.saveDialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
