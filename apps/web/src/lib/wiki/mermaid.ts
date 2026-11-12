import type MermaidApi from 'mermaid';

let mermaidLoader: Promise<typeof MermaidApi> | null = null;
let mermaidTheme: string | null = null;
let seq = 0;

/**
 * Mermaid source → SVG for the editor's live preview: lazily loaded, `securityLevel: 'strict'`,
 * following the app's light / dark theme.
 */
export async function renderMermaid(code: string): Promise<string> {
  mermaidLoader ??= import('mermaid').then((m) => m.default);
  const mermaid = await mermaidLoader;
  const dark =
    document.documentElement.classList.contains('dark') ||
    document.documentElement.dataset.theme === 'dark';
  const theme = dark ? 'dark' : 'neutral';
  if (mermaidTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
    mermaidTheme = theme;
  }
  seq += 1;
  const { svg } = await mermaid.render(`wk-mermaid-${seq}`, code);
  return svg;
}
