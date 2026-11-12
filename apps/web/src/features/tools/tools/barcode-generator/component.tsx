// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/barcode-generator/component.tsx. See THIRD_PARTY.md.
import { useEffect, useMemo, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { Button } from '@/features/tools/components/ui/Button';
import { downloadBlob } from '@/features/tools/lib/image/imageUtils';
import { useI18n } from '@/lib/i18n/I18nContext';

const FORMATS = ['CODE128', 'CODE39', 'EAN13', 'EAN8', 'UPC', 'ITF14', 'MSI', 'codabar'];

export default function BarcodeGeneratorTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialInput ?? 'CREWHALL-123');
  const [format, setFormat] = useState('CODE128');
  const [displayValue, setDisplayValue] = useState(true);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Validate during render: JsBarcode can encode into a plain object, which
  // throws for input the chosen format does not accept.
  const error = useMemo(() => {
    if (!value) return t('tools.items.barcode-generator.emptyValue');
    try {
      JsBarcode({}, value, { format });
      return null;
    } catch {
      return t('tools.items.barcode-generator.invalid', { value, type: format });
    }
  }, [value, format, t]);

  useEffect(() => {
    if (!svgRef.current || error) return;
    try {
      JsBarcode(svgRef.current, value, {
        format,
        displayValue,
        width: 2,
        height: 100,
        margin: 10,
        background: '#ffffff',
        lineColor: '#000000',
      });
    } catch {
      /* already reported by the validation above */
    }
  }, [value, format, displayValue, error]);

  const downloadSvg = () => {
    if (!svgRef.current || error) return;
    const svg = new XMLSerializer().serializeToString(svgRef.current);
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'barcode.svg');
  };

  const downloadPng = () => {
    if (error) return;
    try {
      const canvas = document.createElement('canvas');
      JsBarcode(canvas, value, { format, displayValue, width: 2, height: 100, margin: 10 });
      canvas.toBlob((blob) => blob && downloadBlob(blob, 'barcode.png'));
    } catch {
      /* handled by the live error above */
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-3">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('tools.items.barcode-generator.placeholder')}
          aria-label={t('tools.items.barcode-generator.valueLabel')}
          className="h-10 rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg outline-none focus:border-accent"
        />
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            {t('tools.items.barcode-generator.format')}
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-fg2">
            <input
              type="checkbox"
              checked={displayValue}
              onChange={(e) => setDisplayValue(e.target.checked)}
            />
            {t('tools.items.barcode-generator.showText')}
          </label>
        </div>
        <p className="text-[11px] text-fg3">{t('tools.items.barcode-generator.tip')}</p>
      </div>

      <div className="flex flex-col items-center gap-3 self-start rounded-lg border border-line bg-surface p-4">
        <div className="flex min-h-[120px] w-full items-center justify-center overflow-auto rounded bg-white p-2">
          <svg ref={svgRef} />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={downloadPng} disabled={!!error}>
            PNG
          </Button>
          <Button size="sm" variant="secondary" onClick={downloadSvg} disabled={!!error}>
            SVG
          </Button>
        </div>
      </div>
    </div>
  );
}
