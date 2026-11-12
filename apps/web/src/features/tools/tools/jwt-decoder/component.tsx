// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/jwt-decoder/component.tsx. See THIRD_PARTY.md.
import { useMemo, useState } from 'react';
import { SplitGrid } from '@/features/tools/components/tool/SplitGrid';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { useI18n } from '@/lib/i18n/I18nContext';
import { claimRows, decodeJwt, isExpired } from './logic';

/** Messages thrown by ./logic, mapped to dictionary keys. */
const ERROR_KEYS = {
  'A JWT has 2–3 dot-separated segments.': 'tools.items.jwt-decoder.errors.segments',
  'Header is not valid Base64URL-encoded JSON.': 'tools.items.jwt-decoder.errors.header',
  'Payload is not valid Base64URL-encoded JSON.': 'tools.items.jwt-decoder.errors.payload',
} as const;

/** Claim notes from ./logic end with a status after " · ". */
const NOTE_KEYS = {
  expired: 'tools.items.jwt-decoder.status.expired',
  valid: 'tools.items.jwt-decoder.status.valid',
  'not yet valid': 'tools.items.jwt-decoder.status.notYetValid',
} as const;

const EXAMPLE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkYSBMb3ZlbGFjZSIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTUxNjIzOTAyMn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

export default function JwtDecoderTool({ initialInput }: ToolComponentProps) {
  const { t, rich } = useI18n();
  const [token, setToken] = useState(initialInput ?? EXAMPLE);
  const definition = getDefinition('jwt-decoder')!;

  const { decoded, error } = useMemo(() => {
    if (!token.trim()) return { decoded: null, error: null as string | null };
    try {
      return { decoded: decodeJwt(token), error: null };
    } catch (e) {
      return { decoded: null, error: e instanceof Error ? e.message : '' };
    }
  }, [token]);

  const payloadJson = decoded ? JSON.stringify(decoded.payload, null, 2) : '';
  const headerJson = decoded ? JSON.stringify(decoded.header, null, 2) : '';
  const rows = decoded ? claimRows(decoded.payload) : [];
  const expired = decoded ? isExpired(decoded.payload) : false;

  const errorText = (message: string) => {
    const key = ERROR_KEYS[message as keyof typeof ERROR_KEYS];
    return key ? t(key) : message || t('tools.items.jwt-decoder.errors.invalid');
  };
  const noteText = (note: string) => {
    const [date = '', status] = note.split(' · ');
    const key = status ? NOTE_KEYS[status as keyof typeof NOTE_KEYS] : undefined;
    return key ? `${date} · ${t(key)}` : note;
  };

  return (
    <div className="flex flex-col gap-4">
      <ToolEditor
        label="JWT"
        value={token}
        onChange={setToken}
        minRows={5}
        placeholder={t('tools.items.jwt-decoder.placeholder')}
        footer={
          error !== null ? <span className="text-danger">{errorText(error)}</span> : undefined
        }
      />

      <div className="rounded-md border border-line bg-bg2 px-3 py-2 text-[11px] text-fg2">
        {rich('tools.items.jwt-decoder.notVerified')}
      </div>

      {decoded && (
        <>
          <SplitGrid
            leftLabel={t('tools.items.jwt-decoder.header')}
            rightLabel={t('tools.items.jwt-decoder.payload')}
          >
            <ToolEditor
              label={t('tools.items.jwt-decoder.header')}
              value={headerJson}
              readOnly
              language="json"
              minRows={6}
            />
            <ToolEditor
              label={t('tools.items.jwt-decoder.payload')}
              value={payloadJson}
              readOnly
              language="json"
              minRows={6}
              actions={
                <>
                  <CopyButton size="sm" variant="ghost" value={payloadJson} />
                  <SendToMenu source={definition} value={payloadJson} />
                </>
              }
            />
          </SplitGrid>

          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg2">
              <span>{t('tools.items.jwt-decoder.claims')}</span>
              {typeof decoded.payload.exp === 'number' && (
                <span className={expired ? 'text-danger' : 'text-success'}>
                  {expired
                    ? t('tools.items.jwt-decoder.expired')
                    : t('tools.items.jwt-decoder.notExpired')}
                </span>
              )}
            </div>
            {rows.map((r) => (
              <div
                key={r.key}
                className="flex items-center gap-3 border-b border-line/60 px-3 py-1.5 text-sm last:border-0"
              >
                <span className="w-28 shrink-0 font-mono text-[var(--syntax-key)]">{r.key}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-fg">{r.value}</span>
                {r.note && <span className="shrink-0 text-xs text-fg3">{noteText(r.note)}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
