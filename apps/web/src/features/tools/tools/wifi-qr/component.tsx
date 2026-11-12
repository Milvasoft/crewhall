// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/wifi-qr/component.tsx. See THIRD_PARTY.md.
import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { useI18n } from '@/lib/i18n/I18nContext';
import { wifiPayload, type WifiConfig, type WifiEncryption } from './logic';

export default function WifiQrTool(_: ToolComponentProps) {
  void _;
  const { t } = useI18n();
  const [config, setConfig] = useState<WifiConfig>({
    ssid: '',
    password: '',
    encryption: 'WPA',
    hidden: false,
  });
  // Last generated image; hidden (not reset) while the SSID is empty.
  const [generated, setGenerated] = useState('');
  const hasSsid = config.ssid.trim() !== '';
  const qr = hasSsid ? generated : '';

  const payload = useMemo(() => wifiPayload(config), [config]);
  const set = <K extends keyof WifiConfig>(k: K, v: WifiConfig[K]) =>
    setConfig((c) => ({ ...c, [k]: v }));

  useEffect(() => {
    if (!hasSsid) return;
    let alive = true;
    QRCode.toDataURL(payload, { margin: 1, width: 240 })
      .then((url) => alive && setGenerated(url))
      .catch(() => alive && setGenerated(''));
    return () => {
      alive = false;
    };
  }, [payload, hasSsid]);

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_auto]">
      <div className="space-y-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">{t('tools.items.wifi-qr.ssid')}</span>
          <input
            value={config.ssid}
            onChange={(e) => set('ssid', e.target.value)}
            spellCheck={false}
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg2">{t('tools.items.wifi-qr.password')}</span>
          <input
            value={config.password}
            onChange={(e) => set('password', e.target.value)}
            disabled={config.encryption === 'nopass'}
            spellCheck={false}
            className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-50"
          />
        </label>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-fg2">
            {t('tools.items.wifi-qr.encryption')}
            <select
              value={config.encryption}
              onChange={(e) => set('encryption', e.target.value as WifiEncryption)}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg focus:border-accent focus:outline-none"
            >
              <option value="WPA">WPA/WPA2</option>
              <option value="WEP">WEP</option>
              <option value="nopass">{t('tools.items.wifi-qr.none')}</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-sm text-fg2">
            <input
              type="checkbox"
              checked={config.hidden}
              onChange={(e) => set('hidden', e.target.checked)}
            />
            {t('tools.items.wifi-qr.hidden')}
          </label>
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{payload}</span>
          <CopyButton size="sm" variant="ghost" value={payload} />
        </div>
      </div>

      <div className="flex items-start justify-center">
        {qr ? (
          <div className="rounded-lg border border-line bg-white p-3">
            <img src={qr} alt={t('tools.items.wifi-qr.alt')} width={220} height={220} />
          </div>
        ) : (
          <div className="flex h-56 w-56 items-center justify-center rounded-lg border border-dashed border-line text-sm text-fg2">
            {t('tools.items.wifi-qr.empty')}
          </div>
        )}
      </div>
    </div>
  );
}
