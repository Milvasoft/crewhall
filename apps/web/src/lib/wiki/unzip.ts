/**
 * Reads a ZIP archive in the browser (import packages from Outline and Notion, design 5.15):
 * stored and deflated entries (DecompressionStream), UTF-8 names. A ZIP inside the archive
 * (Notion's "Export-…zip" holds "…-Part-1.zip") is opened too, one level deep.
 */

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

const SIG_END = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Runs bytes through a (de)compression stream and collects the output. */
export async function transformBytes(
  data: Uint8Array,
  transform: ReadableWritablePair<Uint8Array, Uint8Array>,
): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const reader = source.pipeThrough(transform).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const inflateRaw = (data: Uint8Array) =>
  transformBytes(
    data,
    new DecompressionStream('deflate-raw') as ReadableWritablePair<Uint8Array, Uint8Array>,
  );

function endRecord(view: DataView): number {
  // The end record is at most 22 + 65535 (comment) bytes from the end.
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let at = view.byteLength - 22; at >= min; at--) {
    if (view.getUint32(at, true) === SIG_END) return at;
  }
  throw new Error('not a zip archive');
}

export const isZip = (bytes: Uint8Array) =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  bytes[2] === 0x03 &&
  bytes[3] === 0x04;

export async function readZip(bytes: Uint8Array, depth = 0): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endRecord(view);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const utf8 = new TextDecoder('utf-8');
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== SIG_CENTRAL) throw new Error('broken zip directory');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const path = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLen)).replace(/\\/g, '/');
    at += 46 + nameLen + extraLen + commentLen;

    if (path.endsWith('/') || path.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(path)) {
      continue;
    }
    if (view.getUint32(localAt, true) !== SIG_LOCAL) throw new Error('broken zip entry');
    const start =
      localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const raw = bytes.subarray(start, start + compressed);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else continue; // other methods (bzip2, encrypted…) are not supported; the file is skipped

    if (depth === 0 && /\.zip$/i.test(path) && isZip(data)) {
      out.push(...(await readZip(data, 1)));
    } else {
      out.push({ path, data });
    }
  }
  return out;
}
