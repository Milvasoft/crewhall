import {
  emptyItem,
  generateEd25519SshKey,
  newId,
  parseTotp,
  sshFingerprint,
  withHistory,
  type CustomFieldType,
  type ItemPayload,
  type ItemType,
} from '@crewhall/crypto';
import { type Vault, type VaultItem } from '@crewhall/shared';
import {
  Button,
  cn,
  Field,
  Icon,
  IconButton,
  Input,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  DatePicker,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Tag,
  Textarea,
  Tooltip,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, isApiError } from '@/lib/api';
import { formatBytes, formatTime } from '@/lib/i18n/format';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { createItem, invalidateVault, moveItem, saveItem } from '@/lib/vault/api';
import { deleteAttachment, MAX_ATTACHMENT_BYTES, uploadAttachment } from '@/lib/vault/attachments';
import { normalizeTags } from '@/lib/vault/items';
import { decryptVaultItem } from '@/lib/vault/session';
import { errorMessage } from './errors';
import { Generator } from './Generator';
import { ItemAvatar } from './ItemDetail';
import { StrengthBar } from './strength';
import { vaultName } from './VaultSidebar';

type Draft = ItemPayload;

/**
 * Edit / new item form (design 8.7-8.9). Saving encrypts on this device and uploads only the
 * ciphertext; the old password goes to the history. A concurrent save shows both versions.
 */
