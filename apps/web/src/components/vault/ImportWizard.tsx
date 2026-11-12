import {
  ImportError,
  newId,
  noteToApiKey,
  parseBitwardenExport,
  sniffBitwardenFile,
  itemSummary,
  type ItemPayload,
  type ItemSummary,
  type ParsedImport,
} from '@crewhall/crypto';
import { VAULT_IMPORT_MAX, type Vault } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  cn,
  EmptyState,
  Field,
  Icon,
  Input,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { api, idempotencyKey } from '@/lib/api';
import { formatBytes, formatNumber } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { encryptFor, invalidateVault, vaultsQuery } from '@/lib/vault/api';
import { useItemsOf } from '@/lib/vault/items';
import { errorMessage } from './errors';
import { useHealthCount } from './VaultMain';
import { vaultName, VaultSidebar } from './VaultSidebar';

interface Loaded {
  name: string;
  size: number;
  text: string;
  kind: ReturnType<typeof sniffBitwardenFile>;
}

/** Same name, user name and first site as an item already in the vault (design 8.13). */
const dupKey = (p: ItemSummary) =>
  [p.name, p.type === 'login' ? p.username : '', p.type === 'login' ? p.uri : '']
    .join('|')
    .toLocaleLowerCase('tr-TR');
const dupKeyOf = (p: ItemPayload) => dupKey(itemSummary(p));

/** Items encrypted between two yields to the page (the progress bar moves, input stays live). */
const ENCRYPT_CHUNK = 50;
const yieldToPage = () => new Promise<void>((r) => setTimeout(r, 0));

/** Most similar space vault name for a collection (design 8.13 default mapping). */
function guessVault(name: string, vaults: Vault[], personal: Vault | undefined): string {
  const n = name.toLocaleLowerCase('tr-TR');
  const hit = vaults.find(
    (v) =>
      v.kind === 'space' &&
      v.name &&
      (n.includes(v.name.toLocaleLowerCase('tr-TR')) ||
        v.name.toLocaleLowerCase('tr-TR').includes(n.split(' ')[0] ?? n)),
  );
  return hit?.id ?? personal?.id ?? vaults[0]?.id ?? '';
}

/**
 * Bitwarden / Vaultwarden import (design 8.12-8.14). The file is read and parsed in the browser
 * and never uploaded; items are encrypted with each target vault's key and written in one
 * server transaction.
 */
