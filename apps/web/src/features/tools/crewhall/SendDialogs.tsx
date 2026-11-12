import { CHAT_LIMITS } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { spaceName } from '@/components/spaces/spaceUtils';
import { NodePicker, type PickerPlace } from '@/features/drive/NodePicker';
import { addUploads } from '@/features/drive/uploads';
import { api } from '@/lib/api';
import { enqueue } from '@/lib/chat/outbox';
import { conversationsQuery } from '@/lib/chat/queries';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { useSpaces } from '@/lib/useSpaces';
import { pagePath } from '@crewhall/shared';
import { type ToolDataType } from '@/features/tools/lib/tool-sdk';
import { asFile, asMarkdown } from './output';

/**
 * "Gönder" targets outside the tools (roadmap: Crewhall entegrasyonları): the output goes to a
 * chat as a message, to a new page as Markdown, or to a Drive folder as a file. Everything
 * runs with the person's own rights through the regular endpoints.
 */

export type SendTarget = 'chat' | 'page' | 'drive';

export interface SendRequest {
  target: SendTarget;
  value: string;
  type: ToolDataType | undefined;
  /** For file names and page titles. */
  toolId: string;
  toolName: string;
}

export function SendDialog({
  request,
  onClose,
}: {
  request: SendRequest | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(o) => (o ? null : onClose())}>
      {request?.target === 'chat' ? <ChatBody req={request} onClose={onClose} /> : null}
      {request?.target === 'page' ? <PageBody req={request} onClose={onClose} /> : null}
      {request?.target === 'drive' ? <DriveBody req={request} onClose={onClose} /> : null}
    </Dialog>
  );
}

function ChatBody({ req, onClose }: { req: SendRequest; onClose: () => void }) {
  const { t, locale } = useI18n();
  const convs = useQuery(conversationsQuery);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const text = asMarkdown(req.value, req.type);
  const tooLong = text.length > CHAT_LIMITS.messageChars;
  const needle = q.trim().toLocaleLowerCase(locale);
  const shown = (convs.data ?? []).filter(
    (c) => !c.archivedAt && (!needle || c.title.toLocaleLowerCase(locale).includes(needle)),
  );
  const conv = shown.find((c) => c.id === chosen);
  return (
    <DialogContent width={460}>
      <DialogHeader icon="chat" title={t('tools.send.chatTitle')} />
      <Input
        autoFocus
        icon="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('tools.send.chatSearch')}
        aria-label={t('tools.send.chatSearch')}
      />
      <div
        role="listbox"
        aria-label={t('tools.send.chatTitle')}
        className="flex max-h-[300px] min-h-[120px] flex-col gap-0.5 overflow-y-auto"
      >
        {shown.length === 0 ? (
          <p className="m-0 py-6 text-center text-cap text-fg3">{t('tools.send.none')}</p>
        ) : (
          shown.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={chosen === c.id}
              onClick={() => setChosen(c.id)}
              className={cn(
                'flex min-h-10 items-center gap-3 rounded-lg px-2.5 text-left text-cap font-semibold hover:bg-bg2',
                chosen === c.id && 'bg-capsule',
              )}
            >
              <Icon name="chat" size={16} className="text-fg2" />
              <span className="truncate">{c.title}</span>
            </button>
          ))
        )}
      </div>
      {tooLong ? (
        <p className="m-0 text-cap text-danger">
          {t('tools.send.tooLong', { max: CHAT_LIMITS.messageChars })}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="gh" onClick={onClose}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="pri"
          disabled={!conv || tooLong}
          onClick={() => {
            if (!conv) return;
            enqueue({ conversationId: conv.id, text, replyTo: null, attachments: [] });
            toast(t('tools.send.chatSent', { name: conv.title }));
            onClose();
          }}
        >
          {t('tools.send.chatSend')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function PageBody({ req, onClose }: { req: SendRequest; onClose: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { canSpace } = usePermissions();
  const { items: spaces, preferred } = useSpaces();
  const writable = useMemo(
    () => spaces.filter((s) => canSpace('space.edit_content', s.myRole)),
    [spaces, canSpace],
  );
  const [spaceId, setSpaceId] = useState(
    () => writable.find((s) => s.id === preferred()?.id)?.id ?? writable[0]?.id ?? '',
  );
  const [name, setName] = useState(req.toolName);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const page = await api.call('createPage', {
        params: { spaceId },
        body: { parentId: null, name: name.trim(), markdown: asMarkdown(req.value, req.type) },
      });
      toast(t('tools.send.pageCreated'));
      onClose();
      void navigate({ to: '/p/$pageRef', params: { pageRef: pagePath(page).slice(3) } });
    } catch (e) {
      toast(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogContent width={460}>
      <DialogHeader icon="page" title={t('tools.send.pageTitle')} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && spaceId) void create();
        }}
      >
        <Field label={t('tools.send.pageName')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
        </Field>
        <Field label={t('tools.send.pageSpace')}>
          <Select value={spaceId} onValueChange={setSpaceId}>
            <SelectTrigger aria-label={t('tools.send.pageSpace')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {writable.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {spaceName(s, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="submit" variant="pri" loading={busy} disabled={!name.trim() || !spaceId}>
            {t('tools.send.pageCreate')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function DriveBody({ req, onClose }: { req: SendRequest; onClose: () => void }) {
  const { t } = useI18n();
  const { preferred } = useSpaces();
  const file = useMemo(() => asFile(req.value, req.type, req.toolId), [req]);
  const [name, setName] = useState(file.name);
  const [place, setPlace] = useState<PickerPlace>({
    spaceId: preferred()?.id ?? '',
    folderId: null,
    path: [],
  });
  const folderName = place.path.at(-1)?.name ?? '';
  return (
    <DialogContent width={640}>
      <DialogHeader icon="folder" title={t('tools.send.driveTitle')} />
      <Field label={t('tools.send.driveName')}>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
      </Field>
      <NodePicker mode="folder" place={place} onPlace={setPlace} />
      <DialogFooter>
        <Button variant="gh" onClick={onClose}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="pri"
          disabled={!name.trim() || !place.spaceId}
          onClick={() => {
            addUploads([new File([file.blob], name.trim(), { type: file.blob.type })], {
              spaceId: place.spaceId,
              parentId: place.folderId,
              folderName,
            });
            toast(t('tools.send.driveSaved', { name: name.trim() }));
            onClose();
          }}
        >
          {t('tools.send.driveSave')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