export function ItemForm({
  vaults,
  vault,
  item,
  initial,
  tagSuggestions = [],
  onDone,
}: {
  vaults: Vault[];
  vault: Vault;
  /** Null for a new item. */
  item: VaultItem | null;
  initial: ItemPayload;
  /** Tags already used in the vault, offered while typing. */
  tagSuggestions?: string[];
  onDone: (savedId: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(initial);
  const [targetVaultId, setTargetVaultId] = useState(vault.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    theirs: VaultItem;
    payload: ItemPayload | null;
  } | null>(null);
  const [uploading, setUploading] = useState(0);
  const added = useRef<string[]>([]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || targetVaultId !== vault.id;
  const editable = vaults.filter((v) => v.canEdit);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }) as Draft);

  const cancel = async () => {
    // Attachments uploaded in this session but never saved are removed again.
    if (item) {
      for (const id of added.current) await deleteAttachment(item.id, id).catch(() => undefined);
    }
    onDone(null);
  };

  const save = async (base: VaultItem | null = item) => {
    if (!draft.name.trim()) {
      setError(t('vault.form.nameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const before = base ? decryptVaultItem(vault, base) : null;
      const prev = before?.ok ? before.payload : initial;
      const payload = withHistory(prev, { ...draft, name: draft.name.trim(), importWarnings: [] });
      let savedId: string;
      if (!item || !base) {
        const created = await createItem(
          vaults.find((v) => v.id === targetVaultId) ?? vault,
          payload,
        );
        savedId = created.id;
      } else if (targetVaultId !== vault.id) {
        const target = vaults.find((v) => v.id === targetVaultId)!;
        const moved = await moveItem(base, target, payload);
        savedId = moved.id;
      } else {
        await saveItem(vault, base, payload);
        savedId = item.id;
        // Attachments removed from the item are deleted from the store.
        const kept = new Set(payload.attachments.map((a) => a.id));
        for (const a of base.attachments) {
          if (!kept.has(a.id)) await deleteAttachment(item.id, a.id).catch(() => undefined);
        }
      }
      added.current = [];
      invalidateVault(qc, vault.id);
      if (targetVaultId !== vault.id) invalidateVault(qc, targetVaultId);
      onDone(savedId);
    } catch (e) {
      if (isApiError(e, 'vault_revision_conflict') && item) {
        // Someone saved meanwhile (design 8.8): show both, let the person choose.
        await qc.invalidateQueries({ queryKey: ['vault', 'items', vault.id] });
        const fresh = await api.call('vaultGetItem', { params: { itemId: item.id } });
        const r = decryptVaultItem(vault, fresh);
        setConflict({ theirs: fresh, payload: r.ok ? r.payload : null });
      } else setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const addFiles = async (files: FileList | null) => {
    if (!files || !item) return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(t('errors.vault_attachment_too_large'));
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const ref = await uploadAttachment(item.id, file);
        added.current.push(ref.id);
        setDraft((d) => ({ ...d, attachments: [...d.attachments, ref] }));
      } catch (e) {
        setError(errorMessage(e, t));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-6">
        <span className="text-sm text-fg2">
          {dirty ? t('vault.form.unsaved') : item ? t('vault.form.editing') : t('vault.form.new')}
        </span>
        <Button
          size="sm"
          variant="gh"
          className="ml-auto"
          onClick={() => void cancel()}
          disabled={busy}
        >
          {t('vault.cancel')}
        </Button>
        <Button
          size="sm"
          variant="pri"
          loading={busy}
          disabled={uploading > 0}
          onClick={() => void save()}
        >
          {t('vault.save')}
          <Kbd className="bg-black/10 text-current shadow-none">Ctrl S</Kbd>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-7 py-6">
        <header className="flex items-center gap-3">
          <ItemAvatar name={draft.name} type={draft.type} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="text-h font-semibold">
              {item
                ? t('vault.form.editTitle', { name: initial.name })
                : t('vault.form.newTitle', { type: t(`vault.type.${draft.type}`) })}
            </h2>
            <span className="text-sm text-fg2">
              {t(`vault.type.${draft.type}`)}
              {item
                ? ` · ${t('vault.form.lastSaved', { time: formatTime(item.updatedAt, locale), name: item.updatedBy?.name ?? '' })}`
                : ''}
            </span>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Icon
              name="star"
              size={16}
              className={draft.favorite ? 'fill-accent text-accent' : 'text-fg2'}
            />
            {t('vault.detail.favorite')}
            <Switch checked={draft.favorite} onCheckedChange={(v) => set('favorite', v)} />
          </label>
        </header>

        {conflict ? (
          <ConflictPanel
            mine={draft}
            theirs={conflict.payload}
            who={conflict.theirs.updatedBy?.name ?? ''}
            at={formatTime(conflict.theirs.updatedAt, locale)}
            onKeepMine={() => {
              const theirs = conflict.theirs;
              setConflict(null);
              void save(theirs);
            }}
            onTakeTheirs={() => {
              setConflict(null);
              invalidateVault(qc, vault.id);
              onDone(item?.id ?? null);
            }}
          />
        ) : null}

        <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          <Field label={t('vault.form.name')}>
            <Input
              autoFocus
              value={draft.name}
              maxLength={300}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field label={t('vault.form.vault')}>
            <Select value={targetVaultId} onValueChange={setTargetVaultId}>
              <SelectTrigger>
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
          </Field>
          <TypeFields draft={draft} setDraft={setDraft} />
          <Field label={t('vault.form.env')}>
            <Segmented
              aria-label={t('vault.form.env')}
              value={draft.env ?? 'none'}
              onValueChange={(v) => set('env', v === 'none' ? null : (v as 'test' | 'prod'))}
              options={[
                { value: 'none', label: t('vault.env.none') },
                { value: 'test', label: t('vault.env.test') },
                { value: 'prod', label: t('vault.env.prod') },
              ]}
            />
          </Field>
          <TagsField
            tags={draft.tags}
            suggestions={tagSuggestions}
            onChange={(tags) => set('tags', tags)}
          />
          <Field label={t('vault.field.notes')} className="md:col-span-2">
            <Textarea rows={4} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
        </div>

        <CustomFields draft={draft} setDraft={setDraft} />

        <div className="flex flex-col gap-2">
          <span className="eyebrow px-1">
            {t('vault.detail.attachments', { count: draft.attachments.length })}
          </span>
          {draft.attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-3 rounded-lg bg-bg2/60 px-3 py-2 shadow-line"
            >
              <Icon name="file" size={16} />
              <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
              <span className="text-xs text-fg3">{formatBytes(a.size, locale)}</span>
              <IconButton
                aria-label={t('vault.form.removeAttachment')}
                tone="plain"
                size="xs"
                onClick={() =>
                  set(
                    'attachments',
                    draft.attachments.filter((x) => x.id !== a.id),
                  )
                }
              >
                <Icon name="x" size={14} />
              </IconButton>
            </div>
          ))}
          {item ? (
            <label
              className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line2 px-4 py-5 text-sm text-fg2 hover:bg-bg2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void addFiles(e.dataTransfer.files);
              }}
            >
              {uploading ? <Spinner size={16} /> : <Icon name="upload" size={16} />}
              <span>
                <b className="font-semibold text-fg">{t('vault.form.dropFiles')}</b> ·{' '}
                {t('vault.form.encryptedUpload')}
              </span>
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => void addFiles(e.target.files)}
              />
            </label>
          ) : (
            <p className="text-xs text-fg3">{t('vault.form.saveBeforeAttach')}</p>
          )}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ConflictPanel({
  mine,
  theirs,
  who,
  at,
  onKeepMine,
  onTakeTheirs,
}: {
  mine: ItemPayload;
  theirs: ItemPayload | null;
  who: string;
  at: string;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
}) {
  const { t } = useI18n();
  const col = (title: string, p: ItemPayload | null) => (
    <div className="flex flex-1 flex-col gap-1 rounded-lg bg-surface p-3 text-sm shadow-line">
      <span className="eyebrow">{title}</span>
      {p ? (
        <>
          <span className="font-semibold">{p.name}</span>
          {p.type === 'login' ? <span className="text-fg2">{p.username}</span> : null}
          {p.notes ? (
            <span className="line-clamp-3 text-xs whitespace-pre-wrap text-fg3">{p.notes}</span>
          ) : null}
        </>
      ) : (
        <span className="text-fg3">—</span>
      )}
    </div>
  );
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-4"
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <Icon name="alert" size={16} className="text-warning" />
        {t('vault.form.conflict', { name: who, time: at })}
      </span>
      <div className="flex gap-3">
        {col(t('vault.form.theirs'), theirs)}
        {col(t('vault.form.mine'), mine)}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="out" onClick={onTakeTheirs}>
          {t('vault.form.takeTheirs')}
        </Button>
        <Button size="sm" variant="pri" onClick={onKeepMine}>
          {t('vault.form.keepMine')}
        </Button>
      </div>
    </div>
  );
}

