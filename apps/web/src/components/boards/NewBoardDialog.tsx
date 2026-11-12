import { type BoardTemplate, type Space } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Switch,
  toast,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api, idempotencyKey, isApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { TemplateGallery } from '@/components/templates/TemplateGallery';
import { invalidateDrive } from '@/features/drive/api';

const TEMPLATES: { id: BoardTemplate; columns: string[] }[] = [
  { id: 'empty', columns: ['', '', ''] },
  { id: 'sprint', columns: ['', '', '', ''] },
  { id: 'roadmap', columns: ['', '', '', '', ''] },
  { id: 'bugs', columns: ['', '', '', ''] },
];

/**
 * New board (design 6.7): name, location, template and card chats. A template sets up
 * columns, labels, WIP limits and fields only; never cards.
 */
export function NewBoardDialog({
  space,
  parentId = null,
  open,
  onClose,
}: {
  space: Space;
  /** Drive folder to create the board in; null = space root. */
  parentId?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<BoardTemplate>('roadmap');
  const [cardChats, setCardChats] = useState(true);
  const [busy, setBusy] = useState(false);
  // The template gallery (roadmap 8): boards with starter cards, org and saved templates.
  const [gallery, setGallery] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const board = await api.call('createBoard', {
        params: { spaceId: space.id },
        body: {
          name: name.trim(),
          template,
          cardChats,
          parentId,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        idempotencyKey: idempotencyKey(),
      });
      invalidateDrive(qc);
      void qc.invalidateQueries({ queryKey: ['boards', 'list'] });
      onClose();
      setName('');
      void navigate({ to: '/b/$boardId', params: { boardId: board.id } });
    } catch (e) {
      if (isApiError(e, 'node_name_taken')) setError(t(errorKey(e)));
      else toast(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={gallery} onOpenChange={setGallery}>
        {gallery ? (
          <TemplateGallery
            spaceId={space.id}
            parentId={parentId}
            kind="board"
            onClose={() => setGallery(false)}
          />
        ) : null}
      </Dialog>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent width={620}>
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <DialogHeader icon="board" title={t('boards.new.title')} />
            <Field label={t('boards.new.name')} error={error ?? undefined}>
              <Input
                autoFocus
                value={name}
                maxLength={200}
                placeholder={t('boards.new.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label={t('boards.new.location')}>
              <span className="flex h-11 items-center rounded-lg bg-bg2 px-3.5 text-sm text-fg2">
                {spaceName(space, t)} › {t('boards.new.root')}
              </span>
            </Field>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-fg">{t('boards.new.template')}</span>
              <div role="radiogroup" className="grid grid-cols-4 gap-2">
                {TEMPLATES.map((tp) => (
                  <button
                    key={tp.id}
                    type="button"
                    role="radio"
                    aria-checked={template === tp.id}
                    onClick={() => setTemplate(tp.id)}
                    className={cn(
                      'flex flex-col gap-2 rounded-xl bg-bg2 p-2.5 text-left transition-shadow',
                      template === tp.id
                        ? 'shadow-[0_0_0_2px_var(--fg)]'
                        : 'hover:shadow-[0_0_0_1px_var(--line2)]',
                    )}
                  >
                    <span className="flex h-12 gap-1 rounded-md bg-surface p-1.5">
                      {tp.columns.map((_, i) => (
                        <span
                          key={i}
                          className="flex flex-1 flex-col gap-1 rounded-xs bg-bg2 p-0.5"
                        >
                          <span className="h-1.5 rounded-[2px] bg-line2" />
                          {i % 2 === 0 ? <span className="h-1.5 rounded-[2px] bg-line2" /> : null}
                        </span>
                      ))}
                    </span>
                    <span className="text-[13px] font-bold text-fg">
                      {t(`boards.new.templates.${tp.id}.title`)}
                    </span>
                    <span className="text-[11.5px] text-fg3">
                      {t(`boards.new.templates.${tp.id}.hint`)}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-fg3">
                {t('boards.new.templateNote')}{' '}
                <button
                  type="button"
                  className="font-semibold text-fg underline-offset-2 hover:underline"
                  onClick={() => {
                    onClose();
                    setGallery(true);
                  }}
                >
                  {t('templates.fromGallery')}
                </button>
              </p>
            </div>
            <label className="flex items-center gap-3 rounded-lg bg-bg2 px-3.5 py-3">
              <span className="flex flex-1 flex-col">
                <span className="text-sm font-semibold text-fg">{t('boards.new.cardChats')}</span>
                <span className="text-xs text-fg2">{t('boards.new.cardChatsHint')}</span>
              </span>
              <Switch
                checked={cardChats}
                onCheckedChange={setCardChats}
                aria-label={t('boards.new.cardChats')}
              />
            </label>
            <DialogFooter>
              <Button type="button" variant="gh" size="sm" onClick={onClose}>
                {t('boards.new.cancel')}
              </Button>
              <Button type="submit" variant="pri" size="sm" loading={busy} disabled={!name.trim()}>
                {t('boards.new.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
