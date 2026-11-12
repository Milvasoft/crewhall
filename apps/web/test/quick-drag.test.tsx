import { type Card } from '@crewhall/shared';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/** The grid stands in as a recorder: the props it got, and its drag-stop callback. */
const grid = vi.hoisted(() => ({
  layouts: [] as { i: string; x: number; y: number }[][],
  onDragStop: null as
    null | ((l: { i: string; x: number; y: number; w: number; h: number }[]) => void),
}));

vi.mock('react-grid-layout', () => ({
  default: (props: {
    layout: { i: string; x: number; y: number }[];
    onDragStop: typeof grid.onDragStop;
    children: React.ReactNode;
  }) => {
    grid.layouts.push(props.layout.map(({ i, x, y }) => ({ i, x, y })));
    grid.onDragStop = props.onDragStop;
    return <div>{props.children}</div>;
  },
  useContainerWidth: () => ({ width: 1100, containerRef: { current: null }, mounted: true }),
}));
vi.mock('react-grid-layout/css/styles.css', () => ({}));
vi.mock('@/features/quick/cards', () => ({ CardView: () => null }));

const { SurfaceGrid } = await import('@/features/quick/SurfaceGrid');

const card = (id: string, x: number, y: number) =>
  ({ id, type: 'note', layout: { x, y, w: 3, h: 2 }, config: {} }) as unknown as Card;

describe('quick access drag (2.2)', () => {
  it('keeps a dropped card where it was dropped until the saved layout comes back', () => {
    const cards = [card('a', 0, 0), card('b', 3, 0)];
    const onLayout = vi.fn();
    const view = render(
      <SurfaceGrid cards={cards} editable onLayout={onLayout} onDropNew={vi.fn()} />,
    );
    // Drop "a" where "b" was; "b" moves to the left.
    act(() =>
      grid.onDragStop?.([
        { i: 'a', x: 3, y: 0, w: 3, h: 2 },
        { i: 'b', x: 0, y: 0, w: 3, h: 2 },
      ]),
    );
    expect(onLayout).toHaveBeenCalledWith({
      a: { x: 3, y: 0, w: 3, h: 2 },
      b: { x: 0, y: 0, w: 3, h: 2 },
    });
    // The cards prop is still the old one (the cache write lands a tick later), yet the grid
    // is never handed the old slots again.
    expect(grid.layouts.at(-1)).toEqual([
      { i: 'a', x: 3, y: 0 },
      { i: 'b', x: 0, y: 0 },
    ]);
    // The saved cards arrive: they are the source again.
    view.rerender(
      <SurfaceGrid
        cards={[card('a', 3, 0), card('b', 0, 0)]}
        editable
        onLayout={onLayout}
        onDropNew={vi.fn()}
      />,
    );
    expect(grid.layouts.at(-1)).toEqual([
      { i: 'a', x: 3, y: 0 },
      { i: 'b', x: 0, y: 0 },
    ]);
  });
});
