import { type SeriesScope } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Radio,
  RadioGroup,
} from '@crewhall/ui';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

/** "Yalnız bu etkinlik / Bu ve sonrakiler / Tüm etkinlikler" for a change to a series. */
export function ScopeDialog({
  kind,
  withFollowing = true,
  onPick,
  onCancel,
}: {
  kind: 'edit' | 'delete';
  /** Off for connected calendars: Google / Outlook series are not split from Crewhall. */
  withFollowing?: boolean;
  onPick: (scope: SeriesScope) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState<SeriesScope>('this');
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent width={400}>
        <DialogHeader
          title={
            kind === 'delete' ? t('calendar.scope.deleteTitle') : t('calendar.scope.editTitle')
          }
        />
        <RadioGroup
          value={scope}
          onValueChange={(v) => setScope(v as SeriesScope)}
          className="flex flex-col gap-3"
          aria-label={t('calendar.scope.editTitle')}
        >
          {(withFollowing
            ? (['this', 'following', 'all'] as const)
            : (['this', 'all'] as const)
          ).map((s) => (
            <label key={s} className="flex items-center gap-2.5 text-sm font-medium">
              <Radio value={s} aria-label={t(`calendar.scope.${s}`)} />
              {t(`calendar.scope.${s}`)}
            </label>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button variant="gh" onClick={onCancel}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant={kind === 'delete' ? 'dngf' : 'pri'} onClick={() => onPick(scope)}>
            {kind === 'delete' ? t('common.actions.delete') : t('common.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
