import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Icon } from '../icons/Icon';
import { DatePicker } from './date-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './form';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SuggestionPanel,
  toast,
  Toaster,
} from './overlay';

/**
 * jsdom has no layout, so these tests give the trigger a rectangle, the panel a size and the
 * window a viewport, then check where Floating UI (via Radix) puts the panel: doc 02 ·
 * "Açılır paneller" (bottom, top, right edge, inside a scrolled card).
 */

const viewport = { w: 1024, h: 768 };
const panel = { w: 240, h: 300 };

function stubLayout() {
  const html = document.documentElement;
  const props: [object, string, () => number][] = [
    [html, 'clientWidth', () => viewport.w],
    [html, 'clientHeight', () => viewport.h],
    [window, 'innerWidth', () => viewport.w],
    [window, 'innerHeight', () => viewport.h],
  ];
  for (const [target, key, get] of props) {
    Object.defineProperty(target, key, { configurable: true, get });
  }
  for (const key of ['offsetWidth', 'offsetHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.hasAttribute('data-radix-popper-content-wrapper')) return 0;
        return key === 'offsetWidth' ? panel.w : panel.h;
      },
    });
  }
}

function unstubLayout() {
  const html = document.documentElement;
  for (const key of ['clientWidth', 'clientHeight']) Reflect.deleteProperty(html, key);
  for (const key of ['innerWidth', 'innerHeight']) Reflect.deleteProperty(window, key);
  for (const key of ['offsetWidth', 'offsetHeight']) {
    Reflect.deleteProperty(HTMLElement.prototype, key);
  }
}

function placeAt(el: Element, r: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () =>
    ({
      ...r,
      x: r.left,
      y: r.top,
      right: r.left + r.width,
      bottom: r.top + r.height,
      toJSON: () => r,
    }) as DOMRect;
}

interface Case {
  name: string;
  ui: (wrap: (n: ReactNode) => ReactNode) => ReactNode;
  /** The element the panel lines up with. */
  anchor: () => Element;
  open: () => Promise<void>;
}

/** A field with suggestions under it (or above it with `side="top"`), opened by typing. */
function SuggestHarness({ side }: { side?: 'top' | 'bottom' }) {
  const [q, setQ] = useState('');
  return (
    <SuggestionPanel
      open={q.length > 0}
      onDismiss={() => setQ('')}
      side={side}
      anchor={
        <div data-testid="field">
          <input aria-label="Kişi" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      }
    >
      <button type="button">Zeynep</button>
    </SuggestionPanel>
  );
}

/** An editor menu that lines up with a caret box instead of a field. */
function CaretHarness() {
  const [open, setOpen] = useState(false);
  const caret = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span data-testid="caret" ref={caret} />
      <button type="button" onClick={() => setOpen(true)}>
        @
      </button>
      <SuggestionPanel
        open={open}
        onDismiss={() => setOpen(false)}
        anchorRect={() => caret.current?.getBoundingClientRect() ?? null}
        className="w-[240px]"
      >
        <button type="button">Zeynep</button>
      </SuggestionPanel>
    </>
  );
}

function PickerHarness() {
  const [v, setV] = useState<string | null>(null);
  return <DatePicker aria-label="Tarih" value={v} onChange={setV} today="2026-10-18" />;
}

const CASES: Case[] = [
  {
    name: 'Popover',
    ui: (wrap) => (
      <Popover>
        {wrap(<PopoverTrigger>Aç</PopoverTrigger>)}
        <PopoverContent>Panel</PopoverContent>
      </Popover>
    ),
    anchor: () => screen.getByRole('button', { name: 'Aç' }),
    open: () => userEvent.click(screen.getByRole('button', { name: 'Aç' })),
  },
  {
    name: 'Select',
    ui: (wrap) => (
      <Select>
        {wrap(
          <SelectTrigger aria-label="Seç">
            <SelectValue placeholder="Seç" />
          </SelectTrigger>,
        )}
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
          <SelectItem value="b">B</SelectItem>
        </SelectContent>
      </Select>
    ),
    anchor: () => screen.getByRole('combobox', { name: 'Seç' }),
    open: async () => {
      screen.getByRole('combobox', { name: 'Seç' }).focus();
      await userEvent.keyboard('{Enter}');
    },
  },
  {
    name: 'Menu',
    ui: (wrap) => (
      <Menu>
        {wrap(<MenuTrigger>Menü</MenuTrigger>)}
        <MenuContent align="start">
          <MenuItem>Bir</MenuItem>
        </MenuContent>
      </Menu>
    ),
    anchor: () => screen.getByRole('button', { name: 'Menü' }),
    open: async () => {
      screen.getByRole('button', { name: 'Menü' }).focus();
      await userEvent.keyboard('{Enter}');
    },
  },
  {
    name: 'DatePicker',
    ui: (wrap) => wrap(<PickerHarness />),
    // The whole field box, not only the button inside it.
    anchor: () => screen.getByRole('button', { name: 'Tarih' }).parentElement!,
    open: () => userEvent.click(screen.getByRole('button', { name: 'Tarih' })),
  },
  {
    name: 'SuggestionPanel',
    ui: (wrap) => wrap(<SuggestHarness />),
    anchor: () => screen.getByTestId('field'),
    open: () => userEvent.type(screen.getByRole('textbox', { name: 'Kişi' }), 'Z'),
  },
  {
    // Chat composer: prefers the space above, flips below when there is none.
    name: 'SuggestionPanel side="top"',
    ui: (wrap) => wrap(<SuggestHarness side="top" />),
    anchor: () => screen.getByTestId('field'),
    open: () => userEvent.type(screen.getByRole('textbox', { name: 'Kişi' }), 'Z'),
  },
  {
    name: 'SuggestionPanel at a caret',
    ui: (wrap) => wrap(<CaretHarness />),
    anchor: () => screen.getByTestId('caret'),
    open: () => userEvent.click(screen.getByRole('button', { name: '@' })),
  },
];

