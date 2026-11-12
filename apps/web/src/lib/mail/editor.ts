import { type RichEditorHandle } from '@crewhall/editor/react';
import { type RefObject } from 'react';

type Editor = ReturnType<RichEditorHandle['getEditor']>;

/**
 * Runs `fn` once the editor exists and finished creating (its view is mounted); HTML set
 * before that is lost. Inside a dialog the editor mounts a frame after the dialog (portal), so
 * this waits for the ref too. Returns a cleanup for effects.
 */
export function whenEditorReady(
  ref: RefObject<RichEditorHandle | null>,
  fn: (ed: Editor) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tries = 0;
  let detach = () => undefined as void;
  const attempt = () => {
    const ed = ref.current?.getEditor();
    if (!ed) {
      if (tries++ < 100) timer = setTimeout(attempt, 20);
      return;
    }
    if (ed.isInitialized) {
      fn(ed);
      return;
    }
    const run = () => fn(ed);
    ed.on('create', run);
    detach = () => {
      ed.off('create', run);
    };
  };
  attempt();
  return () => {
    clearTimeout(timer);
    detach();
  };
}
