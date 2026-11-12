import { type Meeting, type UserSummary } from '@crewhall/shared';
import {
  Button,
  CheckboxRow,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Radio,
  RadioGroup,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@crewhall/ui';
import { useMediaDeviceSelect, useRoomContext } from '@livekit/components-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { readPrefs, writePrefs, type MeetPrefs } from '@/lib/meet/prefs';
import { mediaAvailable } from '@/lib/meet/media';
import { applyShareAudio } from '@/lib/meet/publish';
import { meetingQuery, meetKeys, recordingTargetQuery } from '@/lib/meet/queries';
import { deviceLabel, useMediaDevices } from '@/lib/meet/devices';
import { DEVICE_LIST_CLASS, SwitchRow, useCopyLink, useFail } from '@/components/meet/bits';
import { PeoplePicker } from '@/components/meet/NewMeetingDialog';
import { useRoomState, publishRights } from './context';

/** Design 7.10: what is recorded, where it goes, who sees it. */
export function RecordDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const { t, locale } = useI18n();
  const state = useRoomState();
  const qc = useQueryClient();
  const fail = useFail();
  const meetingId = state.meeting!.id;
  const target = useQuery(recordingTargetQuery(meetingId));
  const [audioOnly, setAudioOnly] = useState(false);
  const start = useMutation({
    mutationFn: () =>
      api.call('startMeetingRecording', { params: { meetingId }, body: { audioOnly } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: meetKeys.meeting(meetingId) });
      onOpenChange(false);
    },
    onError: fail,
  });
  const d = target.data;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={520}>
        <DialogHeader
          icon="record"
          title={t('meet.record.title')}
          description={
            d
              ? t('meet.record.where', { name: d.spaceName, folder: d.folderName })
              : t('meet.record.loading')
          }
        />
        <RadioGroup
          value={audioOnly ? 'audio' : 'video'}
          onValueChange={(v) => setAudioOnly(v === 'audio')}
          className="flex flex-col gap-2"
        >
          <label className="flex items-center gap-3 rounded-xl bg-bg2 p-3">
            <Radio value="video" />
            <span className="flex flex-col">
              <span className="text-sm font-semibold">{t('meet.record.video')}</span>
              <span className="text-xs text-fg3">{t('meet.record.videoHint')}</span>
            </span>
          </label>
          <label className="flex items-center gap-3 rounded-xl bg-bg2 p-3">
            <Radio value="audio" />
            <span className="flex flex-col">
              <span className="text-sm font-semibold">{t('meet.record.audio')}</span>
              <span className="text-xs text-fg3">{t('meet.record.audioHint')}</span>
            </span>
          </label>
        </RadioGroup>
        <p className="text-xs text-fg3">
          {[
            t('meet.record.moderatorsOnly'),
            d?.freeBytes != null
              ? t('meet.record.free', { size: formatBytes(d.freeBytes, locale) })
              : '',
            d?.retentionDays ? t('meet.record.retention', { days: d.retentionDays }) : '',
          ]
            .filter(Boolean)
            .join(' ')}
        </p>
        {d && !d.canStart ? (
          <p className="rounded-lg bg-bg2 p-3 text-sm text-danger">
            {t('meet.record.unavailable')}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={() => onOpenChange(false)}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="dngf"
            loading={start.isPending}
            disabled={!d?.canStart}
            onClick={() => start.mutate()}
          >
            <Icon name="record" size={16} />
            {t('meet.record.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Design 7.9: devices and quality; applied at once and remembered per device. */
export function SettingsDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const room = useRoomContext();
  const fail = useFail();
  const [prefs, setPrefs] = useState<MeetPrefs>(readPrefs);
  const [tab, setTab] = useState<'audio' | 'video' | 'general'>('audio');
  const update = (patch: Partial<MeetPrefs>) => setPrefs(writePrefs(patch));
  // Only what this person can use: a guest may not share, a listener sends nothing.
  const { guest } = useRoomState();
  const { canPublish, canShare } = publishRights(room.localParticipant);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={560}>
        <DialogHeader title={t('meet.settings.title')} />
        {!mediaAvailable() ? (
          <p className="rounded-lg bg-bg2 p-3 text-sm text-fg2">{t('meet.controls.needsHttps')}</p>
        ) : null}
        <Segmented
          value={tab}
          onValueChange={setTab}
          options={[
            { value: 'audio', label: t('meet.settings.audio') },
            { value: 'video', label: t('meet.settings.video') },
            { value: 'general', label: t('meet.settings.general') },
          ]}
        />
        {tab === 'audio' ? (
          <div className="flex flex-col gap-4">
            {canPublish ? (
              <DevicePicker
                kind="audioinput"
                label={t('meet.settings.microphone')}
                onPick={(id) => update({ audioInput: id })}
              />
            ) : null}
            <DevicePicker
              kind="audiooutput"
              label={t('meet.settings.speaker')}
              onPick={(id) => update({ audioOutput: id })}
            />
            {canPublish ? (
              <>
                <SwitchRow
                  label={t('meet.settings.noise')}
                  hint={t('meet.settings.noiseHint')}
                  checked={prefs.noiseSuppression}
                  onChange={(v) => {
                    update({ noiseSuppression: v });
                    void room.localParticipant.setMicrophoneEnabled(
                      room.localParticipant.isMicrophoneEnabled,
                      {
                        noiseSuppression: v,
                        echoCancellation: prefs.echoCancellation,
                      },
                    );
                  }}
                />
                <SwitchRow
                  label={t('meet.settings.echo')}
                  hint={t('meet.settings.echoHint')}
                  checked={prefs.echoCancellation}
                  onChange={(v) => update({ echoCancellation: v })}
                />
              </>
            ) : null}
          </div>
        ) : tab === 'video' ? (
          <div className="flex flex-col gap-4">
            {canPublish ? (
              <>
                <DevicePicker
                  kind="videoinput"
                  label={t('meet.settings.camera')}
                  onPick={(id) => update({ videoInput: id })}
                />
                <Field label={t('meet.settings.quality')} hint={t('meet.settings.qualityHint')}>
                  <Segmented
                    value={prefs.quality}
                    onValueChange={(v) => update({ quality: v })}
                    options={[
                      { value: 'auto', label: t('meet.settings.auto') },
                      { value: '720p', label: '720p' },
                      { value: '360p', label: '360p' },
                    ]}
                  />
                </Field>
              </>
            ) : null}
            <SwitchRow
              label={t('meet.settings.dataSaver')}
              hint={t('meet.settings.dataSaverHint')}
              checked={prefs.dataSaver}
              onChange={(v) => update({ dataSaver: v })}
            />
            {canShare ? (
              <Field label={t('meet.settings.shareMode')} hint={t('meet.settings.shareModeHint')}>
                <Segmented
                  value={prefs.shareMode}
                  onValueChange={(v) => update({ shareMode: v })}
                  options={[
                    { value: 'detail', label: t('meet.settings.shareDetail') },
                    { value: 'motion', label: t('meet.settings.shareMotion') },
                  ]}
                />
              </Field>
            ) : null}
            {canShare ? (
              <SwitchRow
                label={t('meet.controls.shareAudio')}
                hint={t('meet.controls.shareAudioHint')}
                checked={prefs.shareAudio}
                onChange={(v) => {
                  update({ shareAudio: v });
                  applyShareAudio(room.localParticipant, v).then((r) => {
                    if (r === 'next') toast(t('meet.controls.shareAudioNext'));
                  }, fail);
                }}
              />
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {canPublish ? (
              <>
                <CheckboxRow
                  checked={prefs.joinMuted}
                  onCheckedChange={(v) => update({ joinMuted: v === true })}
                >
                  {t('meet.prejoin.joinMuted')}
                </CheckboxRow>
                <CheckboxRow
                  checked={prefs.joinCameraOff}
                  onCheckedChange={(v) => update({ joinCameraOff: v === true })}
                >
                  {t('meet.prejoin.joinCameraOff')}
                </CheckboxRow>
              </>
            ) : null}
            <CheckboxRow
              checked={prefs.joinLeaveSound}
              onCheckedChange={(v) => update({ joinLeaveSound: v === true })}
            >
              {t('meet.settings.joinLeaveSound')}
            </CheckboxRow>
            {guest ? null : <RemoteControlSwitch />}
            <h3 className="eyebrow mt-2">{t('meet.settings.shortcuts')}</h3>
            <ul className="flex flex-col gap-1.5 text-sm">
              {(canPublish ? (['mic', 'cam', 'hand', 'ptt'] as const) : (['hand'] as const)).map(
                (k) => (
                  <li key={k} className="flex justify-between">
                    <span>{t(`meet.shortcuts.${k}`)}</span>
                    <span className="font-mono text-xs text-fg2">
                      {t(`meet.shortcuts.${k}Keys`)}
                    </span>
                  </li>
                ),
              )}
            </ul>
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

/** Moderators: remote control of shared screens in this meeting (on unless the org turned it off). */
function RemoteControlSwitch() {
  const { t } = useI18n();
  const state = useRoomState();
  const qc = useQueryClient();
  const fail = useFail();
  const id = state.meeting?.id ?? '';
  const meeting = useQuery({
    ...meetingQuery(id),
    enabled: Boolean(id),
    initialData: state.meeting ?? undefined,
    initialDataUpdatedAt: 0,
  }).data;
  const save = useMutation({
    mutationFn: (on: boolean) =>
      api.call('updateMeeting', {
        params: { meetingId: id },
        body: { settings: { remoteControl: on } },
      }),
    onSuccess: (m) => qc.setQueryData(meetKeys.meeting(m.id), m),
    onError: fail,
  });
  if (!meeting || !state.moderator || state.guest) return null;
  return (
    <SwitchRow
      label={t('meet.settings.remoteControl')}
      hint={t('meet.settings.remoteControlHint')}
      checked={meeting.settings.remoteControl !== false}
      disabled={save.isPending}
      onChange={(v) => save.mutate(v)}
    />
  );
}

/** Device lists need navigator.mediaDevices (secure context only). */
function DevicePicker(props: {
  kind: MediaDeviceKind;
  label: string;
  onPick: (id: string) => void;
}) {
  return mediaAvailable() ? <DevicePickerList {...props} /> : null;
}

function DevicePickerList({
  kind,
  label,
  onPick,
}: {
  kind: MediaDeviceKind;
  label: string;
  onPick: (id: string) => void;
}) {
  const { t } = useI18n();
  const room = useRoomContext();
  const fail = useFail();
  const { activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind,
    room,
    requestPermissions: false,
  });
  const { devices, needsPermission, allow } = useMediaDevices(kind);
  const allowButton = needsPermission ? (
    <Button size="sm" variant="out" className="self-start" onClick={() => void allow()}>
      <Icon name="lock" size={14} />
      {t('meet.devices.allow')}
    </Button>
  ) : null;
  if (!devices.some((d) => d.deviceId)) {
    return (
      <Field label={label}>
        <span className="text-sm text-fg3">{t('meet.devices.none')}</span>
        {allowButton}
      </Field>
    );
  }
  return (
    <Field label={label}>
      <Select
        value={activeDeviceId || devices[0]!.deviceId}
        onValueChange={(id) => {
          setActiveMediaDevice(id).catch(fail);
          onPick(id);
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={DEVICE_LIST_CLASS}>
          {devices.map((d, i) => (
            <SelectItem
              key={`${d.deviceId || 'default'}-${i}`}
              value={d.deviceId || 'default'}
              check="start"
              title={deviceLabel(d, i, t)}
            >
              {deviceLabel(d, i, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {allowButton}
    </Field>
  );
}

/** Design 7.12: link (copy, rotate), Hub members, e-mail. */
export function InviteDialog({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const state = useRoomState();
  const qc = useQueryClient();
  const fail = useFail();
  const copy = useCopyLink();
  // The room keeps the meeting from the moment of joining; settings change while it runs.
  const meeting = useQuery({
    ...meetingQuery(state.meeting!.id),
    initialData: state.meeting!,
    initialDataUpdatedAt: 0,
  }).data;
  const [tab, setTab] = useState<'link' | 'members' | 'email'>('link');
  const [people, setPeople] = useState<UserSummary[]>([]);
  const [emails, setEmails] = useState<string[]>([]);
  const guestsOk = meeting.permissions.inviteGuests;

  const invite = useMutation({
    mutationFn: async () => {
      // This is the room, so the meeting is going on: members are rung ("o an ihtiyacım var"),
      // and only guests, who have nothing to ring, get the link by e-mail.
      if (people.length) {
        await api.call('ringToMeeting', {
          params: { meetingId: meeting.id },
          body: { userIds: people.map((p) => p.id) },
        });
      }
      if (emails.length) {
        await api.call('inviteToMeeting', {
          params: { meetingId: meeting.id },
          body: { userIds: [], emails },
        });
      }
    },
    onSuccess: async () => {
      toast(people.length ? t('meet.invite.rung') : t('meet.invite.sent'));
      setPeople([]);
      setEmails([]);
      await qc.invalidateQueries({ queryKey: meetKeys.all });
    },
    onError: fail,
  });
  const settings = useMutation({
    mutationFn: (patch: { lobby?: boolean; guestsAllowed?: boolean; guestLinkHours?: 1 | 24 }) =>
      api.call('updateMeeting', { params: { meetingId: meeting.id }, body: { settings: patch } }),
    onMutate: (patch) => {
      qc.setQueryData(meetKeys.meeting(meeting.id), (m: Meeting | undefined) =>
        m ? { ...m, settings: { ...m.settings, ...patch } } : m,
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: meetKeys.all }),
    onError: fail,
  });
  const rotate = useMutation({
    mutationFn: () => api.call('rotateMeetingLink', { params: { meetingId: meeting.id } }),
    onSuccess: async (m) => {
      toast(t('meet.invite.rotated'));
      await qc.invalidateQueries({ queryKey: meetKeys.all });
      void copy(m.url);
    },
    onError: fail,
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={520}>
        <DialogHeader title={t('meet.invite.title')} />
        <Segmented
          value={tab}
          onValueChange={setTab}
          options={[
            { value: 'link', label: t('meet.invite.link') },
            { value: 'members', label: t('meet.invite.members') },
            { value: 'email', label: t('meet.invite.email') },
          ]}
        />
        {tab === 'link' ? (
          guestsOk ? (
            <div className="flex flex-col gap-4">
              <Field label={t('meet.invite.guestLink')} hint={t('meet.invite.guestLinkHint')}>
                <div className="flex gap-2">
                  <Input readOnly value={meeting.url} className="font-mono text-xs" />
                  <Button onClick={() => void copy(meeting.url)}>{t('meet.actions.copy')}</Button>
                </div>
              </Field>
              {/* The link works for guests only while they are allowed (instant meetings start without). */}
              <SwitchRow
                label={t('meet.new.guests')}
                hint={t('meet.new.guestsHint')}
                checked={meeting.settings.guestsAllowed}
                onChange={(v) => settings.mutate({ guestsAllowed: v })}
              />
              {meeting.settings.guestsAllowed ? (
                <SwitchRow
                  label={t('meet.new.lobby')}
                  hint={t('meet.invite.lobbyHint')}
                  checked={meeting.settings.lobby}
                  onChange={(v) => settings.mutate({ lobby: v })}
                />
              ) : null}
              {meeting.kind === 'scheduled' ? (
                <Field
                  label={t('meet.invite.linkLifetime')}
                  hint={t('meet.invite.linkLifetimeHint')}
                >
                  <Segmented
                    value={String(meeting.settings.guestLinkHours)}
                    onValueChange={(v) => settings.mutate({ guestLinkHours: v === '1' ? 1 : 24 })}
                    options={[
                      { value: '1', label: t('meet.invite.hours', { h: 1 }) },
                      { value: '24', label: t('meet.invite.hours', { h: 24 }) },
                    ]}
                  />
                </Field>
              ) : null}
              <Button
                variant="out"
                size="sm"
                loading={rotate.isPending}
                onClick={() => rotate.mutate()}
              >
                <Icon name="refresh" size={14} />
                {t('meet.invite.rotate')}
              </Button>
            </div>
          ) : (
            <p className="rounded-xl bg-bg2 p-4 text-sm text-fg2">{t('meet.invite.guestsOff')}</p>
          )
        ) : (
          <div className="flex flex-col gap-3">
            <PeoplePicker
              people={tab === 'members' ? people : []}
              onPeople={setPeople}
              emails={tab === 'email' ? emails : []}
              onEmails={setEmails}
              guestsPossible={tab === 'email' && guestsOk}
            />
            <p className="text-xs text-fg3">
              {tab === 'members' ? t('meet.invite.membersHint') : t('meet.invite.emailHint')}
            </p>
            <DialogFooter>
              <Button
                variant="pri"
                loading={invite.isPending}
                disabled={!people.length && !emails.length}
                onClick={() => invite.mutate()}
              >
                {tab === 'members' ? t('meet.invite.ring') : t('meet.invite.send')}
              </Button>
            </DialogFooter>
          </div>
        )}
        <p className="text-xs text-fg3">{t('meet.invite.privacy')}</p>
      </DialogContent>
    </Dialog>
  );
}
