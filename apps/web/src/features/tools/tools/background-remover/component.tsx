// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/background-remover/component.tsx. See THIRD_PARTY.md.
import { useEffect, useRef, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { ImagePicker } from '@/features/tools/components/tool/ImagePicker';
import { Button } from '@/features/tools/components/ui/Button';
import {
  canvasToBlob,
  downloadBlob,
  fileToDataUri,
  formatBytes,
  loadImage,
} from '@/features/tools/lib/image/imageUtils';
import { useI18n } from '@/lib/i18n/I18nContext';
import { autoDetectBackground, removeBackground, type RGB } from './logic';

const CHECKER = {
  backgroundImage: 'repeating-conic-gradient(rgba(128,128,128,.25) 0% 25%, transparent 0% 50%)',
  backgroundSize: '16px 16px',
} as const;

const toHex = (c: RGB) =>
  '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): RGB => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

export default function BackgroundRemoverTool(_props: ToolComponentProps) {
  const { t } = useI18n();
  const [original, setOriginal] = useState<{ dataUri: string; w: number; h: number } | null>(null);
  const [target, setTarget] = useState<RGB>({ r: 255, g: 255, b: 255 });
  const [tolerance, setTolerance] = useState(40);
  const [feather, setFeather] = useState(15);
  const [result, setResult] = useState<{ url: string; blob: Blob; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const origDataRef = useRef<Uint8ClampedArray | null>(null);

  const onFile = async (file: File) => {
    try {
      const dataUri = await fileToDataUri(file);
      const img = await loadImage(dataUri);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas not available.');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      srcCanvasRef.current = canvas;
      origDataRef.current = imageData.data;
      setOriginal({ dataUri, w: canvas.width, h: canvas.height });
      setTarget(autoDetectBackground(imageData.data, canvas.width, canvas.height));
      setError(null);
    } catch {
      setError(t('tools.items.background-remover.loadFailed'));
    }
  };

  // Reprocess whenever the key color or thresholds change.
  useEffect(() => {
    const orig = origDataRef.current;
    if (!original || !orig) return;
    let revoked: string | null = null;

    const data = new Uint8ClampedArray(orig); // clone
    removeBackground(data, target, tolerance, feather);
    const out = document.createElement('canvas');
    out.width = original.w;
    out.height = original.h;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(data, original.w, original.h), 0, 0);
    canvasToBlob(out, 'image/png')
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        revoked = url;
        setResult({ url, blob, size: blob.size });
      })
      .catch(() => setError(t('tools.items.background-remover.processFailed')));

    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [original, target, tolerance, feather, t]);

  const sampleColor = (e: React.MouseEvent<HTMLImageElement>) => {
    const canvas = srcCanvasRef.current;
    if (!canvas || !original) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * original.w);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * original.h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const px = ctx.getImageData(x, y, 1, 1).data;
    setTarget({ r: px[0] ?? 0, g: px[1] ?? 0, b: px[2] ?? 0 });
  };

  return (
    <div className="flex flex-col gap-4">
      {!original ? (
        <ImagePicker onFile={onFile} label={t('tools.items.background-remover.pickLabel')} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs text-fg2">
              {t('tools.items.background-remover.keyColor')}
              <input
                type="color"
                value={toHex(target)}
                onChange={(e) => setTarget(fromHex(e.target.value))}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-fg2">
              {t('tools.items.background-remover.tolerance', { value: tolerance })}
              <input
                type="range"
                min={0}
                max={200}
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-fg2">
              {t('tools.items.background-remover.softEdge', { value: feather })}
              <input
                type="range"
                min={0}
                max={100}
                value={feather}
                onChange={(e) => setFeather(Number(e.target.value))}
              />
            </label>
            <span className="text-[11px] text-fg3">{t('tools.items.background-remover.tip')}</span>
            <Button variant="ghost" size="sm" onClick={() => setOriginal(null)}>
              {t('tools.items.background-remover.chooseAnother')}
            </Button>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <figure className="overflow-hidden rounded-lg border border-line bg-surface">
              <figcaption className="border-b border-line bg-bg2 px-3 py-1.5 text-xs text-fg2">
                {t('tools.items.background-remover.originalCaption')}
              </figcaption>
              <img
                src={original.dataUri}
                alt={t('tools.items.background-remover.originalAlt')}
                onClick={sampleColor}
                className="max-h-[50vh] w-full cursor-crosshair object-contain"
              />
            </figure>

            <figure className="overflow-hidden rounded-lg border border-line bg-surface">
              <figcaption className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1.5 text-xs text-fg2">
                <span>{t('tools.items.background-remover.resultCaption')}</span>
                <span>{result ? formatBytes(result.size) : '…'}</span>
              </figcaption>
              <div className="flex items-center justify-center p-3" style={CHECKER}>
                {result && (
                  <img
                    src={result.url}
                    alt={t('tools.items.background-remover.resultAlt')}
                    className="max-h-[50vh] max-w-full object-contain"
                  />
                )}
              </div>
            </figure>
          </div>

          {result && (
            <div>
              <Button
                variant="primary"
                onClick={() => downloadBlob(result.blob, 'no-background.png')}
              >
                {t('tools.items.background-remover.downloadPng', {
                  size: formatBytes(result.size),
                })}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
