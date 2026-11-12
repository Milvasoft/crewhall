import { type MailCannedResponse, type MailInbox, type Space } from '@crewhall/shared';
import { emptyDoc } from '@crewhall/editor';
import { RichEditor, type RichEditorHandle } from '@crewhall/editor/react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/identity/parts';
import { editorLabels } from '@/components/portal/PortalEditor';
import { api, idempotencyKey } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { whenEditorReady } from '@/lib/mail/editor';
import { cannedQuery, inboxKeys } from '@/lib/mail/inbox';
import { inboxOauthStartUrl, mailAccountQuery } from '@/lib/mail/queries';
import { mailError } from '@/components/mail/errors';

/** First response targets offered (minutes); "none" switches the SLA off. */
const SLA_CHOICES = [15, 30, 60, 120, 240, 480, 1440] as const;
const NO_SLA = 'none';

/**
 * Adds a shared inbox (`spaces`: where the caller may) or edits one (`inbox`): name, the
 * address and its password, the first response target and the signature.
 */
export function InboxSettingsDialog(
  props: { inbox: MailInbox; onClose: () => void } | { spaces: Space[]; onClose: () => void },
) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const inbox = 'inbox' in props ? props.inbox : null;
  const labels = useMemo(() => editorLabels(t), [t]);
  const signature = useRef<RichEditorHandle>(null);
  const [spaceId, setSpaceId] = useState(
    'spaces' in props ? (props.spaces[0]?.id ?? '') : (inbox?.spaceId ?? ''),
  );
  const [name, setName] = useState(inbox?.name ?? '');
  const [email, setEmail] = useState(inbox?.email ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [sla, setSla] = useState(
    inbox?.slaFirstResponseMinutes ? String(inbox.slaFirstResponseMinutes) : NO_SLA,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  // An org that signs in with Microsoft 365 or Google: the inbox needs no password, an admin
  // signs it in after it is added.
  const server = useQuery(mailAccountQuery).data?.server;
  const oauth = server !== undefined && server.authMode !== 'password';

  useEffect(
    () =>
      whenEditorReady(signature, (ed) => {
        if (inbox?.signatureHtml) ed.commands.setContent(inbox.signatureHtml);
      }),
    [inbox?.signatureHtml],
  );

  const html = () => {
    const ed = signature.current?.getEditor();
    return ed && !ed.isEmpty ? ed.getHTML() : '';
  };
  const slaMinutes = sla === NO_SLA ? null : Number(sla);
  const save = useMutation({
    mutationFn: () =>
      inbox
        ? api.call('mailUpdateInbox', {
            params: { inboxId: inbox.id },
            body: {
              name: name.trim(),
              signatureHtml: html(),
              slaFirstResponseMinutes: slaMinutes,
              ...(password ? { password } : {}),
            },
          })
        : api.call('mailCreateInbox', {
            body: {
              spaceId,
              name: name.trim(),
              email: email.trim(),
              ...(username.trim() ? { username: username.trim() } : {}),
              ...(password ? { password } : {}),
              signatureHtml: html(),
              slaFirstResponseMinutes: slaMinutes,
            },
            idempotencyKey: idempotencyKey(),
          }),
    onSuccess: async (saved) => {
      toast(inbox ? t('mail.inbox.saved') : t('mail.inbox.created', { name: saved.name }));
      await qc.invalidateQueries({ queryKey: inboxKeys.list });
      props.onClose();
      if (!inbox && saved.needsSignIn) window.location.assign(inboxOauthStartUrl(saved.id));
      else if (!inbox) void navigate({ to: '/mail/inbox/$inboxId', params: { inboxId: saved.id } });
    },
    onError: (e) => toast(mailError(t, e)),
  });
  const remove = useMutation({
    mutationFn: () => api.call('mailDeleteInbox', { params: { inboxId: inbox!.id } }),
    onSuccess: async () => {
      toast(t('mail.inbox.deleted'));
      await qc.invalidateQueries({ queryKey: inboxKeys.list });
      props.onClose();
      void navigate({ to: '/mail' });
    },
    onError: (e) => toast(mailError(t, e)),
  });
  const ready = name.trim() && (inbox || (spaceId && email.trim() && (password || oauth)));

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : props.onClose())}>
      <DialogContent width={560}>
        <DialogHeader
          icon="inbox"
          title={inbox ? t('mail.inbox.settingsTitle', { name: inbox.name }) : t('mail.inbox.add')}
          description={t('mail.inbox.settingsHint')}
        />
        <div className="flex flex-col gap-3">
          {'spaces' in props ? (
            <Field label={t('mail.inbox.space')} hint={t('mail.inbox.spaceHint')}>
              <Select value={spaceId} onValueChange={setSpaceId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {props.spaces.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field label={t('mail.inbox.name')}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('mail.inbox.namePlaceholder')}
            />
          </Field>
          <Field label={t('mail.inbox.email')}>
            <Input
              type="email"
              value={email}
              disabled={Boolean(inbox)}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="destek@ornek.com"
            />
          </Field>
          {!inbox ? (
            <Field label={t('mail.inbox.username')} hint={t('mail.inbox.usernameHint')}>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
          ) : null}
          <Field
            label={inbox ? t('mail.inbox.newPassword') : t('mail.inbox.password')}
            hint={oauth ? t('mail.inbox.passwordOauthHint') : t('mail.inbox.passwordHint')}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label={t('mail.inbox.sla.label')} hint={t('mail.inbox.sla.hint')}>
            <Select value={sla} onValueChange={setSla}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SLA}>{t('mail.inbox.sla.none')}</SelectItem>
                {SLA_CHOICES.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {m < 60
                      ? t('mail.inbox.sla.minutes', { count: m })
                      : t('mail.inbox.sla.hours', { count: m / 60 })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-cap font-semibold">{t('mail.settings.signature')}</span>
            <div className="min-h-[80px] rounded-lg px-3 py-2 shadow-line2">
              <RichEditor
                variant="light"
                value={emptyDoc()}
                labels={labels}
                editorRef={signature}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          {inbox ? (
            <Button variant="dng" className="mr-auto" onClick={() => setConfirmDelete(true)}>
              {t('mail.inbox.delete')}
            </Button>
          ) : null}
          <Button variant="gh" onClick={props.onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="pri"
            disabled={!ready}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            {inbox ? t('common.actions.save') : t('mail.inbox.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
      {inbox ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t('mail.inbox.deleteTitle', { name: inbox.name })}
          body={t('mail.inbox.deleteHint')}
          confirm={t('mail.inbox.delete')}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </Dialog>
  );
}

/** Canned responses of an inbox: the team's saved replies (space editors). */
export function CannedDialog({ inbox, onClose }: { inbox: MailInbox; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const list = useQuery(cannedQuery(inbox.id));
  const [editing, setEditing] = useState<MailCannedResponse | 'new' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: inboxKeys.canned(inbox.id) });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.call('mailDeleteCannedResponse', { params: { inboxId: inbox.id, cannedId: id } }),
    onSuccess: () => void refresh(),
    onError: (e) => toast(mailError(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent width={600}>
        <DialogHeader
          icon="note"
          title={t('mail.inbox.canned.title')}
          description={t('mail.inbox.canned.hint')}
        />
        {editing ? (
          <CannedEditor
            inbox={inbox}
            item={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
              void refresh();
            }}
          />
        ) : (
          <>
            {(list.data?.items ?? []).length === 0 ? (
              <EmptyState icon="note" title={t('mail.inbox.canned.empty')} />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {list.data!.items.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.title}</span>
                    <IconButton
                      size="xs"
                      tone="plain"
                      aria-label={t('mail.inbox.canned.edit', { title: c.title })}
                      onClick={() => setEditing(c)}
                    >
                      <Icon name="edit" size={14} />
                    </IconButton>
                    <IconButton
                      size="xs"
                      tone="plain"
                      aria-label={t('mail.inbox.canned.delete', { title: c.title })}
                      onClick={() => remove.mutate(c.id)}
                    >
                      <Icon name="trash" size={14} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button variant="gh" onClick={onClose}>
                {t('common.actions.close')}
              </Button>
              <Button variant="pri" onClick={() => setEditing('new')}>
                <Icon name="plus" size={16} />
                {t('mail.inbox.canned.add')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CannedEditor({
  inbox,
  item,
  onDone,
}: {
  inbox: MailInbox;
  item: MailCannedResponse | null;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const labels = useMemo(() => editorLabels(t), [t]);
  const body = useRef<RichEditorHandle>(null);
  const [title, setTitle] = useState(item?.title ?? '');
  useEffect(
    () =>
      whenEditorReady(body, (ed) => {
        if (item?.html) ed.commands.setContent(item.html);
      }),
    [item?.html],
  );
  const save = useMutation({
    mutationFn: () => {
      const ed = body.current?.getEditor();
      const html = ed && !ed.isEmpty ? ed.getHTML() : '';
      return item
        ? api.call('mailUpdateCannedResponse', {
            params: { inboxId: inbox.id, cannedId: item.id },
            body: { title: title.trim(), html },
          })
        : api.call('mailCreateCannedResponse', {
            params: { inboxId: inbox.id },
            body: { title: title.trim(), html },
          });
    },
    onSuccess: onDone,
    onError: (e) => toast(mailError(t, e)),
  });
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('mail.inbox.canned.name')}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="min-h-[140px] rounded-lg px-3 py-2 shadow-line2">
        <RichEditor variant="light" value={emptyDoc()} labels={labels} editorRef={body} />
      </div>
      <DialogFooter>
        <Button variant="gh" onClick={onDone}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="pri"
          disabled={!title.trim()}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('common.actions.save')}
        </Button>
      </DialogFooter>
    </div>
  );
}
