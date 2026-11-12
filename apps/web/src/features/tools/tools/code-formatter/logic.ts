// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/code-formatter/logic.ts. See THIRD_PARTY.md.
import type { EditorLanguage } from '@/features/tools/components/tool/editor/cmLanguages';

export type FormatterLang =
  'javascript' | 'typescript' | 'json' | 'css' | 'scss' | 'less' | 'html' | 'markdown' | 'yaml';

interface LangInfo {
  label: string;
  parser: string;
  editor: EditorLanguage;
}

export const FORMATTER_LANGS: Record<FormatterLang, LangInfo> = {
  javascript: { label: 'JavaScript', parser: 'babel', editor: 'text' },
  typescript: { label: 'TypeScript', parser: 'typescript', editor: 'text' },
  json: { label: 'JSON', parser: 'json', editor: 'json' },
  css: { label: 'CSS', parser: 'css', editor: 'text' },
  scss: { label: 'SCSS', parser: 'scss', editor: 'text' },
  less: { label: 'LESS', parser: 'less', editor: 'text' },
  html: { label: 'HTML', parser: 'html', editor: 'xml' },
  markdown: { label: 'Markdown', parser: 'markdown', editor: 'markdown' },
  yaml: { label: 'YAML', parser: 'yaml', editor: 'yaml' },
};

/**
 * Format source with Prettier standalone. Plugins are dynamically imported so
 * each is only downloaded when actually used (keeps the tool chunk lean).
 */
export async function formatCode(code: string, lang: FormatterLang): Promise<string> {
  const { parser } = FORMATTER_LANGS[lang];
  const prettier = await import('prettier/standalone');

  const plugins: unknown[] = [];
  if (parser === 'babel' || parser === 'json') {
    plugins.push((await import('prettier/plugins/babel')).default);
    plugins.push((await import('prettier/plugins/estree')).default);
  } else if (parser === 'typescript') {
    plugins.push((await import('prettier/plugins/typescript')).default);
    plugins.push((await import('prettier/plugins/estree')).default);
  } else if (parser === 'css' || parser === 'scss' || parser === 'less') {
    plugins.push((await import('prettier/plugins/postcss')).default);
  } else if (parser === 'html') {
    plugins.push((await import('prettier/plugins/html')).default);
  } else if (parser === 'markdown') {
    plugins.push((await import('prettier/plugins/markdown')).default);
  } else if (parser === 'yaml') {
    plugins.push((await import('prettier/plugins/yaml')).default);
  }

  return prettier.format(code, {
    parser,
    plugins: plugins as never,
  });
}
