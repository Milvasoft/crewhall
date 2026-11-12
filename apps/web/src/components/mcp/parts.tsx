import { type McpScope, type McpSpaceRef } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  SpaceDot,
  toast,
  type SpaceColorSlot,
} from '@crewhall/ui';
import { useId, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

export interface ScopeOption {
  scope: McpScope;
  /** Off by policy: shown disabled. */
  allowed: boolean;
  required: boolean;
  approval: boolean;
}

/** Two-column scope checkboxes (18.2, 18.4, 18.5). Reading is fixed on. */
export function ScopeChecklist({
  options,
  value,
  onChange,
  columns = 2,
  footer,
}: {
  options: ScopeOption[];
  value: McpScope[];
  onChange: (v: McpScope[]) => void;
  columns?: 1 | 2;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div
      className={cn(
        'grid overflow-hidden rounded-lg shadow-line2',
        columns === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1',
      )}
    >
      {options.map((o) => {
        const checked = o.required || value.includes(o.scope);
        const box = `${id}-${o.scope}`;
        return (
          <div
            key={o.scope}
            className={cn(
              'flex min-h-10 items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0',
              columns === 2 && 'sm:odd:border-r',
              !o.allowed && 'opacity-55',
            )}
          >
            <Checkbox
              id={box}
              checked={checked}
              disabled={o.required || !o.allowed}
              onCheckedChange={(c) =>
                onChange(c ? [...value, o.scope] : value.filter((s) => s !== o.scope))
              }
            />
            <label htmlFor={box} className="min-w-0 flex-1 cursor-pointer text-cap font-semibold">
              {t(`mcp.scopes.${o.scope}`)}
            </label>
            {o.required ? (
              <span className="text-tag text-fg3">{t('mcp.consent.required')}</span>
            ) : !o.allowed ? (
              <span className="text-tag text-fg3">{t('mcp.consent.notAllowed')}</span>
            ) : o.approval ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-bg2 px-2 py-0.5 text-tag text-fg2">
                <Icon name="lock" size={11} />
                {t('mcp.consent.approval')}
              </span>
            ) : null}
          </div>
        );
      })}
      {footer}
    </div>
  );
}

/** Space chips with an "all" choice; null = every space (18.2, 18.4). */
export function SpaceChips({
  spaces,
  value,
  onChange,
}: {
  spaces: McpSpaceRef[];
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const { t } = useI18n();
  const toggle = (id: string) => {
    const current = value ?? [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    onChange(next);
  };
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('mcp.consent.spaces')}>
      <Chip on={value === null} onClick={() => onChange(value === null ? [] : null)}>
        {t('mcp.consent.allSpaces')}
      </Chip>
      {spaces.map((s) => (
        <Chip key={s.id} on={value?.includes(s.id) ?? false} onClick={() => toggle(s.id)}>
          <SpaceDot color={s.color as SpaceColorSlot} />
          {s.kind === 'personal' ? t('mcp.common.personal') : s.name}
        </Chip>
      ))}
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-cap font-medium transition-colors',
        on
          ? 'bg-bg2 text-fg shadow-[inset_0_0_0_1.5px_var(--fg)]'
          : 'bg-bg2 text-fg2 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

export async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    // Clipboard blocked (http, permissions): the text stays selectable.
  }
}

/** Monospace value with a copy button (server URL, commands, token). */
export function CopyField({
  value,
  display,
  prompt,
  className,
}: {
  value: string;
  display?: ReactNode;
  prompt?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'flex min-h-11 items-center gap-2 rounded-lg bg-bg2 py-1.5 pr-1.5 pl-3 font-mono text-[13px] leading-[19px]',
        className,
      )}
    >
      {prompt ? <span className="text-fg3 select-none">$</span> : null}
      <span className="min-w-0 flex-1 break-all select-all">{display ?? value}</span>
      <Button size="sm" onClick={() => void copyText(value, t('mcp.common.copied'))}>
        <Icon name="copy" size={14} />
        {t('mcp.common.copy')}
      </Button>
    </div>
  );
}

/** Small square copy button for code blocks. */
export function CopyButton({ value }: { value: string }) {
  const { t } = useI18n();
  return (
    <IconButton
      aria-label={t('mcp.common.copy')}
      onClick={() => void copyText(value, t('mcp.common.copied'))}
    >
      <Icon name="copy" size={16} />
    </IconButton>
  );
}

/** Yes/no dialog for disconnecting and revoking. */
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

/** Opens a confirm dialog for a value; keeps the state in one place. */
export function useConfirm<T>() {
  const [target, setTarget] = useState<T | null>(null);
  return { target, ask: setTarget, close: () => setTarget(null) };
}
