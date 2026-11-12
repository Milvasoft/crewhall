import {
  type MailAccount,
  type MailCannedResponse,
  type MailMessage,
  type MailOutgoingAttachment,
  type MailSendResult,
} from '@crewhall/shared';
import { emptyDoc } from '@crewhall/editor';
import { RichEditor, type RichEditorHandle } from '@crewhall/editor/react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  toast,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/identity/parts';
import { editorLabels } from '@/components/portal/PortalEditor';
import { api, idempotencyKey } from '@/lib/api';
import { formatBytes, formatDateLong, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  bodyDocument,
  draftFor,
  fileToBase64,
  quoteBlock,
  type ComposeMode,
  type Recipient,
} from '@/lib/mail/compose';
import { whenEditorReady } from '@/lib/mail/editor';
import { mailKeys } from '@/lib/mail/queries';
import { DrivePicker, type PickedFile } from './DrivePicker';
import { mailError } from './errors';
import { RecipientInput } from './RecipientInput';

type Attachment = { key: string; name: string; size: number; source: MailOutgoingAttachment };

/** What the composer sends; a shared inbox posts it to its own endpoint (`onSend`). */
export interface OutgoingDraft {
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  html: string;
  attachments: MailOutgoingAttachment[];
}

let seq = 0;
const nextKey = () => `a${++seq}`;

/**
 * Write, reply and forward (roadmap 24). The body is written in the shared editor; the
 * signature starts under it and the quoted original travels below as a fixed block. A shared
 * inbox passes `onSend` (its reply endpoint), its canned responses and a footer control.
 */
