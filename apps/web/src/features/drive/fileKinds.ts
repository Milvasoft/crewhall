import { type IconName } from '@crewhall/ui';
import { type NodeType } from '@crewhall/shared';

/** Coarse file family from name and mime; drives icons, filters and the previewer. */
export type FileKind =
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'code'
  | 'text'
  | 'sheet'
  | 'doc'
  | 'slides'
  | 'archive'
  | 'design'
  | 'other';

type NodeLike = { type: NodeType; name: string; mime: string | null };

/** Extension → mime for the types the previewer and filters know; the server sniffs content. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  fig: 'application/x-figma',
  sketch: 'application/x-sketch',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  env: 'text/plain',
  sh: 'application/x-sh',
  cs: 'text/x-csharp',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'text/javascript',
  html: 'text/html',
  css: 'text/css',
  sql: 'application/sql',
  xml: 'application/xml',
};

const CODE_EXT = new Set([
  'yml',
  'yaml',
  'json',
  'sh',
  'cs',
  'ts',
  'tsx',
  'js',
  'html',
  'css',
  'sql',
  'xml',
  'env',
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** "milva-sunum-2026.pdf" → ["milva-sunum-2026", ".pdf"] */
export function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

export function mimeFor(name: string, fallback?: string): string {
  return MIME_BY_EXT[extensionOf(name)] ?? (fallback || 'application/octet-stream');
}

export function kindOf(name: string, mime: string | null): FileKind {
  const ext = extensionOf(name);
  const m = mime ?? '';
  if (CODE_EXT.has(ext)) return 'code';
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (ext === 'md' || ext === 'txt' || m.startsWith('text/')) {
    return ext === 'csv' ? 'sheet' : 'text';
  }
  if (['xlsx', 'xls', 'csv', 'ods'].includes(ext)) return 'sheet';
  if (ext === 'docx' || ext === 'odt') return 'doc';
  if (ext === 'pptx' || ext === 'odp') return 'slides';
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return 'archive';
  if (['fig', 'sketch'].includes(ext)) return 'design';
  return 'other';
}

/** Short type badge on file icons ("PDF", "MP4", "ZIP"). */
export function badgeOf(name: string): string {
  const ext = extensionOf(name);
  return ext ? ext.slice(0, 4).toUpperCase() : '';
}

export const TYPE_ICON: Record<NodeType, IconName> = {
  folder: 'folder',
  file: 'file',
  page: 'page',
  board: 'board',
  drawing: 'vector',
};

const KIND_ICON: Record<FileKind, IconName> = {
  image: 'image',
  pdf: 'pdf',
  video: 'film',
  audio: 'speaker',
  code: 'code',
  text: 'text',
  sheet: 'sheet',
  doc: 'file',
  slides: 'monitor',
  archive: 'zip',
  design: 'frame',
  other: 'file',
};

export function nodeIcon(node: NodeLike): IconName {
  if (node.type === 'file') return KIND_ICON[kindOf(node.name, node.mime)];
  return TYPE_ICON[node.type];
}

/** Language label for the code previewer. */
export function languageOf(name: string): string | null {
  const ext = extensionOf(name);
  const map: Record<string, string> = {
    yml: 'YAML',
    yaml: 'YAML',
    json: 'JSON',
    sh: 'Shell',
    cs: 'C#',
    ts: 'TypeScript',
    tsx: 'TypeScript',
    js: 'JavaScript',
    md: 'Markdown',
    sql: 'SQL',
    xml: 'XML',
    html: 'HTML',
    css: 'CSS',
    env: 'ENV',
  };
  return map[ext] ?? null;
}

/** Opens in the full screen viewer (otherwise only the type badge and download). */
export function isPreviewable(node: NodeLike): boolean {
  if (node.type !== 'file') return false;
  const kind = kindOf(node.name, node.mime);
  return ['image', 'pdf', 'video', 'audio', 'code', 'text'].includes(kind);
}

/** A file a video block can play: by its type, or by its name while it is being processed. */
export function isVideoNode(node: NodeLike): boolean {
  return node.type === 'file' && kindOf(node.name, node.mime ?? mimeFor(node.name)) === 'video';
}
