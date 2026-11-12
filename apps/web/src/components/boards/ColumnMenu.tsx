import { type BoardColumn, type BoardDetail } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@crewhall/ui';
import { useState } from 'react';
import { ActionDropdown, type ActionEntry } from '@/components/common/ActionMenu';
import { useBoardActions } from '@/lib/boards/actions';
import { useI18n } from '@/lib/i18n/I18nContext';

type Mode = null | 'rename' | 'wip' | 'delete';

/**
 * A column's actions (rename, WIP limit, done, delete) as menu entries plus the dialog they
 * open: the same entries feed the header's dots menu and its right-click menu (managers).
 */
export function useColumnMenu(column: BoardColumn, detail: BoardDetail) {
  const { t } = useI18n();
  const actions = useBoardActions(detail.board.id);
  const [mode, setMode] = useState<Mode>(null);
  const [name, setName] = useState(column.name);
  const [wip, setWip] = useState(column.wipLimit ? String(column.wipLimit) : '');
  const others = detail.columns.filter((c) => c.id !== column.id);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? '');
  const hasCards = detail.cards.some((c) => c.columnId === column.id);

  const close = () => setMode(null);
  /** Each dialog starts from the column as it is now (it may have changed meanwhile). */
  const open = (m: Exclude<Mode, null>) => {
    setName(column.name);
    setWip(column.wipLimit ? String(column.wipLimit) : '');
    setMoveTo(others[0]?.id ?? '');
    setMode(m);
  };
  const rename = () => open('rename');
  const entries: ActionEntry[] = [
    {
      kind: 'item',
      key: 'rename',
      icon: 'edit',
      label: t('boards.column.rename'),
      onSelect: () => open('rename'),
    },
    {
      kind: 'item',
      key: 'wip',
      icon: 'sliders',
      label: t('boards.column.setWip'),
      onSelect: () => open('wip'),
    },
    {
      kind: 'item',
      key: 'done',
      icon: 'checkC',
      label: column.isDone ? t('boards.column.unmarkDone') : t('boards.column.markDone'),
      onSelect: () => void actions.updateColumn(column.id, { isDone: !column.isDone }),
    },
    { kind: 'sep', key: 's1' },
    {
      kind: 'item',
      key: 'delete',
      icon: 'trash',
      label: t('boards.column.delete'),
      danger: true,
      disabledReason: others.length === 0 ? t('boards.column.lastColumn') : undefined,
      onSelect: () => open('delete'),
    },
  ];

  const dialog = (
    <>
      <Dialog open={mode !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent width={400}>
          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (mode === 'rename' && name.trim()) {
                await actions.updateColumn(column.id, { name: name.trim() });
              }
              if (mode === 'wip') {
                const n = Number(wip);
                await actions.updateColumn(column.id, {
                  wipLimit: wip && n > 0 ? Math.round(n) : null,
                });
              }
              if (
                mode === 'delete' &&
                !(await actions.deleteColumn(column.id, hasCards ? moveTo : undefined))
              ) {
                return;
              }
              close();
            }}
          >
            <DialogHeader
              title={
                mode === 'rename'
                  ? t('boards.column.rename')
                  : mode === 'wip'
                    ? t('boards.column.setWip')
                    : t('boards.column.delete')
              }
              description={
                mode === 'wip'
                  ? t('boards.settings.columnsHint')
                  : mode === 'delete' && hasCards
                    ? t('errors.board_column_not_empty')
                    : undefined
              }
            />
            {mode === 'rename' ? (
              <Field label={t('boards.settings.name')}>
                <Input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                />
              </Field>
            ) : null}
            {mode === 'wip' ? (
              <Field label={t('boards.column.setWip')}>
                <Input
                  autoFocus
                  inputMode="numeric"
                  value={wip}
                  placeholder="—"
                  onChange={(e) => setWip(e.target.value.replace(/\D/g, '').slice(0, 3))}
                />
              </Field>
            ) : null}
            {mode === 'delete' && hasCards ? (
              <Field label={t('boards.detail.moveTo')}>
                <Select value={moveTo} onValueChange={setMoveTo}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {others.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="gh" size="sm" onClick={close}>
                {t('boards.detail.cancel')}
              </Button>
              <Button type="submit" size="sm" variant={mode === 'delete' ? 'dngf' : 'inv'}>
                {mode === 'delete' ? t('boards.column.delete') : t('boards.detail.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
  return { entries, dialog, rename };
}

/** The dots button in a column header. */
export function ColumnMenuButton({ entries }: { entries: ActionEntry[] }) {
  const { t } = useI18n();
  return (
    <ActionDropdown entries={entries}>
      <IconButton size="xs" tone="plain" aria-label={t('boards.column.menu')}>
        <Icon name="dots" size={15} />
      </IconButton>
    </ActionDropdown>
  );
}
