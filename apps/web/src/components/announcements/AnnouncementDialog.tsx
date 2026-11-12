import { ANNOUNCEMENT_LIMITS, type Announcement } from '@crewhall/shared';
import {
  Button,
  CheckboxRow,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { applyAnnouncement } from '@/lib/announcements/queries';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Write or edit an announcement: title, text, "önemli" (pinned) and "okudum onayı iste". */
export function AnnouncementDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing?: Announcement | null;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState(editing?.title ?? '');
  const [body, setBody] = useState(editing?.body ?? '');
  const [pinned, setPinned] = useState(editing ? editing.pinnedAt !== null : false);
  const [requiresAck, setRequiresAck] = useState(editing?.requiresAck ?? false);
  const [busy, setBusy] = useState(false);
  const ready = title.trim().length > 0 && body.trim().length > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const fields = { title: title.trim(), body: body.trim(), pinned, requiresAck };
      const saved = editing
        ? await api.call('updateAnnouncement', {
            params: { announcementId: editing.id },
            body: fields,
          })
        : await api.call('createAnnouncement', { body: fields });
      applyAnnouncement(qc, saved);
      toast(t(editing ? 'announcements.toast.saved' : 'announcements.toast.published'));
      onOpenChange(false);
      if (!editing) {
        void navigate({
          to: '/announcements/$announcementId',
          params: { announcementId: saved.id },
        });
      }
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={560}>
        <DialogHeader
          title={t(editing ? 'announcements.dialog.editTitle' : 'announcements.dialog.title')}
          description={editing ? undefined : t('announcements.dialog.hint')}
        />
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label={t('announcements.dialog.titleLabel')}>
            <Input
              autoFocus
              value={title}
              maxLength={ANNOUNCEMENT_LIMITS.titleChars}
              placeholder={t('announcements.dialog.titlePlaceholder')}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label={t('announcements.dialog.bodyLabel')}>
            <Textarea
              rows={8}
              value={body}
              maxLength={ANNOUNCEMENT_LIMITS.bodyChars}
              placeholder={t('announcements.dialog.bodyPlaceholder')}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <CheckboxRow checked={pinned} onCheckedChange={(v) => setPinned(v === true)}>
            {t('announcements.dialog.pinned')}
          </CheckboxRow>
          <CheckboxRow checked={requiresAck} onCheckedChange={(v) => setRequiresAck(v === true)}>
            {t('announcements.dialog.requiresAck')}
          </CheckboxRow>
          {!editing ? (
            <p className="m-0 text-xs text-fg2">{t('announcements.dialog.notifyHint')}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="gh" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" disabled={!ready || busy}>
              {t(editing ? 'announcements.dialog.save' : 'announcements.dialog.publish')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
