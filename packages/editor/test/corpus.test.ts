import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc } from '../src';
import { findCorpus, markdownFiles } from './helpers/corpus';

const corpus = findCorpus();

describe.skipIf(!corpus)('Docusaurus corpus', () => {
  it('parses every file and survives a markdown round trip unchanged', () => {
    const files = markdownFiles(corpus!);
    expect(files.length).toBeGreaterThan(100);
    const unstable: string[] = [];
    for (const file of files) {
      const first = markdownToDoc(fs.readFileSync(file, 'utf8'));
      const second = markdownToDoc(docToMarkdown(first.doc));
      if (JSON.stringify(second.doc) !== JSON.stringify(first.doc)) {
        unstable.push(path.relative(corpus!, file));
      }
    }
    expect(unstable).toEqual([]);
  }, 120_000);
});
