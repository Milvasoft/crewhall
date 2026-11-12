// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/qr-generator/component.tsx. See THIRD_PARTY.md.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { Button } from '@/features/tools/components/ui/Button';
import { downloadBlob } from '@/features/tools/lib/image/imageUtils';
import { useI18n } from '@/lib/i18n/I18nContext';

type Ecc = 'L' | 'M' | 'Q' | 'H';

export default function QrGeneratorTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [text, setText] = useState(initialInput ?? 'https://example.com');
  const [size, setSize] = useState(320);
  const [ecc, setEcc] = useState<Ecc>('M');
  const [margin, setMargin] = useState(2);
  const [dark, setDark] = useState('#000000');
  const [light, setLight] = useState('#ffffff');
  // Last generated result. It stays visible until the next one is ready, and is
  // hidden (not reset) when the text is cleared.
  const [generated, setGenerated] = useState<{ url: string; error: string | null }>({
    url: '',
    error: null,
  });
  const dataUrl = text ? generated.url : '';
  const error = text ? generated.error : null;

  useEffect(() => {
    if (!text) return;
    let cancelled = false;
    QRCode.toDataURL(text, {
      width: size,
      margin,
      errorCorrectionLevel: ecc,
      color: { dark, light },
    })
      .then((url) => {
        if (!cancelled) setGenerated({ url, error: null });
      })
      .catch(() => {
        if (!cancelled) setGenerated({ url: '', error: t('tools.items.qr-generator.failed') });
      });
    return () => {
      cancelled = true;
    };
  }, [text, size, ecc, margin, dark, light, t]);

  const downloadPng = () => {
    if (!dataUrl) return;
    fetch(dataUrl)
      .then((r) => r.blob())
      .then((blob) => downloadBlob(blob, 'qr-code.png'));
  };

  const downloadSvg = async () => {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin,
      errorCorrectionLevel: ecc,
      color: { dark, light },
    });
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'qr-code.svg');
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-3">
        <ToolEditor
          label={t('tools.items.qr-generator.textLabel')}
          value={text}
          onChange={setText}
          minRows={6}
          placeholder={t('tools.items.qr-generator.placeholder')}
          footer={error ? <span className="text-danger">{error}</span> : undefined}
        />
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            {t('tools.items.qr-generator.size')}
            <select
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
            >
              {[160, 240, 320, 512, 800].map((s) => (
                <option key={s} value={s}>
                  {s}px
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            {t('tools.items.qr-generator.ecc')}
            <select
              value={ecc}
              onChange={(e) => setEcc(e.target.value as Ecc)}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
            >
              <option value="L">L (7%)</option>
              <option value="M">M (15%)</option>
              <option value="Q">Q (25%)</option>
              <option value="H">H (30%)</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            {t('tools.items.qr-generator.margin')}
            <input
              type="number"
              min={0}
              max={10}
              value={margin}
              onChange={(e) => setMargin(Number(e.target.value) || 0)}
              className="h-8 w-16 rounded-md border border-line bg-surface px-2 text-right text-sm outline-none"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            {t('tools.items.qr-generator.dark')}
            <input type="color" value={dark} onChange={(e) => setDark(e.target.value)} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            {t('tools.items.qr-generator.light')}
            <input type="color" value={light} onChange={(e) => setLight(e.target.value)} />
          </label>
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 self-start rounded-lg border border-line bg-surface p-4">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={t('tools.items.qr-generator.alt')}
            className="max-w-full"
            width={size}
            height={size}
          />
        ) : (
          <div className="flex h-40 w-40 items-center justify-center text-sm text-fg3">
            {t('tools.items.qr-generator.empty')}
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={downloadPng} disabled={!dataUrl}>
            PNG
          </Button>
          <Button size="sm" variant="secondary" onClick={downloadSvg} disabled={!text}>
            SVG
          </Button>
        </div>
      </div>
    </div>
  );
}
