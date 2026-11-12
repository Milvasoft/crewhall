// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/image-compressor/component.tsx. See THIRD_PARTY.md.
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

type Format = 'image/jpeg' | 'image/webp' | 'image/png';

interface Original {
  dataUri: string;
  width: number;
  height: number;
  size: number;
  name: string;
}

interface Result {
  url: string;
  blob: Blob;
  width: number;
  height: number;
  size: number;
}

export default function ImageCompressorTool(_props: ToolComponentProps) {
  const { t } = useI18n();
  const [original, setOriginal] = useState<Original | null>(null);
  const [format, setFormat] = useState<Format>('image/jpeg');
  const [quality, setQuality] = useState(0.8);
  const [maxDim, setMaxDim] = useState(2000);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const onFile = async (file: File) => {
    try {
      const dataUri = await fileToDataUri(file);
      const img = await loadImage(dataUri);
      imgRef.current = img;
      setOriginal({
        dataUri,
        width: img.naturalWidth,
        height: img.naturalHeight,
        size: file.size,
        name: file.name.replace(/\.[^.]+$/, ''),
      });
      setError(null);
    } catch {
      setError(t('tools.items.image-compressor.loadFailed'));
    }
  };

  useEffect(() => {
    const img = imgRef.current;
    if (!original || !img) return;
    let revoked: string | null = null;

    const scale = Math.min(1, maxDim / Math.max(original.width, original.height));
    const w = Math.max(1, Math.round(original.width * scale));
    const h = Math.max(1, Math.round(original.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, w, h);

    canvasToBlob(canvas, format, format === 'image/png' ? undefined : quality)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        revoked = url;
        setResult({ url, blob, width: w, height: h, size: blob.size });
      })
      .catch(() => setError(t('tools.items.image-compressor.compressFailed')));

    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [original, format, quality, maxDim, t]);

  const reduction = original && result ? Math.round((1 - result.size / original.size) * 100) : 0;
  // Every Format value is "image/<ext>".
  const ext = format.split('/')[1]!;

  return (
    <div className="flex flex-col gap-4">
      {!original ? (
        <ImagePicker onFile={onFile} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs text-fg2">
              {t('tools.items.image-compressor.format')}
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as Format)}
                className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
              >
                <option value="image/jpeg">JPEG</option>
                <option value="image/webp">WebP</option>
                <option value="image/png">PNG</option>
              </select>
            </label>
            {format !== 'image/png' && (
              <label className="flex items-center gap-2 text-xs text-fg2">
                {t('tools.items.image-compressor.quality', { pct: Math.round(quality * 100) })}
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                />
              </label>
            )}
            <label className="flex items-center gap-2 text-xs text-fg2">
              {t('tools.items.image-compressor.maxSize')}
              <select
                value={maxDim}
                onChange={(e) => setMaxDim(Number(e.target.value))}
                className="h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none"
              >
                {[400, 800, 1200, 2000, 4000, 100000].map((d) => (
                  <option key={d} value={d}>
                    {d >= 100000 ? t('tools.items.image-compressor.original') : `${d}px`}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="ghost" size="sm" onClick={() => setOriginal(null)}>
              {t('tools.items.image-compressor.chooseAnother')}
            </Button>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <figure className="overflow-hidden rounded-lg border border-line bg-surface">
              <figcaption className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1.5 text-xs text-fg2">
                <span>{t('tools.items.image-compressor.original')}</span>
                <span>
                  {original.width}×{original.height} · {formatBytes(original.size)}
                </span>
              </figcaption>
              <img
                src={original.dataUri}
                alt={t('tools.items.image-compressor.original')}
                className="max-h-[50vh] w-full object-contain"
              />
            </figure>

            <figure className="overflow-hidden rounded-lg border border-line bg-surface">
              <figcaption className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1.5 text-xs text-fg2">
                <span>
                  {t('tools.items.image-compressor.compressed')}{' '}
                  {result && (
                    <span className={reduction >= 0 ? 'text-success' : 'text-danger'}>
                      ({reduction >= 0 ? '−' : '+'}
                      {Math.abs(reduction)}%)
                    </span>
                  )}
                </span>
                <span>
                  {result ? `${result.width}×${result.height} · ${formatBytes(result.size)}` : '…'}
                </span>
              </figcaption>
              {result && (
                <img
                  src={result.url}
                  alt={t('tools.items.image-compressor.compressed')}
                  className="max-h-[50vh] w-full object-contain"
                />
              )}
            </figure>
          </div>

          {result && (
            <div>
              <Button
                variant="primary"
                onClick={() => downloadBlob(result.blob, `${original.name}.${ext}`)}
              >
                {t('tools.items.image-compressor.download', {
                  type: ext.toUpperCase(),
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
