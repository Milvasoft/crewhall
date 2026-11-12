import { Fragment, type CSSProperties } from 'react';
import styles from '@/components/home/Home.module.css';

/**
 * Text split for motion. The words stay real text in the markup (headings remain headings,
 * copy and search work), and they are fully visible until the scroll engine sets the group's
 * custom property: `--reveal` slides words up out of their masks, `--ink` fills them in.
 */

const words = (text: string) => text.split(/\s+/).filter(Boolean);

const indexed = (i: number, n: number) => ({ '--i': i, '--n': n }) as CSSProperties;

/** Words that rise out of a mask one after another as `--reveal` goes 0 → 1. */
export function RevealWords({ text }: { text: string }) {
  const list = words(text);
  return (
    <>
      {list.map((word, i) => (
        <Fragment key={i}>
          <span className={styles.mask}>
            <span className={styles.revealWord} style={indexed(i, list.length)}>
              {word}
            </span>
          </span>
          {i < list.length - 1 && ' '}
        </Fragment>
      ))}
    </>
  );
}

/** Words that fill in from dim to full colour, in reading order, as `--ink` goes 0 → 1. */
export function InkWords({ text }: { text: string }) {
  const list = words(text);
  return (
    <>
      {list.map((word, i) => (
        <Fragment key={i}>
          <span className={styles.inkWord} style={indexed(i, list.length)}>
            {word}
          </span>
          {i < list.length - 1 && ' '}
        </Fragment>
      ))}
    </>
  );
}

/** The hero title's lines (the content separates them with <br />). */
export function splitLines(text: string): string[] {
  return text
    .split(/<br\s*\/?>/i)
    .map((l) => l.trim())
    .filter(Boolean);
}
