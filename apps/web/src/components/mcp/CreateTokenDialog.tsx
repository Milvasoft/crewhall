import {
  MCP_ALWAYS_APPROVED_SCOPES,
  MCP_SCOPES,
  type CreatedApiToken,
  type McpPolicy,
  type McpScope,
  type McpSpaceRef,
} from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { api, isApiError } from '@/lib/api';
import { formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spacesLabel } from '@/lib/mcp/format';
import { mcpKeys } from '@/lib/mcp/queries';
import { useNow } from '@/lib/useNow';
import { CopyField, ScopeChecklist, SpaceChips } from './parts';

const DAY_OPTIONS = [7, 30, 90, 180, 365] as const;

/**
 * Design 18.4: form on the left step, the value once on the right step. The server keeps
 * only the sha256 and the first 8 characters.
 */
export function CreateTokenDialog({
  open,
  onOpenChange,
  spaces,
  maxTokenDays,
  allowedScopes,
  serverUrl,
  apiUrl,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  spaces: McpSpaceRef[];
  maxTokenDays: number | null;
  allowedScopes: McpPolicy['allowedScopes'] | null;
  serverUrl: string;
  apiUrl: string;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const now = useNow();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<McpScope[]>(['hub:read']);
  const [spaceIds, setSpaceIds] = useState<string[] | null>(null);
  const dayChoices = DAY_OPTIONS.filter((d) => maxTokenDays === null || d <= maxTokenDays);
  const [expiry, setExpiry] = useState<string>(
    String(dayChoices.includes(90) ? 90 : (dayChoices.at(-1) ?? 30)),
  );
  const [ips, setIps] = useState('');
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.call('createMcpToken', {
        body: {
          name: name.trim(),
          scopes,
          spaceIds,
          expiresInDays: expiry === 'never' ? null : Number(expiry),
          allowedIps: ips
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: async (res) => {
      setCreated(res);
      await qc.invalidateQueries({ queryKey: mcpKeys.all });
    },
  });

  function reset() {
    setName('');
    setScopes(['hub:read']);
    setSpaceIds(null);
    setIps('');
    setCreated(null);
    create.reset();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || (spaceIds !== null && spaceIds.length === 0)) return;
    create.mutate();
  }

  const options = MCP_SCOPES.map((scope) => ({
    scope,
    allowed: scope === 'hub:read' || (allowedScopes?.includes(scope) ?? true),
    required: scope === 'hub:read',
    approval: MCP_ALWAYS_APPROVED_SCOPES.includes(scope),
  }));
  const until = (days: number) => formatDateLong(new Date(now + days * 86_400_000), locale);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent width={560}>
        {created ? (
          <>
            <DialogHeader
              icon="key"
              title={`${t('mcp.token.step', { n: 2 })} · ${t('mcp.token.createdTitle')}`}
            />
            <Notice tone="warn" icon="alert">
              {t('mcp.token.once')}
            </Notice>
            <div className="flex flex-col gap-1.5">
              <span className="text-cap font-semibold">{created.token.name}</span>
              <CopyField value={created.value} />
              <span className="text-xs text-fg2">
                {[
                  created.token.scopes.map((s) => t(`mcp.scopeShort.${s}`)).join(', '),
                  spacesLabel({ t }, created.token.spaces),
                  created.token.expiresAt
                    ? t('mcp.token.until', {
                        date: formatDateLong(created.token.expiresAt, locale),
                      })
                    : t('mcp.token.never'),
                ].join(' · ')}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">{t('mcp.token.inMcp')}</span>
              <CopyField
                prompt
                value={`claude mcp add --transport http crewhall ${serverUrl} --header "Authorization: Bearer ${created.value}"`}
                display={`claude mcp add --transport http crewhall ${serverUrl} --header "Authorization: Bearer ${created.value.slice(0, 8)}…"`}
              />
              <span className="eyebrow mt-1">{t('mcp.token.inRest')}</span>
              <CopyField
                prompt
                value={`curl -H "Authorization: Bearer ${created.value}" ${apiUrl}/api/v1/spaces`}
                display={`curl -H "Authorization: Bearer ${created.value.slice(0, 8)}…" ${apiUrl}/api/v1/spaces`}
              />
            </div>
            <DialogFooter className="justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs text-fg2">
                <Icon name="shield" size={14} />
                {t('mcp.token.audited')}
              </span>
              <Button
                variant="pri"
                onClick={() => {
                  onOpenChange(false);
                  reset();
                }}
              >
                {t('mcp.token.done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader
              icon="key"
              title={`${t('mcp.token.step', { n: 1 })} · ${t('mcp.token.title')}`}
            />
            <Field label={t('mcp.token.name')} hint={t('mcp.token.nameHint')}>
              <Input
                value={name}
                maxLength={80}
                placeholder={t('mcp.token.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-cap font-semibold">{t('mcp.token.scopes')}</span>
              <ScopeChecklist options={options} value={scopes} onChange={setScopes} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-cap font-semibold">{t('mcp.token.spaces')}</span>
              <SpaceChips spaces={spaces} value={spaceIds} onChange={setSpaceIds} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('mcp.token.expiry')}>
                <Select value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger aria-label={t('mcp.token.expiry')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {dayChoices.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {t('mcp.token.expiryUntil', {
                          label: t('mcp.token.days', { count: d }),
                          date: until(d),
                        })}
                      </SelectItem>
                    ))}
                    {maxTokenDays === null ? (
                      <SelectItem value="never">{t('mcp.token.never')}</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('mcp.token.ips')} hint={t('mcp.token.ipsHint')}>
                <Input
                  value={ips}
                  placeholder={t('mcp.token.ipsPlaceholder')}
                  onChange={(e) => setIps(e.target.value)}
                />
              </Field>
            </div>
            {create.error ? (
              <Notice tone="error">
                {isApiError(create.error) ? t(`errors.${create.error.code}`) : t('errors.internal')}
              </Notice>
            ) : null}
            <DialogFooter>
              <Button variant="gh" onClick={() => onOpenChange(false)}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                type="submit"
                variant="pri"
                loading={create.isPending}
                disabled={!name.trim() || (spaceIds !== null && spaceIds.length === 0)}
              >
                {t('mcp.token.create')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
