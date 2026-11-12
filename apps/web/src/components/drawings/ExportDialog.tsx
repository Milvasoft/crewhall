import { exportToBlob, exportToSvg } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { type Drawing } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  Field,
  Input,
  Segmented,
  Spinner,
  Switch,
  toast,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { invalidateDrive } from '@/features/drive/api';
import { uploadToFolder } from '@/lib/boards/upload';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';

type Format = 'png' | 'svg';

const slug = (name: string) =>
  name
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'cizim';

/**
 * Export (design 6.13): the preview follows the options. "Sahne verisini göm" puts the
 * scene inside the PNG/SVG so dropping the file back opens an editable drawing; "Drive'a
 * kaydet" adds a file node next to the drawing.
 */
export function ExportDialog({
  open,
  api: excalidraw,
  drawing,
  onClose,
}: {
  open: boolean;
  api: ExcalidrawImperativeAPI | null;
  drawing: Drawing;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [format, setFormat] = useState<Format>('png');
  const [scale, setScale] = useState(2);
  const [background, setBackground] = useState(true);
  const [dark, setDark] = useState(false);
  const [embed, setEmbed] = useState(true);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [name, setName] = useState(slug(drawing.name));
  const [preview, setPreview] = useState<{
    url: string;
    w: number;
    h: number;
    count: number;
  } | null>(null);
  const [busy, setBusy] = useState<null | 'drive' | 'copy'>(null);

  const build = useMemo(
    () => async (fmt: Format) => {
      if (!excalidraw) throw new Error('no editor');
      const appState = excalidraw.getAppState();
      let elements = excalidraw.getSceneElements();
      if (selectedOnly) {
        const ids = appState.selectedElementIds;
        const picked = elements.filter((e) => ids[e.id]);
        if (picked.length) elements = picked;
      }
      const state = {
        ...appState,
        exportBackground: background,
        exportWithDarkMode: dark,
        exportEmbedScene: embed,
        exportScale: scale,
        viewBackgroundColor: appState.viewBackgroundColor,
      };
      const files = excalidraw.getFiles();
      if (fmt === 'svg') {
        const svg = await exportToSvg({ elements, appState: state, files, exportPadding: 16 });
        return {
          blob: new Blob([svg.outerHTML], { type: 'image/svg+xml' }),
          count: elements.length,
        };
      }
      const blob = await exportToBlob({
        elements,
        appState: state,
        files,
        mimeType: 'image/png',
        exportPadding: 16,
        getDimensions: (w: number, h: number) => ({ width: w * scale, height: h * scale, scale }),
      });
      return { blob, count: elements.length };
    },
    [excalidraw, selectedOnly, background, dark, embed, scale],
  );

  useEffect(() => {
    if (!open || !excalidraw) return;
    let alive = true;
    let url: string | null = null;
    const id = setTimeout(async () => {
      try {
        const { blob, count } = await build('png');
        if (!alive) return;
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () =>
          alive && setPreview({ url: url!, w: img.naturalWidth, h: img.naturalHeight, count });
        img.src = url;
      } catch {
        if (alive) setPreview(null);
      }
    }, 150);
    return () => {
      alive = false;
      clearTimeout(id);
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, excalidraw, build]);

  const fileName = `${name || 'cizim'}.${format}`;

  const download = async () => {
    try {
      const { blob } = await build(format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast(t('boards.export.failed'));
    }
  };

  const copy = async () => {
    setBusy('copy');
    try {
      const { blob } = await build('png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(t('boards.export.copied'));
    } catch {
      toast(t('boards.export.failed'));
    } finally {
      setBusy(null);
    }
  };

  const saveToDrive = async () => {
    setBusy('drive');
    try {
      const { blob } = await build(format);
      const node = await uploadToFolder(blob, {
        spaceId: drawing.spaceId,
        folderId: drawing.parentId,
        name: fileName,
      });
      invalidateDrive(qc);
      toast(t('boards.export.savedToDrive', { name: node.name }));
    } catch (e) {
      toast(t(errorKey(e)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={900} className="flex-row gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <DialogHeader title={t('boards.export.title')} />
          <span className="eyebrow">{t('boards.export.preview')}</span>
          <div
            className="flex h-[420px] items-center justify-center overflow-hidden rounded-xl bg-bg2"
            style={
              background
                ? undefined
                : {
                    backgroundImage:
                      'repeating-conic-gradient(var(--line) 0 25%, transparent 0 50%)',
                    backgroundSize: '16px 16px',
                  }
            }
          >
            {preview ? (
              <img
                src={preview.url}
                alt={t('boards.export.preview')}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <Spinner />
            )}
          </div>
          {preview ? (
            <span className="text-xs text-fg3 tn">
              {t('boards.export.meta', {
                width: preview.w,
                height: preview.h,
                count: preview.count,
              })}
            </span>
          ) : null}
        </div>
        <div className="flex w-[300px] shrink-0 flex-col gap-4 pt-12">
          <Field label={t('boards.export.format')}>
            <Segmented
              value={format}
              onValueChange={(v) => setFormat(v as Format)}
              options={[
                { value: 'png', label: t('boards.export.png') },
                { value: 'svg', label: t('boards.export.svg') },
              ]}
            />
          </Field>
          {format === 'png' ? (
            <Field label={t('boards.export.scale')}>
              <Segmented
                value={String(scale)}
                onValueChange={(v) => setScale(Number(v))}
                options={[1, 2, 3].map((n) => ({ value: String(n), label: `${n}×` }))}
              />
            </Field>
          ) : null}
          <Option
            title={t('boards.export.background')}
            hint={t('boards.export.backgroundHint')}
            checked={background}
            onChange={setBackground}
          />
          <Option
            title={t('boards.export.dark')}
            hint={t('boards.export.darkHint')}
            checked={dark}
            onChange={setDark}
          />
          <Option
            title={t('boards.export.embed')}
            hint={t('boards.export.embedHint')}
            checked={embed}
            onChange={setEmbed}
          />
          <Option
            title={t('boards.export.selectedOnly')}
            checked={selectedOnly}
            onChange={setSelectedOnly}
          />
          <Field label={t('boards.export.fileName')}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              trailing={<span className="text-xs text-fg3">.{format}</span>}
            />
          </Field>
          <div className="mt-auto flex flex-wrap gap-2">
            {format === 'png' ? (
              <Button size="sm" variant="out" loading={busy === 'copy'} onClick={() => void copy()}>
                {t('boards.export.copy')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="out"
              loading={busy === 'drive'}
              onClick={() => void saveToDrive()}
            >
              {t('boards.export.saveToDrive')}
            </Button>
            <Button size="sm" variant="pri" onClick={() => void download()}>
              {t('boards.export.download')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Option({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="flex flex-1 flex-col">
        <span className="text-[13.5px] font-semibold text-fg">{title}</span>
        {hint ? <span className="text-xs text-fg3">{hint}</span> : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </label>
  );
}
