import { Button, Checkbox, Field, Input, Segmented, Skeleton, toast } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  isSignedOut,
  loadOffice,
  loadTokens,
  officeApi,
  officeCall,
  officeSignIn,
  saveTokens,
  type OfficeAttachment,
  type OfficeGlobal,
  type OfficeItem,
} from '@/lib/microsoft/office';
import { PaneFrame, SignInPrompt } from './OfficeAuth';
import { SaveForm } from './SaveForm';

/**
 * The Outlook task pane (Office Add-in, sonraki-isler.md): reading a mail, "Crewhall'a kaydet";
 * writing one, attachments become Drive links and an upload request link can be inserted.
 */
export function OutlookPane({ clientId, mode }: { clientId: string; mode: 'read' | 'compose' }) {
  const { t } = useI18n();
  const [office, setOffice] = useState<OfficeGlobal | null | undefined>(undefined);
  const [signedIn, setSignedIn] = useState(() => loadTokens(clientId) !== null);
  const [failed, setFailed] = useState(false);
  const client = useMemo(() => officeApi(clientId), [clientId]);
  useEffect(() => {
    void loadOffice().then(setOffice);
  }, []);

  const signIn = async () => {
    if (!office) return;
    setFailed(false);
    const ok = await officeSignIn(office, clientId);
    setSignedIn(ok);
    setFailed(!ok);
  };
  const signOut = () => {
    saveTokens(clientId, null);
    setSignedIn(false);
  };
  const title = mode === 'read' ? t('microsoft.pane.saveTitle') : t('microsoft.pane.linkTitle');

  if (office === undefined) {
    return (
      <PaneFrame title={title}>
        <Skeleton className="h-24 rounded-lg" />
      </PaneFrame>
    );
  }
  const item = office?.context.mailbox?.item ?? null;
  if (!office || !item) {
    return (
      <PaneFrame title={title}>
        <Notice tone="info">{t('microsoft.pane.notOffice')}</Notice>
      </PaneFrame>
    );
  }
  if (!signedIn) {
    return (
      <PaneFrame title={title}>
        <SignInPrompt failed={failed} onSignIn={() => void signIn()} />
      </PaneFrame>
    );
  }
  return (
    <PaneFrame title={title}>
      <SignedIn client={client} onSignedOut={signOut}>
        {mode === 'read' ? (
          <ReadMode client={client} item={item} />
        ) : (
          <ComposeMode client={client} item={item} />
        )}
      </SignedIn>
      <Button variant="gh" size="sm" className="self-start" onClick={signOut}>
        {t('microsoft.pane.signOut')}
      </Button>
    </PaneFrame>
  );
}

type Client = ReturnType<typeof officeApi>;

/** Checks the token once; an expired sign-in goes back to the prompt. */
function SignedIn({
  client,
  onSignedOut,
  children,
}: {
  client: Client;
  onSignedOut: () => void;
  children: React.ReactNode;
}) {
  const me = useQuery({
    queryKey: ['office', 'me'],
    queryFn: () => client.call('me'),
    retry: false,
  });
  useEffect(() => {
    if (me.isError && isSignedOut(me.error)) onSignedOut();
  }, [me.isError, me.error, onSignedOut]);
  if (!me.data) return <Skeleton className="h-24 rounded-lg" />;
  return <>{children}</>;
}

async function textOf(item: OfficeItem, kind: 'text' | 'html') {
  return officeCall<string>((cb) => item.body.getAsync(kind, cb));
}

function ReadMode({ client, item }: { client: Client; item: OfficeItem }) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    void textOf(item, 'text').then(setText, () => setText(''));
  }, [item]);
  if (text === null) return <Skeleton className="h-24 rounded-lg" />;
  const subject = typeof item.subject === 'string' ? item.subject : '';
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-cap text-fg2">{t('microsoft.pane.saveHint')}</p>
      <SaveForm
        client={client}
        item={{
          source: 'outlook',
          title: subject || t('microsoft.pane.saveTitle'),
          from: item.from ? { name: item.from.displayName, email: item.from.emailAddress } : null,
          sentAt: item.dateTimeCreated ? new Date(item.dateTimeCreated).toISOString() : null,
          text: text.slice(0, 100_000),
          link: null,
        }}
      />
    </div>
  );
}

const linkHtml = (url: string, label: string) => {
  const a = document.createElement('a');
  a.href = url;
  a.textContent = label;
  return `<p>${a.outerHTML}</p>`;
};

