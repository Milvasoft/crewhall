import { type Drawing } from '@crewhall/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { invalidateDrive } from '@/features/drive/api';
import { api } from '@/lib/api';

/**
 * Leaving a new drawing that never got an element: it does not stay in the tree (6.14).
 * The discard waits a tick: StrictMode (and a dependency change) runs the cleanup and the
 * effect again straight away, and that remount cancels it, so only a real leave discards.
 */
export function useDiscardEmpty(
  isNew: boolean,
  drawing: Pick<Drawing, 'id' | 'myRole'>,
  elementCount: () => number,
) {
  const qc = useQueryClient();
  const discardTimer = useRef<number | undefined>(undefined);
  const count = useRef(elementCount);
  useEffect(() => {
    count.current = elementCount;
  });
  useEffect(() => {
    if (!isNew) return;
    window.clearTimeout(discardTimer.current);
    return () => {
      if (count.current() !== 0 || drawing.myRole === 'viewer') return;
      discardTimer.current = window.setTimeout(() => {
        void api
          .call('trashNodes', { body: { nodeIds: [drawing.id] } })
          .then(() => invalidateDrive(qc))
          .catch(() => undefined);
      }, 0);
    };
  }, [isNew, drawing.id, drawing.myRole, qc]);
}
