import { cn, Icon } from '@crewhall/ui';
import { useState, type ReactNode } from 'react';
import { useExit } from '@/lib/motion';

/**
 * Children of an opened tree row (Drive folders, pages): they grow in and fold away instead of
 * popping. Reduced motion shows and hides them at once (useExit and the global CSS rule).
 */
export function TreeReveal({ open, children }: { open: boolean; children: ReactNode }) {
  const { mounted, state } = useExit(open, 140);
  // Open from the first paint (a remounted sidebar, a restored path): it is already there, so it
  // does not grow in. Only opening it later animates.
  const [settled, setSettled] = useState(open);
  if (settled && !open) setSettled(false);
  if (!mounted) return null;
  return (
    <div data-state={settled ? 'static' : state} className="tree-reveal">
      {children}
    </div>
  );
}

/** The expand chevron: one arrow that turns, rather than two icons swapping. */
export function TreeChevron({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <Icon
      name="chevR"
      size={size}
      className={cn(
        'transition-transform duration-(--t-base) ease-(--ease-out-std)',
        open && 'rotate-90',
      )}
    />
  );
}
