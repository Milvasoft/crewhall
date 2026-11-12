import { type PortalMedia } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  Skeleton,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invalidatePortal, mediaQuery } from '@/lib/portal/api';
import { usePortalSite } from '@/lib/portal/context';
import { hubMediaUrl, isImage, uploadPortalFile } from '@/lib/portal/media';

/** Thumbnail of a media path for editors (image) or a file-type label. */
export function MediaThumb({
  media,
  path,
  className,
}: {
  media?: Pick<PortalMedia, 'mime' | 'fileName' | 'path'>;
  path?: string | null;
  className?: string;
}) {
  const { site } = usePortalSite();
  const src = media?.path ?? path ?? null;
  const image = media
    ? isImage(media)
    : Boolean(src && /\.(png|jpe?g|gif|svg|webp|avif)$/i.test(src));
  if (src && image) {
    return (
      <img
        src={hubMediaUrl(site.id, src)}
        alt=""
        className={cn('size-full bg-bg2 object-contain', className)}
        loading="lazy"
      />
    );
  }
  const ext = (media?.fileName ?? src ?? '').split('.').pop()?.toUpperCase() ?? '';
  return (
    <span
      className={cn(
        'flex size-full items-center justify-center bg-bg2 text-xs font-bold text-fg2',
        className,
      )}
    >
      {ext || <Icon name="file" size={20} />}
    </span>
  );
}

/** Picks an image from the site's media (or uploads one) and returns its permanent path. */
export function MediaPicker({
  open,
  onOpenChange,
  onPick,
  folder = 'img',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (path: string) => void;
  folder?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <PickerBody onPick={onPick} onClose={() => onOpenChange(false)} folder={folder} />
      ) : null}
    </Dialog>
  );
}

function PickerBody({
  onPick,
  onClose,
  folder,
}: {
  onPick: (path: string) => void;
  onClose: () => void;
  folder: string;
}) {
  const { t } = useI18n();
  const { site } = usePortalSite();
  const qc = useQueryClient();
  const media = useQuery(mediaQuery(site.id, 'image'));
  const [selected, setSelected] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  return (
    <DialogContent width={680}>
      <DialogHeader icon="image" title={t('portal.media.pickTitle')} />
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setUploading(true);
          try {
            const m = await uploadPortalFile(site.id, file, folder);
            invalidatePortal(qc);
            onPick(m.path);
            onClose();
          } catch (err) {
            toast(t(errorKey(err)));
          } finally {
            setUploading(false);
          }
        }}
      />
      <div className="grid max-h-[420px] grid-cols-4 gap-2.5 overflow-y-auto p-0.5">
        {media.isPending
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-square rounded-xl" />)
          : media.data?.items.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={selected === m.path}
                onClick={() => setSelected(m.path)}
                onDoubleClick={() => {
                  onPick(m.path);
                  onClose();
                }}
                className={cn(
                  'flex flex-col overflow-hidden rounded-xl bg-surface text-left shadow-line',
                  selected === m.path && 'shadow-[inset_0_0_0_2px_var(--fg)]',
                )}
              >
                <span className="aspect-[4/3] w-full overflow-hidden">
                  <MediaThumb media={m} />
                </span>
                <span className="truncate px-2 py-1.5 text-xs font-medium">{m.fileName}</span>
              </button>
            ))}
      </div>
      <DialogFooter className="justify-between">
        <Button variant="out" size="sm" loading={uploading} onClick={() => input.current?.click()}>
          <Icon name="upload" size={16} />
          {t('portal.media.upload')}
        </Button>
        <span className="flex gap-2">
          <Button variant="gh" size="sm" onClick={onClose}>
            {t('portal.common.cancel')}
          </Button>
          <Button
            variant="inv"
            size="sm"
            disabled={!selected}
            onClick={() => {
              if (selected) onPick(selected);
              onClose();
            }}
          >
            {t('portal.media.pick')}
          </Button>
        </span>
      </DialogFooter>
    </DialogContent>
  );
}

/** Image field: thumbnail, path, "Medya'dan seç" and remove. */
export function ImageField({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string | null | undefined;
  onChange: (path: string | null) => void;
  disabled?: boolean;
  label: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-md bg-bg2 p-1.5 pr-2">
      <span className="size-9 shrink-0 overflow-hidden rounded-sm">
        {value ? (
          <MediaThumb path={value} />
        ) : (
          <span className="flex size-full items-center justify-center text-fg3">
            <Icon name="image" size={16} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg2">
        {value ?? t('portal.media.none')}
      </span>
      {!disabled ? (
        <>
          <Button
            size="xs"
            variant="gh"
            onClick={() => setOpen(true)}
            aria-label={`${label}: ${t('portal.media.choose')}`}
          >
            {t('portal.media.choose')}
          </Button>
          {value ? (
            <IconButton
              aria-label={`${label}: ${t('portal.common.remove')}`}
              size="xs"
              tone="plain"
              onClick={() => onChange(null)}
            >
              <Icon name="x" size={14} />
            </IconButton>
          ) : null}
        </>
      ) : null}
      <MediaPicker open={open} onOpenChange={setOpen} onPick={(p) => onChange(p)} />
    </div>
  );
}
