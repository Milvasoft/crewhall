import { getSendToTargets } from '@/features/tools/lib/registry';
import { type ToolDataType, type ToolDefinition } from '@/features/tools/lib/tool-sdk';

/**
 * How a tool's output leaves the tools module (chat, page, Drive) and how a Drive file comes
 * in (which tools can open it). Pure functions; the dialogs and the viewer call them.
 */

const EXT: Partial<Record<ToolDataType, string>> = {
  json: 'json',
  xml: 'xml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  markdown: 'md',
  html: 'html',
  csv: 'csv',
  image: 'png',
  binary: 'bin',
};

const MIME: Partial<Record<ToolDataType, string>> = {
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  toml: 'application/toml',
  sql: 'application/sql',
  markdown: 'text/markdown',
  html: 'text/html',
  csv: 'text/csv',
};

/** Code fence language for chat messages and pages (Markdown and plain text go as they are). */
const FENCE: Partial<Record<ToolDataType, string>> = {
  json: 'json',
  xml: 'xml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  html: 'html',
  csv: 'csv',
};

/** The output as Markdown: structured types in a fenced block, text and Markdown as they are. */
export function asMarkdown(value: string, type: ToolDataType | undefined): string {
  const lang = type ? FENCE[type] : undefined;
  if (!lang) return value;
  // A fence longer than any run of backticks inside, so the block cannot end early.
  const longest = Math.max(2, ...(value.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${value.replace(/\n$/, '')}\n${fence}`;
}

/** The output as a file to upload; image outputs are data URLs and become their bytes. */
export function asFile(
  value: string,
  type: ToolDataType | undefined,
  toolId: string,
): { name: string; blob: Blob } {
  const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(value);
  if (data) {
    const mime = data[1] ?? 'application/octet-stream';
    const body = data[3] ?? '';
    const bytes = data[2]
      ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(body));
    const ext = mime.split('/')[1]?.replace('svg+xml', 'svg') ?? 'bin';
    return { name: `${toolId}.${ext}`, blob: new Blob([bytes], { type: mime }) };
  }
  const ext = (type && EXT[type]) ?? 'txt';
  const mime = (type && MIME[type]) ?? 'text/plain';
  return { name: `${toolId}.${ext}`, blob: new Blob([value], { type: `${mime};charset=utf-8` }) };
}

/** The data type of a Drive file, from its extension; null when no tool reads it. */
export function typeOfFile(name: string): ToolDataType | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, ToolDataType> = {
    json: 'json',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sql: 'sql',
    md: 'markdown',
    markdown: 'markdown',
    html: 'html',
    htm: 'html',
    csv: 'csv',
    txt: 'text',
    log: 'text',
    jwt: 'jwt',
  };
  return map[ext] ?? null;
}

/** Tools that can open a Drive file, best match first (the same rules as "Send To"). */
export function toolsForFile(name: string): ToolDefinition[] {
  const type = typeOfFile(name);
  if (!type) return [];
  const source: ToolDefinition = {
    id: '__drive__',
    name: '',
    description: '',
    category: 'data',
    keywords: [],
    execution: 'local',
    outputType: type,
  };
  return getSendToTargets(source, type);
}
