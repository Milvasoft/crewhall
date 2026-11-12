import {
  AI_LIMITS,
  AI_PROVIDER_INFO,
  AI_PROVIDERS,
  AZURE_DEFAULT_API_VERSION,
  type AiProvider,
  type AiSettings,
  type AiTestResult,
  type TestAiSettings,
  type UpdateAiSettings,
} from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { SaveBar, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { useUnsavedGuard } from '@/components/identity/UnsavedGuard';
import { api, isApiError } from '@/lib/api';
import { aiIndexQuery, aiKeys, aiSettingsQuery, aiUsageQuery } from '@/lib/ai/queries';
import { formatNumber, formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

interface Draft {
  provider: AiProvider;
  model: string;
  baseUrl: string;
  /** A newly typed key; empty keeps the stored one. */
  apiKey: string;
  removeKey: boolean;
  orgMonthlyTokens: string;
  userMonthlyTokens: string;
  embeddingModel: string;
  /** "Hızlı model"; empty = everything on the main model. */
  fastModel: string;
  /** Azure OpenAI api-version; empty = the default. */
  apiVersion: string;
  transcriptionUrl: string;
  transcriptionModel: string;
  meetingNotes: boolean;
}

const draftOf = (s: AiSettings): Draft => ({
  provider: s.provider,
  model: s.model,
  baseUrl: s.baseUrl ?? '',
  apiKey: '',
  removeKey: false,
  orgMonthlyTokens: s.orgMonthlyTokens === null ? '' : String(s.orgMonthlyTokens),
  userMonthlyTokens: s.userMonthlyTokens === null ? '' : String(s.userMonthlyTokens),
  embeddingModel: s.embeddingModel ?? '',
  fastModel: s.fastModel ?? '',
  apiVersion: s.apiVersion ?? '',
  transcriptionUrl: s.transcriptionUrl ?? '',
  transcriptionModel: s.transcriptionModel ?? '',
  meetingNotes: s.meetingNotes,
});

const quotaOf = (v: string): number | null => {
  const n = Number(v.replace(/[^\d]/g, ''));
  return v.trim() === '' || !Number.isFinite(n) || n <= 0
    ? null
    : Math.min(n, AI_LIMITS.maxMonthlyTokens);
};

/** Only the fields that differ from the stored settings. */
function changesOf(s: AiSettings, d: Draft): UpdateAiSettings {
  const body: UpdateAiSettings = {};
  if (d.provider !== s.provider) body.provider = d.provider;
  if (d.model.trim() && d.model.trim() !== s.model) body.model = d.model.trim();
  const url = d.baseUrl.trim() || null;
  if (url !== (s.baseUrl ?? null)) body.baseUrl = url;
  if (d.apiKey.trim()) body.apiKey = d.apiKey.trim();
  else if (d.removeKey) body.apiKey = null;
  const org = quotaOf(d.orgMonthlyTokens);
  if (org !== s.orgMonthlyTokens) body.orgMonthlyTokens = org;
  const user = quotaOf(d.userMonthlyTokens);
  if (user !== s.userMonthlyTokens) body.userMonthlyTokens = user;
  const info = AI_PROVIDER_INFO[d.provider];
  const embedding = info.embeddings ? d.embeddingModel.trim() || null : null;
  if (embedding !== s.embeddingModel) body.embeddingModel = embedding;
  const fast = d.fastModel.trim() || null;
  if (fast !== (s.fastModel ?? null)) body.fastModel = fast;
  const version = info.apiVersion ? d.apiVersion.trim() || null : null;
  if (version !== s.apiVersion) body.apiVersion = version;
  const speechUrl = d.transcriptionUrl.trim() || null;
  if (speechUrl !== s.transcriptionUrl) body.transcriptionUrl = speechUrl;
  const speechModel = d.transcriptionModel.trim() || null;
  if (speechModel !== s.transcriptionModel) body.transcriptionModel = speechModel;
  if (d.meetingNotes !== s.meetingNotes) body.meetingNotes = d.meetingNotes;
  return body;
}

/**
 * Yönetim › Yapay zekâ: provider, key, model, quotas and the switch; usage on the side. The
 * switch saves at once; every other field waits for the save bar.
 */
export function AiSettingsPanel() {
  const { t } = useI18n();
  const settings = useQuery(aiSettingsQuery);
  const [draft, setDraft] = useState<Draft | null>(null);
  if (settings.data && !draft) setDraft(draftOf(settings.data));
  if (!settings.data || !draft) return <Skeleton className="h-96 rounded-2xl" />;
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <SettingsForm
        settings={settings.data}
        draft={draft}
        setDraft={setDraft}
        onSaved={(s) => setDraft(draftOf(s))}
      />
      <div className="flex flex-col gap-4">
        <UsageCard />
        <IndexCard />
        <SettingsCard title={t('ai.admin.privacy.title')}>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 pb-2.5 text-xs text-fg2">
            {(['p1', 'p2', 'p3', 'p4'] as const).map((k) => (
              <li key={k} className="flex gap-2">
                <Icon name="shield" size={14} className="mt-0.5 shrink-0 text-fg3" />
                <span>{t(`ai.admin.privacy.${k}`)}</span>
              </li>
            ))}
          </ul>
        </SettingsCard>
      </div>
    </div>
  );
}

function SettingsForm({
  settings,
  draft,
  setDraft,
  onSaved,
}: {
  settings: AiSettings;
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSaved: (s: AiSettings) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const id = useId();
  const [test, setTest] = useState<AiTestResult | null>(null);
  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setTest(null);
  };
  const changes = changesOf(settings, draft);
  const dirty = Object.keys(changes).length > 0;
  const info = AI_PROVIDER_INFO[draft.provider];
  const draftUrl = draft.baseUrl.trim() || null;
  // Same rule as the server: the key never follows the provider or the address elsewhere, but
  // the first address of a provider without a default one (Azure, own server) is not a move.
  const endpointChanged =
    draft.provider !== settings.provider ||
    (draftUrl !== settings.baseUrl && !(info.baseUrl === 'required' && settings.baseUrl === null));
  const keyOptional = info.apiKey === 'optional';
  const keyWillDrop = settings.apiKey.set && endpointChanged && !draft.apiKey.trim();

  const guard = useUnsavedGuard(dirty);

  const save = useMutation({
    mutationFn: (body: UpdateAiSettings) => api.call('updateAiSettings', { body }),
    onSuccess: async (next) => {
      qc.setQueryData(aiKeys.settings, next);
      onSaved(next);
      toast(t('ai.admin.saved'));
      await qc.invalidateQueries({ queryKey: aiKeys.all });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  // The switch saves on its own (optimistic, rolled back on error): a long page with the save
  // button at the bottom made people leave with AI still off.
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.call('updateAiSettings', { body: { enabled } }),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: aiKeys.settings });
      const before = qc.getQueryData<AiSettings>(aiKeys.settings);
      if (before) qc.setQueryData(aiKeys.settings, { ...before, enabled });
      return { before };
    },
    onSuccess: async (next) => {
      qc.setQueryData(aiKeys.settings, next);
      toast(next.enabled ? t('ai.admin.turnedOn') : t('ai.admin.turnedOff'));
      await qc.invalidateQueries({ queryKey: aiKeys.status });
    },
    onError: (e, _enabled, ctx) => {
      if (ctx?.before) qc.setQueryData(aiKeys.settings, ctx.before);
      toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal'));
    },
  });

  const runTest = useMutation({
    mutationFn: () => {
      const body: TestAiSettings = {};
      if (dirty) {
        body.provider = draft.provider;
        body.model = draft.model.trim() || info.defaultModel;
        body.baseUrl = draftUrl;
        if (info.apiVersion) body.apiVersion = draft.apiVersion.trim() || null;
        if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim();
      }
      return api.call('testAiSettings', { body });
    },
    onSuccess: async (r) => {
      setTest(r);
      if (!dirty) await qc.invalidateQueries({ queryKey: aiKeys.settings });
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  const shown = test ?? (dirty ? null : settings.lastTest);
  // A passing test while AI is off: offer to turn it on (saving the tested values with it).
  const offerOn = !settings.enabled && !!shown?.ok;

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard>
        <SettingsRow
          label={t('ai.admin.enabled')}
          description={t('ai.admin.enabledHint')}
          htmlFor={`${id}-on`}
        >
          {!settings.configured && !settings.enabled ? (
            <Badge tone="warn">{t('ai.admin.notConfigured')}</Badge>
          ) : null}
          <Switch
            id={`${id}-on`}
            checked={settings.enabled}
            disabled={toggle.isPending}
            onCheckedChange={(v) => toggle.mutate(v)}
          />
        </SettingsRow>
        {settings.enabled && !settings.configured ? (
          <div
            role="alert"
            className="mb-3 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-cap"
          >
            <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>{t('ai.admin.onButBroken')}</span>
          </div>
        ) : null}
      </SettingsCard>

      {!(settings.enabled && settings.configured) ? (
        <SetupSteps settings={settings} tested={!dirty && !!shown?.ok} />
      ) : null}

      <SettingsCard title={t('ai.admin.connection')}>
        <div className="flex flex-col gap-4 pt-1 pb-4">
          <Field label={t('ai.admin.provider')} hint={t(`ai.admin.providerHint.${draft.provider}`)}>
            <Select
              value={draft.provider}
              onValueChange={(v) => {
                const p = v as AiProvider;
                const next = AI_PROVIDER_INFO[p];
                const same = p === settings.provider;
                set({
                  provider: p,
                  model: same ? settings.model : next.defaultModel,
                  baseUrl: same ? (settings.baseUrl ?? '') : '',
                  apiVersion: same ? (settings.apiVersion ?? '') : '',
                  fastModel: same ? (settings.fastModel ?? '') : '',
                  embeddingModel: same
                    ? (settings.embeddingModel ?? '')
                    : (next.defaultEmbeddingModel ?? ''),
                });
              }}
            >
              <SelectTrigger aria-label={t('ai.admin.provider')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {t(`ai.admin.providers.${p}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {info.baseUrl === 'required' ? (
            <Field
              label={info.apiVersion ? t('ai.admin.azureEndpoint') : t('ai.admin.baseUrl')}
              hint={info.apiVersion ? t('ai.admin.azureEndpointHint') : t('ai.admin.baseUrlHint')}
            >
              <Input
                value={draft.baseUrl}
                inputMode="url"
                placeholder={
                  info.apiVersion ? 'https://kurum.openai.azure.com' : 'http://llm.local:8000/v1'
                }
                onChange={(e) => set({ baseUrl: e.target.value })}
              />
            </Field>
          ) : null}

          <Field
            label={info.apiVersion ? t('ai.admin.deployment') : t('ai.admin.model')}
            hint={
              info.apiVersion
                ? t('ai.admin.deploymentHint')
                : info.models.length
                  ? t('ai.admin.modelSuggestions', { name: info.models.join(', ') })
                  : t('ai.admin.modelHintOpenai')
            }
          >
            <Input
              value={draft.model}
              maxLength={AI_LIMITS.modelChars}
              placeholder={info.defaultModel}
              list={info.models.length ? `${id}-models` : undefined}
              onChange={(e) => set({ model: e.target.value })}
            />
          </Field>
          {info.models.length ? (
            <datalist id={`${id}-models`}>
              {info.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          ) : null}

          <Field
            label={t('ai.admin.fastModel')}
            hint={
              info.fastModel
                ? t('ai.admin.fastModelHintWith', { name: info.fastModel })
                : t('ai.admin.fastModelHint')
            }
          >
            <Input
              value={draft.fastModel}
              maxLength={AI_LIMITS.modelChars}
              placeholder={info.fastModel ?? ''}
              list={info.models.length ? `${id}-models` : undefined}
              onChange={(e) => set({ fastModel: e.target.value })}
            />
          </Field>

          {info.apiVersion ? (
            <Field
              label={t('ai.admin.apiVersion')}
              hint={t('ai.admin.apiVersionHint', { name: AZURE_DEFAULT_API_VERSION })}
            >
              <Input
                value={draft.apiVersion}
                placeholder={AZURE_DEFAULT_API_VERSION}
                onChange={(e) => set({ apiVersion: e.target.value })}
              />
            </Field>
          ) : null}

          {info.embeddings ? (
            <Field
              label={
                info.apiVersion ? t('ai.admin.embeddingDeployment') : t('ai.admin.embeddingModel')
              }
              hint={
                info.defaultEmbeddingModel
                  ? t('ai.admin.embeddingDefault', { name: info.defaultEmbeddingModel })
                  : t('ai.admin.embeddingHint')
              }
            >
              <Input
                value={draft.embeddingModel}
                maxLength={AI_LIMITS.modelChars}
                placeholder={info.defaultEmbeddingModel ?? 'bge-m3'}
                onChange={(e) => set({ embeddingModel: e.target.value })}
              />
            </Field>
          ) : null}

          {info.baseUrl === 'fixed' && info.defaultBaseUrl ? (
            <Field
              label={t('ai.admin.baseUrlOverride')}
              hint={t('ai.admin.baseUrlOverrideHint', { address: info.defaultBaseUrl })}
            >
              <Input
                value={draft.baseUrl}
                inputMode="url"
                placeholder={info.defaultBaseUrl}
                onChange={(e) => set({ baseUrl: e.target.value })}
              />
            </Field>
          ) : null}

          <Field
            label={keyOptional ? t('ai.admin.apiKeyOptional') : t('ai.admin.apiKey')}
            hint={keyWillDrop ? t('ai.admin.keyWillDrop') : t('ai.admin.keyNote')}
          >
            <Input
              type="password"
              autoComplete="off"
              value={draft.apiKey}
              maxLength={AI_LIMITS.apiKeyChars}
              placeholder={
                settings.apiKey.set && !draft.removeKey && !endpointChanged
                  ? settings.apiKey.hint
                    ? t('ai.admin.keySet', { key: settings.apiKey.hint })
                    : t('ai.admin.keySetNoHint')
                  : t('ai.admin.keyPlaceholder')
              }
              onChange={(e) => set({ apiKey: e.target.value, removeKey: false })}
            />
          </Field>
          {settings.apiKey.set && !endpointChanged ? (
            <div className="-mt-2 flex items-center gap-2 text-xs text-fg2">
              {draft.removeKey ? (
                <>
                  <span>{t('ai.admin.keyWillBeRemoved')}</span>
                  <Button size="xs" variant="gh" onClick={() => set({ removeKey: false })}>
                    {t('common.actions.cancel')}
                  </Button>
                </>
              ) : (
                <>
                  {settings.apiKey.updatedAt ? (
                    <span>
                      {t('ai.admin.keyUpdated', {
                        time: formatRelative(settings.apiKey.updatedAt, locale),
                      })}
                    </span>
                  ) : null}
                  <Button
                    size="xs"
                    variant="dng"
                    onClick={() => set({ removeKey: true, apiKey: '' })}
                  >
                    {t('ai.admin.removeKey')}
                  </Button>
                </>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="out"
              size="sm"
              loading={runTest.isPending}
              onClick={() => runTest.mutate()}
            >
              <Icon name="activity" size={15} />
              {t('ai.admin.test')}
            </Button>
            {shown ? (
              <span
                role="status"
                className={`flex items-center gap-1.5 text-xs ${shown.ok ? 'text-success' : 'text-danger'}`}
              >
                <Icon name={shown.ok ? 'check' : 'alert'} size={14} />
                {shown.ok
                  ? t('ai.admin.testOk', { ms: shown.latencyMs ?? 0 })
                  : t('ai.admin.testFail', { error: shown.error ?? '' })}
                {!test ? (
                  <span className="text-fg3">· {formatRelative(shown.at, locale)}</span>
                ) : null}
              </span>
            ) : null}
          </div>
          {offerOn ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent10 px-3 py-2.5">
              <Icon name="sparkle" size={15} className="shrink-0 text-accent-text" />
              <span className="min-w-0 flex-1 text-cap">{t('ai.admin.offerOn')}</span>
              <Button
                size="xs"
                variant="pri"
                loading={save.isPending || toggle.isPending}
                onClick={() =>
                  dirty ? save.mutate({ ...changes, enabled: true }) : toggle.mutate(true)
                }
              >
                {dirty ? t('ai.admin.saveAndTurnOn') : t('ai.admin.turnOn')}
              </Button>
            </div>
          ) : null}
        </div>
      </SettingsCard>

      <SettingsCard title={t('ai.admin.meeting.title')}>
        <p className="m-0 pb-2 text-xs text-fg2">{t('ai.admin.meeting.hint')}</p>
        <div className="flex flex-col gap-4 pb-3">
          <Field label={t('ai.admin.meeting.url')} hint={t('ai.admin.meeting.urlHint')}>
            <Input
              value={draft.transcriptionUrl}
              inputMode="url"
              placeholder="http://whisper:8000/v1"
              onChange={(e) => set({ transcriptionUrl: e.target.value })}
            />
          </Field>
          <Field label={t('ai.admin.meeting.model')}>
            <Input
              value={draft.transcriptionModel}
              maxLength={AI_LIMITS.modelChars}
              placeholder="Systran/faster-whisper-small"
              onChange={(e) => set({ transcriptionModel: e.target.value })}
            />
          </Field>
        </div>
        <SettingsRow
          label={t('ai.admin.meeting.auto')}
          description={t('ai.admin.meeting.autoHint')}
          htmlFor={`${id}-notes`}
        >
          <Switch
            id={`${id}-notes`}
            checked={draft.meetingNotes}
            disabled={!draft.transcriptionUrl.trim() || !draft.transcriptionModel.trim()}
            onCheckedChange={(v) => set({ meetingNotes: v })}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t('ai.admin.quota')} aside={<span className="text-xs text-fg2" />}>
        <p className="m-0 pb-2 text-xs text-fg2">{t('ai.admin.quotaHint')}</p>
        <QuotaRow
          label={t('ai.admin.userQuota')}
          value={draft.userMonthlyTokens}
          onChange={(v) => set({ userMonthlyTokens: v })}
        />
        <QuotaRow
          label={t('ai.admin.orgQuota')}
          value={draft.orgMonthlyTokens}
          onChange={(v) => set({ orgMonthlyTokens: v })}
        />
      </SettingsCard>

      {/* Room for the floating save bar over the last card. */}
      {dirty ? <div aria-hidden className="h-16" /> : null}
      <SaveBar
        count={Object.keys(changes).length}
        saving={save.isPending}
        onCancel={() => onSaved(settings)}
        onSave={() => save.mutate(changes)}
      />
      {guard}
    </div>
  );
}

const STEPS = ['provider', 'key', 'test', 'on'] as const;

/**
 * The order of setting AI up, with the steps already done ticked. Hidden once AI works.
 * `tested`: a test of the saved values just passed (a test of unsaved ones is not stored).
 */
function SetupSteps({ settings, tested }: { settings: AiSettings; tested: boolean }) {
  const { t } = useI18n();
  const done: Record<(typeof STEPS)[number], boolean> = {
    // A provider is always picked; Azure and an own server also need their address.
    provider: AI_PROVIDER_INFO[settings.provider].baseUrl === 'fixed' || settings.baseUrl !== null,
    key: settings.configured,
    test: settings.configured && (tested || !!settings.lastTest?.ok),
    on: settings.enabled,
  };
  const current = STEPS.find((k) => !done[k]);
  return (
    <SettingsCard title={t('ai.admin.steps.title')}>
      <ol className="m-0 flex list-none flex-col gap-2 p-0 pb-3">
        {STEPS.map((k, i) => (
          <li
            key={k}
            aria-current={k === current ? 'step' : undefined}
            className={`flex items-start gap-2.5 text-cap ${done[k] ? 'text-fg2' : ''}`}
          >
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                done[k]
                  ? 'bg-success text-white'
                  : k === current
                    ? 'bg-accent text-black'
                    : 'bg-bg2 text-fg2'
              }`}
            >
              {done[k] ? <Icon name="check" size={12} /> : i + 1}
            </span>
            <span className={k === current ? 'font-semibold' : undefined}>
              {t(`ai.admin.steps.${k}`)}
              {done[k] ? <span className="sr-only"> · {t('ai.admin.steps.done')}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </SettingsCard>
  );
}

function QuotaRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <SettingsRow label={label} htmlFor={id}>
      <Input
        id={id}
        className="w-44"
        inputMode="numeric"
        value={value}
        placeholder={t('ai.admin.unlimited')}
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))}
        aria-describedby={`${id}-unit`}
      />
      <span id={`${id}-unit`} className="text-xs text-fg2">
        {t('ai.admin.tokensUnit')}
      </span>
    </SettingsRow>
  );
}