function SecretInput({
  value,
  onChange,
  generator,
  autoComplete = 'off',
  mono = true,
}: {
  value: string;
  onChange: (v: string) => void;
  generator?: boolean;
  autoComplete?: string;
  mono?: boolean;
}) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <Input
      type={show ? 'text' : 'password'}
      autoComplete={autoComplete}
      value={value}
      spellCheck={false}
      className={cn(mono && 'font-mono')}
      onChange={(e) => onChange(e.target.value)}
      trailing={
        <span className="flex items-center gap-0.5">
          <IconButton
            aria-label={show ? t('vault.hide') : t('vault.show')}
            tone="plain"
            size="xs"
            onClick={() => setShow((v) => !v)}
          >
            <Icon name={show ? 'eyeOff' : 'eye'} size={15} />
          </IconButton>
          {generator ? (
            <Popover open={open} onOpenChange={setOpen}>
              <Tooltip content={t('vault.gen.title')}>
                <PopoverTrigger asChild>
                  <IconButton aria-label={t('vault.gen.title')} tone="plain" size="xs">
                    <Icon name="dice" size={15} />
                  </IconButton>
                </PopoverTrigger>
              </Tooltip>
              <PopoverContent align="end" className="w-auto p-4">
                <Generator
                  onUse={(v) => {
                    onChange(v);
                    setShow(true);
                    setOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
          ) : null}
        </span>
      }
    />
  );
}

