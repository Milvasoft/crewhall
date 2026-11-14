import { ChatReportReason, type ChatReportReason as Reason } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Radio,
  RadioGroup,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useBootstrap } from '@/lib/useBranding';

/**
 * "Yöneticiye bildir": a message or a person reported to the org's own admins (API 54). The
 * dialog is mounted once in the signed-in shell (ChatRuntime), so the person card, which
 * closes as the dialog opens, can open it too.
 */

/** The server lists `chat.reports` from API 54 on, while chat is on for the org. */
export function useReportsEnabled(): boolean {
  return useBootstrap().data?.server?.capabilities?.includes('chat.reports') ?? false;
}

export type ReportTarget =
  | { type: 'message'; messageId: string }
  | { type: 'user'; userId: string; name: string };

let current: ReportTarget | null = null;
const listeners = new Set<() => void>();

export function openReportDialog(target: ReportTarget | null): void {
  current = target;
  listeners.forEach((l) => l());
}

function useReportTarget(): ReportTarget | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}

const close = () => openReportDialog(null);

export const REPORT_NOTE_MAX = 1000;

export function ReportDialog() {
  const target = useReportTarget();
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && close()}>
      {target ? (
        <ReportBody
          key={target.type === 'message' ? target.messageId : target.userId}
          target={target}
        />
      ) : null}
    </Dialog>
  );
}

function ReportBody({ target }: { target: ReportTarget }) {
  const { t } = useI18n();
  const [reason, setReason] = useState<Reason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!reason) return;
    setBusy(true);
    const body = { reason, ...(note.trim() ? { note: note.trim() } : {}) };
    try {
      if (target.type === 'message') {
        await api.call('reportChatMessage', { params: { messageId: target.messageId }, body });
      } else {
        await api.call('reportUser', { params: { userId: target.userId }, body });
      }
      close();
      toast(t('chat.reports.dialog.sent'));
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent width={460}>
      <DialogHeader
        icon="flag"
        title={
          target.type === 'message'
            ? t('chat.reports.dialog.titleMessage')
            : t('chat.reports.dialog.titleUser', { name: target.name })
        }
        description={t('chat.reports.dialog.body')}
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1.5 p-0 text-cap font-semibold">
            {t('chat.reports.dialog.reason')}
          </legend>
          <RadioGroup
            value={reason ?? ''}
            onValueChange={(v) => setReason(v as Reason)}
            className="flex flex-col gap-1"
          >
            {ChatReportReason.options.map((r) => (
              <label
                key={r}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 shadow-line',
                  reason === r && 'shadow-[inset_0_0_0_1.5px_var(--fg)]',
                )}
              >
                <Radio value={r} aria-label={t(`chat.reports.reason.${r}`)} />
                <span className="text-cap">{t(`chat.reports.reason.${r}`)}</span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>
        <Field label={t('chat.reports.dialog.note')}>
          <Textarea
            value={note}
            rows={3}
            maxLength={REPORT_NOTE_MAX}
            placeholder={t('chat.reports.dialog.notePlaceholder')}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="gh" onClick={close}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="submit" variant="dngf" loading={busy} disabled={!reason}>
            {t('chat.reports.dialog.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
