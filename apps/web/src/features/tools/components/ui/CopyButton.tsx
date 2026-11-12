// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/ui/CopyButton.tsx. See THIRD_PARTY.md.
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { Button, type ButtonProps } from './Button';

interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  value: string;
  label?: string;
}

export function CopyButton({ value, label, ...props }: CopyButtonProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button onClick={copy} disabled={!value} {...props}>
      {copied ? t('tools.common.copied') : (label ?? t('tools.common.copy'))}
    </Button>
  );
}