function TypeFields({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: (fn: (d: Draft) => Draft) => void;
}) {
  const { t } = useI18n();
  const field = (key: string, labelKey: MessageKey, node: ReactNode, wide = false) => (
    <Field key={key} label={t(labelKey)} className={wide ? 'md:col-span-2' : undefined}>
      {node}
    </Field>
  );
  const text = <K extends string>(
    d: Record<K, string>,
    k: K,
    labelKey: MessageKey,
    opts: { mono?: boolean; wide?: boolean; type?: string } = {},
  ) =>
    field(
      k,
      labelKey,
      <Input
        type={opts.type ?? 'text'}
        value={d[k]}
        className={cn(opts.mono && 'font-mono')}
        onChange={(e) => setDraft((x) => ({ ...x, [k]: e.target.value }) as Draft)}
      />,
      opts.wide,
    );
  const secret = <K extends string>(
    d: Record<K, string>,
    k: K,
    labelKey: MessageKey,
    opts: { generator?: boolean; wide?: boolean; mono?: boolean } = {},
  ) =>
    field(
      k,
      labelKey,
      <SecretInput
        value={d[k]}
        generator={opts.generator}
        mono={opts.mono}
        onChange={(v) => setDraft((x) => ({ ...x, [k]: v }) as Draft)}
      />,
      opts.wide,
    );

  switch (draft.type) {
    case 'login': {
      const totpOk = !draft.totp || parseTotp(draft.totp) !== null;
      return (
        <>
          {text(draft, 'username', 'vault.field.username')}
          <div className="flex flex-col gap-1.5">
            {secret(draft, 'password', 'vault.field.password', { generator: true })}
            <StrengthBar password={draft.password} />
          </div>
          <Field
            label={t('vault.field.totp')}
            hint={t('vault.form.totpHint')}
            error={totpOk ? undefined : t('vault.totpInvalid')}
          >
            <SecretInput
              value={draft.totp}
              onChange={(v) => setDraft((x) => ({ ...x, totp: v }) as Draft)}
            />
          </Field>
          <UrisField
            uris={draft.uris}
            onChange={(uris) => setDraft((x) => ({ ...x, uris }) as Draft)}
          />
        </>
      );
    }
    case 'api_key':
      return (
        <>
          {secret(draft, 'key', 'vault.field.key', { generator: true })}
          {text(draft, 'username', 'vault.field.username')}
          {text(draft, 'url', 'vault.field.url')}
          {text(draft, 'scope', 'vault.field.scope')}
          <Field label={t('vault.field.expiresAt')}>
            <DatePicker
              value={draft.expiresAt ?? null}
              onChange={(v) => setDraft((x) => ({ ...x, expiresAt: v }) as Draft)}
            />
          </Field>
        </>
      );
    case 'card':
      return (
        <>
          {text(draft, 'cardholder', 'vault.field.cardholder')}
          {text(draft, 'brand', 'vault.field.brand')}
          {secret(draft, 'number', 'vault.field.number', { mono: true })}
          <div className="grid grid-cols-3 gap-2">
            {text(draft, 'expMonth', 'vault.field.expMonth')}
            {text(draft, 'expYear', 'vault.field.expYear')}
            {secret(draft, 'code', 'vault.field.code')}
          </div>
        </>
      );
    case 'ssh_key':
      return (
        <>
          {text(draft, 'host', 'vault.field.host', { mono: true })}
          <Field
            label={t('vault.field.privateKey')}
            className="md:col-span-2"
            labelAside={
              <Button
                size="xs"
                variant="out"
                onClick={() => {
                  const k = generateEd25519SshKey(draft.host);
                  setDraft(
                    (x) =>
                      ({
                        ...x,
                        privateKey: k.privateKey,
                        publicKey: k.publicKey,
                        fingerprint: k.fingerprint,
                      }) as Draft,
                  );
                }}
              >
                <Icon name="key" size={14} />
                {t('vault.form.generateSsh')}
              </Button>
            }
          >
            <Textarea
              rows={5}
              spellCheck={false}
              className="font-mono text-xs"
              value={draft.privateKey}
              onChange={(e) => setDraft((x) => ({ ...x, privateKey: e.target.value }) as Draft)}
            />
          </Field>
          <Field label={t('vault.field.publicKey')} className="md:col-span-2">
            <Textarea
              rows={2}
              spellCheck={false}
              className="font-mono text-xs"
              value={draft.publicKey}
              onChange={(e) =>
                setDraft(
                  (x) =>
                    ({
                      ...x,
                      publicKey: e.target.value,
                      fingerprint:
                        sshFingerprint(e.target.value) ??
                        (x as { fingerprint: string }).fingerprint,
                    }) as Draft,
                )
              }
            />
          </Field>
          {text(draft, 'fingerprint', 'vault.field.fingerprint', { mono: true })}
          {secret(draft, 'passphrase', 'vault.field.passphrase')}
        </>
      );
    case 'identity':
      return (
        <>
          {text(draft, 'firstName', 'vault.field.firstName')}
          {text(draft, 'lastName', 'vault.field.lastName')}
          {text(draft, 'email', 'vault.field.email', { type: 'email' })}
          {text(draft, 'phone', 'vault.field.phone')}
          {text(draft, 'company', 'vault.field.company')}
          {secret(draft, 'nationalId', 'vault.field.nationalId', { mono: false })}
          {secret(draft, 'passport', 'vault.field.passport', { mono: false })}
          {secret(draft, 'license', 'vault.field.license', { mono: false })}
          {text(draft, 'address1', 'vault.field.address', { wide: true })}
          {text(draft, 'postalCode', 'vault.field.postalCode')}
          {text(draft, 'city', 'vault.field.city')}
          {text(draft, 'country', 'vault.field.country')}
        </>
      );
    case 'note':
      return null;
  }
}