export function Composer({
  mode,
  source,
  account,
  maxBytes,
  onClose,
  onSend,
  onSent,
  canned,
  footer,
}: {
  mode: ComposeMode;
  source: MailMessage | null;
  account: Pick<MailAccount, 'email' | 'signatureHtml'>;
  maxBytes: number;
  onClose: () => void;
  onSend?: (draft: OutgoingDraft, idempotencyKey: string) => Promise<MailSendResult>;
  onSent?: () => void;
  canned?: MailCannedResponse[];
  footer?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const labels = useMemo(() => editorLabels(t), [t]);
  const editor = useRef<RichEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const initial = useMemo(
    () =>
      draftFor(mode, source, account.email, {
        reply: t('mail.compose.prefixReply'),
        forward: t('mail.compose.prefixForward'),
      }),
    // The draft is computed once per opened composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [to, setTo] = useState<Recipient[]>(initial.to);
  const [cc, setCc] = useState<Recipient[]>(initial.cc);
  const [bcc, setBcc] = useState<Recipient[]>([]);
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [subject, setSubject] = useState(initial.subject);
  const [attachments, setAttachments] = useState<Attachment[]>(() =>
    mode === 'forward' && source
      ? source.attachments
          .filter((a) => !a.inline)
          .map((a) => ({
            key: nextKey(),
            name: a.filename,
            size: a.size,
            source: { kind: 'message', folder: source.folder, uid: source.uid, part: a.part },
          }))
      : [],
  );
  const [touched, setTouched] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  // One key per composed message: a retried send after a network error is not sent twice.
  const [sendKey] = useState(idempotencyKey);

  const quote = useMemo(() => {
    if (!source || mode === 'new') return null;
    const name = source.from?.name || source.from?.address || '';
    const date = source.date
      ? `${formatDateLong(source.date, locale)} ${formatTime(source.date, locale)}`
      : '';
    const header =
      mode === 'forward'
        ? t('mail.compose.forwardHeader', { name, date, title: source.subject })
        : t('mail.compose.quoteHeader', { name, date });
    return quoteBlock(source, header);
  }, [source, mode, t, locale]);

  // Signature under an empty first line (the editor takes HTML through Tiptap).
  useEffect(
    () =>
      whenEditorReady(editor, (ed) => {
        const sig = account.signatureHtml.trim();
        if (sig) ed.commands.setContent(`<p></p><p>--</p>${sig}`);
        // Replies start in the body; new messages and forwards start in "To".
        if (mode === 'reply' || mode === 'replyAll') ed.commands.focus('start');
      }),
    [account.signatureHtml, mode],
  );

  const total = attachments.reduce((n, a) => n + a.size, 0);
  const send = useMutation({
    mutationFn: async () => {
      const html = (editor.current?.getEditor().getHTML() ?? '') + (quote ?? '');
      if (onSend) {
        return onSend(
          { to, cc, bcc, subject, html, attachments: attachments.map((a) => a.source) },
          sendKey,
        );
      }
      return api.call('mailSend', {
        body: {
          to,
          cc,
          bcc,
          subject,
          html,
          attachments: attachments.map((a) => a.source),
          ...(source && mode !== 'new'
            ? {
                source: {
                  folder: source.folder,
                  uid: source.uid,
                  mode: mode === 'forward' ? ('forward' as const) : ('reply' as const),
                },
              }
            : {}),
        },
        idempotencyKey: sendKey,
      });
    },
    onSuccess: (res) => {
      toast(res.savedToSent ? t('mail.compose.sent') : t('mail.compose.sentNoCopy'));
      void qc.invalidateQueries({ queryKey: mailKeys.all });
      onSent?.();
      onClose();
    },
    onError: (e) => toast(mailError(t, e)),
  });

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const added: Attachment[] = [];
    let size = total;
    for (const file of Array.from(list)) {
      size += file.size;
      if (size > maxBytes) {
        toast(t('mail.compose.tooLarge', { size: formatBytes(maxBytes, locale) }));
        break;
      }
      added.push({
        key: nextKey(),
        name: file.name,
        size: file.size,
        source: {
          kind: 'upload',
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          data: await fileToBase64(file),
        },
      });
    }
    setAttachments((prev) => [...prev, ...added]);
    setTouched(true);
  };
  const addDrive = (files: PickedFile[]) => {
    const size = total + files.reduce((n, f) => n + f.sizeBytes, 0);
    if (size > maxBytes) {
      toast(t('mail.compose.tooLarge', { size: formatBytes(maxBytes, locale) }));
      return;
    }
    setAttachments((prev) => [
      ...prev,
      ...files.map((f) => ({
        key: nextKey(),
        name: f.name,
        size: f.sizeBytes,
        source: { kind: 'drive' as const, nodeId: f.id },
      })),
    ]);
    setTouched(true);
  };

  const close = () => (touched ? setConfirmDiscard(true) : onClose());
  const title =
    mode === 'new'
      ? t('mail.compose.newTitle')
      : mode === 'forward'
        ? t('mail.compose.forwardTitle')
        : t('mail.compose.replyTitle');

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : close())}>
      <DialogContent
        width={760}
        className="gap-0 p-0"
        aria-describedby={undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send.mutate();
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <DialogTitle className="m-0 flex-1 text-sub font-semibold">{title}</DialogTitle>
          <IconButton size="sm" tone="plain" aria-label={t('mail.compose.discard')} onClick={close}>
            <Icon name="x" size={18} />
          </IconButton>
        </div>
        <div className="flex flex-col px-5" onChangeCapture={() => setTouched(true)}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <RecipientInput
                label={t('mail.compose.to')}
                value={to}
                onChange={setTo}
                autoFocus={mode === 'new' || mode === 'forward'}
              />
            </div>
            {!showCc ? (
              <Button size="xs" variant="gh" className="mt-1.5" onClick={() => setShowCc(true)}>
                {t('mail.compose.showCc')}
              </Button>
            ) : null}
          </div>
          {showCc ? (
            <>
              <RecipientInput label={t('mail.compose.cc')} value={cc} onChange={setCc} />
              <RecipientInput label={t('mail.compose.bcc')} value={bcc} onChange={setBcc} />
            </>
          ) : null}
          <div className="flex items-center gap-1.5 border-b border-line py-1.5">
            <label htmlFor="mail-subject" className="w-14 shrink-0 text-sm text-fg2">
              {t('mail.compose.subject')}
            </label>
            <input
              id="mail-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="min-h-8 flex-1 bg-transparent text-sm font-semibold outline-none"
            />
          </div>
        </div>
        <div className="min-h-[220px] overflow-y-auto px-5 py-3" onKeyDown={() => setTouched(true)}>
          <RichEditor
            variant="light"
            value={emptyDoc()}
            labels={labels}
            placeholder={t('mail.compose.bodyPlaceholder')}
            editorRef={editor}
          />
          {quote ? (
            <div className="mt-3 flex flex-col gap-2">
              <Button
                size="xs"
                variant="gh"
                className="self-start"
                onClick={() => setShowQuote((v) => !v)}
              >
                <Icon name="dots" size={14} />
                {showQuote ? t('mail.compose.hideQuoted') : t('mail.compose.showQuoted')}
              </Button>
              {showQuote ? (
                <iframe
                  title={t('mail.compose.quoted')}
                  srcDoc={bodyDocument(
                    { html: quote, text: null },
                    { remoteImages: false, dark: false },
                  )}
                  sandbox=""
                  className="h-60 w-full rounded-md border border-line bg-white"
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {attachments.length ? (
          <ul className="m-0 flex list-none flex-wrap gap-2 border-t border-line px-5 py-3">
            {attachments.map((a) => (
              <li
                key={a.key}
                className="flex max-w-full items-center gap-2 rounded-lg bg-bg2 py-1 pr-1 pl-3 text-sm"
              >
                <Icon
                  name={a.source.kind === 'drive' ? 'folder' : 'clip'}
                  size={14}
                  className="shrink-0 text-fg2"
                />
                <span className="min-w-0 truncate">{a.name}</span>
                <span className="shrink-0 text-xs text-fg3">{formatBytes(a.size, locale)}</span>
                <IconButton
                  size="xs"
                  tone="plain"
                  aria-label={t('mail.compose.removeAttachment', { name: a.name })}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x !== a))}
                >
                  <Icon name="x" size={12} />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <Button variant="pri" loading={send.isPending} onClick={() => send.mutate()}>
            <Icon name="send" size={16} />
            {t('mail.compose.send')}
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="gh" size="sm">
                <Icon name="clip" size={16} />
                {t('mail.compose.attach')}
              </Button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem icon="upload" onSelect={() => fileInput.current?.click()}>
                {t('mail.compose.attachLocal')}
              </MenuItem>
              <MenuItem icon="folder" onSelect={() => setPicking(true)}>
                {t('mail.compose.attachDrive')}
              </MenuItem>
            </MenuContent>
          </Menu>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-label={t('mail.compose.attachLocal')}
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {canned ? (
            <Menu>
              <MenuTrigger asChild>
                <Button variant="gh" size="sm">
                  <Icon name="note" size={16} />
                  {t('mail.inbox.canned.insert')}
                </Button>
              </MenuTrigger>
              <MenuContent align="start">
                {canned.length === 0 ? (
                  <MenuItem disabled>{t('mail.inbox.canned.none')}</MenuItem>
                ) : (
                  canned.map((c) => (
                    <MenuItem
                      key={c.id}
                      onSelect={() => {
                        editor.current?.getEditor().chain().focus().insertContent(c.html).run();
                        setTouched(true);
                      }}
                    >
                      {c.title}
                    </MenuItem>
                  ))
                )}
              </MenuContent>
            </Menu>
          ) : null}
          {footer}
          <span className="ml-auto" />
          <Button variant="gh" size="sm" onClick={close}>
            {t('mail.compose.discard')}
          </Button>
        </div>
        {/* Mounted per use, so every pick starts empty. */}
        {picking ? <DrivePicker open onOpenChange={setPicking} onPick={addDrive} /> : null}
        <ConfirmDialog
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          title={t('mail.compose.discardTitle')}
          body={t('mail.compose.discardBody')}
          confirm={t('mail.compose.discardConfirm')}
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
