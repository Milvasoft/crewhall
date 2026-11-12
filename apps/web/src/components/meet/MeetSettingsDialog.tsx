import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { meetKeys, meetSpaceSettingsQuery } from '@/lib/meet/queries';
import { useSpaces } from '@/lib/useSpaces';
import { SwitchRow, useFail } from './bits';

const RETENTION = ['30', '90', '180', '365', 'keep'] as const;

/**
 * "Toplantı ayarları": per-space meeting rules (doc 17 §5, §15 item 8). Space Admins and
 * Owners change them; others see them read-only.
 */
export function MeetSettingsDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const { items } = useSpaces();
  const shared = items.filter((s) => s.kind === 'shared' && !s.archivedAt);
  const [spaceId, setSpaceId] = useState(shared[0]?.id ?? '');
  const space = shared.find((s) => s.id === spaceId);
  const canEdit = space?.myRole === 'owner' || space?.myRole === 'admin';
  const q = useQuery({ ...meetSpaceSettingsQuery(spaceId), enabled: Boolean(spaceId) });
  const qc = useQueryClient();
  const fail = useFail();
  const save = useMutation({
    mutationFn: (body: {
      guestsAllowed?: boolean;
      editorsCanRecord?: boolean;
      recordingRetentionDays?: number | null;
    }) => api.call('updateMeetSpaceSettings', { params: { spaceId }, body }),
    onSuccess: (data) => qc.setQueryData(meetKeys.spaceSettings(spaceId), data),
    onError: fail,
  });
  const s = q.data;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={520}>
        <DialogHeader
          title={t('meet.spaceSettings.title')}
          description={t('meet.spaceSettings.body')}
        />
        {shared.length ? (
          <Field label={t('meet.new.space')}>
            <Select value={spaceId} onValueChange={setSpaceId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {shared.map((sp) => (
                  <SelectItem key={sp.id} value={sp.id}>
                    {spaceName(sp, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        {!s ? (
          <Skeleton className="h-32" />
        ) : (
          <div className="flex flex-col gap-4">
            <SwitchRow
              label={t('meet.spaceSettings.guests')}
              hint={t('meet.spaceSettings.guestsHint')}
              checked={s.guestsAllowed}
              disabled={!canEdit}
              onChange={(v) => save.mutate({ guestsAllowed: v })}
            />
            <SwitchRow
              label={t('meet.spaceSettings.editorsRecord')}
              hint={t('meet.spaceSettings.editorsRecordHint')}
              checked={s.editorsCanRecord}
              disabled={!canEdit}
              onChange={(v) => save.mutate({ editorsCanRecord: v })}
            />
            <Field
              label={t('meet.spaceSettings.retention')}
              hint={t('meet.spaceSettings.retentionHint')}
            >
              <Select
                disabled={!canEdit}
                value={
                  s.recordingRetentionDays === null ? 'keep' : String(s.recordingRetentionDays)
                }
                onValueChange={(v) =>
                  save.mutate({ recordingRetentionDays: v === 'keep' ? null : Number(v) })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RETENTION.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r === 'keep'
                        ? t('meet.spaceSettings.keep')
                        : t('meet.spaceSettings.days', { n: Number(r) })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {!canEdit ? (
              <p className="text-xs text-fg3">{t('meet.spaceSettings.readOnly')}</p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="pri" onClick={() => onOpenChange(false)}>
            {t('meet.settings.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
