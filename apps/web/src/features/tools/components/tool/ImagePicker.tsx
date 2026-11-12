// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/ImagePicker.tsx. See THIRD_PARTY.md.
import { useI18n } from '@/lib/i18n/I18nContext';
import { useRef, useState } from 'react';
import { cn } from '@/features/tools/components/ui/cn';

/**
 * Drag-and-drop / click-to-select image picker. Reads the file locally (no
 * upload) and hands the File to the caller.
 */
export function ImagePicker({
  onFile,
  accept = 'image/*',
  label,
}: {
  onFile: (file: File) => void;
  accept?: string;
  label?: string;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors',
        dragging ? 'border-accent bg-accent10' : 'border-line-strong bg-surface hover:bg-bg2',
      )}
    >
      <span className="text-2xl text-fg3" aria-hidden>
        ⇪
      </span>
      <span className="text-sm text-fg2">{label ?? t('tools.common.dropImage')}</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
