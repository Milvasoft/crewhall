// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/base64-image/component.tsx. See THIRD_PARTY.md.
import { useEffect, useMemo, useState } from 'react';
import type { ToolComponentProps } from '@/features/tools/lib/tool-sdk';
import { getDefinition } from '@/features/tools/lib/registry';
import { ToolEditor } from '@/features/tools/components/tool/ToolEditor';
import { ImagePicker } from '@/features/tools/components/tool/ImagePicker';
import { CopyButton } from '@/features/tools/components/ui/CopyButton';
import { SendToMenu } from '@/features/tools/components/tool/SendToMenu';
import { cn } from '@/features/tools/components/ui/cn';
import {
  fileToDataUri,
  formatBytes,
  ImageInputError,
  loadImage,
  parseImageInput,
} from '@/features/tools/lib/image/imageUtils';
import { useI18n } from '@/lib/i18n/I18nContext';

type Mode = 'decode' | 'encode';

export default function Base64ImageTool({ initialInput }: ToolComponentProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('decode');
  const [showInput, setShowInput] = useState(true);
  const [input, setInput] = useState(initialInput ?? '');
  const [encoded, setEncoded] = useState('');
  const [measured, setMeasured] = useState<{ uri: string; w: number; h: number } | null>(null);
  const definition = getDefinition('base64-image')!;

  const decoded = useMemo(() => {
    if (mode !== 'decode' || !input.trim()) return { dataUri: '', error: null as string | null };
    try {
      return { dataUri: parseImageInput(input).dataUri, error: null };
    } catch (e) {
      return {
        dataUri: '',
        error:
          e instanceof ImageInputError
            ? t(`tools.items.base64-image.errors.${e.code}`)
            : t('tools.items.base64-image.errors.invalid'),
      };
    }
  }, [mode, input, t]);

  const currentUri = mode === 'decode' ? decoded.dataUri : encoded;

  // Measure the rendered image. The size is kept with its URI, so a stale
  // measurement is never shown for a newer image.
  const dims = measured && measured.uri === currentUri ? measured : null;
  useEffect(() => {
    if (!currentUri) return;
    let cancelled = false;
    loadImage(currentUri)
      .then(
        (img) =>
          !cancelled && setMeasured({ uri: currentUri, w: img.naturalWidth, h: img.naturalHeight }),
      )
      .catch(() => !cancelled && setMeasured(null));
    return () => {
      cancelled = true;
    };
  }, [currentUri]);

  const onFile = async (file: File) => {
    setEncoded(await fileToDataUri(file));
  };

  const approxBytes = currentUri ? Math.floor((currentUri.split(',')[1]?.length ?? 0) * 0.75) : 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          {(['decode', 'encode'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`h-8 px-3 text-sm font-medium transition-colors ${
                mode === m ? 'bg-accent text-accent-fg' : 'bg-surface text-fg2 hover:bg-bg2'
              }`}
            >
              {t(`tools.items.base64-image.modes.${m}`)}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowInput((v) => !v)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs font-medium text-fg2 transition-colors hover:bg-bg2 hover:text-fg"
        >
          {showInput
            ? t('tools.items.base64-image.hideInput')
            : t('tools.items.base64-image.showInput')}
        </button>
      </div>

      <div
        className={cn('grid grid-cols-1 gap-3', showInput ? 'lg:grid-cols-2' : 'lg:grid-cols-1')}
      >
        {!showInput ? null : mode === 'decode' ? (
          <ToolEditor
            label={t('tools.items.base64-image.inputLabel')}
            value={input}
            onChange={setInput}
            minRows={18}
            placeholder={t('tools.items.base64-image.placeholder')}
            footer={
              decoded.error ? <span className="text-danger">{decoded.error}</span> : undefined
            }
          />
        ) : encoded ? (
          <ToolEditor
            label={t('tools.items.base64-image.encodedLabel')}
            value={encoded}
            readOnly
            minRows={18}
            actions={
              <>
                <CopyButton size="sm" variant="ghost" value={encoded} />
                <SendToMenu source={definition} value={encoded} />
              </>
            }
          />
        ) : (
          <ImagePicker onFile={onFile} />
        )}

        <figure className="flex min-h-[200px] flex-col overflow-hidden rounded-lg border border-line bg-surface">
          <figcaption className="flex items-center justify-between border-b border-line bg-bg2 px-3 py-1.5 text-xs text-fg2">
            <span>{t('tools.items.base64-image.preview')}</span>
            <span>
              {dims ? `${dims.w}×${dims.h}` : ''}{' '}
              {currentUri ? `· ~${formatBytes(approxBytes)}` : ''}
            </span>
          </figcaption>
          <div className="flex flex-1 items-center justify-center p-3">
            {currentUri ? (
              <img
                src={currentUri}
                alt={t('tools.items.base64-image.preview')}
                className="max-h-[50vh] max-w-full object-contain"
              />
            ) : (
              <span className="text-sm text-fg3">
                {mode === 'decode'
                  ? t('tools.items.base64-image.emptyDecode')
                  : t('tools.items.base64-image.emptyEncode')}
              </span>
            )}
          </div>
        </figure>
      </div>
    </div>
  );
}
