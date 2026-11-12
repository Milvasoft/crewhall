import { resources } from '@crewhall/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { asFile, asMarkdown, toolsForFile, typeOfFile } from '@/features/tools/crewhall/output';
import { getAllDefinitions } from '@/features/tools/lib/registry';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

// CodeMirror measures text ranges; jsdom has no layout. Only here: a global stub would change
// how other libraries feature-detect ranges in the rest of the suite.
beforeAll(() => {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
});

describe('tools module (Too Much Tools)', () => {
  it('lists categories and finds a tool by its Turkish name', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/tools');
    const user = userEvent.setup();
    const nav = await screen.findByRole('complementary', { name: 'Araçlar' });
    expect(within(nav).getByRole('link', { name: /Kodlama/ })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Araç ara' }), 'base64 kodla');
    const hit = await screen.findByRole('link', { name: /Base64 kodla \/ çöz/ });
    await user.click(hit);
    await waitFor(() => expect(router.state.location.pathname).toBe('/tools/base64'));
    expect(await screen.findByRole('heading', { name: 'Base64 kodla / çöz' })).toBeInTheDocument();
  });

  it('opens a tool lazily with its controls', async () => {
    signedInAs(USER.bugra);
    renderApp('/tools/base64');
    expect(
      await screen.findByRole('button', { name: 'Kodla' }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Çöz' })).toBeInTheDocument();
  });

  it('keeps favorites in the sidebar', async () => {
    signedInAs(USER.bugra);
    renderApp('/tools/base64');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Favorilere ekle' }));
    const nav = screen.getByRole('complementary', { name: 'Araçlar' });
    expect(
      await within(nav).findByRole('link', { name: 'Base64 kodla / çöz' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Favorilerden çıkar' }));
    await waitFor(() =>
      expect(within(nav).queryByRole('link', { name: 'Base64 kodla / çöz' })).toBeNull(),
    );
  });

  it('credits the copied source on the about page, as plain text', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/about');
    const credit = (await screen.findByText('Too Much Tools')).closest('li');
    expect(credit).not.toBeNull();
    expect(within(credit!).getByText('MIT')).toBeInTheDocument();
    expect(within(credit!).queryByRole('link')).toBeNull();
  });

  it('hides the module while it is off', async () => {
    db().org!.settings.modules = { tools: false };
    signedInAs(USER.bugra);
    renderApp('/');
    const rail = await screen.findByRole('navigation', { name: 'Modüller' });
    expect(within(rail).queryByRole('link', { name: 'Araçlar' })).toBeNull();
  });
});

describe('tools texts', () => {
  const items = (locale: 'tr' | 'en') =>
    (
      resources[locale].web as unknown as {
        tools: { items: Record<string, Record<string, unknown>> };
      }
    ).tools.items;

  it('names, describes and keys every registered tool in Turkish and English', () => {
    const missing: string[] = [];
    for (const d of getAllDefinitions()) {
      for (const locale of ['tr', 'en'] as const) {
        const it = items(locale)[d.id];
        for (const k of ['name', 'description', 'keywords']) {
          if (typeof it?.[k] !== 'string') missing.push(`${locale} ${d.id}.${k}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('uses the same keys in both languages', () => {
    const keysOf = (o: unknown, p = ''): string[] =>
      o && typeof o === 'object'
        ? Object.entries(o).flatMap(([k, v]) => keysOf(v, `${p}${k}.`))
        : [p.slice(0, -1)];
    expect(keysOf(items('en')).sort()).toEqual(keysOf(items('tr')).sort());
  });
});

describe('tools output to Crewhall', () => {
  it('fences structured output and keeps text and Markdown as they are', () => {
    expect(asMarkdown('{"a":1}', 'json')).toBe('```json\n{"a":1}\n```');
    expect(asMarkdown('# Başlık', 'markdown')).toBe('# Başlık');
    expect(asMarkdown('düz metin', 'text')).toBe('düz metin');
    // A longer fence when the output itself contains backticks.
    expect(asMarkdown('a ``` b', 'sql').startsWith('````sql\n')).toBe(true);
  });

  it('makes files from text and from image data URLs', async () => {
    const json = asFile('{"a":1}', 'json', 'json-viewer');
    expect(json.name).toBe('json-viewer.json');
    expect(json.blob.type).toBe('application/json;charset=utf-8');
    const png = asFile('data:image/png;base64,iVBORw0KGgo=', 'image', 'qr-generator');
    expect(png.name).toBe('qr-generator.png');
    expect(png.blob.type).toBe('image/png');
    expect(png.blob.size).toBe(8);
  });

  it('offers tools for Drive files by extension, best match first', () => {
    expect(typeOfFile('ayarlar.YML')).toBe('yaml');
    expect(typeOfFile('rapor.pdf')).toBeNull();
    expect(toolsForFile('veri.json')[0]?.id).toBe('json-viewer');
    expect(toolsForFile('liste.csv')[0]?.id).toBe('csv-viewer');
    expect(toolsForFile('foto.png')).toEqual([]);
  });
});
