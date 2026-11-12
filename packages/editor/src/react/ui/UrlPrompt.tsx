import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { webUrl } from '../../model';

/**
 * Asks for a web address inside the editor (the desktop app has no `window.prompt`). Enter with a
 * safe address submits it; Escape, or Enter on an empty field, cancels.
 */
export function UrlPrompt({
  placeholder,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  autoFocus: boolean;
  onSubmit: (url: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  return (
    <input
      className="ch-url-input"
      autoFocus={autoFocus}
      inputMode="url"
      dir="ltr"
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      aria-invalid={invalid}
      onChange={(e) => {
        setValue(e.target.value);
        setInvalid(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const url = webUrl(value);
          if (url) onSubmit(url);
          else if (value.trim()) setInvalid(true);
          else onCancel();
        }
      }}
    />
  );
}

const GAP = 6;
const WIDTH = 360;

/** A small floating address field under the caret, e.g. "/" → Image where nothing can be uploaded. */
export function UrlPopup({
  anchor,
  placeholder,
  onSubmit,
  onClose,
}: {
  anchor: DOMRect;
  placeholder: string;
  onSubmit: (url: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  const width = Math.min(WIDTH, window.innerWidth - 16);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={placeholder}
      className="ch-editor-layer ch-url-popup"
      style={{ top: anchor.bottom + GAP, left, width }}
    >
      <UrlPrompt placeholder={placeholder} autoFocus onSubmit={onSubmit} onCancel={onClose} />
    </div>,
    document.body,
  );
}
