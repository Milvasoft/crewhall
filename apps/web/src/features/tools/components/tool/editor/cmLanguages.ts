// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/editor/cmLanguages.ts. See THIRD_PARTY.md.
import type { Extension } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';

/**
 * Supported editor languages. Add a language by installing its
 * `@codemirror/lang-*` package and mapping it here. `text` (and anything
 * unmapped) falls back to no language extension, a plain monospace editor.
 */
export type EditorLanguage = 'text' | 'json' | 'markdown' | 'sql' | 'xml' | 'yaml';

export function languageExtension(language: EditorLanguage | undefined): Extension[] {
  switch (language) {
    case 'json':
      return [json()];
    case 'markdown':
      return [markdown()];
    case 'sql':
      return [sql()];
    case 'xml':
      return [xml()];
    case 'yaml':
      return [yaml()];
    default:
      return [];
  }
}