function UsageCard() {
  const { t, locale } = useI18n();
  const usage = useQuery(aiUsageQuery());
  const u = usage.data;
  const n = (v: number) => formatNumber(v, locale);
  return (
    <SettingsCard title={t('ai.admin.usage.title')}>
      {!u ? (
        <Skeleton className="mb-3 h-32" />
      ) : u.totals.runs === 0 ? (
        <EmptyState icon="sparkle" title={t('ai.admin.usage.empty')} />
      ) : (
        <div className="flex flex-col gap-3 pb-3">
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['runs', u.totals.runs],
                ['input', u.totals.inputTokens],
                ['output', u.totals.outputTokens],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex flex-col rounded-lg bg-bg2 px-3 py-2">
                <span className="text-[11px] text-fg2">{t(`ai.admin.usage.${k}`)}</span>
                <span className="text-sm font-semibold">{n(v)}</span>
                {k === 'input' && u.totals.cachedInputTokens ? (
                  <span className="text-[11px] text-fg3">
                    {t('ai.admin.usage.cached', { n: n(u.totals.cachedInputTokens) })}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <span className="eyebrow">{t('ai.admin.usage.byAction')}</span>
            {u.byAction.map((a) => (
              <div key={a.action} className="flex items-center justify-between text-cap">
                <span>{t(`ai.admin.actions.${a.action}`)}</span>
                <span className="text-fg2">{n(a.runs)}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">{t('ai.admin.usage.byUser')}</span>
            {u.byUser.map((p) => (
              <div key={p.user.id} className="flex items-center gap-2 text-cap">
                <Avatar name={p.user.name} src={p.user.imageUrl} size="sm" />
                <span className="min-w-0 flex-1 truncate">{p.user.name}</span>
                <span className="text-xs text-fg2">
                  {t('ai.admin.usage.tokens', { n: n(p.inputTokens + p.outputTokens) })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </SettingsCard>
  );
}

/** The search index of "Crewhall'a sor": size, semantic search state and a rebuild button. */
function IndexCard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const index = useQuery(aiIndexQuery);
  const rebuild = useMutation({
    mutationFn: () => api.call('rebuildAiIndex', { body: {} }),
    onSuccess: (next) => {
      qc.setQueryData(aiKeys.index, next);
      toast(t('ai.admin.index.rebuilt'));
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  const s = index.data;
  const n = (v: number) => formatNumber(v, locale);
  return (
    <SettingsCard
      title={t('ai.admin.index.title')}
      aside={
        <Button
          size="xs"
          variant="out"
          loading={rebuild.isPending}
          onClick={() => rebuild.mutate()}
        >
          <Icon name="refresh" size={13} /> {t('ai.admin.index.rebuild')}
        </Button>
      }
    >
      {!s ? (
        <Skeleton className="mb-3 h-20" />
      ) : (
        <div className="flex flex-col gap-1.5 pb-3 text-cap">
          <div className="flex justify-between">
            <span className="text-fg2">{t('ai.admin.index.documents')}</span>
            <span className="font-semibold">{n(s.documents)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-fg2">{t('ai.admin.index.semantic')}</span>
            <span className="font-semibold">
              {s.embeddings
                ? t('ai.admin.index.vector', {
                    type: s.vector,
                    done: n(s.embedded),
                    total: n(s.chunks),
                  })
                : t('ai.admin.index.textOnly')}
            </span>
          </div>
          <span className="text-xs text-fg3">
            {s.lastIndexedAt
              ? t('ai.admin.index.last', { time: formatRelative(s.lastIndexedAt, locale) })
              : t('ai.admin.index.never')}
          </span>
        </div>
      )}
    </SettingsCard>
  );
}
