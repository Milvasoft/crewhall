import sharp from 'sharp';

export interface PreviewOutput {
  kind: 'thumb_256' | 'thumb_1024' | 'pdf_p1';
  data: Buffer;
  width: number;
  height: number;
}

async function webp(input: Buffer, box: number) {
  const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: 100_000_000 })
    .rotate()
    .resize({ width: box, height: box, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** First PDF page as a PNG, rendered with pdf.js on @napi-rs/canvas (both permissive licences). */
async function pdfFirstPage(input: Buffer): Promise<Buffer> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const task = pdfjs.getDocument({
    data: new Uint8Array(input),
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1600 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvas: canvas as never,
      canvasContext: ctx as never,
      viewport,
    }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    await task.destroy();
  }
}

export async function renderPreviews(
  input: Buffer,
  kind: 'image' | 'pdf',
): Promise<PreviewOutput[]> {
  const source = kind === 'pdf' ? await pdfFirstPage(input) : input;
  const out: PreviewOutput[] = [];
  const small = await webp(source, 256);
  out.push({ kind: 'thumb_256', ...small });
  const large = await webp(source, 1024);
  out.push({ kind: 'thumb_1024', ...large });
  if (kind === 'pdf') {
    const page = await webp(source, 1600);
    out.push({ kind: 'pdf_p1', ...page });
  }
  return out;
}
