import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * In the desktop app the window's own minimize, maximize and close buttons sit in the page's top
 * right corner. An X of ours in that row gets people closing the app instead of the panel, so no
 * close control may share it. The sources are read as a syntax tree: a new bar or full-window
 * view that breaks the rule fails here.
 */

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement;

const opening = (el: Jsx) => (ts.isJsxElement(el) ? el.openingElement : el);
const tagName = (el: Jsx) => opening(el).tagName.getText();

function attr(el: Jsx, name: string): string | undefined {
  for (const a of opening(el).attributes.properties) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== name) continue;
    return a.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : '';
  }
  return undefined;
}

const hasSpread = (el: Jsx, name: string) =>
  opening(el).attributes.properties.some(
    (a) => ts.isJsxSpreadAttribute(a) && a.expression.getText() === name,
  );

/** Direct and nested elements of `el`, in source order. */
function descendants(el: Jsx): Jsx[] {
  const found: Jsx[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) found.push(n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(el, visit);
  return found;
}

/**
 * A control whose job is closing: an icon-only X button or a dialog's close part. An X inside a
 * labelled button ("Following Ayşe ×") reads as what it is and stays out of this.
 */
function isCloseControl(el: Jsx): boolean {
  const tag = tagName(el);
  if (attr(el, 'icon') === 'x') return true;
  if (['DialogClose', 'DrawerClose', 'DialogPrimitive.Close'].includes(tag)) return true;
  return (
    tag === 'IconButton' &&
    descendants(el).some((d) => tagName(d) === 'Icon' && attr(d, 'name') === 'x')
  );
}

/** Unprefixed classes only: `max-sm:top-0` is a phone layout. */
function spansTop(el: Jsx): boolean {
  const classes = (attr(el, 'className') ?? '').split(/\s+/);
  return (
    classes.includes('fixed') && ['inset-0', 'inset-y-0', 'top-0'].some((c) => classes.includes(c))
  );
}

/** What breaks the rule in one source file, as readable lines. */
function problems(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const line = (n: ts.Node) => tree.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const titleRow =
        attr(n, 'data-titlebar') !== undefined ||
        hasSpread(n, 'titleBar') ||
        tagName(n) === 'DesktopTitleBarRow';
      const overlay = attr(n, 'data-desktop-overlay');
      const fullHeight = spansTop(n) && attr(n, 'data-desktop-side-panel') === undefined;
      // Only these need their contents looked at; walking every element's subtree takes too long.
      if (titleRow || overlay !== undefined || fullHeight) {
        const inner = descendants(n);
        const closes = inner.filter(isCloseControl);
        if (titleRow && closes.length) {
          out.push(`${file}:${line(closes[0]!)} close control in the window buttons' row`);
        }
        if (fullHeight && closes.length && overlay === undefined) {
          out.push(
            `${file}:${line(n)} full-height view with a close control: mark it for the desktop app`,
          );
        }
        // Starts at the top of the window: the row above its own bar has to be filled.
        if (overlay === '' && !inner.some((d) => attr(d, 'data-desktop-band') !== undefined)) {
          out.push(`${file}:${line(n)} full-window view without a band for the window buttons`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(tree);
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [path] : [];
  });
}

const WEB = join(__dirname, '../src');
const UI = join(__dirname, '../../../packages/ui/src');
const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8');

describe('no close control beside the window buttons', () => {
  it('holds in every screen of the web app and the shared components', () => {
    const files = [...sources(WEB), ...sources(UI)];
    expect(files.length).toBeGreaterThan(300);
    expect(files.flatMap((f) => problems(f, readFileSync(f, 'utf8')))).toEqual([]);
  }, 120_000);

  it('notices the mistakes it is there for', () => {
    const x = '<IconButton aria-label="close"><Icon name="x" /></IconButton>';
    expect(problems('a.tsx', `const a = <header {...titleBar}>${x}</header>;`)).toHaveLength(1);
    expect(problems('b.tsx', `const a = <header data-titlebar="">${x}</header>;`)).toHaveLength(1);
    expect(
      problems('c.tsx', `const a = <aside className="fixed inset-y-0 right-0">${x}</aside>;`),
    ).toHaveLength(1);
    expect(
      problems(
        'd.tsx',
        `const a = <div data-desktop-overlay="" className="fixed inset-0">${x}</div>;`,
      ),
    ).toHaveLength(1);
    // Fine: a labelled chip in the row, a phone-only layout, a view with its band.
    expect(
      problems('e.tsx', '<header {...titleBar}><Button>Ayşe<Icon name="x" /></Button></header>;'),
    ).toEqual([]);
    expect(
      problems('f.tsx', `const a = <aside className="max-sm:fixed max-sm:top-0">${x}</aside>;`),
    ).toEqual([]);
    expect(
      problems(
        'g.tsx',
        `const a = <div data-desktop-overlay="" className="fixed inset-0"><div data-desktop-band="" />${x}</div>;`,
      ),
    ).toEqual([]);
  });

  it('keeps dialogs and sheets under the row', () => {
    const overlay = read(UI, 'components/overlay.tsx');
    expect(overlay).toContain('top-[calc(var(--vv-top,0px)+var(--window-bar,0px)+');
    expect(overlay).toContain('max-h-[calc(var(--vvh,100dvh)-var(--window-bar,0px)-48px)]');
    expect(overlay).toContain('max-md:top-[calc(var(--vv-top,0px)+var(--window-bar,0px))]');
    const styles = read(UI, 'styles.css');
    expect(styles).toContain('--window-bar: env(titlebar-area-height, 0px);');
    expect(styles).toContain(
      'height: max(0px, calc(var(--window-bar) - var(--desktop-strip, 0px)));',
    );
  });

  it('starts side panels under the row and gives full-window views a thin one', () => {
    expect(read(WEB, 'index.css')).toContain(
      "html[data-desktop-titlebar] :is([data-desktop-side-panel], [data-desktop-overlay='below']) {\n" +
        '  top: max(var(--desktop-strip, 0px), var(--window-bar));',
    );
    expect(read(WEB, 'features/drive/Previewer.tsx')).toContain(
      'useLendTitleBarColors(header, true, THIN_TITLE_ROW)',
    );
    expect(read(WEB, 'components/viewer/ViewerHost.tsx')).toContain(
      'useLendTitleBarColors(bar, Boolean(live), THIN_TITLE_ROW)',
    );
  });

  it('keeps the webhook panel under the conversation bar', () => {
    const layout = read(WEB, 'components/chat/ConversationLayout.tsx');
    expect(layout.indexOf('<ConversationHeader')).toBeLessThan(layout.indexOf('<WebhooksPanel'));
    expect(layout.indexOf('<WebhooksPanel')).toBeLessThan(layout.indexOf('</section>'));
  });
});
