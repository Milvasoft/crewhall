import styles from '@/components/home/sections/Trace.module.css';

/**
 * A circuit trace (orthogonal and 45° segments, like the hero's circuit image) that draws itself
 * as the `--trace` custom property of an ancestor goes 0 → 1. Decorative.
 */
export function Trace({ d }: { d: string }) {
  return (
    <svg
      className={styles.trace}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className={styles.base} d={d} pathLength={1} vectorEffect="non-scaling-stroke" />
      <path className={styles.live} d={d} pathLength={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
