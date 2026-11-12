/**
 * Writes inline styles for the scroll engine: only when a value changes, and remembers what it
 * wrote so a scene can be reset to its stylesheet state (reduced motion, unmount).
 */

export interface Transform {
  /** px */
  x?: number;
  y?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  /** deg */
  rotate?: number;
  skewX?: number;
  skewY?: number;
}

const f = (n: number, digits = 2) => {
  const s = n.toFixed(digits);
  return s === '-0.00' || s === '-0.000' || s === '-0.0000' ? s.slice(1) : s;
};

/**
 * CSS transform string for a pose. A moving pose always starts with translate3d, so the element
 * gets its own compositor layer while it animates; the identity is 'none', so it drops the layer
 * again once it rests.
 */
export function toTransform(t: Transform): string {
  const parts: string[] = [];
  const x = t.x ?? 0;
  const y = t.y ?? 0;
  if (t.rotate && Math.abs(t.rotate) >= 0.005) parts.push(`rotate(${f(t.rotate)}deg)`);
  if (t.skewX && Math.abs(t.skewX) >= 0.005) parts.push(`skewX(${f(t.skewX)}deg)`);
  if (t.skewY && Math.abs(t.skewY) >= 0.005) parts.push(`skewY(${f(t.skewY)}deg)`);
  const s = t.scale ?? 1;
  const sx = (t.scaleX ?? 1) * s;
  const sy = (t.scaleY ?? 1) * s;
  if (Math.abs(sx - 1) >= 0.0005 || Math.abs(sy - 1) >= 0.0005) {
    parts.push(sx === sy ? `scale(${f(sx, 4)})` : `scale(${f(sx, 4)}, ${f(sy, 4)})`);
  }
  const moved = Math.abs(x) >= 0.005 || Math.abs(y) >= 0.005;
  if (!moved && !parts.length) return 'none';
  return [`translate3d(${f(x)}px, ${f(y)}px, 0)`, ...parts].join(' ');
}

type El = HTMLElement | SVGElement | null | undefined;

export class Styler {
  private written = new Map<HTMLElement | SVGElement, Map<string, string>>();

  set(el: El, prop: string, value: string): void {
    if (!el) return;
    let props = this.written.get(el);
    if (!props) {
      props = new Map();
      this.written.set(el, props);
    }
    if (props.get(prop) === value) return;
    props.set(prop, value);
    el.style.setProperty(prop, value);
  }

  transform(el: El, t: Transform): void {
    this.set(el, 'transform', toTransform(t));
  }

  opacity(el: El, value: number): void {
    this.set(el, 'opacity', f(Math.min(1, Math.max(0, value)), 3));
  }

  /** A unitless custom property, e.g. --ink for text fills. */
  variable(el: El, name: string, value: number): void {
    this.set(el, name, f(value, 4));
  }

  /** Stops tracking an element that has left the page. */
  forget(el: El): void {
    if (el) this.written.delete(el);
  }

  /** Puts every element back to its stylesheet state. */
  reset(): void {
    for (const [el, props] of this.written) {
      for (const prop of props.keys()) el.style.removeProperty(prop);
    }
    this.written.clear();
  }
}