export function ImportWizard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const vaults = useQuery(vaultsQuery);
  const list = useMemo(() => vaults.data ?? [], [vaults.data]);
  const editable = useMemo(() => list.filter((v) => v.canEdit), [list]);
  const personal = editable.find((v) => v.kind === 'personal');
  const healthCount = useHealthCount(list);
  const existing = useItemsOf(editable);
  const [file, setFile] = useState<Loaded | null>(null);
  const [password, setPassword] = useState('');
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [tagFolders, setTagFolders] = useState(true);
  const [convertApi, setConvertApi] = useState(true);
  const [skipDupes, setSkipDupes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    phase: 'encrypt' | 'upload';
    done: number;
    total: number;
  } | null>(null);
  const [stopped, setStopped] = useState(false);
  const cancelled = useRef(false);
  const [result, setResult] = useState<{
    byVault: { vaultId: string; count: number }[];
    warnings: { name: string; vaultId: string; codes: string[] }[];
    ms: number;
  } | null>(null);
  const step = result ? 3 : parsed ? 2 : 1;

  const dupes = useMemo(
    () =>
      new Set(
        existing.items.filter((d) => d.summary && !d.item.deletedAt).map((d) => dupKey(d.summary!)),
      ),
    [existing.items],
  );
  const groupName = (key: string) => {
    const g = parsed?.groups.find((x) => x.key === key);
    return !g || g.kind === 'none' ? t('vault.import.noFolder') : g.name;
  };
  const plan = useMemo(() => {
    if (!parsed) return [];
    return parsed.items
      .filter((i) => !(skipDupes && dupes.has(dupKeyOf(i.payload))))
      .map((i) => {
        let payload = convertApi && i.apiKeyLike ? noteToApiKey(i.payload) : i.payload;
        const g = parsed.groups.find((x) => x.key === i.group);
        if (tagFolders && g && g.kind !== 'none' && !payload.tags.includes(g.name)) {
          payload = { ...payload, tags: [...payload.tags, g.name] };
        }
        if (i.warnings.length) payload = { ...payload, importWarnings: i.warnings };
        return { src: i, payload, vaultId: mapping[i.group] ?? personal?.id ?? '' };
      });
  }, [parsed, skipDupes, dupes, convertApi, tagFolders, mapping, personal]);
  const skipped = parsed ? parsed.items.length - plan.length : 0;
  const dupeCount = useMemo(
    () => (parsed ? parsed.items.filter((i) => dupes.has(dupKeyOf(i.payload))).length : 0),
    [parsed, dupes],
  );
  const apiLikeCount = useMemo(
    () => (parsed ? parsed.items.filter((i) => i.apiKeyLike).length : 0),
    [parsed],
  );
  const perVault = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of plan) m.set(p.vaultId, (m.get(p.vaultId) ?? 0) + 1);
    return [...m];
  }, [plan]);

  const read = async (f: File) => {
    setError(null);
    setParsed(null);
    const text = await f.text();
    setFile({ name: f.name, size: f.size, text, kind: sniffBitwardenFile(text) });
    setPassword('');
  };

  const parse = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const p = await parseBitwardenExport(file.text, { password });
      const m: Record<string, string> = {};
      for (const g of p.groups) {
        m[g.key] =
          g.kind === 'collection'
            ? guessVault(g.name, editable, personal)
            : (personal?.id ?? editable[0]?.id ?? '');
      }
      setMapping(m);
      setParsed(p);
    } catch (e) {
      setError(e instanceof ImportError ? t(`vault.import.error.${e.code}`) : errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Encrypts in chunks with a yield in between (a 2000-item export used to freeze the page),
   * then writes each batch in one server transaction. Stopping is possible while encrypting,
   * before anything is written.
   */
  const run = async () => {
    setBusy(true);
    setError(null);
    setStopped(false);
    cancelled.current = false;
    const started = performance.now();
    try {
      const byId = new Map(list.map((v) => [v.id, v]));
      const body = [];
      setProgress({ phase: 'encrypt', done: 0, total: plan.length });
      for (let i = 0; i < plan.length; i += ENCRYPT_CHUNK) {
        for (const p of plan.slice(i, i + ENCRYPT_CHUNK)) {
          const vault = byId.get(p.vaultId)!;
          const id = newId();
          body.push({
            id,
            vaultId: vault.id,
            ...encryptFor(vault, id, 1, p.payload),
            ...(p.src.createdAt ? { createdAt: p.src.createdAt } : {}),
            ...(p.src.updatedAt ? { updatedAt: p.src.updatedAt } : {}),
          });
        }
        setProgress({ phase: 'encrypt', done: body.length, total: plan.length });
        await yieldToPage();
        if (cancelled.current) {
          setStopped(true);
          return;
        }
      }
      setProgress({ phase: 'upload', done: 0, total: body.length });
      const totals = new Map<string, number>();
      for (let i = 0; i < body.length; i += VAULT_IMPORT_MAX) {
        const res = await api.call('vaultImport', {
          body: { items: body.slice(i, i + VAULT_IMPORT_MAX) },
          idempotencyKey: idempotencyKey(),
        });
        for (const v of res.byVault) totals.set(v.vaultId, (totals.get(v.vaultId) ?? 0) + v.count);
        setProgress({
          phase: 'upload',
          done: Math.min(body.length, i + VAULT_IMPORT_MAX),
          total: body.length,
        });
      }
      setResult({
        byVault: [...totals].map(([vaultId, count]) => ({ vaultId, count })),
        warnings: plan
          .filter((p) => p.src.warnings.length)
          .map((p) => ({ name: p.payload.name, vaultId: p.vaultId, codes: p.src.warnings })),
        ms: performance.now() - started,
      });
      setFile(null);
      for (const v of totals.keys()) invalidateVault(qc, v);
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const stat = (n: number, label: string) => (
    <div className="flex flex-col">
      <span className="text-h font-semibold tn">{formatNumber(n, locale)}</span>
      <span className="text-xs text-fg2">{label}</span>
    </div>
  );

  return (
    <Workspace
      sidebar={<VaultSidebar vaults={list} healthCount={healthCount} />}
      crumbs={[{ label: t('vault.title') }, { label: t('vault.import.crumb') }]}
      tools={
        <Button size="sm" variant="gh" onClick={() => void navigate({ to: '/vault' })}>
          {t('vault.cancel')}
        </Button>
      }
    >
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
        <ol className="flex items-center gap-3 text-sm font-medium text-fg3">
          {[
            t('vault.import.stepFile'),
            t('vault.import.stepMap'),
            t('vault.import.stepResult'),
          ].map((l, i) => (
            <li key={l} className={cn('flex items-center gap-2', i + 1 === step && 'text-fg')}>
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full text-[11px] font-bold shadow-line2',
                  i + 1 < step && 'bg-success text-white shadow-none',
                  i + 1 === step && 'bg-fg text-bg shadow-none',
                )}
              >
                {i + 1 < step ? <Icon name="check" size={12} /> : i + 1}
              </span>
              {l}
            </li>
          ))}
        </ol>

        {step === 1 ? (
          <section className="flex flex-col gap-4 rounded-4xl bg-surface p-6 shadow-line">
            <div>
              <h1 className="text-h font-semibold">{t('vault.import.fromBitwarden')}</h1>
              <p className="text-sm text-fg2">{t('vault.import.body')}</p>
            </div>
            <label
              className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line2 p-6 text-center hover:bg-bg2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) void read(f);
              }}
            >
              <Icon name="upload" size={22} />
              <span className="text-sm font-semibold">{t('vault.import.pick')}</span>
              <span className="text-xs text-fg3">{t('vault.import.formats')}</span>
              <input
                type="file"
                accept=".json,.csv,application/json,text/csv"
                className="sr-only"
                onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])}
              />
            </label>
            {file ? (
              <div className="flex flex-col gap-3 rounded-xl bg-bg2/60 p-4 shadow-line">
                <span className="flex items-center gap-2 text-sm">
                  <Icon name="file" size={16} />
                  <b className="font-semibold">{file.name}</b>
                  <span className="text-fg3">
                    {formatBytes(file.size, locale)} · {t('vault.import.localOnly')}
                  </span>
                </span>
                <span className="text-sm text-fg2">{t(`vault.import.kind.${file.kind}`)}</span>
                {file.kind === 'encrypted_json' ? (
                  <Field label={t('vault.import.password')}>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button
                variant="pri"
                disabled={
                  !file ||
                  file.kind === 'unknown' ||
                  file.kind === 'account_encrypted' ||
                  (file.kind === 'encrypted_json' && !password)
                }
                loading={busy}
                onClick={() => void parse()}
              >
                {t('vault.import.read')}
              </Button>
            </div>
          </section>
        ) : null}

        {step === 2 && parsed ? (
          <section className="flex flex-col gap-4 rounded-4xl bg-surface p-6 shadow-line">
            <div className="flex flex-wrap gap-6">
              {stat(parsed.stats.total, t('vault.import.items'))}
              {stat(parsed.stats.byType.login ?? 0, t('vault.category.logins'))}
              {stat(parsed.stats.byType.note ?? 0, t('vault.category.notes'))}
              {stat(parsed.stats.byType.card ?? 0, t('vault.category.cards'))}
              {stat(parsed.stats.byType.identity ?? 0, t('vault.category.identities'))}
            </div>
            <p className="text-xs text-fg2">
              {t('vault.import.found', {
                folders: parsed.stats.folders,
                collections: parsed.stats.collections,
                totp: parsed.stats.withTotp,
                fields: parsed.stats.withFields,
              })}
            </p>
            {parsed.stats.failed ? (
              <p className="flex items-start gap-2 rounded-lg bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-3 text-sm">
                <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-warning" />
                {t('vault.import.failedRows', { count: parsed.stats.failed })}
              </p>
            ) : null}
            {parsed.format !== 'encrypted_json' ? (
              <p className="flex items-start gap-2 rounded-lg bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-3 text-sm">
                <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-warning" />
                {t('vault.import.plainWarning')}
              </p>
            ) : null}
            <h2 className="text-sub font-semibold">{t('vault.import.mapTitle')}</h2>
            <div className="flex flex-col divide-y divide-line rounded-xl shadow-line">
              {parsed.groups.map((g) => (
                <div key={g.key} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon
                    name={g.kind === 'collection' ? 'users' : 'folder'}
                    size={16}
                    className="text-fg2"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {groupName(g.key)}
                  </span>
                  <Select
                    value={mapping[g.key] ?? ''}
                    onValueChange={(v) => setMapping((m) => ({ ...m, [g.key]: v }))}
                  >
                    <SelectTrigger className="w-[190px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {editable.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {vaultName(v, t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="w-10 text-right text-sm text-fg2 tn">{g.count}</span>
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2.5 text-sm">
              <Checkbox checked={tagFolders} onCheckedChange={(v) => setTagFolders(v === true)} />
              {t('vault.import.tagFolders')}
            </label>
            <label className="flex items-center gap-2.5 text-sm">
              <Checkbox checked={convertApi} onCheckedChange={(v) => setConvertApi(v === true)} />
              {t('vault.import.convertApi', { count: apiLikeCount })}
            </label>
            <label className="flex items-center gap-2.5 text-sm">
              <Checkbox checked={skipDupes} onCheckedChange={(v) => setSkipDupes(v === true)} />
              {t('vault.import.skipDupes', { count: dupeCount })}
              {existing.loading ? <Spinner size={14} /> : null}
            </label>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            {stopped ? (
              <p role="status" className="text-sm text-fg2">
                {t('vault.import.stopped')}
              </p>
            ) : null}
            {progress ? (
              <div className="flex flex-col gap-2 rounded-xl bg-bg2/60 p-4 shadow-line">
                <span className="flex items-center gap-2 text-sm">
                  <span className="flex-1">
                    {t(`vault.import.progress.${progress.phase}`, {
                      done: formatNumber(progress.done, locale),
                      total: formatNumber(progress.total, locale),
                    })}
                  </span>
                  {progress.phase === 'encrypt' ? (
                    <Button
                      size="sm"
                      variant="out"
                      onClick={() => {
                        cancelled.current = true;
                      }}
                    >
                      {t('vault.import.stop')}
                    </Button>
                  ) : null}
                </span>
                <Progress
                  large
                  label={t('vault.import.progressLabel')}
                  value={progress.total ? (100 * progress.done) / progress.total : 0}
                />
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <Button variant="gh" onClick={() => setParsed(null)} disabled={busy}>
                {t('vault.back')}
              </Button>
              <span className="ml-auto text-xs text-fg2">
                {perVault
                  .map(
                    ([id, n]) =>
                      `${vaultName(list.find((v) => v.id === id) ?? { kind: 'space', name: '?' }, t)} ${n}`,
                  )
                  .join(' · ')}
                {skipped ? ` · ${t('vault.import.skipped', { count: skipped })}` : ''}
              </span>
              <Button
                variant="pri"
                loading={busy}
                disabled={!plan.length || plan.some((p) => !p.vaultId)}
                onClick={() => void run()}
              >
                {t('vault.import.run', { count: plan.length })}
              </Button>
            </div>
          </section>
        ) : null}

        {step === 3 && result ? (
          <section className="flex flex-col gap-4 rounded-4xl bg-surface p-6 shadow-line">
            <EmptyState
              icon="checkC"
              title={t('vault.import.done', {
                count: result.byVault.reduce((n, v) => n + v.count, 0),
              })}
              description={t('vault.import.doneBody', { seconds: (result.ms / 1000).toFixed(1) })}
            />
            <div className="flex flex-wrap justify-center gap-6">
              {result.byVault.map((v) =>
                stat(
                  v.count,
                  vaultName(
                    list.find((x) => x.id === v.vaultId) ?? { kind: 'space', name: '?' },
                    t,
                  ),
                ),
              )}
              {stat(result.warnings.length, t('vault.import.warnings'))}
            </div>
            {result.warnings.length ? (
              <ul className="flex flex-col divide-y divide-line rounded-xl shadow-line">
                {result.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                    <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-warning" />
                    <span className="flex flex-col">
                      <b className="font-semibold">{w.name}</b>
                      <span className="text-fg2">
                        {w.codes
                          .map((c) => t(`vault.import.warning.${c as 'attachments_missing'}`))
                          .join(' · ')}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="flex items-start gap-2 text-sm text-fg2">
              <Icon name="trash" size={15} className="mt-0.5 shrink-0" />
              {t('vault.import.deleteFile')}
            </p>
            <div className="flex justify-end">
              <Button variant="pri" asChild>
                <Link to="/vault">{t('vault.import.toVault')}</Link>
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </Workspace>
  );
}
