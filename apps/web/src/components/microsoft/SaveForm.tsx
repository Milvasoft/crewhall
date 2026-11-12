import type { SaveTarget, SavedToCrewhall, SaveToCrewhall } from '@crewhall/shared';
import {
  Button,
  Field,
  Input,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@crewhall/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import type { officeApi } from '@/lib/microsoft/office';

type OfficeApi = ReturnType<typeof officeApi>;
type Kind = SaveTarget['kind'];

/**
 * "Crewhall'a kaydet" of the Outlook add-in and the Teams app: where (a page in a space, a card
 * on a board, a message in a conversation) and the title; the rest comes from the mail or message.
 */
export function SaveForm({
  client,
  item,
  onSaved,
}: {
  client: OfficeApi;
  item: Omit<SaveToCrewhall, 'target'>;
  onSaved?: (saved: SavedToCrewhall) => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<Kind>('page');
  const [title, setTitle] = useState(item.title);
  const [spaceId, setSpace] = useState('');
  const [boardId, setBoard] = useState('');
  const [conversationId, setConversation] = useState('');
  const spaces = useQuery({
    queryKey: ['office', 'spaces'],
    queryFn: () => client.call('listSpaces'),
  });
  const boardSpace = spaceId || spaces.data?.items[0]?.id || '';
  const boards = useQuery({
    queryKey: ['office', 'boards', boardSpace],
    queryFn: () => client.call('listBoards', { params: { spaceId: boardSpace } }),
    enabled: kind === 'card' && !!boardSpace,
  });
  const conversations = useQuery({
    queryKey: ['office', 'conversations'],
    queryFn: () => client.call('listConversations', { query: {} as never }),
    enabled: kind === 'chat',
  });
  const save = useMutation({
    mutationFn: () => {
      const target: SaveTarget =
        kind === 'page'
          ? { kind, spaceId: boardSpace }
          : kind === 'card'
            ? { kind, boardId }
            : { kind, conversationId };
      return client.call('saveToCrewhall', { body: { ...item, title: title.trim(), target } });
    },
    onSuccess: (saved) => onSaved?.(saved),
  });
  const ready =
    title.trim().length > 0 &&
    (kind === 'page' ? !!boardSpace : kind === 'card' ? !!boardId : !!conversationId);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label={t('microsoft.save.target')}>
        <Segmented
          value={kind}
          onValueChange={setKind}
          aria-label={t('microsoft.save.target')}
          options={(['page', 'card', 'chat'] as const).map((k) => ({
            value: k,
            label: t(`microsoft.save.targets.${k}`),
          }))}
        />
      </Field>
      <Field label={t('microsoft.save.titleField')}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {kind !== 'chat' ? (
        <Field label={t('microsoft.save.space')}>
          <Select value={boardSpace} onValueChange={setSpace}>
            <SelectTrigger aria-label={t('microsoft.save.space')}>
              <SelectValue placeholder={t('microsoft.save.pick')} />
            </SelectTrigger>
            <SelectContent>
              {(spaces.data?.items ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {kind === 'card' ? (
        <Field label={t('microsoft.save.board')}>
          <Select value={boardId} onValueChange={setBoard}>
            <SelectTrigger aria-label={t('microsoft.save.board')}>
              <SelectValue placeholder={t('microsoft.save.pick')} />
            </SelectTrigger>
            <SelectContent>
              {(boards.data?.items ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {kind === 'chat' ? (
        <Field label={t('microsoft.save.conversation')}>
          <Select value={conversationId} onValueChange={setConversation}>
            <SelectTrigger aria-label={t('microsoft.save.conversation')}>
              <SelectValue placeholder={t('microsoft.save.pick')} />
            </SelectTrigger>
            <SelectContent>
              {(conversations.data?.items ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {save.isError ? <Notice tone="error">{t(errorKey(save.error))}</Notice> : null}
      {save.data ? (
        <Notice tone="info">
          {t('microsoft.save.saved')}{' '}
          <a
            href={save.data.path}
            target="_blank"
            rel="noreferrer"
            className="font-semibold underline"
          >
            {t('microsoft.save.open')}
          </a>
        </Notice>
      ) : null}
      <Button type="submit" variant="inv" loading={save.isPending} disabled={!ready}>
        {t('microsoft.save.submit')}
      </Button>
    </form>
  );
}
