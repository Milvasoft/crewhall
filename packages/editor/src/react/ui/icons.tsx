import type { JSX } from 'react';

/** Stroke icons (24×24, currentColor). Paths are simple geometric shapes drawn for this package. */
const paths: Record<string, string> = {
  text: 'M5 6V4h14v2 M12 4v16 M9 20h6',
  h1: 'M4 6v12 M12 6v12 M4 12h8 M17 10l3-2v10',
  h2: 'M4 6v12 M12 6v12 M4 12h8 M16 10a2.5 2.5 0 1 1 4.5 1.5L16 18h5',
  h3: 'M4 6v12 M12 6v12 M4 12h8 M16 8h4l-2.5 4a2.5 2.5 0 1 1-1.5 4.5',
  bulletList: 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01',
  orderedList: 'M10 6h10 M10 12h10 M10 18h10 M4 5l1.5-1v5 M3.5 14.5a1.5 1.5 0 1 1 2.5 1.2L3.5 19H6',
  taskList: 'M3 6l2 2 3-3 M3 15l2 2 3-3 M11 6.5h10 M11 15.5h10',
  quote: 'M5 17c2-1 3-3 3-6V7H4v5h4 M15 17c2-1 3-3 3-6V7h-4v5h4',
  codeBlock: 'M9 8l-4 4 4 4 M15 8l4 4-4 4 M13.5 6l-3 12',
  table: 'M4 5h16v14H4z M4 10h16 M4 15h16 M10 5v14',
  admonition: 'M12 3l9 16H3z M12 10v4 M12 17h.01',
  note: 'M5 4h14v16H5z M9 9h6 M9 13h6 M9 17h3',
  tip: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v6 M12 7.5h.01',
  warning: 'M12 3l9 16H3z M12 10v4 M12 17h.01',
  danger: 'M8 3h8l5 5v8l-5 5H8l-5-5V8z M12 8v5 M12 16h.01',
  tabs: 'M3 8h18v12H3z M3 8V5h7v3 M10 5h6v3',
  mermaid: 'M4 4h6v5H4z M14 15h6v5h-6z M7 9v4a2 2 0 0 0 2 2h5 M17 9h3V4h-6v5h3z',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 2-2 5 5 M15 9.5h.01',
  file: 'M14 3H6v18h12V7z M14 3v4h4',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
  folder: 'M3 6h6l2 2h10v11H3z',
  divider: 'M3 12h18 M8 7h8 M8 17h8',
  truncate: 'M6 6a2.5 2.5 0 1 0 0 .01 M6 18a2.5 2.5 0 1 0 0 .01 M8 7.5L20 18 M8 16.5L20 6',
  html: 'M8 8l-4 4 4 4 M16 8l4 4-4 4',
  toc: 'M4 6h16 M8 12h12 M8 18h12 M4 12h.01 M4 18h.01',
  toggle: 'M5 6l4 3-4 3z M12 9h8 M9 16h11 M9 20h7',
  columns: 'M4 5h7v14H4z M13 5h7v14h-7z',
  math: 'M18 5H6l6 7-6 7h12',
  play: 'M8 5l11 7-11 7z',
  chevron: 'M9 6l6 6-6 6',
  turnInto: 'M4 8h13l-3-3 M20 16H7l3 3',
  embed: 'M14 4h6v6 M20 4l-8 8 M18 14v6H4V6h6',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7z M7 12h7a4 4 0 0 1 0 8H7z',
  italic: 'M10 4h8 M6 20h8 M14 4l-4 16',
  strike:
    'M4 12h16 M16 7a4 3 0 0 0-4-2c-2.5 0-4 1.3-4 3s1.2 2.5 4 3 M8 17a4 3 0 0 0 4 2c2.5 0 4-1.3 4-3',
  code: 'M9 8l-4 4 4 4 M15 8l4 4-4 4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  unlink:
    'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1 M4 4l16 16',
  check: 'M5 12l5 5 9-10',
  close: 'M6 6l12 12 M18 6L6 18',
  plus: 'M12 5v14 M5 12h14',
  pencil: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  rowAdd: 'M4 4h16v8H4z M12 15v6 M9 18h6',
  colAdd: 'M4 4h8v16H4z M15 12h6 M18 9v6',
  rowDelete: 'M4 4h16v8H4z M9 16l6 5 M15 16l-6 5',
  colDelete: 'M4 4h8v16H4z M16 9l5 6 M21 9l-5 6',
  alignLeft: 'M4 6h16 M4 10h10 M4 14h16 M4 18h10',
  alignCenter: 'M4 6h16 M7 10h10 M4 14h16 M7 18h10',
  alignRight: 'M4 6h16 M10 10h10 M4 14h16 M10 18h10',
  copy: 'M8 8h12v12H8z M16 8V4H4v12h4',
  duplicate: 'M8 8h12v12H8z M16 8V4H4v12h4 M14 11v6 M11 14h6',
  arrowUp: 'M12 19V5 M6 11l6-6 6 6',
  arrowDown: 'M12 5v14 M6 13l6 6 6-6',
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16 }: { name: string; size?: number }): JSX.Element {
  const d = paths[name] ?? paths.text;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

/** Six-dot grip for the drag handle. */
export function GripIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      {[3.5, 7, 10.5].flatMap((y) =>
        [4.5, 9.5].map((x) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />
        )),
      )}
    </svg>
  );
}