function wrapper(): HTMLElement {
  const el = document.querySelector('[data-radix-popper-content-wrapper]');
  if (!(el instanceof HTMLElement)) throw new Error('panel not open');
  return el;
}

async function placed(): Promise<{ x: number; y: number; side: string; available: number }> {
  let out = { x: 0, y: 0, side: '', available: 0 };
  await waitFor(() => {
    const w = wrapper();
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(w.style.transform);
    expect(m).not.toBeNull();
    const side = w.firstElementChild?.getAttribute('data-side') ?? '';
    out = {
      x: Number(m![1]),
      y: Number(m![2]),
      side,
      available: parseFloat(w.style.getPropertyValue('--radix-popper-available-height')),
    };
    expect(out.y).toBeGreaterThan(-100);
  });
  return out;
}

describe.each(CASES)('$name panel', ({ ui, anchor, open }) => {
  beforeEach(() => {
    viewport.w = 1024;
    viewport.h = 768;
    panel.w = 240;
    panel.h = 300;
    stubLayout();
  });
  afterEach(unstubLayout);

  it('opens upward at the bottom of the screen', async () => {
    render(<>{ui((n) => n)}</>);
    placeAt(anchor(), { left: 100, top: 720, width: 200, height: 44 });
    await open();
    const p = await placed();
    expect(p.side).toBe('top');
    expect(p.y + panel.h).toBeLessThanOrEqual(720);
    expect(p.y).toBeGreaterThanOrEqual(8);
  });

  it('opens downward at the top and fits the height left', async () => {
    render(<>{ui((n) => n)}</>);
    placeAt(anchor(), { left: 100, top: 20, width: 200, height: 44 });
    await open();
    const p = await placed();
    expect(p.side).toBe('bottom');
    expect(p.y).toBeGreaterThanOrEqual(64);
    // max-height follows the space below the trigger, minus the 8 px collision padding.
    expect(p.available).toBeLessThanOrEqual(768 - 64 - 8);
    expect(p.available).toBeGreaterThan(600);
  });

  it('shifts inside at the right edge', async () => {
    render(<>{ui((n) => n)}</>);
    placeAt(anchor(), { left: 960, top: 200, width: 56, height: 36 });
    await open();
    const p = await placed();
    expect(p.x + panel.w).toBeLessThanOrEqual(viewport.w - 8);
    expect(p.x).toBeGreaterThanOrEqual(8);
  });

  it('escapes a scrolled card through the portal and keeps the page height', async () => {
    const before = document.documentElement.scrollHeight;
    render(
      <div data-testid="card" style={{ overflow: 'auto', height: 120 }}>
        <div style={{ height: 600 }}>{ui((n) => n)}</div>
      </div>,
    );
    const card = screen.getByTestId('card');
    card.scrollTop = 400;
    // Near the bottom of the window although the card is scrolled.
    placeAt(anchor(), { left: 300, top: 640, width: 200, height: 44 });
    await open();
    const p = await placed();
    const w = wrapper();
    expect(card.contains(w)).toBe(false);
    expect(w.parentElement).toBe(document.body);
    // Fixed positioning: the panel never adds to the document's scroll height.
    expect(w.style.position).toBe('fixed');
    expect(document.documentElement.scrollHeight).toBe(before);
    expect(p.side).toBe('top');
    expect(p.y).toBeGreaterThanOrEqual(8);
  });

  it('shrinks to the larger side when neither fits', async () => {
    viewport.h = 420;
    render(<>{ui((n) => n)}</>);
    placeAt(anchor(), { left: 100, top: 150, width: 200, height: 44 });
    await open();
    const p = await placed();
    // 420 - 194 - 6 offset - 8 padding below vs 150 - 6 - 8 above: bottom wins, and the
    // panel's max-height becomes that space so its content scrolls inside.
    expect(p.side).toBe('bottom');
    expect(p.available).toBeLessThanOrEqual(420 - 194 - 8);
    expect(p.available).toBeLessThan(panel.h);
  });
});

