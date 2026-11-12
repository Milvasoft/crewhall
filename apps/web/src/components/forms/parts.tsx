import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, Input } from '@crewhall/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Confirm before deleting a form or an answer. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  body: ReactNode;
  confirm: ReactNode;
  onConfirm: () => void;
  pending?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={440}>
        <DialogHeader icon="alert" title={title} description={body} />
        <DialogFooter>
          <Button variant="gh" onClick={() => onOpenChange(false)}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="dngf" loading={pending} onClick={onConfirm}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * In-place rename of a list item: Enter or leaving the field saves, Escape cancels. Used by the
 * forms and automations lists (double-click on the title or "Rename" in the right-click menu).
 */
export function RenameInput({
  value,
  label,
  maxLength,
  onCommit,
  onCancel,
  containerClassName,
}: {
  value: string;
  label: string;
  maxLength: number;
  onCommit: (next: string) => void;
  onCancel: () => void;
  containerClassName?: string;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const shownAt = useRef(0);
  const done = useRef(false);
  useEffect(() => {
    shownAt.current = Date.now();
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const next = text.trim();
    if (next && next !== value) onCommit(next);
    else onCancel();
  };
  return (
    <Input
      ref={ref}
      aria-label={label}
      value={text}
      maxLength={maxLength}
      containerClassName={containerClassName}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        // A right-click menu that just closed hands focus back to where it was; keep the field.
        if (Date.now() - shownAt.current < 400) {
          requestAnimationFrame(() => ref.current?.focus());
          return;
        }
        commit();
      }}
    />
  );
}
