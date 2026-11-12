import { editorLabelKeys, type EditorLabels } from '../../src/react';

/** Fake labels: every visible string is `L:<key>`, so leaks of untranslated text stand out. */
export const fakeLabels = Object.fromEntries(
  editorLabelKeys.map((k) => [k, `L:${k}`]),
) as unknown as EditorLabels;
