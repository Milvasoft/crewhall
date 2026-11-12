// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/ui/CopyRichButton.tsx. See THIRD_PARTY.md.
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { Button, type ButtonProps } from './Button';

interface CopyRichButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  /** Rendered HTML to place on the clipboard as rich text. */
  html: string;
  /** Plain-text fallback (e.g. the Markdown source). */
  plain: string;
  label?: string;
}

/**
 * Copies formatted content to the clipboard as BOTH `text/html` and
 * `text/plain`. Pasting into rich editors (Notion, Google Docs, Word, email)
 * keeps the formatting; pasting into a plain field yields the fallback text.
 */
export function CopyRichButton({ html, plain, label, ...props }: CopyRichButtonProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const item = new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([item]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button onClick={copy} disabled={!html} {...props}>
      {copied ? t('tools.common.copied') : (label ?? t('tools.common.copy'))}
    </Button>
  );
}
