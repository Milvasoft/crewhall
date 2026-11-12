// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/smart-paste/logic.ts. See THIRD_PARTY.md.
/**
 * Heuristic content detection, no AI, no network. Given pasted text, guess
 * what it is and which tools can handle it. Pure and testable; the component
 * resolves tool ids to names and wires up navigation.
 */

export interface Detection {
  type: string;
  label: string;
  note: string;
  /** Suggested tool ids, most relevant first. */
  toolIds: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isJson(s: string): boolean {
  if (!/^[[{]/.test(s)) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function isJwt(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 3) return false;
  if (!parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p) && p.length > 0)) return false;
  try {
    const json = atob(parts[0]!.replace(/-/g, '+').replace(/_/g, '/'));
    const header = JSON.parse(json) as Record<string, unknown>;
    return typeof header === 'object' && header !== null && 'alg' in header;
  } catch {
    return false;
  }
}

function isSql(s: string): boolean {
  return (
    /\b(select|insert|update|delete|create|alter|drop|with|merge)\b/i.test(s) &&
    /\b(from|into|table|where|values|set|join)\b/i.test(s)
  );
}

function isXml(s: string): boolean {
  return /^<\??[a-zA-Z!]/.test(s) && /<\/?[a-zA-Z][^>]*>/.test(s);
}

function isHtml(s: string): boolean {
  return /<(!doctype|html|head|body|div|span|p|a|ul|ol|li|table|tr|td|h[1-6]|img|br|script|style)\b/i.test(
    s,
  );
}

function isCsv(s: string): boolean {
  if (/^[[{]/.test(s)) return false;
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  if (!lines.every((l) => l.includes(','))) return false;
  const counts = lines.map((l) => l.split(',').length);
  const first = counts[0]!;
  return first >= 2 && counts.every((c) => Math.abs(c - first) <= 1);
}

function isCron(s: string): boolean {
  if (/\n/.test(s)) return false;
  const f = s.split(/\s+/).filter(Boolean);
  if (f.length < 5 || f.length > 6) return false;
  return f.every((t) => /^[\d*/,\-?LW#]+$/i.test(t));
}

function isYaml(s: string): boolean {
  if (/^[[{]/.test(s)) return false;
  const lines = s.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length === 0) return false;
  return lines.some((l) => /^\s*[\w.-]+:\s/.test(l) || /^\s*-\s/.test(l));
}

function isBase64(s: string): boolean {
  const t = s.replace(/\s+/g, '');
  if (t.length < 12 || t.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(t);
}

/** Detected formats, most specific/likely first. */
export function detectContent(input: string): Detection[] {
  const s = input.trim();
  const out: Detection[] = [];
  if (!s) return out;

  if (/^data:image\//i.test(s)) {
    out.push({
      type: 'image',
      label: 'Base64 image / data URI',
      note: 'An inline image.',
      toolIds: ['base64-image', 'image-compressor', 'background-remover'],
    });
  }

  if (isJwt(s)) {
    out.push({
      type: 'jwt',
      label: 'JWT',
      note: 'A JSON Web Token (header.payload.signature).',
      toolIds: ['jwt-decoder'],
    });
  }

  if (UUID_RE.test(s)) {
    out.push({
      type: 'uuid',
      label: 'UUID / GUID',
      note: 'A universally unique identifier.',
      toolIds: ['id-generator'],
    });
  }

  if (/^\d{10}$/.test(s) || /^\d{13}$/.test(s)) {
    out.push({
      type: 'timestamp',
      label: 'Unix timestamp',
      note: 'An epoch time in seconds or milliseconds.',
      toolIds: ['timestamp'],
    });
  }

  if (/^https?:\/\/[^\s]+$/i.test(s)) {
    out.push({
      type: 'url',
      label: 'URL',
      note: 'A web address.',
      toolIds: ['url-parser', 'url-encode'],
    });
  }

  if (
    /(server|data source|database|initial catalog|user id|uid|password|pwd)\s*=/i.test(s) &&
    s.includes(';')
  ) {
    out.push({
      type: 'connection-string',
      label: 'Connection string',
      note: 'An ADO.NET-style connection string.',
      toolIds: ['connection-string'],
    });
  }

  if (isJson(s)) {
    out.push({
      type: 'json',
      label: 'JSON',
      note: 'Valid JSON.',
      toolIds: [
        'json-viewer',
        'json-diff',
        'jsonpath',
        'json-schema',
        'json-yaml',
        'json-csv',
        'json-string',
        'csharp-to-json',
      ],
    });
  }

  if (isXml(s)) {
    if (isHtml(s)) {
      out.push({
        type: 'html',
        label: 'HTML',
        note: 'HTML markup.',
        toolIds: ['html-markdown', 'code-formatter'],
      });
    } else {
      out.push({
        type: 'xml',
        label: 'XML',
        note: 'XML markup.',
        toolIds: ['xml-formatter', 'json-xml'],
      });
    }
  }

  if (isSql(s)) {
    out.push({
      type: 'sql',
      label: 'SQL',
      note: 'A SQL statement.',
      toolIds: ['sql-formatter', 'sql-to-json', 'sql-parameterizer'],
    });
  }

  if (isCsv(s)) {
    out.push({
      type: 'csv',
      label: 'CSV',
      note: 'Comma-separated values.',
      toolIds: ['csv-viewer', 'json-csv'],
    });
  }

  if (isCron(s)) {
    out.push({
      type: 'cron',
      label: 'Cron expression',
      note: 'A cron schedule.',
      toolIds: ['cron-viewer'],
    });
  }

  if (!isJson(s) && isYaml(s)) {
    out.push({
      type: 'yaml',
      label: 'YAML',
      note: 'A YAML document.',
      toolIds: ['json-yaml', 'config-validator'],
    });
  }

  if (isBase64(s) && !out.some((d) => d.type === 'jwt' || d.type === 'image')) {
    out.push({
      type: 'base64',
      label: 'Base64',
      note: 'Base64-encoded data.',
      toolIds: ['base64', 'base64-image'],
    });
  }

  return out;
}