function ComposeMode({ client, item }: { client: Client; item: OfficeItem }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [password, setPassword] = useState('');
  const [days, setDays] = useState<'0' | '7' | '30'>('7');
  const [folder, setFolder] = useState('');
  const attachmentsQuery = useQuery({
    queryKey: ['office', 'attachments'],
    queryFn: () =>
      item.getAttachmentsAsync
        ? officeCall<OfficeAttachment[]>((cb) => item.getAttachmentsAsync!(cb)).then(
            (list) => list.filter((a) => !a.isInline),
            () => [],
          )
        : Promise.resolve([]),
  });
  const attachments = attachmentsQuery.data ?? null;
  const reload = () => void attachmentsQuery.refetch();

  const insert = (html: string) =>
    officeCall<void>((cb) => item.body.setSelectedDataAsync(html, { coercionType: 'html' }, cb));

  const convert = useMutation({
    mutationFn: async () => {
      const chosen = (attachments ?? []).filter((a) => selected.has(a.id));
      const expiresAt =
        days === '0' ? null : new Date(Date.now() + Number(days) * 86_400_000).toISOString();
      for (const a of chosen) {
        const content = await officeCall<{ content: string; format: string }>((cb) =>
          item.getAttachmentContentAsync(a.id, cb),
        );
        const shared = await client.call('shareAttachment', {
          body: {
            name: a.name,
            mime: a.contentType || null,
            contentBase64: content.content,
            expiresAt,
            ...(password ? { password } : {}),
          },
        });
        await insert(linkHtml(shared.url, a.name));
        if (item.removeAttachmentAsync) {
          await officeCall<void>((cb) => item.removeAttachmentAsync!(a.id, cb));
        }
      }
      return chosen.length;
    },
    onSuccess: (count) => {
      toast(t('microsoft.pane.converted', { count }));
      setSelected(new Set());
      reload();
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });

  const requests = useQuery({
    queryKey: ['office', 'upload-requests'],
    queryFn: () => client.call('listUploadRequests'),
    select: (d) => d.items.filter((r) => !r.revokedAt && Date.parse(r.expiresAt) > Date.now()),
  });
  const ask = useMutation({
    mutationFn: async () => {
      const req = await client.call('createUploadRequest', {
        body: { folderName: folder.trim(), ...(password ? { password } : {}) },
      });
      await insert(
        linkHtml(req.url!, t('microsoft.pane.uploadLinkText', { name: req.folderName })),
      );
    },
    onSuccess: () => {
      toast(t('microsoft.pane.uploadInserted'));
      setFolder('');
      void qc.invalidateQueries({ queryKey: ['office', 'upload-requests'] });
    },
    onError: (e) => toast.error(t(errorKey(e))),
  });
  const close = useMutation({
    mutationFn: (requestId: string) =>
      client.call('revokeUploadRequest', { params: { requestId } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['office', 'upload-requests'] }),
  });

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2" aria-label={t('microsoft.pane.attachments')}>
        <h2 className="m-0 text-cap font-semibold">{t('microsoft.pane.attachments')}</h2>
        {attachments === null ? (
          <Skeleton className="h-10 rounded-lg" />
        ) : attachments.length === 0 ? (
          <span className="text-cap text-fg2">{t('microsoft.pane.noAttachments')}</span>
        ) : (
          attachments.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-cap">
              <Checkbox
                checked={selected.has(a.id)}
                onCheckedChange={(v) => {
                  const next = new Set(selected);
                  if (v === true) next.add(a.id);
                  else next.delete(a.id);
                  setSelected(next);
                }}
              />
              <span className="truncate">{a.name}</span>
            </label>
          ))
        )}
      </section>
      <Field label={t('microsoft.pane.password')}>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <Field label={t('microsoft.pane.expires')}>
        <Segmented
          value={days}
          onValueChange={setDays}
          aria-label={t('microsoft.pane.expires')}
          options={[
            { value: '7', label: t('microsoft.pane.days', { count: 7 }) },
            { value: '30', label: t('microsoft.pane.days', { count: 30 }) },
            { value: '0', label: t('microsoft.pane.never') },
          ]}
        />
      </Field>
      <Button
        variant="inv"
        loading={convert.isPending}
        disabled={selected.size === 0 || (password.length > 0 && password.length < 4)}
        onClick={() => convert.mutate()}
      >
        {t('microsoft.pane.convert')}
      </Button>

      <section
        className="flex flex-col gap-2 border-t border-line pt-3"
        aria-label={t('microsoft.pane.uploadTitle')}
      >
        <h2 className="m-0 text-cap font-semibold">{t('microsoft.pane.uploadTitle')}</h2>
        <span className="text-xs text-fg2">{t('microsoft.pane.uploadHint')}</span>
        <Field label={t('microsoft.pane.uploadFolder')}>
          <Input value={folder} onChange={(e) => setFolder(e.target.value)} />
        </Field>
        <Button
          variant="out"
          loading={ask.isPending}
          disabled={!folder.trim()}
          onClick={() => ask.mutate()}
        >
          {t('microsoft.pane.uploadInsert')}
        </Button>
        {requests.data?.length ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-fg2">
              {t('microsoft.pane.openRequests')}
            </span>
            {requests.data.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-cap">
                <span className="truncate">
                  {r.folderName} · {t('microsoft.pane.uploads', { count: r.uploads })}
                </span>
                <Button size="sm" variant="gh" onClick={() => close.mutate(r.id)}>
                  {t('microsoft.pane.close')}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
