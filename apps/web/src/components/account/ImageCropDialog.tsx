import { IMAGE_UPLOAD_MAX_BYTES } from '@crewhall/shared';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader } from '@crewhall/ui';
import { useRef, useState, type PointerEvent } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Image types the server accepts (H5); SVG is never sent. */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/avif';

export interface PickedImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** Reads a picked file; null with an error key when it is too big or not an image. */
export async function readImage(
  file: File,
): Promise<{ image: PickedImage } | { error: 'errors.image_too_large' | 'errors.image_invalid' }> {
  if (file.size > IMAGE_UPLOAD_MAX_BYTES) return { error: 'errors.image_too_large' };
  if (!IMAGE_ACCEPT.split(',').includes(file.type)) return { error: 'errors.image_invalid' };
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const size = await new Promise<{ width: number; height: number } | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
  if (!size) return { error: 'errors.image_invalid' };
  return { image: { dataUrl, ...size } };
}

export interface SquareCrop {
  x: number;
  y: number;
  size: number;
}

const BOX = 280;

/**
 * Square crop for a profile photo (H5): drag to move, the slider zooms. The result is a square
 * in the original image's pixels; the server cuts and resizes it.
 */
export function ImageCropDialog({
  image,
  saving,
  onCancel,
  onSave,
}: {
  image: PickedImage | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (crop: SquareCrop) => void;
}) {
  return (
    <Dialog open={image !== null} onOpenChange={(v) => (v ? null : onCancel())}>
      {image ? (
        <CropBody image={image} saving={saving} onCancel={onCancel} onSave={onSave} />
      ) : null}
    </Dialog>
  );
}

function CropBody({
  image,
  saving,
  onCancel,
  onSave,
}: {
  image: PickedImage;
  saving: boolean;
  onCancel: () => void;
  onSave: (crop: SquareCrop) => void;
}) {
  const { t } = useI18n();
  const short = Math.min(image.width, image.height);
  const [zoom, setZoom] = useState(1);
  const size = Math.round(short / zoom);
  const [raw, setPos] = useState({
    x: Math.round((image.width - short) / 2),
    y: Math.round((image.height - short) / 2),
  });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // Keep the square inside the image.
  const clamp = (p: { x: number; y: number }, s = size) => ({
    x: Math.min(Math.max(0, Math.round(p.x)), image.width - s),
    y: Math.min(Math.max(0, Math.round(p.y)), image.height - s),
  });
  // Clamped while rendering: zooming out never leaves the square outside the image.
  const pos = clamp(raw);

  // The visible square is the box; the image is scaled so `size` px fill it.
  const scale = BOX / size;
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setPos(clamp({ x: d.x - (e.clientX - d.px) / scale, y: d.y - (e.clientY - d.py) / scale }));
  };

  return (
    <DialogContent width={360}>
      <DialogHeader
        title={t('account.profile.cropTitle')}
        description={t('account.profile.cropHint')}
      />
      <div className="flex flex-col items-center gap-4 py-2">
        <div
          className="relative cursor-grab touch-none overflow-hidden rounded-full shadow-line2 active:cursor-grabbing"
          style={{ width: BOX, height: BOX }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          role="img"
          aria-label={t('account.profile.cropTitle')}
        >
          <img
            src={image.dataUrl}
            alt=""
            draggable={false}
            className="pointer-events-none absolute max-w-none select-none"
            style={{
              width: image.width * scale,
              height: image.height * scale,
              left: -pos.x * scale,
              top: -pos.y * scale,
            }}
          />
        </div>
        <label className="flex w-full items-center gap-3 text-xs text-fg2">
          {t('account.profile.zoom')}
          <input
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-[var(--accent)]"
          />
        </label>
      </div>
      <DialogFooter>
        <Button onClick={onCancel}>{t('common.actions.cancel')}</Button>
        <Button variant="inv" loading={saving} onClick={() => onSave({ ...pos, size })}>
          {t('common.actions.save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
