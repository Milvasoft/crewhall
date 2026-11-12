// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/ToolErrorBoundary.tsx. See THIRD_PARTY.md.
import { Component, type ReactNode } from 'react';
import { Button } from '@/features/tools/components/ui/Button';
import { useI18n } from '@/lib/i18n/I18nContext';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Isolates a single tool: if it throws during render, we show an inline
 * fallback instead of crashing the whole page. Reset via `key` on the tool id
 * (see ToolRunner) so switching tools clears the error.
 */
export class ToolErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(error);
  }

  override render() {
    if (this.state.error) {
      return (
        <Crashed
          message={this.state.error.message}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

/** The fallback as a function component, so it can read Crewhall's i18n. */
function Crashed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-line bg-surface p-6">
      <p className="text-sm font-semibold text-danger">{t('tools.common.crashed')}</p>
      <p className="mt-1 text-sm text-fg2">{t('tools.common.crashedHint')}</p>
      <pre className="mt-3 max-h-32 overflow-auto rounded bg-bg2 px-3 py-2 font-mono text-xs text-fg2">
        {message}
      </pre>
      <Button className="mt-3" variant="primary" size="sm" onClick={onRetry}>
        {t('tools.common.retry')}
      </Button>
    </div>
  );
}