function UrisField({ uris, onChange }: { uris: string[]; onChange: (v: string[]) => void }) {
  const { t } = useI18n();
  const list = uris.length ? uris : [''];
  return (
    <Field label={t('vault.field.uris')} className="md:col-span-2">
      <div className="flex flex-col gap-2">
        {list.map((u, i) => (
          <Input
            key={i}
            value={u}
            placeholder="https://"
            onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))}
            trailing={
              list.length > 1 ? (
                <IconButton
                  aria-label={t('vault.form.removeSite')}
                  tone="plain"
                  size="xs"
                  onClick={() => onChange(list.filter((_, j) => j !== i))}
                >
                  <Icon name="x" size={14} />
                </IconButton>
              ) : null
            }
          />
        ))}
        <Button
          size="xs"
          variant="gh"
          className="self-start"
          onClick={() => onChange([...list, ''])}
        >
          <Icon name="plus" size={14} />
          {t('vault.form.addSite')}
        </Button>
      </div>
    </Field>
  );
}

function TagsField({
  tags,
  suggestions,
  onChange,
}: {
  tags: string[];
  suggestions: string[];
  onChange: (v: string[]) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const listId = useId();
  const commit = (value = text) => {
    const next = normalizeTags([...tags, ...value.split(',')]);
    if (next.length !== tags.length) onChange(next);
    setText('');
  };
  return (
    <Field label={t('vault.form.tags')} hint={t('vault.form.tagsHint')} className="md:col-span-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <Tag key={tag} className="gap-1 pr-1">
            #{tag}
            <IconButton
              aria-label={t('vault.form.removeTag', { tag })}
              tone="plain"
              size="xs"
              className="size-4"
              onClick={() => onChange(tags.filter((x) => x !== tag))}
            >
              <Icon name="x" size={11} />
            </IconButton>
          </Tag>
        ))}
        <Input
          aria-label={t('vault.form.tags')}
          placeholder={t('vault.form.tagPlaceholder')}
          containerClassName="min-w-40 flex-1"
          list={listId}
          value={text}
          maxLength={100}
          onChange={(e) => {
            // Picking a suggestion fills the whole value at once; take it as a tag.
            const v = e.target.value;
            if (v.includes(',') || suggestions.includes(v)) commit(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && !text && tags.length) {
              onChange(tags.slice(0, -1));
            }
          }}
          onBlur={() => commit()}
        />
        <datalist id={listId}>
          {suggestions
            .filter((s) => !tags.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      </div>
    </Field>
  );
}

const FIELD_TYPES: CustomFieldType[] = ['text', 'hidden', 'boolean', 'date'];

