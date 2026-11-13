import { columnWidth, imageWidth, isImageAlign, webUrl } from '@crewhall/editor';
import { cn } from '@crewhall/ui';
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { diffBlocks, type BlockOp, type PMNode } from '@/lib/wiki/diff';
import { resolveNodeSrc } from '@/lib/wiki/media';
import './wiki.css';

/** Read-only render of stored page JSON (version view, design 5.10). */

/** An image's stored layout (the editor's own rule for it, for this read-only render). */
function imageStyle(attrs: PMNode['attrs']): CSSProperties | undefined {
  const width = imageWidth(attrs?.width);
  const align = isImageAlign(attrs?.align) ? attrs?.align : null;
  if (!width && !align) return undefined;
  return {
    display: 'block',
    ...(width ? { width: `${width}%` } : {}),
    ...(align === 'center'
      ? { marginInline: 'auto' }
      : align === 'right'
        ? { marginLeft: 'auto' }
        : {}),
  };
}

function inline(nodes: PMNode[] | undefined): ReactNode {
  return (nodes ?? []).map((n, i) => {
    if (n.type === 'hardBreak') return <br key={i} />;
    // Raw HTML is shown as text, never rendered.
    if (n.type === 'htmlInline') return <code key={i}>{String(n.attrs?.html ?? '')}</code>;
    if (n.type === 'mathInline') return <code key={i}>{String(n.attrs?.latex ?? '')}</code>;
    if (n.type === 'mention') {
      return (
        <span key={i} className={cn('wk-mention', `wk-mention-${String(n.attrs?.kind ?? 'user')}`)}>
          {n.attrs?.kind === 'date' ? '' : '@'}
          {String(n.attrs?.label ?? '')}
        </span>
      );
    }
    if (n.type === 'image') {
      return (
        <img
          key={i}
          src={resolveNodeSrc(String(n.attrs?.src ?? ''))}
          alt={String(n.attrs?.alt ?? '')}
          style={imageStyle(n.attrs)}
        />
      );
    }
    let el: ReactNode = n.text ?? '';
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') el = <strong>{el}</strong>;
      else if (m.type === 'italic') el = <em>{el}</em>;
      else if (m.type === 'strike') el = <s>{el}</s>;
      else if (m.type === 'code') el = <code>{el}</code>;
      else if (m.type === 'link') {
        el = <a href={resolveNodeSrc(String(m.attrs?.href ?? '#'))}>{el}</a>;
      }
    }
    return <Fragment key={i}>{el}</Fragment>;
  });
}

