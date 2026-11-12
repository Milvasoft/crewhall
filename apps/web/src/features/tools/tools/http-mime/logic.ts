// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/http-mime/logic.ts. See THIRD_PARTY.md.
export interface HttpStatus {
  code: number;
  message: string;
  category: string;
  description: string;
}

export interface MimeType {
  ext: string;
  type: string;
}

export const HTTP_STATUSES: HttpStatus[] = [
  {
    code: 100,
    message: 'Continue',
    category: '1xx Informational',
    description: 'Request received, continue.',
  },
  {
    code: 101,
    message: 'Switching Protocols',
    category: '1xx Informational',
    description: 'Server switching protocols.',
  },
  {
    code: 200,
    message: 'OK',
    category: '2xx Success',
    description: 'Standard successful response.',
  },
  { code: 201, message: 'Created', category: '2xx Success', description: 'Resource created.' },
  {
    code: 202,
    message: 'Accepted',
    category: '2xx Success',
    description: 'Accepted for processing.',
  },
  {
    code: 204,
    message: 'No Content',
    category: '2xx Success',
    description: 'Success, no body returned.',
  },
  {
    code: 206,
    message: 'Partial Content',
    category: '2xx Success',
    description: 'Range request fulfilled.',
  },
  {
    code: 301,
    message: 'Moved Permanently',
    category: '3xx Redirection',
    description: 'Resource moved permanently.',
  },
  { code: 302, message: 'Found', category: '3xx Redirection', description: 'Temporary redirect.' },
  {
    code: 304,
    message: 'Not Modified',
    category: '3xx Redirection',
    description: 'Cached version is still valid.',
  },
  {
    code: 307,
    message: 'Temporary Redirect',
    category: '3xx Redirection',
    description: 'Redirect, method preserved.',
  },
  {
    code: 308,
    message: 'Permanent Redirect',
    category: '3xx Redirection',
    description: 'Permanent, method preserved.',
  },
  {
    code: 400,
    message: 'Bad Request',
    category: '4xx Client Error',
    description: 'Malformed or invalid request.',
  },
  {
    code: 401,
    message: 'Unauthorized',
    category: '4xx Client Error',
    description: 'Authentication required.',
  },
  {
    code: 403,
    message: 'Forbidden',
    category: '4xx Client Error',
    description: 'Authenticated but not allowed.',
  },
  {
    code: 404,
    message: 'Not Found',
    category: '4xx Client Error',
    description: 'Resource does not exist.',
  },
  {
    code: 405,
    message: 'Method Not Allowed',
    category: '4xx Client Error',
    description: 'HTTP method not supported.',
  },
  {
    code: 409,
    message: 'Conflict',
    category: '4xx Client Error',
    description: 'Request conflicts with state.',
  },
  {
    code: 410,
    message: 'Gone',
    category: '4xx Client Error',
    description: 'Resource permanently removed.',
  },
  {
    code: 415,
    message: 'Unsupported Media Type',
    category: '4xx Client Error',
    description: 'Payload format not supported.',
  },
  {
    code: 418,
    message: "I'm a teapot",
    category: '4xx Client Error',
    description: 'RFC 2324 easter egg.',
  },
  {
    code: 422,
    message: 'Unprocessable Entity',
    category: '4xx Client Error',
    description: 'Semantic validation failed.',
  },
  {
    code: 429,
    message: 'Too Many Requests',
    category: '4xx Client Error',
    description: 'Rate limit exceeded.',
  },
  {
    code: 500,
    message: 'Internal Server Error',
    category: '5xx Server Error',
    description: 'Generic server failure.',
  },
  {
    code: 501,
    message: 'Not Implemented',
    category: '5xx Server Error',
    description: 'Not supported by server.',
  },
  {
    code: 502,
    message: 'Bad Gateway',
    category: '5xx Server Error',
    description: 'Invalid upstream response.',
  },
  {
    code: 503,
    message: 'Service Unavailable',
    category: '5xx Server Error',
    description: 'Server overloaded or down.',
  },
  {
    code: 504,
    message: 'Gateway Timeout',
    category: '5xx Server Error',
    description: 'Upstream timed out.',
  },
];

export const MIME_TYPES: MimeType[] = [
  { ext: 'json', type: 'application/json' },
  { ext: 'xml', type: 'application/xml' },
  { ext: 'html', type: 'text/html' },
  { ext: 'htm', type: 'text/html' },
  { ext: 'css', type: 'text/css' },
  { ext: 'js', type: 'text/javascript' },
  { ext: 'mjs', type: 'text/javascript' },
  { ext: 'txt', type: 'text/plain' },
  { ext: 'csv', type: 'text/csv' },
  { ext: 'md', type: 'text/markdown' },
  { ext: 'yaml', type: 'application/yaml' },
  { ext: 'yml', type: 'application/yaml' },
  { ext: 'pdf', type: 'application/pdf' },
  { ext: 'zip', type: 'application/zip' },
  { ext: 'gz', type: 'application/gzip' },
  { ext: 'tar', type: 'application/x-tar' },
  { ext: 'doc', type: 'application/msword' },
  { ext: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { ext: 'xls', type: 'application/vnd.ms-excel' },
  { ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { ext: 'ppt', type: 'application/vnd.ms-powerpoint' },
  {
    ext: 'pptx',
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  { ext: 'png', type: 'image/png' },
  { ext: 'jpg', type: 'image/jpeg' },
  { ext: 'jpeg', type: 'image/jpeg' },
  { ext: 'gif', type: 'image/gif' },
  { ext: 'webp', type: 'image/webp' },
  { ext: 'svg', type: 'image/svg+xml' },
  { ext: 'ico', type: 'image/x-icon' },
  { ext: 'avif', type: 'image/avif' },
  { ext: 'mp3', type: 'audio/mpeg' },
  { ext: 'wav', type: 'audio/wav' },
  { ext: 'ogg', type: 'audio/ogg' },
  { ext: 'mp4', type: 'video/mp4' },
  { ext: 'webm', type: 'video/webm' },
  { ext: 'woff', type: 'font/woff' },
  { ext: 'woff2', type: 'font/woff2' },
  { ext: 'ttf', type: 'font/ttf' },
  { ext: 'wasm', type: 'application/wasm' },
  { ext: 'bin', type: 'application/octet-stream' },
];

export function lookupStatus(code: number): HttpStatus | undefined {
  return HTTP_STATUSES.find((s) => s.code === code);
}

export function lookupMime(ext: string): MimeType | undefined {
  const e = ext.replace(/^\./, '').toLowerCase();
  return MIME_TYPES.find((m) => m.ext === e);
}

export function filterStatuses(query: string): HttpStatus[] {
  const q = query.trim().toLowerCase();
  if (!q) return HTTP_STATUSES;
  return HTTP_STATUSES.filter(
    (s) =>
      String(s.code).includes(q) ||
      s.message.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q),
  );
}

export function filterMimes(query: string): MimeType[] {
  const q = query.trim().toLowerCase();
  if (!q) return MIME_TYPES;
  return MIME_TYPES.filter((m) => m.ext.includes(q) || m.type.toLowerCase().includes(q));
}