function CustomFields({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: (fn: (d: Draft) => Draft) => void;
}) {
  const { t } = useI18n();
  const update = (id: string, patch: Partial<Draft['fields'][number]>) =>
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    }));
  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow px-1">{t('vault.detail.customFields')}</span>
      {draft.fields.map((f) => (
        <div key={f.id} className="grid grid-cols-[110px_1fr_1.4fr_auto] items-center gap-2">
          <span className="text-xs font-semibold text-fg2">{t(`vault.fieldType.${f.type}`)}</span>
          <Input
            aria-label={t('vault.form.fieldLabel')}
            placeholder={t('vault.form.fieldLabel')}
            value={f.label}
            onChange={(e) => update(f.id, { label: e.target.value })}
          />
          {f.type === 'boolean' ? (
            <Switch
              aria-label={f.label}
              checked={f.value === 'true'}
              onCheckedChange={(v) => update(f.id, { value: v ? 'true' : 'false' })}
            />
          ) : f.type === 'hidden' ? (
            <SecretInput
              value={f.value}
              mono={false}
              onChange={(v) => update(f.id, { value: v })}
            />
          ) : (
            <Input
              type={f.type === 'date' ? 'date' : 'text'}
              aria-label={f.label}
              value={f.value}
              onChange={(e) => update(f.id, { value: e.target.value })}
            />
          )}
          <IconButton
            aria-label={t('vault.form.removeField')}
            tone="plain"
            size="xs"
            onClick={() =>
              setDraft((d) => ({ ...d, fields: d.fields.filter((x) => x.id !== f.id) }))
            }
          >
            <Icon name="x" size={14} />
          </IconButton>
        </div>
      ))}
      <Menu>
        <MenuTrigger asChild>
          <Button size="xs" variant="gh" className="self-start">
            <Icon name="plus" size={14} />
            {t('vault.form.addField')}
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          {FIELD_TYPES.map((type) => (
            <MenuItem
              key={type}
              onSelect={() =>
                setDraft((d) => ({
                  ...d,
                  fields: [
                    ...d.fields,
                    { id: newId(), type, label: '', value: type === 'boolean' ? 'false' : '' },
                  ],
                }))
              }
            >
              {t(`vault.fieldType.${type}`)}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}

/** "Yeni öğe" type picker (design 8.7). */
export const NEW_TYPES: {
  type: ItemType;
  icon: 'user' | 'note' | 'card' | 'key' | 'terminal' | 'id';
  key: string;
}[] = [
  { type: 'login', icon: 'user', key: 'G' },
  { type: 'note', icon: 'note', key: 'T' },
  { type: 'card', icon: 'card', key: 'K' },
  { type: 'api_key', icon: 'key', key: 'A' },
  { type: 'ssh_key', icon: 'terminal', key: 'S' },
  { type: 'identity', icon: 'id', key: 'I' },
];

export function TypePicker({
  vault,
  onPick,
  onImport,
}: {
  vault: Vault;
  onPick: (t: ItemType) => void;
  onImport: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.target as HTMLElement).closest('input,textarea')
      ) {
        return;
      }
      const hit = NEW_TYPES.find((x) => x.key === e.key.toUpperCase());
      if (hit) {
        e.preventDefault();
        onPick(hit.type);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPick]);
  return (
    <div className="flex flex-col gap-4 px-7 py-6">
      <h2 className="text-h font-semibold">
        {t('vault.newItem.title', { vault: vaultName(vault, t) })}
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {NEW_TYPES.map((x) => (
          <button
            key={x.type}
            type="button"
            onClick={() => onPick(x.type)}
            className="flex items-center gap-3 rounded-xl p-3 text-left shadow-line hover:bg-bg2"
          >
            <span className="flex size-10 items-center justify-center rounded-lg bg-bg2">
              <Icon name={x.icon} size={18} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-semibold">{t(`vault.type.${x.type}`)}</span>
              <span className="truncate text-xs text-fg2">{t(`vault.newItem.hint.${x.type}`)}</span>
            </span>
            <Kbd>{x.key}</Kbd>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onImport}
        className="flex items-center gap-2 self-start text-sm font-semibold text-fg2 hover:text-fg"
      >
        <Icon name="upload" size={16} />
        {t('vault.import.fromBitwarden')}
      </button>
    </div>
  );
}

export const newPayload = (type: ItemType): ItemPayload => emptyItem(type, '');