export function Block({ n, className }: { n: PMNode; className?: string }): ReactNode {
  const kids = (n.content ?? []).map((c, i) => <Block key={i} n={c} />);
  switch (n.type) {
    case 'paragraph':
      return <p className={className}>{inline(n.content)}</p>;
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1)));
      const H = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <H className={className}>{inline(n.content)}</H>;
    }
    case 'blockquote':
      return <blockquote className={className}>{kids}</blockquote>;
    case 'bulletList':
      return <ul className={className}>{kids}</ul>;
    case 'orderedList':
      return <ol className={className}>{kids}</ol>;
    case 'listItem':
      return <li>{kids}</li>;
    case 'taskList':
      return (
        <ul data-type="taskList" className={className}>
          {kids}
        </ul>
      );
    case 'taskItem':
      return (
        <li data-checked={n.attrs?.checked === true}>
          <label>
            <input type="checkbox" checked={n.attrs?.checked === true} readOnly disabled />
          </label>
          <div>{kids}</div>
        </li>
      );
    case 'codeBlock':
    case 'mermaid':
      return (
        <pre className={className}>
          <code>{(n.content ?? []).map((c) => c.text ?? '').join('')}</code>
        </pre>
      );
    case 'horizontalRule':
      return <hr className={className} />;
    case 'table':
      return (
        <div className={cn('tableWrapper', className)}>
          <table className="wk-table">
            <tbody>{kids}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr>{kids}</tr>;
    case 'tableHeader':
      return <th>{kids}</th>;
    case 'tableCell':
      return <td>{kids}</td>;
    case 'admonition':
      return (
        <div
          className={cn('wk-callout', `wk-callout-${String(n.attrs?.type ?? 'note')}`, className)}
        >
          <div className="min-w-0 flex-1">
            {n.attrs?.title ? (
              <div className="wk-callout-title">{String(n.attrs.title)}</div>
            ) : null}
            {kids}
          </div>
        </div>
      );
    case 'toggle':
      return (
        <details open className={className}>
          <summary className="font-semibold">{String(n.attrs?.summary ?? '')}</summary>
          <div className="wk-toggle-body">{kids}</div>
        </details>
      );
    case 'tabs':
      return <div className={cn('wk-tabs', className)}>{kids}</div>;
    case 'tabItem':
      return (
        <section className={className}>
          <div className="wk-callout-title">{String(n.attrs?.label ?? n.attrs?.value ?? '')}</div>
          {kids}
        </section>
      );
    case 'htmlBlock':
      return (
        <pre className={className}>
          <code>{String(n.attrs?.html ?? '')}</code>
        </pre>
      );
    case 'mathBlock':
      return (
        <pre className={className}>
          <code>{String(n.attrs?.latex ?? '')}</code>
        </pre>
      );
    case 'columns':
      return <div className={cn('wk-render-columns', className)}>{kids}</div>;
    case 'column': {
      // A resized column keeps its share (the editor stores all widths of a set or none).
      const width = columnWidth(n.attrs?.width);
      return (
        <div className={className} style={width ? { flexGrow: width } : undefined}>
          {kids}
        </div>
      );
    }
    case 'bookmark':
    case 'video': {
      const target = String((n.type === 'video' ? n.attrs?.src : n.attrs?.url) ?? '');
      const href = target.startsWith('node:') ? resolveNodeSrc(target) : webUrl(target);
      const description = n.type === 'bookmark' ? String(n.attrs?.description ?? '') : '';
      return (
        <p className={className}>
          {href ? <a href={href}>{String(n.attrs?.title ?? '') || target}</a> : target}
          {description ? <span className="wk-render-desc"> — {description}</span> : null}
        </p>
      );
    }
    case 'truncate':
    case 'toc':
      return null;
    case 'embed':
      return (
        <div className={cn('wk-embed-card', className)}>
          <span className="wk-embed-meta">⧉ {String(n.attrs?.nodeType ?? '')}</span>
        </div>
      );
    default:
      return <div className={className}>{kids}</div>;
  }
}

function ModBlock({ op }: { op: Extract<BlockOp, { op: 'mod' }> }) {
  const words = op.words.map((w, i) =>
    w.op === 'same' ? (
      <Fragment key={i}>{w.text}</Fragment>
    ) : (
      <span key={i} className={w.op === 'add' ? 'wk-add' : 'wk-del'}>
        {w.text}
      </span>
    ),
  );
  if (op.after.type === 'heading') {
    const level = Number(op.after.attrs?.level ?? 1);
    const H = (level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3') as 'h1' | 'h2' | 'h3';
    return <H>{words}</H>;
  }
  return <p>{words}</p>;
}

/** A document, or its changes against `previous` when `highlight` is on. */
export function DocRender({
  doc,
  previous,
  highlight,
  className,
}: {
  doc: { content?: PMNode[] };
  previous?: { content?: PMNode[] } | null;
  highlight: boolean;
  className?: string;
}) {
  const blocks = doc.content ?? [];
  if (!highlight || !previous) {
    return (
      <div className={cn('wk-prose wk-render', className)}>
        {blocks.map((b, i) => (
          <Block key={i} n={b} />
        ))}
      </div>
    );
  }
  const ops = diffBlocks(previous.content ?? [], blocks);
  return (
    <div className={cn('wk-prose wk-render', className)}>
      {ops.map((o, i) =>
        o.op === 'mod' ? (
          <ModBlock key={i} op={o} />
        ) : (
          <Block
            key={i}
            n={o.block}
            className={
              o.op === 'add' ? 'wk-block-add' : o.op === 'del' ? 'wk-block-del' : undefined
            }
          />
        ),
      )}
    </div>
  );
}
