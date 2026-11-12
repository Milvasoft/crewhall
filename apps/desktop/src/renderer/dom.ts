type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | ((ev: Event) => void) | undefined>;

/** Tiny element builder: h('button', { class: 'primary', onclick }, 'Kaydet'). Text is never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(key.replace(/^on/, ''), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

export function mount(root: HTMLElement, ...children: Child[]): void {
  root.replaceChildren(...children.filter((c): c is Node | string => !!c));
}
