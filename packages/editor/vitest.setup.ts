import '@testing-library/jest-dom/vitest';

// jsdom has no layout. ProseMirror, the suggestion plugin and floating-ui ask for rectangles
// and hit testing; zero-sized answers are enough for the tests.
const emptyRect = (): DOMRect =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }) as DOMRect;
const emptyRects = (): DOMRectList => {
  const list: DOMRect[] = [];
  return Object.assign(list, { item: () => null }) as unknown as DOMRectList;
};

if (typeof window !== 'undefined') {
  Range.prototype.getBoundingClientRect = emptyRect;
  Range.prototype.getClientRects = emptyRects;
  Element.prototype.getClientRects = emptyRects;
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
}
