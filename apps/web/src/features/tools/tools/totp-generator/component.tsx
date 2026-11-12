// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/totp-generator/component.tsx. See THIRD_PARTY.md.
import { useBootstrap } from '@/lib/useBranding';
import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { Button } from '@/features/tools/components/ui/Button';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import {
  base32Decode,
  base32Encode,
  otpauthUri,
  randomSecret,
  totp,
  type OtpAlgorithm,
} from './logic';
import { useI18n } from '@/lib/i18n/I18nContext';

const ALGORITHMS: OtpAlgorithm[] = ['SHA-1', 'SHA-256', 'SHA-512'];

export default function TotpGeneratorTool(_: ToolComponentProps) {
  const { branding } = useBootstrap();
  void _;
  const { t } = useI18n();
  // A fresh random secret on first mount.
  const [secret, setSecret] = useState(() => base32Encode(randomSecret(20)));
  const [digits, setDigits] = useState(6);
  const [period, setPeriod] = useState(30);
  const [algorithm, setAlgorithm] = useState<OtpAlgorithm>('SHA-1');

  const [tick, setTick] = useState({ code: '', remaining: period, failed: false });
  const [qr, setQr] = useState('');

  const [check, setCheck] = useState('');
  const [checkState, setCheckState] = useState<null | boolean>(null);

  const secretBytes = useMemo(() => {
    try {
      return secret.trim() ? base32Decode(secret) : null;
    } catch {
      return null;
    }
  }, [secret]);

  // Tick every second.
  useEffect(() => {
    if (!secretBytes) return;
    let alive = true;
    const refresh = async () => {
      try {
        const r = await totp(secretBytes, { digits, period, algorithm });
        if (alive) setTick({ code: r.code, remaining: r.secondsRemaining, failed: false });
      } catch {
        if (alive) setTick((s) => ({ ...s, failed: true }));
      }
    };
    void refresh();
    const id = setInterval(() => void refresh(), 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [secretBytes, digits, period, algorithm]);

  const code = secretBytes ? tick.code : '';
  const remaining = tick.remaining;
  const error = !secretBytes
    ? secret.trim()
      ? t('tools.items.totp-generator.errors.invalidSecret')
      : null
    : tick.failed
      ? t('tools.items.totp-generator.errors.computeFailed')
      : null;

  // Build the otpauth URI + QR whenever inputs change.
  const uri = useMemo(
    // Crewhall: the issuer is the organization (white label), not the copied tool's name.
    () =>
      secret.trim()
        ? otpauthUri(secret, { digits, period, algorithm, issuer: branding.orgName })
        : '',
    [secret, digits, period, algorithm, branding.orgName],
  );
  useEffect(() => {
    if (!uri) return;
    let alive = true;
    QRCode.toDataURL(uri, { margin: 1, width: 180 })
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => {
        if (alive) setQr('');
      });
    return () => {
      alive = false;
    };
  }, [uri]);
  const qrShown = uri ? qr : '';

  // Validate a code against the current and previous time window.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!check.trim() || !secretBytes) {
        setCheckState(null);
        return;
      }
      const now = Date.now() / 1000;
      const current = await totp(secretBytes, { digits, period, algorithm, now });
      const prev = await totp(secretBytes, {
        digits,
        period,
        algorithm,
        now: now - period,
      });
      const entered = check.trim();
      if (alive) setCheckState(entered === current.code || entered === prev.code);
    })();
    return () => {
      alive = false;
    };
  }, [check, code, secretBytes, digits, period, algorithm]);

  return (
    <div className="max-w-2xl space-y-5">
      <section className="space-y-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">
            {t('tools.items.totp-generator.secret')}
          </span>
          <div className="flex gap-2">
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              spellCheck={false}
              className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
            />
            <Button
              variant="secondary"
              className="h-10 shrink-0"
              onClick={() => setSecret(base32Encode(randomSecret(20)))}
            >
              {t('tools.items.totp-generator.random')}
            </Button>
          </div>
        </label>

        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg2">
              {t('tools.items.totp-generator.digits')}
            </span>
            <select
              value={digits}
              onChange={(e) => setDigits(Number(e.target.value))}
              className="h-9 w-24 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
            >
              {[6, 7, 8].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg2">
              {t('tools.items.totp-generator.period')}
            </span>
            <select
              value={period}
              onChange={(e) => setPeriod(Number(e.target.value))}
              className="h-9 w-24 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
            >
              {[30, 60].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg2">
              {t('tools.items.totp-generator.algorithm')}
            </span>
            <select
              value={algorithm}
              onChange={(e) => setAlgorithm(e.target.value as OtpAlgorithm)}
              className="h-9 w-28 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
            >
              {ALGORITHMS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : (
        <section className="flex flex-wrap items-center gap-6 rounded-lg border border-line bg-surface p-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-fg3">
              {t('tools.items.totp-generator.currentCode')}
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-3xl tracking-widest text-fg">{code || '------'}</span>
              <CopyButton size="sm" variant="ghost" value={code} />
            </div>
            <div className="mt-1 text-xs text-fg2">
              {t('tools.items.totp-generator.refreshesIn', { seconds: remaining })}
            </div>
          </div>
          {qrShown && (
            <div className="ml-auto">
              <img
                src={qrShown}
                alt={t('tools.items.totp-generator.qrAlt')}
                width={140}
                height={140}
                className="rounded-md border border-line bg-white p-1"
              />
            </div>
          )}
        </section>
      )}

      {uri && (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
          <span className="w-24 shrink-0 text-xs text-fg3">otpauth URI</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{uri}</span>
          <CopyButton size="sm" variant="ghost" value={uri} />
        </div>
      )}

      <section className="space-y-2 border-t border-line pt-4">
        <span className="text-xs font-medium text-fg2">
          {t('tools.items.totp-generator.validate')}
        </span>
        <input
          value={check}
          onChange={(e) => setCheck(e.target.value)}
          spellCheck={false}
          inputMode="numeric"
          placeholder={t('tools.items.totp-generator.validatePlaceholder', { count: digits })}
          className="h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg focus:border-accent focus:outline-none"
        />
        {checkState !== null && (
          <p className={`text-sm ${checkState ? 'text-success' : 'text-danger'}`}>
            {checkState
              ? t('tools.items.totp-generator.valid')
              : t('tools.items.totp-generator.invalid')}
          </p>
        )}
      </section>
    </div>
  );
}
