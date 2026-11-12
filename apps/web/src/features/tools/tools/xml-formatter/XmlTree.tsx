// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/xml-formatter/XmlTree.tsx. See THIRD_PARTY.md.
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import type { XmlNode } from './logic';

/** Renders a parsed XML tree as collapsible nodes. */
export function XmlTree({ nodes }: { nodes: XmlNode[] }) {
  return (
    <ul className="font-mono text-sm leading-relaxed">
      {nodes.map((node, i) => (
        <TreeNode key={i} node={node} depth={0} />
      ))}
    </ul>
  );
}

function TreeNode({ node, depth }: { node: XmlNode; depth: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(depth < 2);

  if (node.type === 'text') {
    return (
      <li className="pl-4 text-fg">
        <span className="text-fg3">“</span>
        {node.text}
        <span className="text-fg3">”</span>
      </li>
    );
  }

  const attrs = node.attributes;
  const children = node.children;
  // A single text child renders inline (<tag>value</tag>), cleaner than nesting.
  const first = children[0];
  const inlineText = children.length === 1 && first?.type === 'text' ? first.text : null;
  const hasNestedChildren = children.length > 0 && inlineText === null;

  return (
    <li>
      <div className="flex items-start gap-1">
        {hasNestedChildren ? (
          <button
            onClick={() => setOpen((o) => !o)}
            className="mt-0.5 w-4 shrink-0 select-none text-fg3 hover:text-fg"
            aria-label={open ? t('tools.common.collapse') : t('tools.common.expand')}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        <span className="min-w-0">
          <span className="text-fg3">&lt;</span>
          <span className="text-accent-text">{node.name}</span>
          {attrs.map((a) => (
            <span key={a.name}>
              {' '}
              <span className="text-fg2">{a.name}</span>
              <span className="text-fg3">=</span>
              <span className="text-fg">&quot;{a.value}&quot;</span>
            </span>
          ))}
          {inlineText !== null ? (
            <>
              <span className="text-fg3">&gt;</span>
              <span className="text-fg">{inlineText}</span>
              <span className="text-fg3">&lt;/</span>
              <span className="text-accent-text">{node.name}</span>
              <span className="text-fg3">&gt;</span>
            </>
          ) : children.length === 0 ? (
            <span className="text-fg3"> /&gt;</span>
          ) : (
            <span className="text-fg3">&gt;</span>
          )}
        </span>
      </div>

      {hasNestedChildren && open && (
        <ul className="border-l border-line/60 pl-3">
          {children.map((c, i) => (
            <TreeNode key={i} node={c} depth={depth + 1} />
          ))}
          <li className="pl-4 text-fg3">&lt;/{node.name}&gt;</li>
        </ul>
      )}
    </li>
  );
}
