'use client';

import { useEffect, useId, useRef, useSyncExternalStore } from 'react';

function currentTheme(): 'dark' | 'default' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/**
 * Mermaid diagram (Docusaurus theme-mermaid look). The library is loaded on demand and the
 * diagram re-renders when the colour mode changes. Mermaid runs with securityLevel "strict",
 * which sanitizes its SVG output.
 */
export function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => null);

  useEffect(() => {
    if (!theme) return;
    let cancelled = false;
    void (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
      try {
        const { svg } = await mermaid.render(`${id}-${theme}`, code);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (!cancelled && ref.current) ref.current.textContent = code;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, id, theme]);

  return <div ref={ref} className="docusaurus-mermaid-container container_lyt7" />;
}
