// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/markdown-viewer/export.ts. See THIRD_PARTY.md.
/**
 * Export registry for the Markdown tool. New output formats (e.g. PDF) can be
 * added by registering another entry, the toolbar renders whatever is enabled
 * here, so the UI needs no changes.
 */

export type ExportFormat = 'md' | 'html' | 'pdf';

export interface Exporter {
  format: ExportFormat;
  label: string;
  ext: string;
  enabled: boolean;
  /** Produce the file contents. `md` is the source, `html` the rendered body. */
  build: (args: { md: string; html: string; title: string }) => Blob;
}

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; line-height: 1.6; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; }
  pre { background: #f4f4f5; padding: 0.85em 1em; border-radius: 8px; overflow: auto; }
  code { font-family: ui-monospace, monospace; }
  blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 1em; color: #555; }
  table { border-collapse: collapse; } th, td { border: 1px solid #ddd; padding: 0.4em 0.6em; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export const EXPORTERS: Exporter[] = [
  {
    format: 'md',
    label: 'Markdown (.md)',
    ext: 'md',
    enabled: true,
    build: ({ md }) => new Blob([md], { type: 'text/markdown' }),
  },
  {
    format: 'html',
    label: 'HTML (.html)',
    ext: 'html',
    enabled: true,
    build: ({ html, title }) => new Blob([htmlDocument(title, html)], { type: 'text/html' }),
  },
  // PDF is planned; the infrastructure above is ready for it (add an entry that
  // renders `html` to a PDF Blob and set enabled: true).
  {
    format: 'pdf',
    label: 'PDF (.pdf), coming soon',
    ext: 'pdf',
    enabled: false,
    build: ({ html, title }) => new Blob([htmlDocument(title, html)], { type: 'text/html' }),
  },
];

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
