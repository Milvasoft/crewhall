import { act, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { emptyDoc } from '../src';
import { RichEditor, type RichEditorHandle } from '../src/react';
import { uploadAndInsert } from '../src/react/extensions/paste';
import { fakeLabels } from './helpers/labels';

const ID = '0190f0a0-0000-7000-8000-000000000abc';

describe('a dropped file', () => {
  it('becomes a video when it is one, and an embed otherwise', async () => {
    const ref = createRef<RichEditorHandle>();
    render(<RichEditor value={emptyDoc()} labels={fakeLabels} editorRef={ref} />);
    const editor = ref.current!.getEditor();
    const uploadFile = vi.fn(async () => ({ nodeId: ID, nodeType: 'file' }));
    await act(async () => {
      await uploadAndInsert(editor, [new File(['x'], 'tanıtım.mp4', { type: 'video/mp4' })], 1, {
        uploadFile,
      });
      await uploadAndInsert(
        editor,
        [new File(['x'], 'rapor.pdf', { type: 'application/pdf' })],
        1,
        {
          uploadFile,
        },
      );
    });
    await waitFor(() => {
      const types = editor.getJSON().content?.map((n) => n.type);
      expect(types).toContain('video');
      expect(types).toContain('embed');
    });
    const video = editor.getJSON().content?.find((n) => n.type === 'video');
    expect(video?.attrs).toEqual({ src: `node:${ID}`, title: 'tanıtım.mp4' });
  });
});
