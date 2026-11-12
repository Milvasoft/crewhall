# Third-party code: Too Much Tools

The tools under this folder (`tools/`, `lib/`, `components/`) are copied from
[Too Much Tools](https://github.com/Milvasoft/too-much-tools) at commit `8aa4902`
(2026-10-29), under the MIT license below. The two projects live separately: later changes
in Too Much Tools do not reach Crewhall on their own.

Changes made in Crewhall:

- Paths: `@/lib`, `@/components`, `@/tools` became `@/features/tools/…`.
- Tailwind color tokens mapped to Crewhall's (`bg-surface-secondary` → `bg-bg2`, …);
  `"use client"` and Next.js imports removed (React.lazy, TanStack Router).
- Every user-facing text comes from `@crewhall/i18n` (`tools.*`), Turkish and English.
- The shell (home, sidebar, Ctrl K, "Gönder" to chat / page / Drive, "Araçta aç" from
  Drive) is Crewhall's. The per-tool SEO content (`content.ts`) was not copied.
- `ua-parser-js` is pinned to 1.0.x (MIT); 2.x is AGPL-3.0.

Each copied file starts with a one-line note naming its source path.

## License

MIT License

Copyright (c) 2026 Too Much Tools contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