describe('SuggestionPanel', () => {
  it('keeps focus in the field, stays open on clicks in it and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<SuggestHarness />);
    const field = screen.getByRole('textbox', { name: 'Kişi' });
    await user.type(field, 'Ze');
    expect(await screen.findByRole('button', { name: 'Zeynep' })).toBeInTheDocument();
    expect(field).toHaveFocus();
    await user.click(field);
    expect(screen.getByRole('button', { name: 'Zeynep' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Zeynep' })).toBeNull());
    expect(field).toHaveFocus();
  });

  it('closes on a click outside', async () => {
    const user = userEvent.setup();
    render(
      <>
        <SuggestHarness />
        <p>Dışarısı</p>
      </>,
    );
    await user.type(screen.getByRole('textbox', { name: 'Kişi' }), 'Z');
    await screen.findByRole('button', { name: 'Zeynep' });
    await user.click(screen.getByText('Dışarısı'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Zeynep' })).toBeNull());
  });
});

describe('SelectItem with the check at the start (device lists, H12)', () => {
  it('keeps a check column on every row, the name on the same line, truncated with a title', async () => {
    const long = 'Mikrofon (Realtek(R) Audio) — çok uzun bir cihaz adı, tek satıra sığmaz';
    render(
      <Select defaultValue="b">
        <SelectTrigger aria-label="Mikrofon">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a" check="start" title="Varsayılan">
            Varsayılan
          </SelectItem>
          <SelectItem value="b" check="start" title={long}>
            {long}
          </SelectItem>
        </SelectContent>
      </Select>,
    );
    screen.getByRole('combobox', { name: 'Mikrofon' }).focus();
    await userEvent.keyboard('{Enter}');
    const rows = await screen.findAllByRole('option');
    for (const row of rows) {
      const [column, text] = [...row.children] as HTMLElement[];
      // Same row: a fixed column first, then the name that ends with an ellipsis.
      expect(column!.className).toContain('w-3.5');
      expect(text!.className).toContain('truncate');
    }
    const selected = rows[1]!;
    expect(selected).toHaveAttribute('title', long);
    expect(selected.children[0]!.querySelector('svg')).not.toBeNull();
    expect(rows[0]!.children[0]!.querySelector('svg')).toBeNull();
  });
});

describe('menu items', () => {
  it('keep the icon on the text line, as a prop or as a child', async () => {
    const user = userEvent.setup();
    render(
      <Menu>
        <MenuTrigger>open</MenuTrigger>
        <MenuContent>
          <MenuItem icon="link">Linki kopyala</MenuItem>
          <MenuItem danger>
            <Icon name="trash" size={16} />
            Sil
          </MenuItem>
        </MenuContent>
      </Menu>,
    );
    await user.click(screen.getByText('open'));
    for (const name of ['Linki kopyala', 'Sil']) {
      const item = await screen.findByRole('menuitem', { name });
      const text = item.querySelector('span.truncate')!;
      const svg = item.querySelector('svg')!;
      // The svg is a block: inside the text span it would sit on its own line.
      expect(text).toHaveTextContent(name);
      expect(text.contains(svg)).toBe(false);
      expect(svg.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // A danger item's icon takes the danger colour too.
    const del = screen.getByRole('menuitem', { name: 'Sil' });
    expect(del.querySelector('svg')!.closest('.text-danger')).not.toBeNull();
  });
});

describe('Toaster', () => {
  it('closes a toast on a click, and its action still runs on its own', async () => {
    // sonner captures the pointer for its swipe, which jsdom does not have.
    Element.prototype.setPointerCapture ??= () => undefined;
    const user = userEvent.setup();
    let acted = 0;
    render(<Toaster />);
    toast('Birinci');
    expect(await screen.findByText('Birinci')).toBeInTheDocument();
    await user.click(screen.getByText('Birinci'));
    await waitFor(() => expect(screen.queryByText('Birinci')).toBeNull());

    toast('Ikinci', { action: { label: 'Geri al', onClick: () => acted++ } });
    await user.click(await screen.findByRole('button', { name: 'Geri al' }));
    expect(acted).toBe(1);
  });
});
