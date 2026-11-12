'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  code: string;
  labels: { copy: string; copied: string; aria: string };
}

/** Docusaurus code block copy button. */
export function CopyButton({ code, labels }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const area = document.createElement('textarea');
      area.value = code;
      area.setAttribute('readonly', '');
      area.style.position = 'absolute';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1000);
  };

  return (
    <div className="buttonGroup_M5ko">
      <button
        type="button"
        aria-label={copied ? labels.copied : labels.aria}
        title={copied ? labels.copied : labels.copy}
        className={`clean-btn${copied ? ' copyButtonCopied_Vdqa' : ''}`}
        onClick={copy}
      >
        <span className="copyButtonIcons_IEyt" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="copyButtonIcon_TrPX">
            <path
              fill="currentColor"
              d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z"
            />
          </svg>
          <svg viewBox="0 0 24 24" className="copyButtonSuccessIcon_cVMy">
            <path fill="currentColor" d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" />
          </svg>
        </span>
      </button>
    </div>
  );
}
